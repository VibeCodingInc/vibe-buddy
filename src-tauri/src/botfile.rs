//! Reading a vibeconf Botfile so a session can show up as somebody.
//!
//! A session row today is a path and a heartbeat: `/Users/yourname`, `active`.
//! That is accurate and completely impersonal — five of them look like five
//! terminals rather than five agents you know.
//!
//! vibeconf already solved naming for calls. A `BOT.md` in a project's working
//! directory gives that project's agent a durable character: a slug, a display
//! name, an emoji, an owner. Buddy knows the `cwd` of every session on THIS
//! machine, so it can read the same file and render the same identity — one
//! source of truth for "who is this agent", shared between the call and the
//! buddy list, with no new format to invent and nothing to sync.
//!
//! Scope, deliberately: **local sessions only.** Buddy can read its own machine's
//! disk. It cannot read anyone else's, so other people's sessions are untouched
//! by this. Carrying bot identity between people is presence data, and presence
//! semantics belong to the platform — a client must not invent a second channel
//! for it.
//!
//! Trust posture: a Botfile is a plain markdown file that lands in the UI. It is
//! not hostile, but it is not validated by anyone either — a stray 400-character
//! `display:` or a control character would wreck a 300px window. Everything is
//! bounded and stripped on the way in, and anything malformed yields None rather
//! than a half-rendered identity.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// Longest display name worth rendering in a 300px list row.
const MAX_DISPLAY: usize = 32;
/// Longest `bot:` slug we will echo back.
const MAX_SLUG: usize = 48;
/// A Botfile bigger than this is not a Botfile.
const MAX_FILE_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Botfile {
    /// Canonical lowercase identifier (`bot:`).
    pub bot: String,
    /// Human-facing name (`display:`), falling back to the slug.
    pub display: String,
    /// Single emoji (`emoji:`), if the file declares a usable one.
    pub emoji: Option<String>,
    /// Handle of the human operator (`owner:`).
    pub owner: Option<String>,
}

/// Strip anything that would corrupt a single-line label, then bound the length.
///
/// Control characters are the real hazard: a newline or an ANSI escape in a
/// display name breaks the row it is drawn in. Truncation is by CHARACTER, not
/// byte, so a multi-byte name cannot be sliced into invalid UTF-8.
fn sanitize(value: &str, max: usize) -> String {
    let cleaned: String = value
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .collect();
    cleaned.chars().take(max).collect::<String>().trim().to_string()
}

/// Is this a single emoji we are willing to draw?
///
/// Deliberately permissive about WHICH emoji and strict about how many: the
/// field is documented as one emoji, and a "display name" smuggled in through
/// the emoji slot would sit in a layout that budgets one glyph. Rejecting ASCII
/// keeps `emoji: :)` from rendering as a face-shaped hole.
fn valid_emoji(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Count by char, but allow a short ZWJ/variation-selector sequence — a
    // family or profession emoji is legitimately several code points.
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() > 8 {
        return None;
    }
    let first = chars[0];
    if first.is_ascii() || first.is_control() || first.is_whitespace() {
        return None;
    }
    Some(trimmed.to_string())
}

/// Pull `key: value` pairs out of the leading `---` frontmatter block.
///
/// Hand-rolled rather than pulling in a YAML parser: the schema is flat strings,
/// and a full parser would accept nested structures this code would then have to
/// decide how to ignore. Unknown keys are skipped, so the file can carry fields
/// (`voice`, `home`, `born`, `profile`) that Buddy has no opinion about.
fn parse_frontmatter(text: &str) -> Option<Vec<(String, String)>> {
    let mut lines = text.lines();
    // The delimiter must be the first non-empty line; otherwise there is no
    // frontmatter and we must not go hunting for `---` further down the file.
    let first = lines.by_ref().find(|l| !l.trim().is_empty())?;
    if first.trim() != "---" {
        return None;
    }
    let mut out = Vec::new();
    for line in lines {
        let trimmed = line.trim_end();
        if trimmed.trim() == "---" {
            return Some(out);
        }
        let Some((key, value)) = trimmed.split_once(':') else {
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        let mut value = value.trim().to_string();
        // Tolerate quoted values; the spec's examples are bare, but people quote.
        if value.len() >= 2 {
            let bytes = value.as_bytes();
            let quoted = (bytes[0] == b'"' && bytes[value.len() - 1] == b'"')
                || (bytes[0] == b'\'' && bytes[value.len() - 1] == b'\'');
            if quoted {
                value = value[1..value.len() - 1].to_string();
            }
        }
        if !key.is_empty() {
            out.push((key, value));
        }
    }
    // Ran off the end without a closing delimiter — treat as malformed rather
    // than guessing, so a truncated file cannot half-name an agent.
    None
}

/// Build a Botfile from raw text. Separated from IO so it can be tested.
pub fn parse_botfile(text: &str) -> Option<Botfile> {
    let fields = parse_frontmatter(text)?;
    let get = |name: &str| {
        fields
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    };

    // `bot:` is the identity. Without it there is nothing to name.
    let bot = sanitize(get("bot")?, MAX_SLUG);
    if bot.is_empty() {
        return None;
    }

    // A display name is a nicety; the slug is a fine fallback and is always present.
    let display = get("display")
        .map(|d| sanitize(d, MAX_DISPLAY))
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| bot.clone());

    Some(Botfile {
        bot,
        display,
        emoji: get("emoji").and_then(valid_emoji),
        owner: get("owner")
            .map(|o| sanitize(o.trim_start_matches('@'), MAX_SLUG))
            .filter(|o| !o.is_empty()),
    })
}

/// Read `BOT.md` from a session's working directory.
///
/// Returns None for every ordinary reason — no file, unreadable, not a Botfile —
/// because "this session has no character" is the common case and not an error.
pub fn read_botfile_at(dir: &Path) -> Option<Botfile> {
    let path: PathBuf = dir.join("BOT.md");
    // Check the size before reading: this runs for every local session on every
    // render pass, and a pathological file should cost nothing.
    let meta = fs::metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return None;
    }
    let text = fs::read_to_string(&path).ok()?;
    parse_botfile(&text)
}

#[tauri::command]
pub fn read_botfile(cwd: String) -> Option<Botfile> {
    if cwd.trim().is_empty() {
        return None;
    }
    read_botfile_at(Path::new(&cwd))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FULL: &str = r#"---
botfile: 1
bot: coltrane
display: COLTRANE
emoji: 🎷
profile: Default
home: /Users/yourname/Projects/vibe/coltrane
voice: elevenlabs/abc123
owner: brightseth
born: 2026-06-01
---

I'm the rep for the /vibe community lane.

## Habits
- Read the room before speaking.
"#;

    #[test]
    fn reads_the_documented_schema() {
        let b = parse_botfile(FULL).expect("should parse");
        assert_eq!(b.bot, "coltrane");
        assert_eq!(b.display, "COLTRANE");
        assert_eq!(b.emoji.as_deref(), Some("🎷"));
        assert_eq!(b.owner.as_deref(), Some("brightseth"));
    }

    #[test]
    fn unknown_fields_are_ignored_not_fatal() {
        // voice/home/born/profile are vibeconf's business, not Buddy's. A file
        // that grows new fields must keep working here.
        assert!(parse_botfile(FULL).is_some());
    }

    #[test]
    fn the_slug_stands_in_for_a_missing_display_name() {
        let b = parse_botfile("---\nbot: sal\n---\n").expect("should parse");
        assert_eq!(b.display, "sal");
    }

    #[test]
    fn a_file_with_no_bot_is_not_an_identity() {
        assert!(parse_botfile("---\ndisplay: Nameless\n---\n").is_none());
        assert!(parse_botfile("---\nbot:   \n---\n").is_none());
    }

    #[test]
    fn not_a_botfile_at_all() {
        assert!(parse_botfile("# Just a readme\n\nsome prose").is_none());
        assert!(parse_botfile("").is_none());
        // A `---` that is not the FIRST line is a horizontal rule, not frontmatter.
        assert!(parse_botfile("# Title\n\n---\nbot: sneaky\n---\n").is_none());
    }

    #[test]
    fn unterminated_frontmatter_is_malformed_not_partial() {
        // Half a name is worse than no name.
        assert!(parse_botfile("---\nbot: truncated\ndisplay: Half").is_none());
    }

    #[test]
    fn control_characters_cannot_break_the_row() {
        let b = parse_botfile("---\nbot: x\ndisplay: Ev\u{1b}[31mil\u{7}\n---\n").unwrap();
        assert!(!b.display.contains('\u{1b}'));
        assert!(!b.display.contains('\u{7}'));
    }

    #[test]
    fn an_overlong_display_name_is_truncated_on_a_char_boundary() {
        let long = "é".repeat(200);
        let b = parse_botfile(&format!("---\nbot: x\ndisplay: {}\n---\n", long)).unwrap();
        assert!(b.display.chars().count() <= MAX_DISPLAY);
        // Would have panicked or produced invalid UTF-8 on a byte slice.
        assert!(b.display.chars().all(|c| c == 'é'));
    }

    #[test]
    fn the_emoji_slot_cannot_smuggle_a_label() {
        assert_eq!(parse_botfile("---\nbot: x\nemoji: hello there\n---\n").unwrap().emoji, None);
        assert_eq!(parse_botfile("---\nbot: x\nemoji: :)\n---\n").unwrap().emoji, None);
        assert_eq!(parse_botfile("---\nbot: x\nemoji:\n---\n").unwrap().emoji, None);
    }

    #[test]
    fn a_multi_codepoint_emoji_still_counts_as_one() {
        // Profession and family emoji are legitimately several code points.
        let b = parse_botfile("---\nbot: x\nemoji: 👩‍💻\n---\n").unwrap();
        assert_eq!(b.emoji.as_deref(), Some("👩‍💻"));
    }

    #[test]
    fn quoted_values_are_tolerated() {
        let b = parse_botfile("---\nbot: \"sal\"\ndisplay: 'SAL'\n---\n").unwrap();
        assert_eq!(b.bot, "sal");
        assert_eq!(b.display, "SAL");
    }

    #[test]
    fn an_at_prefixed_owner_is_stored_bare() {
        let b = parse_botfile("---\nbot: x\nowner: @brightseth\n---\n").unwrap();
        assert_eq!(b.owner.as_deref(), Some("brightseth"));
    }

    #[test]
    fn a_missing_directory_is_not_an_error() {
        assert!(read_botfile_at(Path::new("/nonexistent/path/for/tests")).is_none());
    }

    /// The IO path itself, not just the parser — a real file in a real directory,
    /// because "it parses" and "we can find it on disk" are different claims.
    #[test]
    fn reads_a_real_botfile_from_a_directory() {
        let dir = std::env::temp_dir().join(format!("buddy-botfile-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("BOT.md"), FULL).unwrap();

        let b = read_botfile_at(&dir).expect("should read BOT.md from the directory");
        assert_eq!(b.display, "COLTRANE");
        assert_eq!(b.emoji.as_deref(), Some("🎷"));

        // A directory with no BOT.md is the common case, not a failure.
        let empty = dir.join("empty");
        fs::create_dir_all(&empty).unwrap();
        assert!(read_botfile_at(&empty).is_none());

        fs::remove_dir_all(&dir).ok();
    }

    /// A BOT.md that is really a 300MB log must cost nothing.
    #[test]
    fn an_oversized_file_is_refused_before_it_is_read() {
        let dir = std::env::temp_dir().join(format!("buddy-botfile-big-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let huge = format!("---\nbot: x\n---\n{}", "A".repeat((MAX_FILE_BYTES + 1) as usize));
        fs::write(dir.join("BOT.md"), huge).unwrap();
        assert!(read_botfile_at(&dir).is_none());
        fs::remove_dir_all(&dir).ok();
    }
}
