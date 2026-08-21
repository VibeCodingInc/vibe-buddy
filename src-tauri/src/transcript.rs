//! What a local coding session looks like it is doing — read from its own
//! transcript, claimed no harder than the evidence allows.
//!
//! The operator's scarcest resource is knowing which of a dozen sessions
//! wants him. Claude Code writes a JSONL transcript per session under
//! `~/.claude/projects/<encoded-cwd>/<session>.jsonl`, and that file can
//! distinguish "waiting on you" from "working" from "we cannot tell".
//!
//! THE LAWS (from the codex challenge review, 2026-08-14, canon ce3dc221):
//!
//! 1. **Unknown-first.** Every label states the EVIDENCE, never a diagnosis.
//!    An unmatched tool call is "a tool call has no recorded result" — it is
//!    NOT "permission prompt pending"; the same shape is produced by a long
//!    tool, an API hang, or a crash. Buddy never names a cause it cannot see.
//! 2. **Structural markers only.** Never text-match the transcript for
//!    "rate limit" or "login": in this operator's own sessions, prose about
//!    rate limits outnumbers real API errors ~33:1 (measured 2026-08-14), so
//!    a text scan is a false-positive machine. Only `isApiErrorMessage`
//!    counts, and even then the label says "recent API error", not "stalled".
//! 3. **Privacy is structural, not careful.** This module returns state,
//!    confidence, timestamps and a tool NAME. No prompt text, no tool input,
//!    no output, no file paths from the conversation, ever — not to the
//!    frontend, not to logs, and never anywhere near the network. Presence
//!    consent is not transcript consent (CLAUDE.md kill switch 0c).
//! 4. **Version-gated.** The JSONL shape is a Claude Code internal, not a
//!    contract. Records carry `version`; anything outside the tested range
//!    degrades to Unknown{unrecognized version} rather than guessing.
//! 5. **A noisy queue is the same defeat as no queue.** When in doubt this
//!    module returns Unknown, and the UI says so plainly.

use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

/// Records at or below this Claude Code minor were the ones whose shapes the
/// fixtures were built from (observed 2.1.224–2.1.232). A transcript whose
/// newest record is outside this range is not classified — the format is an
/// internal, and a silently-changed shape must read as "cannot see", never as
/// a confident state.
/// The transcript family this classifier was taught. A MAJOR or MINOR bump is
/// a real signal that the format may have moved, so it degrades to unknown.
///
/// The patch number deliberately does NOT gate: a fixed ceiling proved to be
/// the wrong instrument twice. Too generous, it classifies a changed format
/// confidently (codex r1); pinned to the last version in the corpus, it
/// switched the whole feature off for the CURRENT release the same day
/// (codex r2 — 2.1.233 shipped while the cap said 232). Both failures come
/// from checking a version number as a proxy for the shape. So we check the
/// SHAPE ITSELF, below, and let the patch number alone mean nothing.
const KNOWN_MAJOR_MINOR: (u32, u32) = (2, 1);

/// Records read from the tail. Enough to pair a tool call with its result
/// across a long thinking stretch, bounded so a multi-GB transcript cannot
/// stall a scan.
const TAIL_RECORDS: usize = 200;
const MAX_TAIL_BYTES: u64 = 4 * 1024 * 1024;

/// What the transcript shows, in the words the UI is allowed to use.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SessionSignal {
    /// No transcript, unreadable, or a version we have not tested against.
    Unknown { why: String },
    /// The last thing in the thread is the assistant finishing its turn: the
    /// session is not working and nobody has replied. The closest thing to
    /// "wants you" that evidence supports.
    AwaitingYou { idle_seconds: u64 },
    /// A tool call has no recorded result. Cause unknown by construction —
    /// permission prompt, long-running tool, API hang, or a dead process all
    /// produce exactly this shape.
    ToolNoResult { tool: String, idle_seconds: u64 },
    /// The transcript recorded an API error near its end and nothing has
    /// succeeded since. Not "stalled" — an error happened, that is all.
    ApiErrorRecent { idle_seconds: u64 },
    /// Turns are flowing; the last record is recent and nothing is dangling.
    Working { idle_seconds: u64 },
    /// Nothing dangling, but no activity for a while either.
    Quiet { idle_seconds: u64 },
}

#[derive(Serialize, Clone, Debug)]
pub struct TranscriptRead {
    pub signal: SessionSignal,
    /// Age of the newest record, seconds. The evidence's own clock.
    pub last_activity_seconds: Option<u64>,
    /// The transcript's session id — correlation only, never authority
    /// (RUNTIME-DELIVERY-CONTRACT: client session ids are not identities).
    pub session_id: Option<String>,
}

/// Claude Code encodes a project directory by replacing every non-alphanumeric
/// run in the absolute path with '-'. We do not rely on reproducing that
/// exactly: we scan candidate directories and VERIFY via the `cwd` field
/// inside the records, which is the only trustworthy join.
fn projects_root() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude/projects"))
}

fn encoded_dir_name(cwd: &str) -> String {
    let mut out = String::with_capacity(cwd.len());
    for ch in cwd.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
        } else {
            out.push('-');
        }
    }
    out
}

/// Chunk size for the backward scan. A transcript record is typically a few
/// KB, so 128 KiB usually reaches 200 records in one or two reads.
const TAIL_CHUNK: u64 = 128 * 1024;

/// Read the last `TAIL_RECORDS` lines by walking BACKWARD in chunks.
///
/// The naive version read a flat 4 MiB every poll and then threw away all but
/// 200 lines — in an always-on menu-bar app polling ten long sessions that is
/// tens of MiB per minute of pure waste (codex r2 P2). This stops as soon as
/// it has the records it needs.
fn tail_lines(path: &Path) -> Option<Vec<String>> {
    use std::io::{Read, Seek, SeekFrom};
    let len = fs::metadata(path).ok()?.len();
    let mut f = fs::File::open(path).ok()?;
    let mut end = len;
    let mut buf: Vec<u8> = Vec::new();
    let floor = len.saturating_sub(MAX_TAIL_BYTES);

    loop {
        let start = end.saturating_sub(TAIL_CHUNK).max(floor);
        let mut chunk = vec![0u8; (end - start) as usize];
        f.seek(SeekFrom::Start(start)).ok()?;
        f.read_exact(&mut chunk).ok()?;
        chunk.extend_from_slice(&buf);
        buf = chunk;
        let newlines = buf.iter().filter(|b| **b == b'\n').count();
        end = start;
        if newlines > TAIL_RECORDS || start == floor {
            break;
        }
    }

    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<String> = text.lines().map(str::to_owned).collect();
    if end > 0 && !lines.is_empty() {
        lines.remove(0); // a partial first line from mid-file seeking
    }
    let start = lines.len().saturating_sub(TAIL_RECORDS);
    Some(lines.split_off(start))
}

/// A live `claude` process: how long it has been running, and where.
///
/// Claude does NOT hold its transcript open (verified 2026-08-14 — it appends
/// and closes), so there is no file-handle join. What exists is the process's
/// AGE: a transcript belonging to a live process must have been written since
/// that process started. That turns "newest file in the folder" — which can
/// name a session that CLOSED while an older one keeps running (codex r2 P1)
/// — into a bounded candidate set, and more than one candidate is a refusal
/// rather than a guess.
#[derive(Debug, Clone, PartialEq, Eq)]
struct LiveClaude {
    cwd: String,
    /// Wall-clock seconds since the process started.
    age_seconds: u64,
}

/// "07-01:29:54" / "01:29:54" / "29:54" → seconds.
fn parse_etime(s: &str) -> Option<u64> {
    let (days, rest) = match s.split_once('-') {
        Some((d, r)) => (d.trim().parse::<u64>().ok()?, r),
        None => (0, s.trim()),
    };
    let parts: Vec<u64> = rest.split(':').map(|p| p.trim().parse::<u64>().ok()).collect::<Option<_>>()?;
    let hms = match parts.as_slice() {
        [h, m, s] => h * 3600 + m * 60 + s,
        [m, s] => m * 60 + s,
        [s] => *s,
        _ => return None,
    };
    Some(days * 86400 + hms)
}

fn live_claudes() -> Vec<LiveClaude> {
    let Ok(ps) = std::process::Command::new("ps")
        .args(["-A", "-o", "pid=,etime=,comm="])
        .output()
    else {
        return Vec::new();
    };
    let mut ages: Vec<(String, u64)> = Vec::new();
    for line in String::from_utf8_lossy(&ps.stdout).lines() {
        let mut it = line.split_whitespace();
        let (Some(pid), Some(etime), Some(comm)) = (it.next(), it.next(), it.next()) else {
            continue;
        };
        if comm == "claude" || comm.ends_with("/claude") {
            if let Some(age) = parse_etime(etime) {
                ages.push((pid.to_string(), age));
            }
        }
    }
    if ages.is_empty() {
        return Vec::new();
    }
    let pid_list = ages.iter().map(|(p, _)| p.clone()).collect::<Vec<_>>().join(",");
    let Ok(lsof) = std::process::Command::new("lsof")
        .args(["-p", &pid_list, "-a", "-d", "cwd", "-F", "pn"])
        .output()
    else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut current: Option<String> = None;
    for line in String::from_utf8_lossy(&lsof.stdout).lines() {
        if let Some(pid) = line.strip_prefix('p') {
            current = Some(pid.to_string());
        } else if let Some(path) = line.strip_prefix('n') {
            if let Some(pid) = current.take() {
                if let Some((_, age)) = ages.iter().find(|(p, _)| *p == pid) {
                    out.push(LiveClaude { cwd: path.to_string(), age_seconds: *age });
                }
            }
        }
    }
    out
}

fn version_supported(version: Option<&str>) -> bool {
    let Some(v) = version else { return false };
    let mut parts = v.split('.').map(|p| p.parse::<u32>().ok());
    match (parts.next().flatten(), parts.next().flatten()) {
        (Some(maj), Some(min)) => (maj, min) == KNOWN_MAJOR_MINOR,
        _ => false,
    }
}

/// Does this tail actually speak the vocabulary the classifier reasons over?
///
/// This is the real gate. The classifier depends on exactly three things:
/// conversational records, content blocks it recognizes, and stop reasons it
/// recognizes. If a future release renames `tool_use`, drops `stop_reason`,
/// or restructures `message.content`, this returns false and the row says
/// "can't read this transcript" — instead of the silent failure mode where
/// unrecognized records look like a calm, idle session.
fn shape_recognized(records: &[serde_json::Value]) -> bool {
    use serde_json::Value;
    const KNOWN_BLOCKS: [&str; 5] = ["text", "thinking", "tool_use", "tool_result", "image"];
    const KNOWN_STOPS: [&str; 4] = ["end_turn", "tool_use", "stop_sequence", "max_tokens"];

    let mut has_turn = false;
    let mut has_vocabulary = false;
    for r in records {
        let ty = r.get("type").and_then(Value::as_str).unwrap_or("");
        if ty != "user" && ty != "assistant" {
            continue;
        }
        has_turn = true;
        let msg = r.get("message");
        if let Some(stop) = msg.and_then(|m| m.get("stop_reason")).and_then(Value::as_str) {
            if KNOWN_STOPS.contains(&stop) {
                has_vocabulary = true;
            }
        }
        match msg.and_then(|m| m.get("content")) {
            Some(Value::Array(items)) => {
                for i in items {
                    if let Some(t) = i.get("type").and_then(Value::as_str) {
                        if KNOWN_BLOCKS.contains(&t) {
                            has_vocabulary = true;
                        }
                    }
                }
            }
            // A plain-string user turn is the oldest, simplest shape and is
            // still written today — it is vocabulary we understand.
            Some(Value::String(_)) => has_vocabulary = true,
            _ => {}
        }
    }
    has_turn && has_vocabulary
}

/// Classify from already-parsed JSON records (newest last). Pure, so the
/// fixtures test the reasoning rather than the filesystem.
pub fn classify(records: &[serde_json::Value], now_epoch_secs: u64) -> TranscriptRead {
    use serde_json::Value;

    let newest_version = records
        .iter()
        .rev()
        .find_map(|r| r.get("version").and_then(Value::as_str))
        .map(str::to_owned);
    let session_id = records
        .iter()
        .rev()
        .find_map(|r| r.get("sessionId").and_then(Value::as_str))
        .map(str::to_owned);

    let parse_ts = |r: &Value| -> Option<u64> {
        let s = r.get("timestamp").and_then(Value::as_str)?;
        // RFC3339 without pulling a date crate: the shape is
        // YYYY-MM-DDTHH:MM:SS(.mmm)Z — convert via days-since-epoch math.
        let (date, rest) = s.split_once('T')?;
        let mut d = date.split('-');
        let (y, mo, da) = (
            d.next()?.parse::<i64>().ok()?,
            d.next()?.parse::<i64>().ok()?,
            d.next()?.parse::<i64>().ok()?,
        );
        let time = rest.trim_end_matches('Z');
        let time = time.split('.').next()?;
        let mut t = time.split(':');
        let (h, mi, se) = (
            t.next()?.parse::<i64>().ok()?,
            t.next()?.parse::<i64>().ok()?,
            t.next()?.parse::<i64>().ok()?,
        );
        // Howard Hinnant's days_from_civil.
        let y2 = if mo <= 2 { y - 1 } else { y };
        let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
        let yoe = y2 - era * 400;
        let mp = (mo + 9) % 12;
        let doy = (153 * mp + 2) / 5 + da - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        let days = era * 146097 + doe - 719468;
        let secs = days * 86400 + h * 3600 + mi * 60 + se;
        u64::try_from(secs).ok()
    };

    let last_ts = records.iter().rev().find_map(parse_ts);
    let idle = |ts: Option<u64>| ts.map_or(0, |t| now_epoch_secs.saturating_sub(t));
    let last_activity_seconds = last_ts.map(|t| now_epoch_secs.saturating_sub(t));
    // Progress means a real TURN happened, not that any record was appended:
    // a `last-prompt` or `system` line after an API error is bookkeeping, not
    // recovery (codex r1 P2).
    let last_turn_ts = records
        .iter()
        .rev()
        .find(|r| matches!(r.get("type").and_then(Value::as_str), Some("user") | Some("assistant")))
        .and_then(parse_ts);

    let unknown = |why: &str| TranscriptRead {
        signal: SessionSignal::Unknown { why: why.to_string() },
        last_activity_seconds,
        session_id: session_id.clone(),
    };

    if records.is_empty() {
        return unknown("no records");
    }
    if !version_supported(newest_version.as_deref()) {
        return unknown("this Claude Code release is outside the transcript family Buddy reads");
    }
    if !shape_recognized(records) {
        // Law 4, checked against the thing itself: unrecognized records must
        // read as "cannot see", never as a calm idle session.
        return unknown("this transcript's shape isn't one Buddy has been taught");
    }

    // Pair tool calls with their results by id. The last-60-record sample of
    // 80 real transcripts had ZERO dangling calls, so a dangling one is a
    // high-signal event rather than routine noise — but its CAUSE stays
    // unknown (law 1).
    let mut used: Vec<(String, String, Option<u64>)> = Vec::new(); // (id, tool, ts)
    let mut resulted: HashSet<String> = HashSet::new();
    let mut last_conversational: Option<&Value> = None;
    let mut api_error_ts: Option<u64> = None;
    let mut last_user_ts: Option<u64> = None;
    let mut last_assistant_end_turn_ts: Option<u64> = None;

    for r in records {
        let ty = r.get("type").and_then(Value::as_str).unwrap_or("");
        if r.get("isApiErrorMessage").and_then(Value::as_bool) == Some(true) {
            api_error_ts = parse_ts(r).or(api_error_ts);
        }
        if ty != "user" && ty != "assistant" {
            continue; // last-prompt / system / mode records are not turns
        }
        last_conversational = Some(r);
        let msg = r.get("message");
        let role = msg.and_then(|m| m.get("role")).and_then(Value::as_str).unwrap_or(ty);
        let content = msg.and_then(|m| m.get("content"));
        let stop = msg.and_then(|m| m.get("stop_reason")).and_then(Value::as_str);

        if role == "user" {
            // A user record carrying ONLY tool_result blocks is the harness
            // returning a tool's output, not the human speaking.
            let only_tool_results = content
                .and_then(Value::as_array)
                .map(|a| {
                    !a.is_empty()
                        && a.iter().all(|c| c.get("type").and_then(Value::as_str) == Some("tool_result"))
                })
                .unwrap_or(false);
            if !only_tool_results {
                last_user_ts = parse_ts(r).or(last_user_ts);
            }
        }
        if role == "assistant" && stop == Some("end_turn") {
            last_assistant_end_turn_ts = parse_ts(r).or(last_assistant_end_turn_ts);
        }

        if let Some(items) = content.and_then(Value::as_array) {
            for item in items {
                match item.get("type").and_then(Value::as_str) {
                    Some("tool_use") => {
                        if let Some(id) = item.get("id").and_then(Value::as_str) {
                            used.push((
                                id.to_string(),
                                item.get("name").and_then(Value::as_str).unwrap_or("a tool").to_string(),
                                parse_ts(r),
                            ));
                        }
                    }
                    Some("tool_result") => {
                        if let Some(id) = item.get("tool_use_id").and_then(Value::as_str) {
                            resulted.insert(id.to_string());
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    if last_conversational.is_none() {
        return unknown("no conversation turns in the recent tail");
    }

    // An API error that nothing has succeeded past outranks the rest: it is
    // the most actionable thing the transcript can show, and it is structural
    // (never text-matched — law 2).
    if let Some(err_ts) = api_error_ts {
        let progressed = last_turn_ts.map_or(false, |t| t > err_ts + 5);
        if !progressed {
            return TranscriptRead {
                signal: SessionSignal::ApiErrorRecent { idle_seconds: idle(Some(err_ts)) },
                last_activity_seconds,
                session_id,
            };
        }
    }

    // "Awaiting you" needs the assistant to have ENDED ITS TURN with no human
    // reply after it. Merely ending on a question mark is not evidence.
    let awaiting = last_assistant_end_turn_ts
        .filter(|end_ts| last_user_ts.map_or(true, |u| u < *end_ts));

    // A dangling call only means anything if nothing has HAPPENED SINCE. An
    // interrupted tool from twenty turns ago is history, and letting it win
    // would suppress a genuine wants-you badge until it aged out of the tail
    // (codex r1 P2).
    let superseding = awaiting.or(last_user_ts).unwrap_or(0);
    let dangling = used
        .iter()
        .find(|(id, _, ts)| !resulted.contains(id) && ts.map_or(true, |t| t >= superseding));
    if let Some((_, tool, ts)) = dangling {
        return TranscriptRead {
            signal: SessionSignal::ToolNoResult { tool: tool.clone(), idle_seconds: idle(*ts) },
            last_activity_seconds,
            session_id,
        };
    }

    if let Some(end_ts) = awaiting {
        return TranscriptRead {
            signal: SessionSignal::AwaitingYou { idle_seconds: idle(Some(end_ts)) },
            last_activity_seconds,
            session_id,
        };
    }

    let idle_secs = last_activity_seconds.unwrap_or(0);
    TranscriptRead {
        signal: if idle_secs < 120 {
            SessionSignal::Working { idle_seconds: idle_secs }
        } else {
            SessionSignal::Quiet { idle_seconds: idle_secs }
        },
        last_activity_seconds,
        session_id,
    }
}

/// Find the newest transcript whose records claim this cwd, and classify it.
/// The `cwd` inside the records is the join — never the encoded directory
/// name alone, which is lossy.
#[tauri::command]
pub async fn transcript_signal(cwd: String) -> TranscriptRead {
    tauri::async_runtime::spawn_blocking(move || transcript_signal_blocking(&cwd))
        .await
        .unwrap_or_else(|_| TranscriptRead {
            signal: SessionSignal::Unknown { why: "the read did not finish".into() },
            last_activity_seconds: None,
            session_id: None,
        })
}

fn transcript_signal_blocking(cwd: &str) -> TranscriptRead {
    let nothing = |why: &str| TranscriptRead {
        signal: SessionSignal::Unknown { why: why.to_string() },
        last_activity_seconds: None,
        session_id: None,
    };
    let Some(root) = projects_root() else {
        return nothing("no home directory");
    };
    let dir = root.join(encoded_dir_name(cwd));
    let Ok(entries) = fs::read_dir(&dir) else {
        return nothing("no transcript for this directory");
    };

    // Correlate to a LIVE process before believing any file (codex r2 P1).
    // Without a live claude in this directory there is nothing to attribute a
    // transcript to — a stale file's "wants you" belongs to nobody.
    let live: Vec<LiveClaude> = live_claudes().into_iter().filter(|l| l.cwd == cwd).collect();
    if live.is_empty() {
        return nothing("no live Claude session in this directory to attribute a transcript to");
    }
    if live.len() > 1 {
        return nothing("two Claude sessions share this directory — Buddy can't tell their transcripts apart");
    }
    // A transcript this process wrote must have been touched since it booted.
    // Anything older belongs to a session that ended, and anything else
    // touched since would mean a second live writer we just ruled out.
    let now = std::time::SystemTime::now();
    let started = now
        .checked_sub(std::time::Duration::from_secs(live[0].age_seconds))
        .unwrap_or(std::time::UNIX_EPOCH);

    let mut candidates: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(m) = e.metadata() else { continue };
        let Ok(t) = m.modified() else { continue };
        if t >= started {
            candidates.push((t, p));
        }
    }
    if candidates.is_empty() {
        return nothing("that session hasn't written a transcript yet");
    }
    if candidates.len() > 1 {
        return nothing("several transcripts here were written during this session's life — Buddy can't tell which is its own");
    }
    let (_, path) = candidates.remove(0);
    let Some(lines) = tail_lines(&path) else {
        return nothing("transcript unreadable");
    };
    let records: Vec<serde_json::Value> = lines
        .iter()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .collect();

    // Verify the join: the records must claim this cwd. The encoded directory
    // name is lossy (every non-alphanumeric becomes '-'), so two real paths
    // can collide on it.
    let claims_cwd = records
        .iter()
        .rev()
        .find_map(|r| r.get("cwd").and_then(serde_json::Value::as_str))
        .map(|c| c == cwd);
    if claims_cwd == Some(false) {
        return nothing("the transcript in that folder belongs to a different directory");
    }

    let now_secs = now
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    classify(&records, now_secs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const V: &str = "2.1.232";
    const T0: u64 = 1_786_000_000;

    fn ts(offset: i64) -> String {
        // Render an RFC3339 stamp `offset` seconds from T0 by inverting the
        // civil-days math the classifier uses (test-only, keeps fixtures
        // readable without a date dependency).
        let secs = (T0 as i64) + offset;
        let days = secs.div_euclid(86400);
        let rem = secs.rem_euclid(86400);
        let z = days + 719468;
        let era = if z >= 0 { z } else { z - 146096 } / 146097;
        let doe = z - era * 146097;
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        let y = yoe + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        let y = if m <= 2 { y + 1 } else { y };
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.000Z",
            y, m, d, rem / 3600, (rem % 3600) / 60, rem % 60
        )
    }

    fn assistant_tool(id: &str, name: &str, offset: i64) -> serde_json::Value {
        json!({"type":"assistant","version":V,"sessionId":"s1","timestamp":ts(offset),
               "message":{"role":"assistant","stop_reason":"tool_use",
                          "content":[{"type":"tool_use","id":id,"name":name}]}})
    }
    fn tool_result(id: &str, offset: i64) -> serde_json::Value {
        json!({"type":"user","version":V,"sessionId":"s1","timestamp":ts(offset),
               "message":{"role":"user","content":[{"type":"tool_result","tool_use_id":id}]}})
    }
    fn assistant_done(offset: i64) -> serde_json::Value {
        json!({"type":"assistant","version":V,"sessionId":"s1","timestamp":ts(offset),
               "message":{"role":"assistant","stop_reason":"end_turn",
                          "content":[{"type":"text","text":"…"}]}})
    }
    fn human(offset: i64) -> serde_json::Value {
        json!({"type":"user","version":V,"sessionId":"s1","timestamp":ts(offset),
               "message":{"role":"user","content":[{"type":"text","text":"…"}]}})
    }
    /// The shape the tail ACTUALLY ends with in 43 of 60 real transcripts —
    /// a non-conversational record. A classifier that reads "the last line"
    /// sees this and learns nothing.
    fn last_prompt(offset: i64) -> serde_json::Value {
        json!({"type":"last-prompt","version":V,"sessionId":"s1","timestamp":ts(offset)})
    }

    #[test]
    fn a_finished_turn_with_no_human_reply_is_awaiting_you() {
        let r = classify(&[human(-600), assistant_done(-300), last_prompt(-299)], T0);
        assert_eq!(r.signal, SessionSignal::AwaitingYou { idle_seconds: 300 });
    }

    #[test]
    fn trailing_non_conversational_records_do_not_hide_the_last_turn() {
        // The 43-of-60 case: last-prompt/system records sit after the turn.
        let r = classify(&[assistant_done(-60), last_prompt(-59), last_prompt(-58)], T0);
        assert!(matches!(r.signal, SessionSignal::AwaitingYou { .. }));
    }

    #[test]
    fn a_human_reply_after_the_turn_means_nobody_is_waiting_on_you() {
        let r = classify(&[assistant_done(-300), human(-30)], T0);
        assert!(matches!(r.signal, SessionSignal::Working { .. }));
    }

    #[test]
    fn a_tool_result_is_not_a_human_reply() {
        // The harness returning tool output must never read as "you answered".
        let r = classify(
            &[assistant_done(-300), tool_result("t1", -30)],
            T0,
        );
        assert!(matches!(r.signal, SessionSignal::AwaitingYou { .. }));
    }

    #[test]
    fn an_unmatched_tool_call_names_the_evidence_not_a_cause() {
        let r = classify(&[human(-400), assistant_tool("t9", "Bash", -200)], T0);
        match &r.signal {
            SessionSignal::ToolNoResult { tool, idle_seconds } => {
                assert_eq!(tool, "Bash");
                assert_eq!(*idle_seconds, 200);
            }
            other => panic!("expected ToolNoResult, got {other:?}"),
        }
        // The whole point of the label: it must not say "permission prompt".
        let json = serde_json::to_string(&r.signal).unwrap();
        assert!(!json.contains("permission"), "the label must not name a cause it cannot see");
    }

    #[test]
    fn a_matched_tool_call_is_not_dangling() {
        let r = classify(
            &[assistant_tool("t1", "Bash", -100), tool_result("t1", -95), assistant_done(-90)],
            T0,
        );
        assert!(matches!(r.signal, SessionSignal::AwaitingYou { .. }));
    }

    #[test]
    fn api_errors_are_structural_never_text_matched() {
        // Law 2, the measured one: this operator's prose mentions rate limits
        // ~33x more often than real API errors occur. Text that merely TALKS
        // about a rate limit must classify as an ordinary turn.
        let chatty = json!({"type":"assistant","version":V,"sessionId":"s1","timestamp":ts(-30),
            "message":{"role":"assistant","stop_reason":"end_turn",
                       "content":[{"type":"text","text":"we hit a rate limit / 429 earlier, please run /login"}]}});
        let r = classify(&[human(-60), chatty], T0);
        assert!(matches!(r.signal, SessionSignal::AwaitingYou { .. }),
                "prose about rate limits is not an API error");

        let real = json!({"type":"assistant","version":V,"sessionId":"s1","timestamp":ts(-45),
            "isApiErrorMessage": true,
            "message":{"role":"assistant","content":[{"type":"text","text":"…"}]}});
        let r2 = classify(&[human(-60), real], T0);
        assert_eq!(r2.signal, SessionSignal::ApiErrorRecent { idle_seconds: 45 });
    }

    #[test]
    fn progress_after_an_error_clears_it() {
        let err = json!({"type":"assistant","version":V,"sessionId":"s1","timestamp":ts(-300),
            "isApiErrorMessage": true, "message":{"role":"assistant","content":[]}});
        let r = classify(&[err, human(-100), assistant_done(-20)], T0);
        assert!(matches!(r.signal, SessionSignal::AwaitingYou { .. }));
    }

    #[test]
    fn an_old_interrupted_tool_call_does_not_mask_a_later_wants_you() {
        // codex r1 P2: a dangling call from twenty turns ago is history. If
        // the thread has since finished a turn, THAT is the news.
        let r = classify(
            &[
                assistant_tool("dead", "Bash", -5000), // never resulted
                human(-400),
                assistant_done(-200),
            ],
            T0,
        );
        assert_eq!(r.signal, SessionSignal::AwaitingYou { idle_seconds: 200 });
    }

    #[test]
    fn a_dangling_call_after_the_last_turn_still_wins() {
        let r = classify(
            &[assistant_done(-900), human(-600), assistant_tool("live", "Edit", -60)],
            T0,
        );
        assert!(matches!(r.signal, SessionSignal::ToolNoResult { .. }));
    }

    #[test]
    fn metadata_records_do_not_count_as_recovery_from_an_error() {
        // codex r1 P2: a last-prompt line appended after an API error is
        // bookkeeping, not a successful turn — the badge must survive it.
        let err = json!({"type":"assistant","version":V,"sessionId":"s1","timestamp":ts(-300),
            "isApiErrorMessage": true, "message":{"role":"assistant","content":[]}});
        let r = classify(&[human(-400), err, last_prompt(-10)], T0);
        assert_eq!(r.signal, SessionSignal::ApiErrorRecent { idle_seconds: 300 });
    }

    #[test]
    fn an_untested_version_reads_as_cannot_see_never_as_a_state() {
        let future = json!({"type":"assistant","version":"9.9.9","sessionId":"s1","timestamp":ts(-10),
            "message":{"role":"assistant","stop_reason":"end_turn","content":[]}});
        assert!(matches!(classify(&[future], T0).signal, SessionSignal::Unknown { .. }));
        let versionless = json!({"type":"assistant","timestamp":ts(-10),
            "message":{"role":"assistant","stop_reason":"end_turn","content":[]}});
        assert!(matches!(classify(&[versionless], T0).signal, SessionSignal::Unknown { .. }));
        // The patch number is not the gate — the SHAPE is (codex r2 P1: a
        // pinned ceiling switched the feature off for the current release
        // the day it shipped). Family bumps still degrade.
        assert!(version_supported(Some("2.1.232")));
        assert!(version_supported(Some("2.1.233")));
        assert!(version_supported(Some("2.1.900")));
        assert!(!version_supported(Some("2.2.100")));
        assert!(!version_supported(Some("3.0.1")));
    }

    #[test]
    fn an_unrecognized_record_vocabulary_reads_as_cannot_see() {
        // The silent failure this replaces: if a future release renames the
        // content blocks, the old gate would have found no tool calls and no
        // end_turn and reported a calm "Quiet" session.
        let alien = json!({"type":"assistant","version":V,"sessionId":"s1","timestamp":ts(-30),
            "message":{"role":"assistant","finish":"done",
                       "content":[{"type":"speech_act","body":"…"}]}});
        let r = classify(&[alien], T0);
        match &r.signal {
            SessionSignal::Unknown { why } => assert!(why.contains("shape")),
            other => panic!("expected Unknown, got {other:?}"),
        }
        // ...while today's vocabulary is recognized, including a plain-string
        // user turn (still written in 2.1.233).
        let plain = json!({"type":"user","version":"2.1.233","sessionId":"s1","timestamp":ts(-30),
            "message":{"role":"user","content":"hello"}});
        assert!(shape_recognized(&[plain]));
    }

    #[test]
    fn empty_or_turnless_tails_are_unknown_not_quiet() {
        assert!(matches!(classify(&[], T0).signal, SessionSignal::Unknown { .. }));
        let only_noise = classify(&[last_prompt(-10)], T0);
        assert!(matches!(only_noise.signal, SessionSignal::Unknown { .. }));
    }

    #[test]
    fn the_signal_carries_no_conversation_content() {
        // Law 3 as a test: serialize every variant and prove the payload has
        // room for state, ages and a tool NAME — and nothing else.
        let chatty = json!({"type":"assistant","version":V,"sessionId":"s1","timestamp":ts(-30),
            "message":{"role":"assistant","stop_reason":"end_turn",
                       "content":[{"type":"text","text":"SECRET-CONTENT-MARKER"}]}});
        let r = classify(&[human(-60), chatty], T0);
        let json = serde_json::to_string(&r).unwrap();
        assert!(!json.contains("SECRET-CONTENT-MARKER"));
        assert!(!json.contains("message"));
    }

    #[test]
    fn quiet_and_working_split_on_recency_only() {
        let a = classify(&[human(-3600), assistant_done(-3500), human(-10)], T0);
        assert!(matches!(a.signal, SessionSignal::Working { .. }));
        let b = classify(&[assistant_done(-3600), human(-3000)], T0);
        assert!(matches!(b.signal, SessionSignal::Quiet { .. }));
    }

    #[test]
    fn etime_parses_every_ps_shape() {
        assert_eq!(parse_etime("29:54"), Some(29 * 60 + 54));
        assert_eq!(parse_etime("01:29:54"), Some(3600 + 29 * 60 + 54));
        assert_eq!(parse_etime("07-01:29:54"), Some(7 * 86400 + 3600 + 29 * 60 + 54));
        assert_eq!(parse_etime("garbage"), None);
    }

    #[test]
    fn the_tail_reader_walks_backward_and_stops_early() {
        // codex r2 P2: the old reader pulled a flat 4 MiB per poll. Write a
        // file far larger than one chunk and prove we still get exactly the
        // last TAIL_RECORDS lines.
        let dir = std::env::temp_dir().join(format!("buddy-tail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("big.jsonl");
        let filler = "x".repeat(2000);
        let mut body = String::new();
        for i in 0..800 {
            body.push_str(&format!("{{\"n\":{i},\"pad\":\"{filler}\"}}\n"));
        }
        std::fs::write(&path, &body).unwrap();
        let lines = tail_lines(&path).unwrap();
        assert_eq!(lines.len(), TAIL_RECORDS);
        assert!(lines.last().unwrap().contains("\"n\":799"));
        // ...and the first retained line is a WHOLE record, not a fragment.
        assert!(serde_json::from_str::<serde_json::Value>(lines.first().unwrap()).is_ok());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn the_encoded_directory_name_matches_claude_codes_scheme() {
        assert_eq!(
            encoded_dir_name("/Users/yourname/Projects/example-project"),
            "-Users-yourname-Projects-example-project"
        );
        // Lossy by design — which is why the cwd inside the records is the
        // real join and this is only a lookup hint.
        assert_eq!(encoded_dir_name("/a/b.c"), encoded_dir_name("/a/b-c"));
    }
}
