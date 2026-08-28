//! Private Personal Mind transport.
//!
//! The renderer may provide only the active draft or the recent visible
//! thread excerpt it already holds. The bearer stays in the native process,
//! the destination is fixed to Seth's private Tailnet Studio, and every
//! failure becomes silence. Nothing in this module talks to slashvibe.dev.

use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

const MIND_ORIGIN: &str = "http://100.121.205.111:7788";
const MAX_HANDLE_BYTES: usize = 64;
const MAX_DRAFT_BYTES: usize = 4_000;
const MAX_CONTEXT_BYTES: usize = 2_000;
const MAX_RESPONSE_BYTES: u64 = 256 * 1024;

#[derive(Serialize)]
struct MindRequest<'a> {
    handle: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    draft: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    context: Option<&'a str>,
}

#[derive(Clone, Copy)]
enum MindRoute {
    Prime,
    Facet,
}

impl MindRoute {
    fn path(self) -> &'static str {
        match self {
            Self::Prime => "/prime",
            Self::Facet => "/facet",
        }
    }

    fn timeout(self) -> Duration {
        match self {
            Self::Prime => Duration::from_secs(180),
            Self::Facet => Duration::from_secs(90),
        }
    }
}

fn token_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".vibe/mind/runtime-token"))
}

fn read_private_token(path: &Path) -> Option<String> {
    let meta = fs::symlink_metadata(path).ok()?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return None;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o077 != 0 {
            return None;
        }
    }

    let token = fs::read_to_string(path).ok()?;
    let token = token.trim();
    if token.len() < 24 || token.len() > 512 || token.chars().any(char::is_whitespace) {
        return None;
    }
    Some(token.to_owned())
}

fn valid_handle(handle: &str) -> bool {
    !handle.is_empty()
        && handle.len() <= MAX_HANDLE_BYTES
        && handle
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'@')
}

fn mind_client(route: MindRoute) -> Option<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(route.timeout())
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .ok()
}

fn request(route: MindRoute, handle: &str, text: &str) -> Option<Value> {
    if !valid_handle(handle) || text.trim().is_empty() {
        return None;
    }
    let limit = match route {
        MindRoute::Prime => MAX_CONTEXT_BYTES,
        MindRoute::Facet => MAX_DRAFT_BYTES,
    };
    if text.len() > limit {
        // Never silently analyze different words from the ones the human sees.
        return None;
    }

    let token = read_private_token(&token_path()?)?;
    let payload = match route {
        MindRoute::Prime => MindRequest {
            handle,
            draft: None,
            context: Some(text),
        },
        MindRoute::Facet => MindRequest {
            handle,
            draft: Some(text),
            context: None,
        },
    };

    let client = mind_client(route)?;
    let response = client
        .post(format!("{}{}", MIND_ORIGIN, route.path()))
        .bearer_auth(token)
        .header("Content-Type", "application/json")
        .body(serde_json::to_vec(&payload).ok()?)
        .send()
        .ok()?;
    if !response.status().is_success()
        || response.content_length().unwrap_or(0) > MAX_RESPONSE_BYTES
    {
        return None;
    }
    let bytes = response.bytes().ok()?;
    if bytes.len() as u64 > MAX_RESPONSE_BYTES {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

#[tauri::command]
pub async fn mind_prime(handle: String, context: String) -> Option<Value> {
    tauri::async_runtime::spawn_blocking(move || request(MindRoute::Prime, &handle, &context))
        .await
        .ok()
        .flatten()
}

// SINGLE-FLIGHT (round-2 P1): the renderer's supersede aborts only its local
// Promise.race — the 90s blocking request underneath keeps running. Without
// this guard, pause–edit–pause stacks native requests. While one facet ask is
// in flight, a second returns None immediately (the client already renders
// null as silence and simply asks again at the next pause).
static FACET_IN_FLIGHT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
pub async fn mind_facet(handle: String, draft: String) -> Option<Value> {
    use std::sync::atomic::Ordering;
    if FACET_IN_FLIGHT.swap(true, Ordering::SeqCst) {
        return None; // silence now; the next pause asks again
    }
    let out = tauri::async_runtime::spawn_blocking(move || request(MindRoute::Facet, &handle, &draft))
        .await
        .ok()
        .flatten();
    FACET_IN_FLIGHT.store(false, Ordering::SeqCst);
    out
}

/// METADATA-ONLY composer tracing (Camille defect, 2026-08-28): every stage
/// of the ask path leaves one line in ~/.vibe/mind/client-trace.local.jsonl
/// so "the client never asked" versus "the Mind chose silence" versus
/// "unreachable" are three DIFFERENT diagnostics instead of one identical
/// nothing. NEVER the draft, the context, or any text — event names, byte
/// counts, a short thread fingerprint, and response classes only.
#[tauri::command]
pub fn mind_trace(event: String, meta: Value) {
    // CLOSED VOCABULARY (round-2 P1): event names and meta KEYS are
    // whitelisted — an open key set meant a key itself could carry a draft.
    // Values are numbers/bools or short ids. Anything else is dropped whole.
    const EVENTS: [&str; 8] = [
        "ineligible", "timer_scheduled", "timer_fired", "request_attempted",
        "response", "discard_stale", "suppressed_dismissed", "offer_rendered",
    ];
    const KEYS: [&str; 4] = ["fp", "draft_bytes", "context_bytes", "class"];
    const CLASSES: [&str; 6] = ["offer", "facet", "aperture", "silence", "native_null", "invoke_error"];
    if !EVENTS.contains(&event.as_str()) {
        return;
    }
    let Some(obj) = meta.as_object() else { return };
    if obj.len() > 4 {
        return;
    }
    for (k, v) in obj {
        if !KEYS.contains(&k.as_str()) {
            return;
        }
        let ok = match (k.as_str(), v) {
            ("fp", Value::String(s)) => s.len() <= 16 && s.chars().all(|c| c.is_ascii_alphanumeric()),
            ("class", Value::String(s)) => CLASSES.contains(&s.as_str()),
            ("draft_bytes" | "context_bytes", Value::Number(_)) => true,
            _ => false,
        };
        if !ok {
            return;
        }
    }
    let Some(home) = dirs::home_dir() else { return };
    let path = home.join(".vibe/mind/client-trace.local.jsonl");
    let line = serde_json::json!({
        "ts": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        "event": event,
        "meta": meta,
    })
    .to_string();
    // The cap counts THIS line too (round-2 P2): a diagnostics file may never
    // cross 1MB, not merely start each append under it.
    let existing = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if existing + line.len() as u64 + 1 > 1_000_000 {
        let _ = fs::remove_file(&path);
    }
    use std::io::Write;
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{}", line);
    }
}

#[cfg(test)]#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;
    use std::thread;

    fn temp_token(mode: u32, body: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "vibe-mind-token-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut file = fs::File::create(&path).unwrap();
        file.write_all(body.as_bytes()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        }
        path
    }

    #[test]
    fn private_token_requires_a_regular_0600_file() {
        let good = temp_token(0o600, "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG");
        assert!(read_private_token(&good).is_some());
        fs::remove_file(&good).unwrap();

        let open = temp_token(0o644, "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG");
        assert!(read_private_token(&open).is_none());
        fs::remove_file(&open).unwrap();
    }

    #[test]
    fn native_destination_is_one_exact_tailnet_origin() {
        assert_eq!(MIND_ORIGIN, "http://100.121.205.111:7788");
        assert!(!MIND_ORIGIN.contains("slashvibe.dev"));
    }

    #[test]
    fn payloads_contain_only_the_visible_scope() {
        let prime = serde_json::to_value(MindRequest {
            handle: "friend",
            draft: None,
            context: Some("recent visible thread"),
        })
        .unwrap();
        assert_eq!(prime, serde_json::json!({
            "handle": "friend",
            "context": "recent visible thread"
        }));

        let facet = serde_json::to_value(MindRequest {
            handle: "friend",
            draft: Some("the active draft"),
            context: None,
        })
        .unwrap();
        assert_eq!(facet, serde_json::json!({
            "handle": "friend",
            "draft": "the active draft"
        }));
    }

    #[test]
    fn boundary_rejects_invalid_handles() {
        assert!(!valid_handle("friend/../../token"));
        assert!(!valid_handle(&"a".repeat(MAX_HANDLE_BYTES + 1)));
        assert!(valid_handle("@friend-name"));
    }

    #[test]
    fn native_client_refuses_redirects_before_private_payload_can_follow() {
        let redirect_target = TcpListener::bind("127.0.0.1:0").unwrap();
        redirect_target.set_nonblocking(true).unwrap();
        let target_address = redirect_target.local_addr().unwrap();

        let redirector = TcpListener::bind("127.0.0.1:0").unwrap();
        let redirector_address = redirector.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = redirector.accept().unwrap();
            let response = format!(
                "HTTP/1.1 307 Temporary Redirect\r\nLocation: http://{target_address}/escaped\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            stream.write_all(response.as_bytes()).unwrap();
        });

        let client = mind_client(MindRoute::Facet).unwrap();
        let response = client
            .post(format!("http://{redirector_address}/private"))
            .body("private draft")
            .send()
            .unwrap();
        server.join().unwrap();

        assert_eq!(response.status(), reqwest::StatusCode::TEMPORARY_REDIRECT);
        thread::sleep(Duration::from_millis(25));
        assert!(redirect_target.accept().is_err());
    }
}
