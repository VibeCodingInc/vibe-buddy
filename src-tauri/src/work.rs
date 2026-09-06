//! Getting back to the work a reply belongs to.
//!
//! The terminal package (slashvibe-mcp) keeps a PRIVATE note of what was sent
//! from which work: `~/.vibe/return-bindings.json`, mode 0600, never on the
//! wire. Buddy reads it — the same file family it already reads for identity
//! (`auth.json`, `config.json`) — so a reply can say what it answers and offer
//! one way back: front the exact terminal tab if it is still open, or reveal
//! the folder if it is not. Never "resume": Buddy can front a tab or open a
//! folder; it cannot resume a session, and it must not say it did.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReturnBinding {
    /// The other person (the thread this binding labels).
    pub handle: String,
    /// The account that sent the message (bindings are per-person; another
    /// account on the same machine must never inherit them).
    pub from: Option<String>,
    /// The work it was sent from, in the person's own word for it.
    pub project: Option<String>,
    /// The id of the message that was sent — a reply carrying this as its
    /// `reply_to` is a VERIFIED answer; anything else is not.
    #[serde(rename = "messageId")]
    pub message_id: Option<String>,
    /// First line of what was sent, for "what you asked".
    #[serde(rename = "firstLine")]
    pub first_line: Option<String>,
    /// The session's working directory when it sent (local only).
    pub cwd: Option<String>,
    #[serde(rename = "sentAt")]
    pub sent_at: Option<f64>,
}

fn bindings_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".vibe").join("return-bindings.json")
}

/// All bindings on this machine for `me`. Missing file, unreadable file or
/// malformed JSON → an empty list: a binding is a convenience, never a claim
/// worth erroring over, and nothing here may block a thread from rendering.
#[tauri::command]
pub fn read_return_bindings(me: String) -> Vec<ReturnBinding> {
    let path = bindings_path();
    let Ok(raw) = fs::read_to_string(&path) else { return Vec::new() };
    let Ok(map) = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&raw) else { return Vec::new() };
    let mut out = Vec::new();
    for (handle, v) in map {
        let from = v.get("from").and_then(|x| x.as_str()).map(String::from);
        // Only the signed-in account's own bindings. A binding without an
        // owner is from an older package and is shown too (it could only
        // have been written by this machine's user).
        if let Some(f) = &from {
            if !f.eq_ignore_ascii_case(&me) { continue; }
        }
        out.push(ReturnBinding {
            handle: handle.to_lowercase(),
            from,
            project: v.get("project").and_then(|x| x.as_str()).map(String::from),
            message_id: v.get("messageId").and_then(|x| x.as_str()).map(String::from),
            first_line: v.get("firstLine").and_then(|x| x.as_str()).map(String::from),
            cwd: v.get("cwd").and_then(|x| x.as_str()).map(String::from),
            sent_at: v.get("sentAt").and_then(|x| x.as_f64()),
        });
    }
    out
}

/// Reveal a folder in Finder. Only an existing directory under the user's
/// home is accepted — this is "show me where the work was", not a launcher.
#[tauri::command]
pub fn reveal_in_finder(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    let canonical = p.canonicalize().map_err(|_| "that folder isn't there anymore".to_string())?;
    if !canonical.is_dir() { return Err("that isn't a folder".into()); }
    let home = dirs::home_dir().ok_or_else(|| "no home directory".to_string())?;
    let home = home.canonicalize().unwrap_or(home);
    if !canonical.starts_with(&home) { return Err("only folders in your home can be revealed".into()); }
    let status = Command::new("open").arg("-R").arg(&canonical).status().map_err(|e| format!("could not open Finder: {e}"))?;
    if status.success() { Ok(()) } else { Err("Finder did not open it".into()) }
}
