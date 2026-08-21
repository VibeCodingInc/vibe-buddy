//! Context Extractor — reads local coding data to build CodingDNA
//!
//! Sources:
//! 1. vibecheck SQLite DB (~/.vibe-check/vibe_check.db)
//!    - Active session, recent projects, token usage, languages, topics
//! 2. Claude Code memory files (~/.claude/projects/*/memory/MEMORY.md)
//!    - Project knowledge, patterns, architectural decisions

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

// REMOVED 2026-08-15: `extract_recent_turns`, the only path that carried raw
// conversation text out of this module, and the Tauri command that exposed it.
//
// Kill switch 0c (2026-08-09) stopped Buddy SENDING turns, but the capability
// stayed registered — so the transcript-privacy promise was enforced by client
// code choosing not to call it, rather than by the capability being absent.
// The platform's `turns` handling is correctly scoped to its explicit share
// endpoint, which made this registration the last real gap. Nothing in the app
// called it (verified: no caller outside its own test).
//
// The query core and its SessionTurn type went with it. Keeping them private
// but test-pinned was the first instinct; the compiler correctly called that
// dead code, and dead code rots. If raw turns ever return behind a scoped,
// revocable, per-session grant, they will be written against that consent
// model rather than inheriting a reader built before it existed.
//
// What remains in this module reads STRUCTURE for CodingDNA — projects,
// languages, token counts — and no conversation text.

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CodingDNA {
    pub active_project: Option<String>,
    pub branch: Option<String>,
    pub model: Option<String>,
    pub session_minutes: u64,
    pub tokens_today: TokenUsage,
    pub top_projects: Vec<String>,
    pub top_languages: Vec<String>,
    pub recent_topics: Vec<String>,
    pub weekly_sessions: u32,
    pub streak_days: u32,
    pub stuck_signal: bool,
    pub projects_known: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TokenUsage {
    pub input: u64,
    pub output: u64,
}

fn vibecheck_db_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".vibe-check").join("vibe_check.db")
}

fn claude_projects_dir() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".claude").join("projects")
}

pub fn extract_coding_context() -> CodingDNA {
    let mut dna = CodingDNA {
        active_project: None,
        branch: None,
        model: None,
        session_minutes: 0,
        tokens_today: TokenUsage { input: 0, output: 0 },
        top_projects: vec![],
        top_languages: vec![],
        recent_topics: vec![],
        weekly_sessions: 0,
        streak_days: 0,
        stuck_signal: false,
        projects_known: vec![],
    };

    // Read vibecheck DB
    let db_path = vibecheck_db_path();
    if db_path.exists() {
        if let Ok(conn) = Connection::open_with_flags(
            &db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        ) {
            extract_from_vibecheck(&conn, &mut dna);
        }
    }

    // Read Claude Code memory files
    extract_from_claude_memory(&mut dna);

    dna
}

fn extract_from_vibecheck(conn: &Connection, dna: &mut CodingDNA) {
    // 1. Most recent session — active project, branch, model
    if let Ok(mut stmt) = conn.prepare(
        "SELECT file_name, event_git_branch, event_model, event_session_id, event_timestamp
         FROM conversation_events
         WHERE event_type = 'assistant'
         ORDER BY id DESC LIMIT 1",
    ) {
        if let Ok(row) = stmt.query_row([], |row| {
            Ok((
                row.get::<_, String>(0).unwrap_or_default(),
                row.get::<_, Option<String>>(1).unwrap_or(None),
                row.get::<_, Option<String>>(2).unwrap_or(None),
                row.get::<_, Option<String>>(3).unwrap_or(None),
                row.get::<_, Option<String>>(4).unwrap_or(None),
            ))
        }) {
            // Extract project name from file path
            dna.active_project = extract_project_from_path(&row.0);
            dna.branch = row.1;
            dna.model = row.2;

            // Calculate session duration from first event in this session
            if let Some(ref session_id) = row.3 {
                if let Ok(mut stmt2) = conn.prepare(
                    "SELECT MIN(event_timestamp), MAX(event_timestamp)
                     FROM conversation_events
                     WHERE event_session_id = ?1",
                ) {
                    if let Ok((start, end)) = stmt2.query_row([session_id], |r| {
                        Ok((
                            r.get::<_, Option<String>>(0).unwrap_or(None),
                            r.get::<_, Option<String>>(1).unwrap_or(None),
                        ))
                    }) {
                        if let (Some(s), Some(e)) = (start, end) {
                            if let (Ok(st), Ok(et)) = (
                                chrono::DateTime::parse_from_rfc3339(&s),
                                chrono::DateTime::parse_from_rfc3339(&e),
                            ) {
                                let dur = et.signed_duration_since(st);
                                dna.session_minutes = (dur.num_minutes().max(0)) as u64;
                            }
                        }
                    }
                }
            }
        }
    }

    // 2. Token usage today
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT COALESCE(SUM(event_input_tokens), 0), COALESCE(SUM(event_output_tokens), 0)
         FROM conversation_events
         WHERE date(inserted_at) = ?1 AND event_type = 'assistant'",
    ) {
        if let Ok((input, output)) = stmt.query_row([&today], |r| {
            Ok((
                r.get::<_, i64>(0).unwrap_or(0),
                r.get::<_, i64>(1).unwrap_or(0),
            ))
        }) {
            dna.tokens_today = TokenUsage {
                input: input.max(0) as u64,
                output: output.max(0) as u64,
            };
        }
    }

    // 3. Top projects (last 7 days by event count)
    if let Ok(mut stmt) = conn.prepare(
        "SELECT file_name, COUNT(*) as cnt
         FROM conversation_events
         WHERE inserted_at > datetime('now', '-7 days')
         GROUP BY file_name
         ORDER BY cnt DESC
         LIMIT 20",
    ) {
        let mut project_counts: HashMap<String, u64> = HashMap::new();
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0).unwrap_or_default(),
                row.get::<_, u64>(1).unwrap_or(0),
            ))
        }) {
            for row in rows.flatten() {
                if let Some(proj) = extract_project_from_path(&row.0) {
                    *project_counts.entry(proj).or_insert(0) += row.1;
                }
            }
        }
        let mut sorted: Vec<_> = project_counts.into_iter().collect();
        sorted.sort_by(|a, b| b.1.cmp(&a.1));
        dna.top_projects = sorted.into_iter().take(5).map(|(p, _)| p).collect();
    }

    // 4. Top languages (from file extensions in project files table if exists, else from file_name)
    if let Ok(mut stmt) = conn.prepare(
        "SELECT file_name FROM conversation_events
         WHERE inserted_at > datetime('now', '-7 days')
         GROUP BY file_name ORDER BY COUNT(*) DESC LIMIT 50",
    ) {
        let mut lang_counts: HashMap<String, u32> = HashMap::new();
        if let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) {
            for path in rows.flatten() {
                // Detect languages from the project path context
                let lower = path.to_lowercase();
                if lower.contains("rust") || lower.contains("cargo") {
                    *lang_counts.entry("Rust".into()).or_insert(0) += 1;
                }
                if lower.contains("typescript") || lower.contains(".tsx") || lower.contains(".ts") {
                    *lang_counts.entry("TypeScript".into()).or_insert(0) += 1;
                }
                if lower.contains("python") || lower.contains(".py") {
                    *lang_counts.entry("Python".into()).or_insert(0) += 1;
                }
                if lower.contains("react") || lower.contains(".jsx") {
                    *lang_counts.entry("React".into()).or_insert(0) += 1;
                }
                if lower.contains(".js") || lower.contains("node") {
                    *lang_counts.entry("JavaScript".into()).or_insert(0) += 1;
                }
                if lower.contains(".html") || lower.contains(".css") {
                    *lang_counts.entry("HTML/CSS".into()).or_insert(0) += 1;
                }
                if lower.contains("swift") {
                    *lang_counts.entry("Swift".into()).or_insert(0) += 1;
                }
                if lower.contains(".sol") {
                    *lang_counts.entry("Solidity".into()).or_insert(0) += 1;
                }
            }
        }
        let mut sorted: Vec<_> = lang_counts.into_iter().collect();
        sorted.sort_by(|a, b| b.1.cmp(&a.1));
        dna.top_languages = sorted.into_iter().take(5).map(|(l, _)| l).collect();
    }

    // 5. Weekly sessions count
    if let Ok(mut stmt) = conn.prepare(
        "SELECT COUNT(DISTINCT event_session_id)
         FROM conversation_events
         WHERE inserted_at > datetime('now', '-7 days')",
    ) {
        if let Ok(count) = stmt.query_row([], |r| r.get::<_, u32>(0)) {
            dna.weekly_sessions = count;
        }
    }

    // 6. Streak days (consecutive days with activity, going backwards from today)
    if let Ok(mut stmt) = conn.prepare(
        // Bounded to 60 days: a streak can't exceed the LIMIT anyway, and the bound
        // stops SQLite from DISTINCT-scanning the entire (multi-GB) table.
        "SELECT DISTINCT date(inserted_at) as day
         FROM conversation_events
         WHERE inserted_at > datetime('now', '-60 days')
         ORDER BY day DESC
         LIMIT 60",
    ) {
        if let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) {
            let days: Vec<String> = rows.flatten().collect();
            let mut streak: u32 = 0;
            let now = chrono::Local::now().date_naive();

            for (i, day_str) in days.iter().enumerate() {
                if let Ok(day) = chrono::NaiveDate::parse_from_str(day_str, "%Y-%m-%d") {
                    let expected = now - chrono::Duration::days(i as i64);
                    if day == expected {
                        streak += 1;
                    } else {
                        break;
                    }
                } else {
                    break;
                }
            }
            dna.streak_days = streak;
        }
    }

    // 7. Recent topics — extract from recent assistant messages (simple keyword extraction)
    if let Ok(mut stmt) = conn.prepare(
        "SELECT event_message FROM conversation_events
         WHERE event_type = 'human' AND inserted_at > datetime('now', '-1 day')
         AND event_message IS NOT NULL
         ORDER BY id DESC LIMIT 20",
    ) {
        let mut topic_counts: HashMap<String, u32> = HashMap::new();
        let keywords = [
            "api", "auth", "database", "deploy", "test", "debug", "refactor",
            "ui", "css", "performance", "security", "migration", "webhook",
            "notification", "search", "cache", "payment", "email",
            "presence", "message", "dm", "session", "avatar", "login",
            "signup", "onboarding", "analytics", "config", "build",
        ];

        if let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) {
            for msg in rows.flatten() {
                let lower = msg.to_lowercase();
                for kw in &keywords {
                    if lower.contains(kw) {
                        *topic_counts.entry((*kw).to_string()).or_insert(0) += 1;
                    }
                }
            }
        }
        let mut sorted: Vec<_> = topic_counts.into_iter().collect();
        sorted.sort_by(|a, b| b.1.cmp(&a.1));
        dna.recent_topics = sorted.into_iter().take(5).map(|(t, _)| t).collect();
    }

    // 8. Stuck signal — high token usage on same branch with no apparent progress
    // Heuristic: >50k tokens in last hour on same session
    if let Ok(mut stmt) = conn.prepare(
        "SELECT COALESCE(SUM(event_input_tokens + COALESCE(event_output_tokens, 0)), 0)
         FROM conversation_events
         WHERE inserted_at > datetime('now', '-1 hour')
         AND event_type = 'assistant'",
    ) {
        if let Ok(tokens_last_hour) = stmt.query_row([], |r| r.get::<_, i64>(0)) {
            // >100k tokens in an hour with session >60min suggests possible stuck
            dna.stuck_signal = tokens_last_hour > 100_000 && dna.session_minutes > 60;
        }
    }
}

fn extract_from_claude_memory(dna: &mut CodingDNA) {
    let projects_dir = claude_projects_dir();
    if !projects_dir.exists() {
        return;
    }

    // Look for MEMORY.md files in project directories
    let pattern = projects_dir
        .join("*")
        .join("memory")
        .join("MEMORY.md");

    if let Ok(paths) = glob::glob(&pattern.to_string_lossy()) {
        for entry in paths.flatten() {
            // Extract project name from the directory path
            // ~/.claude/projects/-Users-yourname-Projects-PROJECTNAME/memory/MEMORY.md
            if let Some(project_dir) = entry.parent().and_then(|p| p.parent()) {
                let dir_name = project_dir
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy();

                // Parse project name from path encoding: -Users-seth-Projects-PROJNAME
                let parts: Vec<&str> = dir_name.split('-').collect();
                if let Some(idx) = parts.iter().position(|&p| p == "Projects") {
                    if idx + 1 < parts.len() {
                        let proj = parts[idx + 1..].join("-");
                        if !proj.is_empty() {
                            dna.projects_known.push(proj);
                        }
                    }
                }
            }
        }
    }

    dna.projects_known.sort();
    dna.projects_known.dedup();
}

fn extract_project_from_path(path: &str) -> Option<String> {
    // vibecheck stores JSONL file paths like:
    // /Users/yourname/.claude/projects/-Users-yourname-Projects-someproject/...
    // or just filenames with project context

    let lower = path.to_lowercase();

    // Try to extract from -Projects- pattern
    if let Some(idx) = lower.find("-projects-") {
        let after = &path[idx + 10..];
        let end = after.find('/').unwrap_or(after.len());
        let proj = &after[..end];
        if !proj.is_empty() {
            return Some(proj.replace('-', "-"));
        }
    }

    // Try to extract from ~/Projects/ pattern
    if let Some(idx) = path.find("Projects/") {
        let after = &path[idx + 9..];
        let end = after.find('/').unwrap_or(after.len());
        let proj = &after[..end];
        if !proj.is_empty() {
            return Some(proj.to_string());
        }
    }

    // Fallback: use the filename stem
    let p = std::path::Path::new(path);
    p.file_stem().map(|s| s.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE conversation_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_session_id TEXT,
                event_type TEXT,
                event_message TEXT
             );",
        )
        .unwrap();
        conn
    }

    fn insert(conn: &Connection, session: &str, event_type: &str, msg: &str) {
        conn.execute(
            "INSERT INTO conversation_events (event_session_id, event_type, event_message)
             VALUES (?1, ?2, ?3)",
            rusqlite::params![session, event_type, msg],
        )
        .unwrap();
    }

    #[test]
    fn project_extraction_handles_both_path_shapes_and_the_fallback() {
        assert_eq!(
            extract_project_from_path("/Users/x/.claude/projects/-Users-x-Projects-vibe-platform/y.jsonl"),
            Some("vibe-platform".to_string())
        );
        assert_eq!(
            extract_project_from_path("/Users/x/Projects/spirit/notes.md"),
            Some("spirit".to_string())
        );
        assert_eq!(
            extract_project_from_path("standalone-file.jsonl"),
            Some("standalone-file".to_string())
        );
    }
}
