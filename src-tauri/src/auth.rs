//! Authentication module for Vibe Buddy
//!
//! Reused from vibe-terminal. Handles OAuth flow by:
//! 1. Opening browser to slashvibe.dev/login
//! 2. Running a one-time local HTTP server to receive the callback
//! 3. Storing the JWT token to ~/.vibe/auth.json

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthState {
    pub token: String,
    pub handle: String,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub authenticated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthStatus {
    pub authenticated: bool,
    pub handle: Option<String>,
    pub token: Option<String>,
}

fn get_auth_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".vibe").join("auth.json")
}

/// Serializes every read-decide-write on auth.json within this process. The
/// OAuth callback lands on its own thread while async commands (token
/// refresh, conditional revocation clear) run elsewhere — without this, a
/// stale revocation probe could compute holds_expected, lose the CPU to a
/// completing sign-in, then delete the FRESH session (codex P2 round 4).
static AUTH_FILE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Write a credential-bearing file PRIVATELY and ATOMICALLY:
///   - the parent directory exists and is 0700 (tightened if it was looser —
///     the terminal package creates ~/.vibe at 0700 too, so this only ever
///     narrows what Buddy itself once created at the umask's 0755);
///   - the bytes go to a fresh temp file in the same directory, created 0600
///     and synced, then renamed over the target — so a reader (the terminal
///     package reads the same auth.json) sees the old file or the new one,
///     never a torn one, and a target that was 0644 is replaced by a 0600 file.
/// The contents and format are unchanged: the terminal reads them as before.
pub(crate) fn write_private(path: &Path, contents: &str) -> Result<(), String> {
    let dir = path.parent().ok_or_else(|| "no parent directory".to_string())?;
    fs::create_dir_all(dir).map_err(|e| format!("Failed to create {}: {}", dir.display(), e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(dir) {
            if meta.permissions().mode() & 0o077 != 0 {
                let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
            }
        }
    }
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let tmp = dir.join(format!(".{}.{}.{}.tmp", name, std::process::id(), nanos));
    let result = (|| -> Result<(), String> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut f = options
            .open(&tmp)
            .map_err(|e| format!("Failed to create temp file: {}", e))?;
        f.write_all(contents.as_bytes()).map_err(|e| format!("Failed to write temp file: {}", e))?;
        f.sync_all().map_err(|e| format!("Failed to sync temp file: {}", e))?;
        fs::rename(&tmp, path).map_err(|e| format!("Failed to replace {}: {}", path.display(), e))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Minimal base64url decoder — avoids pulling in a crate just to read one
/// claim. Returns None on any invalid input (caller then treats the token as
/// "let the server decide").
fn base64url_decode(input: &str) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a') as u32 + 26),
            b'0'..=b'9' => Some((c - b'0') as u32 + 52),
            b'-' => Some(62),
            b'_' => Some(63),
            _ => None,
        }
    }
    let chars: Vec<u8> = input.bytes().filter(|b| *b != b'=').collect();
    let mut out = Vec::with_capacity(chars.len() * 3 / 4);
    for chunk in chars.chunks(4) {
        if chunk.len() < 2 {
            return None;
        }
        let mut acc: u32 = 0;
        for (i, &c) in chunk.iter().enumerate() {
            acc |= val(c)? << (18 - 6 * i);
        }
        out.push((acc >> 16) as u8);
        if chunk.len() >= 3 {
            out.push((acc >> 8) as u8);
        }
        if chunk.len() == 4 {
            out.push(acc as u8);
        }
    }
    Some(out)
}

/// Is this JWT past its `exp`? Decodes the payload WITHOUT verifying the
/// signature — that's the server's job, and we hold no key here. This is only
/// to avoid presenting a signed-in UI on a token we can already see is dead.
/// Unparseable or `exp`-less tokens are treated as NOT expired: the server is
/// the authority, and locking a user out over a token shape we don't recognize
/// is worse than one failed request.
fn is_jwt_expired(token: &str) -> bool {
    let payload_b64 = match token.split('.').nth(1) {
        Some(p) => p,
        None => return false, // not a JWT (legacy two-part token) — let the server decide
    };
    let bytes = match base64url_decode(payload_b64) {
        Some(b) => b,
        None => return false,
    };
    let claims: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let exp = match claims.get("exp").and_then(|v| v.as_i64()) {
        Some(e) => e,
        None => return false,
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    // Skew EARLY, not late. This previously read `now >= exp + 60`, which
    // granted a dead token a further 60 seconds of apparent validity — the
    // opposite of what the comment claimed and the wrong direction for the
    // bug it exists to prevent. Treating a token as expired slightly before
    // `exp` sends the user to sign-in instead of into a session whose very
    // next request will 401.
    exp > 0 && now >= exp - 60
}

#[cfg(test)]
mod jwt_tests {
    use super::*;

    fn make_jwt(exp: i64) -> String {
        // header.payload.signature — only the payload is ever read.
        let payload = format!("{{\"handle\":\"friend\",\"exp\":{}}}", exp);
        let b64 = |s: &str| {
            const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
            let bytes = s.as_bytes();
            let mut out = String::new();
            for chunk in bytes.chunks(3) {
                let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
                let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
                out.push(T[(n >> 18) as usize & 63] as char);
                out.push(T[(n >> 12) as usize & 63] as char);
                if chunk.len() > 1 { out.push(T[(n >> 6) as usize & 63] as char); }
                if chunk.len() > 2 { out.push(T[n as usize & 63] as char); }
            }
            out
        };
        format!("hdr.{}.sig", b64(&payload))
    }

    fn now() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    }

    #[test]
    fn expired_token_is_expired() {
        assert!(is_jwt_expired(&make_jwt(now() - 3600)));
    }

    #[test]
    fn valid_token_is_not_expired() {
        assert!(!is_jwt_expired(&make_jwt(now() + 3600)));
    }

    #[test]
    fn token_expiring_within_the_minute_counts_as_expired() {
        // Expires in 30s: inside the early-refresh window. We'd rather send the
        // user to sign-in than hand them a session whose next request 401s.
        assert!(is_jwt_expired(&make_jwt(now() + 30)));
    }

    #[test]
    fn a_token_well_past_exp_is_expired() {
        assert!(is_jwt_expired(&make_jwt(now() - 30)));
    }

    #[test]
    fn unrecognized_tokens_defer_to_the_server() {
        assert!(!is_jwt_expired("legacy.token"));       // two-part legacy
        assert!(!is_jwt_expired("not-a-jwt"));
        assert!(!is_jwt_expired("hdr.!!!notbase64!!!.sig"));
        assert!(!is_jwt_expired(""));
    }
}

pub fn check_auth() -> AuthStatus {
    let path = get_auth_path();

    if !path.exists() {
        return AuthStatus {
            authenticated: false,
            handle: None,
            token: None,
        };
    }

    match fs::read_to_string(&path) {
        Ok(content) => match serde_json::from_str::<AuthState>(&content) {
            // A stored token that is already past `exp` is NOT a session.
            // Reporting it as one produced a zombie app: the user saw a
            // signed-in buddy list while every authenticated request 401'd,
            // and — for anyone outside the alpha whitelist, i.e. every
            // invited friend — the refresh path could not recover it. Better
            // to show the sign-in screen than a UI that silently does nothing.
            Ok(state) if is_jwt_expired(&state.token) => AuthStatus {
                authenticated: false,
                handle: Some(state.handle),
                token: None,
            },
            Ok(state) => AuthStatus {
                authenticated: true,
                handle: Some(state.handle),
                token: Some(state.token),
            },
            Err(_) => AuthStatus {
                authenticated: false,
                handle: None,
                token: None,
            },
        },
        Err(_) => AuthStatus {
            authenticated: false,
            handle: None,
            token: None,
        },
    }
}

pub fn save_auth(token: &str, handle: &str) -> Result<(), String> {
    let _guard = AUTH_FILE_LOCK.lock().map_err(|_| "auth lock poisoned".to_string())?;
    let path = get_auth_path();

    let state = AuthState {
        token: token.to_string(),
        handle: handle.to_string(),
        provider: Some("github".to_string()),
        authenticated_at: Some(chrono::Utc::now().to_rfc3339()),
    };

    let json = serde_json::to_string_pretty(&state)
        .map_err(|e| format!("Failed to serialize auth state: {}", e))?;

    write_private(&path, &json).map_err(|e| format!("Failed to write auth file: {}", e))?;

    // Keep the MCP config's copy of the credential current (same-identity
    // only) — it is written once at setup and otherwise never refreshed, so
    // without this a reauthenticated Buddy left every terminal session on
    // yesterday's (possibly revoked) token.
    sync_mcp_config_token(token, handle);

    Ok(())
}

// The refreshed-token writer (update_token / save_auth_token) is gone with
// the refresh path it served: /api/auth/buddy-token mints for house agents
// only, so Buddy could never refresh a person's session, and a webview
// command that writes any token it is handed into auth.json was a standing
// way to swap the credential the terminal also uses. A fresh session comes
// only from the OAuth callback below.

pub fn clear_auth() -> Result<(), String> {
    let _guard = AUTH_FILE_LOCK.lock().map_err(|_| "auth lock poisoned".to_string())?;
    let path = get_auth_path();

    // The MCP config (~/.vibe/config.json) carries its own copy of the
    // credential, written once at setup and never refreshed — and the MCP
    // server prefers its locally-unexpired copy. Clearing only auth.json
    // left a revoked token alive for every terminal session (codex P1 on
    // the revoked-token fix). Invalidate the config copy ONLY when it
    // matches the credential being cleared — a config deliberately holding
    // a different identity's token is not ours to erase.
    if let Ok(content) = fs::read_to_string(&path) {
        if let Ok(auth) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(tok) = auth.get("token").and_then(|v| v.as_str()) {
                invalidate_matching_mcp_config_token(tok);
            }
        }
    }

    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("Failed to remove auth file: {}", e))?;
    }

    Ok(())
}

fn mcp_config_path() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| h.join(".vibe").join("config.json"))
}

/// Every credential field the platform-owned MCP store recognizes
/// (mcp-server/config.js: `cfg.authToken || cfg.privyToken`). Invalidation
/// and sync must treat ALL of them, or a stale alias silently rehydrates
/// the very zombie this code exists to kill (codex P1 round 3).
const MCP_TOKEN_ALIASES: [&str; 2] = ["authToken", "privyToken"];

/// Who owns this MCP config? The platform writes identity as `username`
/// (config.js save()), older Buddy code wrote `handle`, and a config may
/// carry a token with no identity label at all — in that case the token
/// ITSELF names its owner (its `handle`/`sub` claim). Only a config with no
/// identity evidence anywhere is ownerless.
fn config_owner(cfg: &serde_json::Value) -> Option<String> {
    // The CREDENTIAL outranks remembered labels — the platform resolves
    // split states in favor of the token (codex P1 round 4). With
    // label-says-A / token-says-B, label-first ownership refused the real
    // owner's sign-in and let the stale label's owner overwrite B's
    // credential. Labels decide only when no alias names a subject.
    for alias in MCP_TOKEN_ALIASES {
        if let Some(tok) = cfg.get(alias).and_then(|v| v.as_str()) {
            if let Some(owner) = jwt_handle_claim(tok) {
                return Some(owner);
            }
        }
    }
    if let Some(h) = cfg.get("handle").and_then(|v| v.as_str()) {
        if !h.is_empty() { return Some(h.to_string()); }
    }
    if let Some(u) = cfg.get("username").and_then(|v| v.as_str()) {
        if !u.is_empty() { return Some(u.to_string()); }
    }
    None
}

/// The `handle`/`sub` claim of a JWT payload, unverified — ownership
/// attribution only, never authorization (the server owns verification).
fn jwt_handle_claim(token: &str) -> Option<String> {
    let payload_b64 = token.split('.').nth(1)?;
    let bytes = base64url_decode(payload_b64)?;
    let claims: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let h = claims.get("handle").or_else(|| claims.get("sub"))?.as_str()?;
    if h.is_empty() { None } else { Some(h.to_string()) }
}

/// Pure decision: the config after invalidating `dead_token`, or None when
/// nothing should change. Matching is against EVERY alias the store
/// accepts, and every alias CARRYING the dead value is removed — while an
/// alias holding a DIFFERENT credential is preserved. Other
/// fields (identity, apiUrl, keys) are preserved, so the MCP server can
/// still say who it was and prompt for a fresh sign-in.
fn config_after_invalidation(mut cfg: serde_json::Value, dead_token: &str) -> Option<serde_json::Value> {
    let dead_aliases: Vec<&str> = MCP_TOKEN_ALIASES
        .iter()
        .copied()
        .filter(|a| cfg.get(*a).and_then(|v| v.as_str()) == Some(dead_token))
        .collect();
    if dead_aliases.is_empty() {
        return None;
    }
    // Remove ONLY the aliases carrying the dead value: a legacy config with
    // distinct authToken/privyToken values may hold a still-valid credential
    // in the other field, and a verdict for the dormant one must not erase
    // it (codex P2 round 4).
    let obj = cfg.as_object_mut()?;
    for alias in dead_aliases {
        obj.remove(alias);
    }
    Some(cfg)
}

/// Pure decision: the config after adopting a fresh credential, or None
/// when it belongs to a DIFFERENT identity (that config was set up
/// deliberately — overwriting it would silently switch someone's terminal
/// sessions to another account). Ownership comes from config_owner(), so a
/// platform-written `username` config and a label-less token-bearing config
/// are both protected. Sync writes BOTH identity spellings (the platform
/// reads either), replaces authToken, and retires any stale privyToken so
/// no alias outlives the refresh.
fn config_after_sync(mut cfg: serde_json::Value, token: &str, handle: &str) -> Option<serde_json::Value> {
    match config_owner(&cfg) {
        Some(owner) if owner != handle => return None,
        _ => {}
    }
    let obj = cfg.as_object_mut()?;
    obj.insert("handle".into(), serde_json::Value::String(handle.to_string()));
    obj.insert("username".into(), serde_json::Value::String(handle.to_string()));
    obj.insert("authToken".into(), serde_json::Value::String(token.to_string()));
    obj.remove("privyToken");
    Some(cfg)
}

/// Clear the persisted session ONLY if it still holds `expected` — the
/// guard against a stale asynchronous revocation verdict erasing a session
/// that was re-established while the probe was in flight (codex P2 round
/// 3). The MCP config's matching aliases are invalidated regardless: a dead
/// copy there is dead wherever auth.json has moved on to.
pub fn clear_auth_if_token(expected: &str) -> Result<(), String> {
    invalidate_matching_mcp_config_token(expected);

    let _guard = AUTH_FILE_LOCK.lock().map_err(|_| "auth lock poisoned".to_string())?;
    let path = get_auth_path();
    let holds_expected = fs::read_to_string(&path)
        .ok()
        .and_then(|c| serde_json::from_str::<AuthState>(&c).ok())
        .map(|a| a.token == expected)
        .unwrap_or(false);
    if holds_expected {
        fs::remove_file(&path).map_err(|e| format!("Failed to remove auth file: {}", e))?;
    }
    Ok(())
}

fn rewrite_mcp_config<F>(decide: F)
where
    F: FnOnce(serde_json::Value) -> Option<serde_json::Value>,
{
    let Some(path) = mcp_config_path() else { return };
    let Ok(content) = fs::read_to_string(&path) else { return };
    let Ok(cfg) = serde_json::from_str::<serde_json::Value>(&content) else { return };
    if let Some(updated) = decide(cfg) {
        if let Ok(json) = serde_json::to_string_pretty(&updated) {
            // Same rule as auth.json: it carries a token too.
            let _ = write_private(&path, &json);
        }
    }
}

fn invalidate_matching_mcp_config_token(dead_token: &str) {
    rewrite_mcp_config(|cfg| config_after_invalidation(cfg, dead_token));
}

fn sync_mcp_config_token(token: &str, handle: &str) {
    rewrite_mcp_config(|cfg| config_after_sync(cfg, token, handle));
}

#[cfg(test)]
mod mcp_config_tests {
    use super::*;
    use serde_json::json;

    fn jwt_for(handle: &str) -> String {
        // header.payload.sig; only the payload is read, unverified.
        let payload = format!("{{\"handle\":\"{}\",\"exp\":99999999999}}", handle);
        let b64 = |s: &str| {
            const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
            let bytes = s.as_bytes();
            let mut out = String::new();
            for chunk in bytes.chunks(3) {
                let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
                let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
                out.push(T[(n >> 18) as usize & 63] as char);
                out.push(T[(n >> 12) as usize & 63] as char);
                if chunk.len() > 1 { out.push(T[(n >> 6) as usize & 63] as char); }
                if chunk.len() > 2 { out.push(T[n as usize & 63] as char); }
            }
            out
        };
        format!("hdr.{}.sig", b64(&payload))
    }

    #[test]
    fn a_matching_dead_token_is_removed_and_nothing_else_touched() {
        let cfg = json!({"handle": "friend", "authToken": "dead", "apiUrl": "https://www.slashvibe.dev"});
        let out = config_after_invalidation(cfg, "dead").unwrap();
        assert!(out.get("authToken").is_none());
        assert_eq!(out.get("handle").unwrap(), "friend");
        assert_eq!(out.get("apiUrl").unwrap(), "https://www.slashvibe.dev");
    }

    #[test]
    fn a_dead_privy_token_is_matched_and_all_aliases_removed() {
        // The platform store accepts privyToken too — matching only
        // authToken would leave the zombie alive one field over.
        let cfg = json!({"username": "friend", "privyToken": "dead", "authToken": "dead"});
        let out = config_after_invalidation(cfg, "dead").unwrap();
        assert!(out.get("authToken").is_none());
        assert!(out.get("privyToken").is_none());
        assert_eq!(out.get("username").unwrap(), "friend");
    }

    #[test]
    fn a_different_identitys_token_is_not_ours_to_erase() {
        let cfg = json!({"handle": "other", "authToken": "theirs"});
        assert!(config_after_invalidation(cfg, "dead").is_none());
    }

    #[test]
    fn a_fresh_sign_in_refreshes_the_same_identitys_config() {
        let cfg = json!({"handle": "friend", "authToken": "stale", "apiUrl": "x"});
        let out = config_after_sync(cfg, "fresh", "friend").unwrap();
        assert_eq!(out.get("authToken").unwrap(), "fresh");
        assert_eq!(out.get("apiUrl").unwrap(), "x");
    }

    #[test]
    fn sync_retires_a_stale_privy_alias_and_writes_both_identity_spellings() {
        let cfg = json!({"username": "friend", "privyToken": "stale"});
        let out = config_after_sync(cfg, "fresh", "friend").unwrap();
        assert_eq!(out.get("authToken").unwrap(), "fresh");
        assert!(out.get("privyToken").is_none());
        assert_eq!(out.get("handle").unwrap(), "friend");
        assert_eq!(out.get("username").unwrap(), "friend");
    }

    #[test]
    fn a_platform_written_username_config_is_someone_elses() {
        // config.js writes identity as `username`; treating that as
        // ownerless let a different GitHub sign-in hijack the terminal.
        let cfg = json!({"username": "other", "authToken": "theirs"});
        assert!(config_after_sync(cfg, "fresh", "friend").is_none());
    }

    #[test]
    fn in_a_split_state_the_credential_outranks_the_remembered_label() {
        // Label says "stale", token says "real": the platform resolves in
        // favor of the credential, so the real owner's sign-in refreshes
        // the config and the stale label's owner cannot hijack it.
        let cfg = json!({"username": "stale", "authToken": jwt_for("real")});
        assert!(config_after_sync(cfg.clone(), "fresh", "real").is_some());
        assert!(config_after_sync(cfg, "fresh", "stale").is_none());
    }

    #[test]
    fn only_the_alias_carrying_the_dead_value_is_removed() {
        // Legacy split: privyToken is the dead one, authToken holds a
        // different (possibly valid) credential — it must survive.
        let cfg = json!({"username": "friend", "authToken": "alive", "privyToken": "dead"});
        let out = config_after_invalidation(cfg, "dead").unwrap();
        assert_eq!(out.get("authToken").unwrap(), "alive");
        assert!(out.get("privyToken").is_none());
    }

    #[test]
    fn a_label_less_config_is_owned_by_its_tokens_subject() {
        let cfg = json!({"authToken": jwt_for("other")});
        assert!(config_after_sync(cfg, "fresh", "friend").is_none());
        let same = json!({"authToken": jwt_for("friend")});
        assert!(config_after_sync(same, "fresh", "friend").is_some());
    }

    #[test]
    fn a_config_for_someone_else_is_left_alone() {
        let cfg = json!({"handle": "other", "authToken": "theirs"});
        assert!(config_after_sync(cfg, "fresh", "friend").is_none());
    }

    #[test]
    fn a_config_with_no_identity_evidence_adopts_the_new_one() {
        let cfg = json!({"apiUrl": "x"});
        let out = config_after_sync(cfg, "fresh", "friend").unwrap();
        assert_eq!(out.get("handle").unwrap(), "friend");
        assert_eq!(out.get("authToken").unwrap(), "fresh");
    }
}

/// What the loopback callback delivered: the token only. The handle is NOT
/// taken from the callback — a callback parameter is whatever the URL says;
/// the account is whoever the token belongs to (`resolve_handle`).
#[derive(Debug, Clone)]
pub struct AuthCallbackData {
    pub token: String,
}

#[derive(Debug)]
pub enum AuthResult {
    Success(AuthCallbackData),
    Error(String),
    Timeout,
}

pub struct LoginFlow {
    pub login_url: String,
    #[allow(dead_code)]
    pub callback_port: u16,
    pub receiver: mpsc::Receiver<AuthResult>,
}

impl LoginFlow {
    pub fn wait_for_callback(&self, timeout: Duration) -> AuthResult {
        match self.receiver.recv_timeout(timeout) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => AuthResult::Timeout,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                AuthResult::Error("Callback handler disconnected".to_string())
            }
        }
    }
}

/// How long one sign-in attempt's listener lives (the terminal package uses
/// the same five minutes: a GitHub sign-in can include 2FA).
pub const LOGIN_WINDOW: Duration = Duration::from_secs(300);

/// A fresh, single-use state for one sign-in attempt: 32 bytes from the OS
/// CSPRNG, hex. No crate needed on macOS/Linux.
fn mint_state() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|e| format!("could not read randomness: {}", e))?;
    Ok(bytes.iter().map(|b| format!("{:02x}", b)).collect())
}

/// Constant-time comparison, so the state cannot be learned byte by byte.
fn same_secret(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The callback verdict for one raw request.
#[derive(Debug, PartialEq)]
enum Callback {
    /// Exact path, GET, matching state, a token: the sign-in.
    Token(String),
    /// Exact path, GET, matching state, and the platform reported an error.
    Refused,
    /// Anything else — wrong path, method or state, no token. Ignored: the
    /// listener keeps waiting for the real callback until the window ends.
    Ignore,
}

/// Parse one request line against THIS attempt's state. Only
/// `GET /callback?...state=<ours>...` counts; the `handle` parameter is never read.
fn parse_callback(request: &str, expected_state: &str) -> Callback {
    let Some(first_line) = request.lines().next() else { return Callback::Ignore };
    let mut parts = first_line.split(' ');
    let (Some(method), Some(target)) = (parts.next(), parts.next()) else { return Callback::Ignore };
    if method != "GET" {
        return Callback::Ignore;
    }
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p, q),
        None => (target, ""),
    };
    if path != "/callback" {
        return Callback::Ignore;
    }
    let mut state = None;
    let mut token = None;
    let mut error = false;
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let decoded = urlencoding::decode(value).map(|v| v.to_string()).unwrap_or_default();
        match key {
            // A repeated state is ambiguous: refuse rather than pick one.
            "state" => state = if state.is_some() { Some(String::new()) } else { Some(decoded) },
            "token" => token = Some(decoded),
            "error" => error = true,
            _ => {}
        }
    }
    match state {
        Some(s) if same_secret(&s, expected_state) => {}
        _ => return Callback::Ignore,
    }
    match token {
        Some(t) if !t.is_empty() => Callback::Token(t),
        _ if error => Callback::Refused,
        _ => Callback::Ignore,
    }
}

const PAGE_HEAD: &str = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";

/// The pages carry no data from the request (nothing reflected).
fn page(body: &str) -> String {
    format!(
        "{PAGE_HEAD}<!DOCTYPE html><html><head><meta charset=\"utf-8\"><style>body {{ font-family: ui-monospace, monospace; background: #0a0a0a; color: #ccc; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }}</style></head><body><p>{body}</p></body></html>"
    )
}

pub fn start_login() -> Result<LoginFlow, String> {
    // Loopback only, on an OS-chosen port; the callback URL names the same
    // literal address the socket is bound to.
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed to bind to local port: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get local address: {}", e))?
        .port();
    let state = mint_state()?;

    // The state rides inside the redirect URL. The platform keeps the
    // redirect's own query and appends token/handle to it
    // (api/auth/github/callback.js: `${finalRedirectUri}${separator}token=…`),
    // so it comes back to us without any platform change — the same
    // mechanism slashvibe-mcp's oauth-callback.js uses.
    let callback_url = format!("http://127.0.0.1:{}/callback?state={}", port, state);
    let login_url = format!(
        "https://www.slashvibe.dev/api/auth/github?redirect={}&app=buddy",
        urlencoding::encode(&callback_url)
    );

    let (tx, rx) = mpsc::channel::<AuthResult>();

    thread::spawn(move || {
        listener.set_nonblocking(true).ok();
        let start = std::time::Instant::now();
        loop {
            if start.elapsed() > LOGIN_WINDOW {
                let _ = tx.send(AuthResult::Timeout);
                break;
            }
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let _ = stream.set_nonblocking(false);
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                    let mut buffer = [0; 8192];
                    let n = stream.read(&mut buffer).unwrap_or(0);
                    let request = String::from_utf8_lossy(&buffer[..n]);
                    match parse_callback(&request, &state) {
                        Callback::Token(token) => {
                            let _ = stream.write_all(page("Signed in. You can close this tab and return to Buddy.").as_bytes());
                            let _ = stream.flush();
                            let _ = tx.send(AuthResult::Success(AuthCallbackData { token }));
                            break; // single use: the listener is dropped here
                        }
                        Callback::Refused => {
                            let _ = stream.write_all(page("Sign-in did not complete. You can close this tab and try again from Buddy.").as_bytes());
                            let _ = tx.send(AuthResult::Error("OAuth error".to_string()));
                            break;
                        }
                        Callback::Ignore => {
                            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
                        }
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(100));
                }
                Err(e) => {
                    let _ = tx.send(AuthResult::Error(format!("Accept error: {}", e)));
                    break;
                }
            }
        }
    });

    Ok(LoginFlow {
        login_url,
        callback_port: port,
        receiver: rx,
    })
}

/// Who a freshly delivered token belongs to: the SERVER's answer
/// (GET /api/auth/verify → { valid, handle }), never a callback parameter.
/// Ok(None) means the server explicitly rejected the token (do not sign in).
/// Err means the server could not be asked; the caller may then fall back to
/// the token's own `handle` claim — still the token, never the URL.
pub fn verified_handle(token: &str) -> Result<Option<String>, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .get("https://www.slashvibe.dev/api/auth/verify")
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let text = res.text().unwrap_or_default();
    decide_verified_handle(status, &text)
}

/// Pure half of `verified_handle`, for tests.
fn decide_verified_handle(status: u16, body: &str) -> Result<Option<String>, String> {
    if status == 401 {
        return Ok(None);
    }
    if status != 200 {
        return Err(format!("verify answered {}", status));
    }
    let v: serde_json::Value = serde_json::from_str(body).map_err(|_| "verify answer unreadable".to_string())?;
    if v.get("valid") != Some(&serde_json::Value::Bool(true)) {
        return Ok(None);
    }
    match v.get("handle").and_then(|h| h.as_str()).map(|h| h.trim().to_lowercase()) {
        Some(h) if !h.is_empty() => Ok(Some(h)),
        _ => Err("verify answer had no handle".to_string()),
    }
}

/// The token's own `handle`/`sub` claim (unverified decode), for when the
/// verify call could not be made. The token is what the server signed; the
/// server rejects a forged one on first use.
pub fn token_handle_claim(token: &str) -> Option<String> {
    jwt_handle_claim(token).map(|h| h.trim().to_lowercase()).filter(|h| !h.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ST: &str = "aa11bb22";

    #[test]
    fn only_the_exact_get_callback_with_our_state_counts() {
        assert_eq!(parse_callback(&format!("GET /callback?state={ST}&token=t.k.n&handle=x HTTP/1.1\r\n"), ST), Callback::Token("t.k.n".into()));
        // wrong or missing state, wrong path, wrong method, no token: ignored
        assert_eq!(parse_callback("GET /callback?state=nope&token=t HTTP/1.1\r\n", ST), Callback::Ignore);
        assert_eq!(parse_callback("GET /callback?token=t&handle=x HTTP/1.1\r\n", ST), Callback::Ignore);
        assert_eq!(parse_callback(&format!("GET /callbackx?state={ST}&token=t HTTP/1.1\r\n"), ST), Callback::Ignore);
        assert_eq!(parse_callback(&format!("GET /other/callback?state={ST}&token=t HTTP/1.1\r\n"), ST), Callback::Ignore);
        assert_eq!(parse_callback(&format!("POST /callback?state={ST}&token=t HTTP/1.1\r\n"), ST), Callback::Ignore);
        assert_eq!(parse_callback(&format!("GET /callback?state={ST} HTTP/1.1\r\n"), ST), Callback::Ignore);
        // a repeated state is refused, whichever copy matches
        assert_eq!(parse_callback(&format!("GET /callback?state={ST}&state=x&token=t HTTP/1.1\r\n"), ST), Callback::Ignore);
        // the platform's error, under our state
        assert_eq!(parse_callback(&format!("GET /callback?state={ST}&error=denied HTTP/1.1\r\n"), ST), Callback::Refused);
        // garbage
        assert_eq!(parse_callback("", ST), Callback::Ignore);
    }

    #[test]
    fn the_callback_handle_parameter_is_never_read() {
        let src = include_str!("auth.rs");
        assert!(!src.contains(concat!("\"handle", "\" =>")), "the callback must not read a handle parameter");
    }

    #[test]
    fn states_are_fresh_and_long() {
        let a = mint_state().unwrap();
        let b = mint_state().unwrap();
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
        assert!(same_secret(&a, &a.clone()));
        assert!(!same_secret(&a, &b));
        assert!(!same_secret(&a, &a[..63]));
    }

    #[test]
    fn the_account_is_the_servers_answer() {
        assert_eq!(decide_verified_handle(200, r#"{"valid":true,"handle":"Brightseth"}"#), Ok(Some("brightseth".into())));
        assert_eq!(decide_verified_handle(401, r#"{"valid":false}"#), Ok(None));
        assert_eq!(decide_verified_handle(200, r#"{"valid":false}"#), Ok(None));
        assert!(decide_verified_handle(503, "").is_err());
        assert!(decide_verified_handle(200, "<html>").is_err());
        assert!(decide_verified_handle(200, r#"{"valid":true}"#).is_err());
    }

    #[test]
    fn pages_reflect_nothing_from_the_request() {
        let src = include_str!("auth.rs");
        assert!(!src.contains(concat!("Logged in", " as @{}")));
        assert!(page("x").starts_with("HTTP/1.1 200 OK\r\n"));
    }

    #[test]
    fn private_writes_are_0600_in_a_0700_dir_and_tighten_looser_files() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("buddy-private-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        let f = dir.join("auth.json");
        fs::write(&f, "old").unwrap();
        fs::set_permissions(&f, fs::Permissions::from_mode(0o644)).unwrap();
        write_private(&f, "{\"token\":\"t\",\"handle\":\"h\"}").unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), "{\"token\":\"t\",\"handle\":\"h\"}");
        assert_eq!(fs::metadata(&f).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        // no temp file left behind
        let leftovers: Vec<_> = fs::read_dir(&dir).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".tmp")).collect();
        assert!(leftovers.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_persisted_unexpired_token_is_not_treated_as_expired() {
        // exp far in the future; payload is base64url of {"exp":4102444800}
        assert!(!is_jwt_expired("aaa.eyJleHAiOjQxMDI0NDQ4MDB9.bbb"));
    }
}
