//! The terminal's drafts, decided from Buddy — without Buddy becoming a sender.
//!
//! The coding agent prepares a message in a terminal session (`/vibe`); the
//! draft lives in `~/.vibe/drafts.json` under the terminal package's own lock,
//! revision and approval digest. Buddy shows that draft in its composer and
//! lets the person decide here. Every decision goes back THROUGH the package
//! (`vibe-draft list | send <id> <rev> | discard <id>`): one draft, one sender,
//! one digest, never two sends. Buddy never reads the drafts file directly and
//! never posts a draft's text itself.
//!
//! The package is found the way the person's own sessions find it: the npx
//! cache of the pinned `slashvibe-mcp` version. Nothing is downloaded here; if
//! the package is not installed, drafts are simply unavailable and say so.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DraftRef {
    pub title: Option<String>,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalDraft {
    pub id: String,
    pub to: String,
    pub why: Option<String>,
    pub why_now: Option<String>,
    /// Exactly what the terminal preview showed. Buddy renders it verbatim.
    pub message: String,
    #[serde(default)]
    pub refs: Vec<DraftRef>,
    pub reply_to: Option<String>,
    /// The preview revision. A send must name it; the package refuses any other.
    pub rev: String,
    pub created_at: Option<u64>,
    /// 'previewed' (decidable) or 'unknown' (a send whose fate is unconfirmed).
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub unconfirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DraftList {
    pub handle: Option<String>,
    #[serde(default)]
    pub drafts: Vec<TerminalDraft>,
    pub error: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendOutcome {
    pub id: String,
    pub sent: bool,
    pub message_id: Option<String>,
    pub status: Option<String>,
    /// The package's own sentence about what happened — shown as-is.
    pub display: Option<String>,
    /// True when the refusal provably happened before any write (nothing sent).
    #[serde(default)]
    pub definite: bool,
    /// True when an earlier attempt may have committed: Send again retries
    /// exactly this text; Buddy must keep the draft reachable.
    #[serde(default)]
    pub unconfirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscardOutcome {
    pub id: String,
    pub status: Option<String>,
    /// The package's word that the stored row is now cancelled. Only this
    /// permits Buddy to treat the draft as gone.
    #[serde(default)]
    pub cancelled: bool,
    /// An earlier attempt may already have been delivered: cancel stops only
    /// future retries. A field, so no surface has to read it out of prose.
    #[serde(default)]
    pub may_have_sent: bool,
    pub display: Option<String>,
}

/// Semantic version as a comparable tuple; anything unparseable sorts lowest.
fn semver(v: &str) -> (u64, u64, u64) {
    let mut it = v.trim().trim_start_matches('v').split(|c| c == '.' || c == '-').map(|p| p.parse::<u64>().unwrap_or(0));
    (it.next().unwrap_or(0), it.next().unwrap_or(0), it.next().unwrap_or(0))
}

/// The installed package's draft CLI, or None. Newest pinned version wins,
/// compared as a version, not as a string (0.8.10 > 0.8.9).
fn draft_cli() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let npx = home.join(".npm").join("_npx");
    let mut best: Option<((u64, u64, u64), PathBuf)> = None;
    for entry in std::fs::read_dir(&npx).ok()?.flatten() {
        let pkg = entry.path().join("node_modules").join("slashvibe-mcp");
        let cli = pkg.join("draft-cli.js");
        if !cli.exists() { continue; }
        let version = std::fs::read_to_string(pkg.join("package.json")).ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .and_then(|v| v.get("version").and_then(|x| x.as_str()).map(String::from))
            .unwrap_or_default();
        let sv = semver(&version);
        if best.as_ref().map(|(v, _)| sv > *v).unwrap_or(true) { best = Some((sv, cli)); }
    }
    best.map(|(_, p)| p)
}

/// The same Finder-safe Node resolver the vibeconf bridge uses: a Buddy
/// launched from Finder inherits no shell PATH, so Homebrew, nvm, Volta and
/// asdf installs are all looked up explicitly.
fn node() -> Result<PathBuf, String> {
    crate::vibeconf::node_binary().ok_or_else(|| "no Node runtime found on this machine".to_string())
}

/// The CLI's error envelope `{error, message}` is an Err here, so a caller
/// never deserializes it into a false outcome (codex r5): "sent: false" with
/// no reason is not what "not_signed_in" means.
fn envelope_error(v: &serde_json::Value) -> Option<String> {
    let err = v.get("error")?.as_str()?;
    let msg = v.get("message").and_then(|m| m.as_str()).unwrap_or("");
    Some(if msg.is_empty() { err.to_string() } else { format!("{err}: {msg}") })
}

/// Run one verb. The CLI prints exactly one JSON object on stdout; stderr is logs.
fn run(args: &[&str]) -> Result<serde_json::Value, String> {
    let cli = draft_cli().ok_or_else(|| "the terminal package is not installed here".to_string())?;
    let out = Command::new(node()?).arg(&cli).args(args).output().map_err(|e| format!("could not run the terminal package: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().rev().find(|l| l.trim_start().starts_with('{')).ok_or_else(|| "the terminal package gave no answer".to_string())?;
    serde_json::from_str(line).map_err(|e| format!("could not read the terminal package's answer: {e}"))
}

/// Previewed drafts for the signed-in account. `me` must match the package's
/// account; a mismatch returns none — a draft is never shown to another account.
#[tauri::command]
pub async fn terminal_drafts(me: String) -> Result<DraftList, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let v = run(&["list"])?;
        let list: DraftList = serde_json::from_value(v).map_err(|e| e.to_string())?;
        // The CLI's own errors (not_signed_in, store_failed) carry no handle and
        // must reach the surface as themselves, not as a mismatch (codex r3).
        if list.error.is_some() { return Ok(DraftList { drafts: vec![], ..list }); }
        match &list.handle {
            Some(h) if h.eq_ignore_ascii_case(&me) => Ok(list),
            _ => Ok(DraftList { handle: list.handle, drafts: vec![], error: Some("account_mismatch".into()), message: Some("the terminal is signed in as someone else".into()) }),
        }
    }).await.map_err(|e| format!("worker died: {e}"))?
}

/// Send exactly the revision Buddy showed. The package does the sending.
#[tauri::command]
pub async fn send_terminal_draft(id: String, rev: String) -> Result<SendOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let v = run(&["send", &id, &rev])?;
        if let Some(e) = envelope_error(&v) { return Err(e); }
        serde_json::from_value(v).map_err(|e| e.to_string())
    }).await.map_err(|e| format!("worker died: {e}"))?
}

/// Discard here = discarded everywhere.
#[tauri::command]
pub async fn discard_terminal_draft(id: String) -> Result<DiscardOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let v = run(&["discard", &id])?;
        if let Some(e) = envelope_error(&v) { return Err(e); }
        serde_json::from_value(v).map_err(|e| e.to_string())
    }).await.map_err(|e| format!("worker died: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::{semver, envelope_error};
    #[test]
    fn a_cli_error_envelope_is_an_error_not_an_outcome() {
        let v: serde_json::Value = serde_json::from_str(r#"{"error":"not_signed_in","message":"no /vibe account on this machine"}"#).unwrap();
        assert_eq!(envelope_error(&v).as_deref(), Some("not_signed_in: no /vibe account on this machine"));
        let ok: serde_json::Value = serde_json::from_str(r#"{"id":"d1","sent":true}"#).unwrap();
        assert!(envelope_error(&ok).is_none());
    }
    #[test]
    fn newest_is_a_version_not_a_string() {
        assert!(semver("0.8.10") > semver("0.8.9"));
        assert!(semver("0.10.0") > semver("0.9.0"));
        assert!(semver("0.8.100") > semver("0.8.99"));
        assert!(semver("v1.0.0") > semver("0.99.99"));
        assert_eq!(semver("garbage"), (0, 0, 0));
    }
}
