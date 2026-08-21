//! MCP auto-install for Vibe Buddy
//!
//! After OAuth login, automatically configures the /vibe MCP server in every
//! MCP-speaking coding agent on the machine — Claude Code (always), Codex and
//! Cursor (when installed) — so the user gets terminal integration without
//! manual setup. Mirrors the npx `slashvibe-mcp setup` semantics, including
//! its safety rules:
//!   - a corrupt-but-recoverable JSON config is NEVER overwritten
//!   - Codex's config.toml is detected section-aware (quoted/spaced headers,
//!     sub-tables, inline tables; commented-out headers don't count) and only
//!     ever appended to
//!   - hosts are configured independently; one failure doesn't block the rest

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpStatus {
    pub installed: bool,
    pub npx_available: bool,
    pub config_path: Option<String>,
    /// Host agents with /vibe configured, e.g. ["Claude Code", "Codex"].
    #[serde(default)]
    pub hosts: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpInstallResult {
    pub success: bool,
    pub message: String,
    pub config_path: Option<String>,
}

/// One host's install outcome.
struct HostResult {
    host: &'static str,
    path: PathBuf,
    status: Result<&'static str, String>, // Ok("added"|"exists") | Err(reason)
}

fn vibe_server_entry() -> serde_json::Value {
    serde_json::json!({
        "command": "npx",
        "args": ["-y", "slashvibe-mcp@latest"],
        "env": {
            "VIBE_API_URL": "https://www.slashvibe.dev"
        }
    })
}

/// Check if npx is available on the system PATH
pub fn check_npx_available() -> bool {
    Command::new("which")
        .arg("npx")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Find the Claude config file. Checks ~/.claude.json first (Claude Code CLI),
/// then ~/Library/Application Support/Claude/claude_desktop_config.json (desktop app).
pub fn find_claude_config() -> Option<PathBuf> {
    let home = dirs::home_dir()?;

    // Primary: Claude Code CLI config
    let cli_config = home.join(".claude.json");
    if cli_config.exists() {
        return Some(cli_config);
    }

    // Secondary: Claude Desktop app config
    let desktop_config = home
        .join("Library")
        .join("Application Support")
        .join("Claude")
        .join("claude_desktop_config.json");
    if desktop_config.exists() {
        return Some(desktop_config);
    }

    // If neither exists, default to creating ~/.claude.json
    Some(cli_config)
}

/// Codex home honors $CODEX_HOME (custom-home installs) before ~/.codex.
/// Note: GUI apps don't inherit shell exports, so the env var only matters
/// when Buddy is launched from a terminal — the ~/.codex fallback is the
/// common path.
fn codex_home() -> Option<PathBuf> {
    if let Ok(custom) = std::env::var("CODEX_HOME") {
        if !custom.is_empty() {
            return Some(PathBuf::from(custom));
        }
    }
    dirs::home_dir().map(|h| h.join(".codex"))
}

fn cursor_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".cursor"))
}

// ─── JSON hosts (Claude Code, Cursor) ────────────────────────────────────

/// Does an mcpServers-style JSON config already carry a vibe entry?
fn json_config_has_vibe(config_path: &Path) -> bool {
    let content = match fs::read_to_string(config_path) {
        Ok(c) => c,
        Err(_) => return false,
    };
    let config: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return false,
    };
    config
        .get("mcpServers")
        .and_then(|s| s.get("vibe"))
        .is_some()
}

/// Add vibe to an mcpServers-style JSON config, preserving everything else.
/// Refuses to touch a file that exists but isn't valid JSON (or whose root
/// isn't an object) — overwriting would destroy whatever else lives there
/// (~/.claude.json holds far more than mcpServers).
fn install_json_host(config_path: &Path) -> Result<&'static str, String> {
    let mut config: serde_json::Value = if config_path.exists() {
        let content =
            fs::read_to_string(config_path).map_err(|e| format!("read failed: {}", e))?;
        serde_json::from_str(&content)
            .map_err(|_| "existing config is not valid JSON — fix it by hand".to_string())?
    } else {
        serde_json::json!({})
    };

    if !config.is_object() {
        return Err("existing config root is not a JSON object".to_string());
    }

    if config.get("mcpServers").is_none() {
        config["mcpServers"] = serde_json::json!({});
    }
    if !config["mcpServers"].is_object() {
        return Err("mcpServers is not a JSON object".to_string());
    }
    if config["mcpServers"].get("vibe").is_some() {
        return Ok("exists");
    }

    config["mcpServers"]["vibe"] = vibe_server_entry();

    let json = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("serialize failed: {}", e))?;
    atomic_write(config_path, &json)?;
    Ok("added")
}

// ─── Codex (config.toml) ─────────────────────────────────────────────────

/// Does a Codex config.toml already declare a vibe MCP server, in any of the
/// spellings TOML allows? Line-based, section-aware scan — no TOML dependency:
///   [mcp_servers.vibe]        [mcp_servers . "vibe"]      (header forms)
///   [mcp_servers.vibe.env]                                 (sub-tables)
///   vibe = { ... } inside [mcp_servers]                    (inline table)
/// A commented-out header (# [mcp_servers.vibe]) does NOT count.
fn codex_config_has_vibe(toml: &str) -> bool {
    let mut section = String::new();
    for raw in toml.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') {
            if let Some(end) = line.find(']') {
                // Normalize: strip quotes and whitespace around dots
                section = line[1..end]
                    .split('.')
                    .map(|p| p.trim().trim_matches('"'))
                    .collect::<Vec<_>>()
                    .join(".");
                if section == "mcp_servers.vibe" || section.starts_with("mcp_servers.vibe.") {
                    return true;
                }
            }
            continue;
        }
        if section == "mcp_servers" {
            if let Some(eq) = line.find('=') {
                let key = line[..eq].trim().trim_matches('"');
                if key == "vibe" {
                    return true;
                }
            }
        }
    }
    false
}

/// Append our [mcp_servers.vibe] block to Codex's config.toml. Append-only:
/// we never rewrite existing content, and skip if a vibe entry exists in any
/// form.
fn install_codex_host(config_path: &Path) -> Result<&'static str, String> {
    let existing = if config_path.exists() {
        fs::read_to_string(config_path).map_err(|e| format!("read failed: {}", e))?
    } else {
        String::new()
    };

    if codex_config_has_vibe(&existing) {
        return Ok("exists");
    }

    let mut out = existing.clone();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(
        "\n[mcp_servers.vibe]\n\
         command = \"npx\"\n\
         args = [\"-y\", \"slashvibe-mcp@latest\"]\n\
         \n\
         [mcp_servers.vibe.env]\n\
         VIBE_API_URL = \"https://www.slashvibe.dev\"\n",
    );

    atomic_write(config_path, &out)?;
    Ok("added")
}

// ─── Shared ──────────────────────────────────────────────────────────────

/// Write via temp file + rename in the target's directory; falls back to a
/// direct write if rename fails (cross-device).
fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "config".to_string());
    let temp_path = dir.join(format!(".{}.vibe-tmp", file_name));

    fs::write(&temp_path, content).map_err(|e| format!("temp write failed: {}", e))?;
    if let Err(rename_err) = fs::rename(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        fs::write(path, content)
            .map_err(|e| format!("write failed: {} / {}", rename_err, e))?;
    }
    Ok(())
}

/// Configure every detected host. Claude Code always; Codex and Cursor only
/// when their config dirs exist (i.e. they're installed).
fn install_all_hosts() -> Vec<HostResult> {
    let mut results = Vec::new();

    if let Some(claude_path) = find_claude_config() {
        let status = install_json_host(&claude_path);
        results.push(HostResult { host: "Claude Code", path: claude_path, status });
    }

    if let Some(codex) = codex_home() {
        if codex.exists() {
            let config_path = codex.join("config.toml");
            let status = install_codex_host(&config_path);
            results.push(HostResult { host: "Codex", path: config_path, status });
        }
    }

    if let Some(cursor) = cursor_dir() {
        if cursor.exists() {
            let config_path = cursor.join("mcp.json");
            let status = install_json_host(&config_path);
            results.push(HostResult { host: "Cursor", path: config_path, status });
        }
    }

    results
}

/// Which hosts currently have /vibe configured (for status display).
fn configured_hosts() -> Vec<String> {
    let mut hosts = Vec::new();

    if let Some(claude_path) = find_claude_config() {
        if json_config_has_vibe(&claude_path) {
            hosts.push("Claude Code".to_string());
        }
    }
    if let Some(codex) = codex_home() {
        let config_path = codex.join("config.toml");
        if let Ok(content) = fs::read_to_string(&config_path) {
            if codex_config_has_vibe(&content) {
                hosts.push("Codex".to_string());
            }
        }
    }
    if let Some(cursor) = cursor_dir() {
        if json_config_has_vibe(&cursor.join("mcp.json")) {
            hosts.push("Cursor".to_string());
        }
    }

    hosts
}

/// Check if the vibe MCP server is configured for Claude Code (the primary
/// host — kept as the meaning of `installed` for frontend compatibility).
pub fn check_mcp_installed() -> bool {
    match find_claude_config() {
        Some(p) => json_config_has_vibe(&p),
        None => false,
    }
}

/// Install the vibe MCP server into every detected coding agent.
pub fn install_mcp() -> McpInstallResult {
    if !check_npx_available() {
        return McpInstallResult {
            success: false,
            message: "Node.js not found — install from nodejs.org".to_string(),
            config_path: None,
        };
    }

    let results = install_all_hosts();
    if results.is_empty() {
        return McpInstallResult {
            success: false,
            message: "Could not determine any host config path".to_string(),
            config_path: None,
        };
    }

    let mut ok_hosts: Vec<&str> = Vec::new();
    let mut failures: Vec<String> = Vec::new();
    let mut claude_path: Option<String> = None;

    for r in &results {
        match &r.status {
            Ok(_) => {
                ok_hosts.push(r.host);
                if r.host == "Claude Code" {
                    claude_path = Some(r.path.to_string_lossy().to_string());
                }
                eprintln!("[MCP] {} configured at {}", r.host, r.path.display());
            }
            Err(reason) => {
                failures.push(format!("{}: {}", r.host, reason));
                eprintln!("[MCP] {} FAILED: {}", r.host, reason);
            }
        }
    }

    if ok_hosts.is_empty() {
        return McpInstallResult {
            success: false,
            message: format!("MCP setup failed — {}", failures.join("; ")),
            config_path: None,
        };
    }

    // Also write ~/.vibe/config.json with identity if it doesn't exist
    write_vibe_config_if_needed();

    let mut message = format!(
        "MCP configured for {} — restart to activate",
        ok_hosts.join(", ")
    );
    if !failures.is_empty() {
        message.push_str(&format!(" ({})", failures.join("; ")));
    }

    McpInstallResult {
        success: true,
        message,
        config_path: claude_path,
    }
}

/// Write ~/.vibe/config.json with handle + authToken if it doesn't already exist.
/// This gives the MCP server identity context on first run.
fn write_vibe_config_if_needed() {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return,
    };

    let config_path = home.join(".vibe").join("config.json");

    // Don't overwrite if it already exists
    if config_path.exists() {
        return;
    }

    // Read auth to get handle and token
    let auth_path = home.join(".vibe").join("auth.json");
    if !auth_path.exists() {
        return;
    }

    let auth_content = match fs::read_to_string(&auth_path) {
        Ok(c) => c,
        Err(_) => return,
    };

    let auth: HashMap<String, serde_json::Value> = match serde_json::from_str(&auth_content) {
        Ok(v) => v,
        Err(_) => return,
    };

    let handle = auth.get("handle").and_then(|v| v.as_str()).unwrap_or("");
    let token = auth.get("token").and_then(|v| v.as_str()).unwrap_or("");

    if handle.is_empty() || token.is_empty() {
        return;
    }

    let vibe_config = serde_json::json!({
        "handle": handle,
        "authToken": token,
        "apiUrl": "https://www.slashvibe.dev"
    });

    if let Ok(json) = serde_json::to_string_pretty(&vibe_config) {
        let _ = fs::write(&config_path, json);
    }
}

/// Get full MCP status for the frontend
pub fn get_mcp_status() -> McpStatus {
    let npx = check_npx_available();
    let installed = check_mcp_installed();
    let config_path = find_claude_config().map(|p| p.to_string_lossy().to_string());
    let hosts = configured_hosts();

    McpStatus {
        installed,
        npx_available: npx,
        config_path,
        hosts,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toml_detection_matches_setup_js_cases() {
        // Mirrors the 8 cases verified against setup.js's codexConfigHasVibe.
        assert!(codex_config_has_vibe("[mcp_servers.vibe]\ncommand = \"npx\""));
        assert!(codex_config_has_vibe("[mcp_servers . \"vibe\"]"));
        assert!(codex_config_has_vibe("[mcp_servers.vibe.env]"));
        assert!(codex_config_has_vibe("[mcp_servers]\nvibe = { command = \"npx\" }"));
        assert!(!codex_config_has_vibe("# [mcp_servers.vibe]\n[mcp_servers.other]"));
        assert!(!codex_config_has_vibe("[mcp_servers.vibrant]"));
        assert!(!codex_config_has_vibe("[other]\nvibe = 1"));
        assert!(!codex_config_has_vibe(""));
    }

    #[test]
    fn corrupt_json_is_never_overwritten() {
        let dir = std::env::temp_dir().join(format!("vibe-mcp-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("corrupt.json");
        fs::write(&path, "{ not json").unwrap();
        let result = install_json_host(&path);
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{ not json");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn json_install_preserves_existing_entries() {
        let dir = std::env::temp_dir().join(format!("vibe-mcp-test2-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        fs::write(&path, r#"{"mcpServers":{"other":{"command":"x"}},"theme":"dark"}"#).unwrap();
        assert_eq!(install_json_host(&path).unwrap(), "added");
        let after: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert!(after["mcpServers"]["other"].is_object());
        assert!(after["mcpServers"]["vibe"].is_object());
        assert_eq!(after["theme"], "dark");
        assert_eq!(install_json_host(&path).unwrap(), "exists");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn codex_append_is_idempotent_and_preserves_content() {
        let dir = std::env::temp_dir().join(format!("vibe-mcp-test3-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.toml");
        fs::write(&path, "model = \"gpt-5.6-sol\"\n").unwrap();
        assert_eq!(install_codex_host(&path).unwrap(), "added");
        let after = fs::read_to_string(&path).unwrap();
        assert!(after.starts_with("model = \"gpt-5.6-sol\"\n"));
        assert!(codex_config_has_vibe(&after));
        assert_eq!(install_codex_host(&path).unwrap(), "exists");
        let _ = fs::remove_dir_all(&dir);
    }
}
