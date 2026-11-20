//! Is /vibe set up in Claude Code on this machine? READ-ONLY.
//!
//! Buddy used to install /vibe itself after sign-in, writing the MCP entry into
//! Claude Code, Codex and Cursor configs and a token-bearing ~/.vibe/config.json.
//! That drifted from the terminal package: `npx slashvibe-mcp setup` (0.9.16)
//! configures Claude Code ONLY and also installs the hooks that bring a message
//! to you while you work — an install from Buddy had the tools and none of the
//! arrival. So Buddy no longer writes any agent configuration. It only looks,
//! and when something is missing it shows the one real command to run.
//!
//! What counts as set up, mirroring what setup writes:
//!   - the `vibe` server in Claude Code's MCP config (~/.claude.json, or the
//!     desktop config when only that exists), and
//!   - the arrival hook (`arrival-hook.cjs`) referenced in Claude Code's
//!     settings.json (~/.claude/settings.json, or $CLAUDE_CONFIG_DIR).

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpStatus {
    /// Both halves present: the MCP server AND the arrival hook.
    pub installed: bool,
    /// The `vibe` MCP server entry is in Claude Code's config.
    #[serde(default)]
    pub server: bool,
    /// The arrival hook is referenced in Claude Code's settings.
    #[serde(default)]
    pub hooks: bool,
    pub npx_available: bool,
    pub config_path: Option<String>,
}

/// Is npx available on the system PATH?
pub fn check_npx_available() -> bool {
    Command::new("which")
        .arg("npx")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Claude Code's MCP config: ~/.claude.json first (Claude Code CLI), then the
/// desktop app's config. None when neither exists — nothing is created.
pub fn find_claude_config() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let cli_config = home.join(".claude.json");
    if cli_config.exists() {
        return Some(cli_config);
    }
    let desktop_config = home
        .join("Library")
        .join("Application Support")
        .join("Claude")
        .join("claude_desktop_config.json");
    if desktop_config.exists() {
        return Some(desktop_config);
    }
    None
}

/// Claude Code's settings.json, where setup installs the hooks.
fn claude_settings_path() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("CLAUDE_CONFIG_DIR") {
        if !dir.trim().is_empty() {
            return Some(PathBuf::from(dir).join("settings.json"));
        }
    }
    dirs::home_dir().map(|h| h.join(".claude").join("settings.json"))
}

/// Does an mcpServers-style JSON config carry a vibe entry?
fn json_config_has_vibe(content: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(content)
        .ok()
        .and_then(|c| c.get("mcpServers").and_then(|s| s.get("vibe")).map(|_| ()))
        .is_some()
}

/// Does a Claude Code settings.json reference the /vibe arrival hook in its
/// `hooks` section? A mention anywhere else (a comment-like string, a
/// permission) does not count.
fn settings_have_arrival_hook(content: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(content)
        .ok()
        .and_then(|c| c.get("hooks").cloned())
        .map(|hooks| hooks.to_string().contains("arrival-hook.cjs"))
        .unwrap_or(false)
}

fn read(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok()
}

/// Full status for the frontend. Reads two files and runs `which npx`.
pub fn get_mcp_status() -> McpStatus {
    let config = find_claude_config();
    let server = config.as_deref().and_then(read).map(|c| json_config_has_vibe(&c)).unwrap_or(false);
    let hooks = claude_settings_path().as_deref().and_then(read).map(|c| settings_have_arrival_hook(&c)).unwrap_or(false);
    McpStatus {
        installed: server && hooks,
        server,
        hooks,
        npx_available: check_npx_available(),
        config_path: config.map(|p| p.to_string_lossy().to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_server_entry_is_detected_and_nothing_else_counts() {
        assert!(json_config_has_vibe(r#"{"mcpServers":{"vibe":{"command":"npx"}},"theme":"dark"}"#));
        assert!(!json_config_has_vibe(r#"{"mcpServers":{"other":{}}}"#));
        assert!(!json_config_has_vibe(r#"{"vibe":{}}"#));
        assert!(!json_config_has_vibe("{ not json"));
    }

    #[test]
    fn the_arrival_hook_counts_only_inside_hooks() {
        let with = r#"{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"\"/usr/local/bin/node\" \"/Users/x/.vibe/hooks/arrival-hook.cjs\""}]}]}}"#;
        assert!(settings_have_arrival_hook(with));
        assert!(!settings_have_arrival_hook(r#"{"permissions":{"allow":["arrival-hook.cjs"]}}"#));
        assert!(!settings_have_arrival_hook(r#"{"hooks":{}}"#));
        assert!(!settings_have_arrival_hook("not json"));
    }

    #[test]
    fn this_module_writes_nothing() {
        // The installer is gone: no write, rename or create call may come back.
        let src = include_str!("mcp_setup.rs");
        let code = src.split("#[cfg(test)]").next().unwrap();
        for forbidden in ["fs::write", "fs::rename", "create_dir", "OpenOptions", "set_permissions"] {
            assert!(!code.contains(forbidden), "mcp_setup.rs must stay read-only: found {forbidden}");
        }
    }
}
