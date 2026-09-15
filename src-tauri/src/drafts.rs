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
    pub definite: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscardOutcome {
    pub id: String,
    pub status: Option<String>,
    pub display: Option<String>,
}

/// The installed package's draft CLI, or None. Newest pinned version wins.
fn draft_cli() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let npx = home.join(".npm").join("_npx");
    let mut best: Option<(String, PathBuf)> = None;
    for entry in std::fs::read_dir(&npx).ok()?.flatten() {
        let pkg = entry.path().join("node_modules").join("slashvibe-mcp");
        let cli = pkg.join("draft-cli.js");
        if !cli.exists() { continue; }
        let version = std::fs::read_to_string(pkg.join("package.json")).ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .and_then(|v| v.get("version").and_then(|x| x.as_str()).map(String::from))
            .unwrap_or_default();
        if best.as_ref().map(|(v, _)| version > *v).unwrap_or(true) { best = Some((version, cli)); }
    }
    best.map(|(_, p)| p)
}

fn node() -> String {
    for c in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] {
        if std::path::Path::new(c).exists() { return c.to_string(); }
    }
    "node".to_string()
}

/// Run one verb. The CLI prints exactly one JSON object on stdout; stderr is logs.
fn run(args: &[&str]) -> Result<serde_json::Value, String> {
    let cli = draft_cli().ok_or_else(|| "the terminal package is not installed here".to_string())?;
    let out = Command::new(node()).arg(&cli).args(args).output().map_err(|e| format!("could not run the terminal package: {e}"))?;
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
        serde_json::from_value(v).map_err(|e| e.to_string())
    }).await.map_err(|e| format!("worker died: {e}"))?
}

/// Discard here = discarded everywhere.
#[tauri::command]
pub async fn discard_terminal_draft(id: String) -> Result<DiscardOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let v = run(&["discard", &id])?;
        serde_json::from_value(v).map_err(|e| e.to_string())
    }).await.map_err(|e| format!("worker died: {e}"))?
}
