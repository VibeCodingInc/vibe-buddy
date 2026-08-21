//! Session verbs — the terminal side of "sessions are agents are bots".
//!
//! A MY SESSIONS row is a being that also lives in an iTerm tab. This module
//! gives the row its two missing verbs:
//!
//!   front — focus the tab whose claude process runs in the row's cwd
//!   place — stage a draft in that claude prompt, UNSUBMITTED
//!
//! The mechanism is deliberately boring: AppleScript enumerates iTerm
//! sessions (window id + tty + title), `ps -t <tty>` finds the foreground
//! process, `lsof` resolves its cwd. Matching row→tab happens at the moment
//! of use, never cached — tabs move, sessions end, and a stale match would
//! front (or worse, TYPE INTO) the wrong being.
//!
//! TWO LAWS, from the codex rounds on this feature:
//!
//! 1. The terminal owns the turn; Buddy owns the interval (AGENTS.md). So
//!    this module can only PLACE — `write text ... newline NO` — and no
//!    code path submits. The human presses enter in the terminal. This is
//!    the canon boundary AND the race-closure: with no newline ever
//!    written, no timing can make a shell execute a Buddy draft.
//! 2. Placement still gates on the tty's FOREGROUND process being `claude`
//!    (ps stat `+`, command is claude) — staging text at a shell prompt is
//!    inert but misleading, so "not claude in front" refuses, never falls
//!    back.
//!
//! Attribution is honest by construction: a placed draft submits as the
//! user's own prompt because the user submits it, in the terminal, with
//! their own enter key. Nothing impersonates anyone.

use serde::Serialize;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// osascript against a hung iTerm (or a pending Automation prompt) must not
/// hang Buddy's worker forever — and the commands are async + spawn_blocking
/// precisely so it never hangs the UI thread (the vibe-check extractor's
/// beach-ball lesson, main.rs:148).
const OSA_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct TerminalSession {
    /// Which terminal owns this session — the two verbs are not equally
    /// supported, so the host is part of the session's identity here.
    pub app: String,
    /// Can a draft be PLACED here without being submitted?
    ///
    /// iTerm2 can (`write text ... newline NO`). Terminal.app cannot: its
    /// only scripting verb is `do script`, which RUNS what you give it —
    /// there is no inert placement, and Buddy never submits on someone's
    /// behalf. So the draft verb is hidden there rather than degraded into
    /// something that presses enter for you.
    pub can_place: bool,
    /// Window id — needed to focus the right window.
    pub window_id: String,
    /// The tty (e.g. "/dev/ttys008") — the stable join key for ps/lsof.
    pub tty: String,
    /// The tab's title as iTerm shows it (often the agent's name).
    pub name: String,
    /// The claude process's working directory, when one is running here.
    pub cwd: Option<String>,
    /// True when a `claude` process is the tty's FOREGROUND process — the
    /// precondition for `write`. False means "visible but not writable".
    pub claude_foreground: bool,
}

const ENUMERATE_ITERM: &str = r#"if application "iTerm2" is running then
tell application "iTerm2"
  set out to ""
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        set out to out & (id of w) & "|" & (tty of s) & "|" & (name of s) & linefeed
      end repeat
    end repeat
  end repeat
  return out
end tell
else
  return ""
end if"#;

/// Terminal.app's model is flatter: a tab IS the session and carries the tty.
/// Guarded by `is running` so merely ASKING never launches an app the user
/// did not open.
const ENUMERATE_APPLE_TERMINAL: &str = r#"if application "Terminal" is running then
  tell application "Terminal"
    set out to ""
    repeat with w in windows
      repeat with t in tabs of w
        try
          set out to out & (id of w) & "|" & (tty of t) & "|" & (processes of t as string) & linefeed
        end try
      end repeat
    end repeat
    return out
  end tell
else
  return ""
end if"#;

/// `host` is the app the script talks to, and it exists purely so failures
/// name the right one: telling somebody to allow control of iTerm when it was
/// Terminal that macOS blocked sends them to the wrong switch (codex r2 P2).
fn osascript(script: &str, host: &str) -> Result<String, String> {
    use std::io::Read;
    let mut child = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run osascript: {e}"))?;
    let deadline = Instant::now() + OSA_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "{host} didn't answer within 10s — it may be showing a macOS \
                     Automation permission prompt, or be unresponsive"
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(40)),
            Err(e) => return Err(format!("osascript wait failed: {e}")),
        }
    };
    let mut stdout = String::new();
    let mut stderr = String::new();
    if let Some(mut s) = child.stdout.take() { let _ = s.read_to_string(&mut stdout); }
    if let Some(mut s) = child.stderr.take() { let _ = s.read_to_string(&mut stderr); }
    let output_ok = status.success();
    if !output_ok {
        let err = stderr;
        // -1743 is macOS's "not permitted to automate" — the one error the
        // user can actually fix, so name the fix.
        if err.contains("-1743") {
            return Err(format!(
                "macOS blocked Buddy from controlling {host} — allow it in \
                 System Settings → Privacy & Security → Automation"
            ));
        }
        return Err(format!("{host} didn't answer: {}", err.trim()));
    }
    Ok(stdout)
}

/// Parse the enumeration script's `window|tty|title` lines.
fn parse_enumeration(raw: &str) -> Vec<(String, String, String)> {
    raw.lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '|');
            match (parts.next(), parts.next(), parts.next()) {
                (Some(w), Some(tty), Some(name)) if tty.starts_with("/dev/tty") => {
                    Some((w.trim().to_string(), tty.trim().to_string(), name.trim().to_string()))
                }
                _ => None,
            }
        })
        .collect()
}

/// "/dev/ttys008" → "s008", the form `ps -t` wants.
fn tty_short(tty: &str) -> &str {
    tty.strip_prefix("/dev/tty").unwrap_or(tty)
}

/// Find the foreground `claude` pid on a tty, if any. The `+` in ps's stat
/// column marks the foreground process group — the difference between
/// typing into claude and typing into a shell.
fn foreground_claude_pid(tty: &str) -> Option<u32> {
    let output = Command::new("ps")
        .args(["-t", tty_short(tty), "-o", "pid=,stat=,command="])
        .output()
        .ok()?;
    parse_foreground_claude(&String::from_utf8_lossy(&output.stdout))
}

fn parse_foreground_claude(ps_output: &str) -> Option<u32> {
    for line in ps_output.lines() {
        let mut cols = line.split_whitespace();
        let pid = cols.next()?.parse::<u32>().ok()?;
        let stat = cols.next()?;
        let command = cols.next().unwrap_or("");
        // Foreground (`+`), and the command IS claude — not an MCP child
        // like `npm exec slashvibe-mcp` that happens to share the tty.
        if stat.contains('+') && (command == "claude" || command.ends_with("/claude")) {
            return Some(pid);
        }
    }
    None
}

fn cwd_of_pid(pid: u32) -> Option<String> {
    let output = Command::new("lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
        .output()
        .ok()?;
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find(|l| l.starts_with('n'))
        .map(|l| l[1..].to_string())
}

/// Enumerate iTerm sessions with their claude cwd, at the moment of asking.
/// Async + spawn_blocking: AppleScript then per-tab ps/lsof is real wall time,
/// and a sync command would beach-ball the WebView (main.rs:148 lesson).
#[tauri::command]
pub async fn terminal_sessions() -> Result<TerminalScan, String> {
    tauri::async_runtime::spawn_blocking(terminal_sessions_blocking)
        .await
        .map_err(|e| format!("worker died: {e}"))?
}

/// Sessions AND what went wrong getting them. Two hosts are asked, so success
/// is not binary: a denied Automation permission on Terminal used to vanish
/// the moment iTerm returned a single tab, leaving the person's Terminal
/// sessions simply absent with nothing to fix (codex r2 P2). A warning is not
/// an error — the list is still usable — but it must survive to the surface.
#[derive(Debug, Clone, Serialize)]
pub struct TerminalScan {
    pub sessions: Vec<TerminalSession>,
    pub warnings: Vec<String>,
}

fn terminal_sessions_blocking() -> Result<TerminalScan, String> {
    let mut out: Vec<TerminalSession> = Vec::new();
    let mut errors: Vec<String> = Vec::new();

    // Both hosts are asked, and neither is LAUNCHED by asking (the scripts
    // are guarded by `is running`) — enumerating your sessions must never
    // open an app you had closed.
    for (app, script, can_place) in [
        ("iTerm2", ENUMERATE_ITERM, true),
        ("Terminal", ENUMERATE_APPLE_TERMINAL, false),
    ] {
        match osascript(script, app) {
            Ok(raw) => {
                for (window_id, tty, name) in parse_enumeration(&raw) {
                    let pid = foreground_claude_pid(&tty);
                    let cwd = pid.and_then(cwd_of_pid);
                    out.push(TerminalSession {
                        app: app.to_string(),
                        can_place,
                        window_id,
                        tty,
                        name,
                        cwd,
                        claude_foreground: pid.is_some(),
                    });
                }
            }
            // One unhappy host must not blind us to the other.
            Err(e) => errors.push(format!("{app}: {e}")),
        }
    }

    // Nothing at all AND something broke: that is a failure, not an empty
    // desk, and it gets the loud path. Anything else keeps the warnings
    // attached to the results they are incomplete relative to.
    if out.is_empty() && !errors.is_empty() {
        return Err(errors.join(" · "));
    }
    Ok(TerminalScan { sessions: out, warnings: errors })
}

/// AppleScript string literal: backslashes then quotes, nothing else changes.
fn applescript_escape(text: &str) -> String {
    text.replace('\\', "\\\\").replace('"', "\\\"")
}

fn focus_script_iterm(tty: &str) -> String {
    format!(
        r#"tell application "iTerm2"
  activate
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if (tty of s) is "{tty}" then
          select w
          select t
          select s
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
  return "gone"
end tell"#,
        tty = applescript_escape(tty)
    )
}

/// Terminal.app: select the tab, raise its window, bring the app forward.
fn focus_script_apple(tty: &str) -> String {
    format!(
        r#"tell application "Terminal"
  activate
  repeat with w in windows
    repeat with t in tabs of w
      if (tty of t) is "{tty}" then
        set selected of t to true
        set frontmost of w to true
        return "ok"
      end if
    end repeat
  end repeat
  return "gone"
end tell"#,
        tty = applescript_escape(tty)
    )
}

fn focus_script(tty: &str, app: &str) -> String {
    if app == "Terminal" { focus_script_apple(tty) } else { focus_script_iterm(tty) }
}

/// Bring the tab holding `tty` to the front.
#[tauri::command]
pub async fn front_terminal_session(tty: String, app: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let host = app.unwrap_or_else(|| "iTerm2".to_string());
        let result = osascript(&focus_script(&tty, &host), &host)?;
        if result.trim() == "ok" {
            Ok(())
        } else {
            Err("that tab is gone — the session list was stale, refresh and retry".into())
        }
    })
    .await
    .map_err(|e| format!("worker died: {e}"))?
}

/// Place the text WITHOUT submitting (`newline NO`). Wherever it lands —
/// claude's input or, if claude just died, a shell prompt — it is inert:
/// nothing executes without a newline, and THIS MODULE NEVER SENDS ONE.
fn write_text_script(tty: &str, text: &str) -> String {
    format!(
        r#"tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if (tty of s) is "{tty}" then
          tell s to write text "{text}" newline NO
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
  return "gone"
end tell"#,
        tty = applescript_escape(tty),
        text = applescript_escape(text)
    )
}

/// Place `text` into the claude prompt on `tty` WITHOUT submitting it.
///
/// This is the canon-shaped verb (codex r2): the terminal owns the turn and
/// Buddy owns the interval, so Buddy STAGES a turn and the human submits it
/// by pressing enter in the terminal. No newline is ever written by this
/// module — which also removes the entire submit-race class by construction:
/// the worst any timing can produce is inert text sitting at a prompt.
///
/// The foreground-claude gate still applies — placing text into a shell
/// prompt would be inert but misleading, so "not claude in front" refuses.
#[tauri::command]
pub async fn place_in_terminal_session(
    tty: String,
    text: String,
    app: Option<String>,
) -> Result<(), String> {
    // Terminal.app's only scripting verb RUNS what it is given. Placing an
    // inert draft is impossible there, and submitting on the operator's
    // behalf is the one thing this module will not do — so it refuses in
    // words rather than quietly doing something else.
    if app.as_deref() == Some("Terminal") {
        return Err(
            "Terminal.app can only run a line, not hold it — Buddy won't press enter for you. Open the session and type there, or use iTerm."
                .into(),
        );
    }
    tauri::async_runtime::spawn_blocking(move || place_text(&tty, &text))
        .await
        .map_err(|e| format!("worker died: {e}"))?
}

fn place_text(tty: &str, text: &str) -> Result<(), String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("nothing to place".into());
    }
    if trimmed.contains('\n') {
        // In `write text ... newline NO`, an embedded newline is still a
        // submission. One draft, one line — the guarantee depends on it.
        return Err("one line at a time — a newline would submit, and submitting is yours to do".into());
    }
    if foreground_claude_pid(tty).is_none() {
        return Err(
            "claude isn't in the foreground on that tab — refusing to type at whatever is"
                .into(),
        );
    }
    let placed = osascript(&write_text_script(tty, trimmed), "iTerm2")?;
    if placed.trim() == "ok" {
        Ok(())
    } else {
        Err("that tab is gone — the session list was stale, refresh and retry".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enumeration_parses_window_tty_and_title_with_pipes_in_title() {
        let raw = "9159|/dev/ttys008|✳ URIEL (node)\n9159|/dev/ttys001|IP | ESTATE\nnoise\n";
        let parsed = parse_enumeration(raw);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0], ("9159".into(), "/dev/ttys008".into(), "✳ URIEL (node)".into()));
        // splitn(3) keeps a title's own pipes intact.
        assert_eq!(parsed[1].2, "IP | ESTATE");
    }

    #[test]
    fn foreground_gate_requires_both_the_plus_and_the_claude() {
        // Real shape from the prototype run: shell background, claude foreground,
        // MCP children also foreground-grouped. Only the claude row may win.
        let ps = "55075 Ss   login -fp yourname\n55076 S    -zsh\n55096 S+   claude\n55111 S+   npm\n";
        assert_eq!(parse_foreground_claude(ps), Some(55096));
        // claude present but BACKGROUNDED (ctrl-z): the gate must refuse —
        // the shell would eat the write.
        let bg = "55076 S+   -zsh\n55096 S    claude\n";
        assert_eq!(parse_foreground_claude(bg), None);
        // No claude at all.
        assert_eq!(parse_foreground_claude("1 S+ -zsh\n"), None);
    }

    #[test]
    fn a_path_qualified_claude_still_counts() {
        assert_eq!(
            parse_foreground_claude("77 S+ /opt/homebrew/bin/claude\n"),
            Some(77)
        );
        // ...but a command merely CONTAINING claude does not (claude-tail,
        // an editor open on claude.md, etc. must never receive keystrokes).
        assert_eq!(parse_foreground_claude("78 S+ vim claude.md\n"), None);
        assert_eq!(parse_foreground_claude("79 S+ claude-tail\n"), None);
    }

    #[test]
    fn applescript_escaping_covers_quotes_and_backslashes() {
        assert_eq!(applescript_escape(r#"say "hi" \ bye"#), r#"say \"hi\" \\ bye"#);
    }

    #[test]
    fn placement_is_inert_by_construction_no_newline_exists_anywhere() {
        // The canon-shaped guarantee: this module can only PLACE. The one
        // script writes with `newline NO`, and no script submits — so no
        // timing can ever make a shell execute a Buddy draft.
        let place = write_text_script("/dev/ttys008", "hello");
        assert!(place.contains(r#"write text "hello" newline NO"#));
    }

    #[test]
    fn tty_short_strips_the_dev_prefix_ps_rejects() {
        assert_eq!(tty_short("/dev/ttys008"), "s008");
        assert_eq!(tty_short("s008"), "s008");
    }
}
