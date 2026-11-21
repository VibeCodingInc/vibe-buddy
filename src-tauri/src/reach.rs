//! The terminal's reach settings, read by Buddy — never written.
//!
//! slashvibe-mcp keeps "who may reach you while you work" in
//! `~/.vibe/reach.json` (reach.js), changed only by commands the person types:
//! `npx slashvibe-mcp invisible | visible | quiet | unquiet | mute @h | unmute @h`.
//! Buddy honours three of them so the two surfaces never contradict each other:
//!   - invisible → Buddy sends no presence heartbeats;
//!   - quiet     → no notifications about people;
//!   - muted[h]  → no notification from that person.
//!
//! Scope of this command, deliberately narrow: ONE fixed path, read-only, no
//! arguments from the webview, a size cap, and no error surface. A missing,
//! unreadable, oversized or malformed file is the defaults (nothing hidden,
//! nothing muted) — exactly what reach.js itself does on a bad read.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// reach.json holds a handful of handles; anything past this is not ours to parse.
const MAX_REACH_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct ReachPrefs {
    /// False when there was no readable file — the UI may say nothing at all.
    pub present: bool,
    pub quiet: bool,
    pub invisible: bool,
    /// Handles as the terminal stored them (trimmed, '@'-less, lowercased by
    /// reach.norm). Canonical comparison ('-' vs '_') is the reader's job.
    pub muted: Vec<String>,
}

fn reach_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".vibe").join("reach.json"))
}

/// Same truth table as reach.js `read()`: only a literal `true` turns a flag
/// on; `muted` counts only when it is an object; its keys are the handles.
pub fn parse_reach(text: &str) -> ReachPrefs {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else { return ReachPrefs::default() };
    let Some(o) = v.as_object() else { return ReachPrefs::default() };
    let mut muted: Vec<String> = o
        .get("muted")
        .and_then(|m| m.as_object())
        .map(|m| m.keys().map(|k| k.trim().trim_start_matches('@').to_lowercase()).filter(|k| !k.is_empty()).collect())
        .unwrap_or_default();
    muted.sort();
    muted.dedup();
    ReachPrefs {
        present: true,
        quiet: o.get("quiet") == Some(&serde_json::Value::Bool(true)),
        invisible: o.get("invisible") == Some(&serde_json::Value::Bool(true)),
        muted,
    }
}

pub fn read_reach_at(path: &Path) -> ReachPrefs {
    let Ok(meta) = fs::metadata(path) else { return ReachPrefs::default() };
    if !meta.is_file() || meta.len() > MAX_REACH_BYTES {
        return ReachPrefs::default();
    }
    match fs::read_to_string(path) {
        Ok(text) => parse_reach(&text),
        Err(_) => ReachPrefs::default(),
    }
}

/// Read `~/.vibe/reach.json`. Async + spawn_blocking so a slow disk never
/// stalls the UI thread.
#[tauri::command]
pub async fn read_reach_prefs() -> ReachPrefs {
    tauri::async_runtime::spawn_blocking(|| reach_path().map(|p| read_reach_at(&p)).unwrap_or_default())
        .await
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_terminal_format_reads_as_written() {
        let r = parse_reach(r#"{"quiet":false,"invisible":true,"muted":{"sam":1763600000000,"a-b":1},"known":{"x":1}}"#);
        assert!(r.present);
        assert!(r.invisible);
        assert!(!r.quiet);
        assert_eq!(r.muted, vec!["a-b".to_string(), "sam".to_string()]);
    }

    #[test]
    fn only_a_literal_true_turns_a_flag_on() {
        let r = parse_reach(r#"{"quiet":"yes","invisible":1}"#);
        assert!(!r.quiet && !r.invisible);
        assert!(r.present);
    }

    #[test]
    fn malformed_shapes_are_the_defaults() {
        assert_eq!(parse_reach("not json"), ReachPrefs::default());
        assert_eq!(parse_reach("[1,2]"), ReachPrefs::default());
        let r = parse_reach(r#"{"muted":["sam"]}"#);
        assert!(r.muted.is_empty());
    }

    #[test]
    fn a_missing_file_or_a_directory_is_the_defaults_not_an_error() {
        let dir = std::env::temp_dir().join(format!("buddy-reach-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        assert_eq!(read_reach_at(&dir.join("absent.json")), ReachPrefs::default());
        assert_eq!(read_reach_at(&dir), ReachPrefs::default());
        let f = dir.join("reach.json");
        fs::write(&f, r#"{"quiet":true}"#).unwrap();
        assert!(read_reach_at(&f).quiet);
        let _ = fs::remove_dir_all(&dir);
    }
}
