//! Hand off to vibeconf.
//!
//! Buddy does not own a call. It owns presence and messages, and when a call is
//! wanted it hands the job to the product that IS a conferencing app. This
//! module is that handoff.
//!
//! The local app is reached through its bundled MCP server over stdio. The
//! health endpoint is only a liveness probe; room creation remains an MCP tool.

use serde::Serialize;
use serde_json::{json, Value};
use std::env;
use std::ffi::OsStr;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const PORT_START: u16 = 7865;
const PORT_SPAN: u16 = 10;
const HEALTH_PATH: &str = "/api/sync/no-room";
const MCP_APP_RELATIVE: &str =
    "Vibeconferencing.app/Contents/Resources/mcp-server/server.js";
const CALL_TIMEOUT: Duration = Duration::from_secs(60);
const AVAILABILITY_TIMEOUT: Duration = Duration::from_secs(4);
const PROBE_TIMEOUT: Duration = Duration::from_millis(400);
const MAX_BRIDGE_LINE_BYTES: usize = 1024 * 1024;
const BRIDGE_CHANNEL_CAPACITY: usize = 8;

const INITIALIZE_REQUEST: &str = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"vibe-buddy","version":"1"}}}"#;
const INITIALIZED_NOTIFICATION: &str =
    r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
const START_CALL_REQUEST: &str = r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"start_call","arguments":{}}}"#;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct CallInfo {
    /// Full join URL, for the clipboard and for display.
    pub url: String,
    /// Meet code alone, which is what `/join-call <code>` wants.
    pub code: String,
}

fn remaining_before(deadline: Instant) -> Option<Duration> {
    deadline.checked_duration_since(Instant::now())
}

/// Probe within an existing operation deadline. A call's 60 seconds begins
/// before this function, so ten slow ports cannot silently add four more
/// seconds after the advertised deadline.
fn probe_available_before(deadline: Instant) -> Option<u16> {
    let client = reqwest::blocking::Client::builder().build().ok()?;

    for port in PORT_START..PORT_START + PORT_SPAN {
        let remaining = remaining_before(deadline)?;
        if remaining.is_zero() {
            return None;
        }
        let url = format!("http://127.0.0.1:{}{}", port, HEALTH_PATH);
        if let Ok(resp) = client
            .get(&url)
            .timeout(remaining.min(PROBE_TIMEOUT))
            .send()
        {
            if resp.status().is_success() {
                return Some(port);
            }
        }
    }
    None
}

/// Is the Vibeconferencing app usable on this machine right now?
///
/// The affordance is hidden unless all three prerequisites are true: its
/// health endpoint answers, its bundled MCP server exists, and a Node runtime
/// can actually launch that server. A health response alone is not enough.
#[tauri::command]
pub fn vibeconf_available() -> Option<u16> {
    let deadline = Instant::now() + AVAILABILITY_TIMEOUT;
    mcp_server_path()?;
    node_binary()?;
    probe_available_before(deadline)
}

/// The seat app's own report of its call state, read from the same sync
/// endpoint the liveness probe uses. Every field is optional on our side:
/// the endpoint belongs to the seat app and its shape may move under us
/// (a vibeconf-app contract note), so an absent or unrecognized field degrades to
/// `running` (app up, call state unreadable) — never to a guess.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SeatState {
    /// No port answered with connection refused everywhere: the app is down.
    Closed,
    /// We could not complete the read — which is not evidence of anything.
    Unknown,
    /// App up, no call ('idle' or 'left').
    Idle,
    /// App up and entering a room — not seated yet.
    Joining { room: Option<String> },
    /// App up and in a room, by its own report.
    InCall { room: String },
    /// App up but the response shape told us nothing we recognize.
    Running,
}

fn parse_seat_state(body: &Value) -> SeatState {
    let room = body
        .get("roomId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let status = body
        .get("status")
        .and_then(|s| s.get("callStatus"))
        .and_then(Value::as_str);
    match status {
        Some("idle") | Some("left") => SeatState::Idle,
        Some("joining") | Some("waiting-to-be-admitted") => SeatState::Joining { room },
        Some("in-call") => match room {
            Some(room) => SeatState::InCall { room },
            // "in a call, in no room" is a shape we don't understand.
            None => SeatState::Running,
        },
        _ => SeatState::Running,
    }
}

/// The seat app's full port territory: the default instance (7865), the
/// legacy span, and manual profiles (7870–7899 per its profile-manager,
/// which stays below the test fleet's 7901). Scanning short of this reported
/// a running profile as Closed — the codex review's P2.
const PROFILE_PORT_MAX: u16 = 7899;

/// Fold every responding profile's state into one answer for rung ③.
///
/// Multiple profiles can run at once, so "the first port that answered" is
/// not the seat state — an idle default instance must not mask a named
/// profile that is in a call (codex P1). Order of claims: a seat in a room
/// beats one joining, and an unreadable running profile beats Idle, because
/// an unreadable seat COULD be in a call and Idle would deny it.
/// `saw_non_refusal` records any attempt that failed some way other than
/// connection-refused: with zero responses that is Unknown, never Closed.
fn aggregate_seat_states(states: &[SeatState], saw_non_refusal: bool) -> SeatState {
    if let Some(in_call) = states.iter().find(|s| matches!(s, SeatState::InCall { .. })) {
        return in_call.clone();
    }
    if let Some(joining) = states.iter().find(|s| matches!(s, SeatState::Joining { .. })) {
        return joining.clone();
    }
    if states.iter().any(|s| matches!(s, SeatState::Running)) || (saw_non_refusal && !states.is_empty()) {
        return SeatState::Running;
    }
    if states.iter().any(|s| matches!(s, SeatState::Idle)) {
        return SeatState::Idle;
    }
    if saw_non_refusal {
        SeatState::Unknown
    } else {
        SeatState::Closed
    }
}

#[tauri::command]
pub fn vibeconf_seat_state() -> SeatState {
    let deadline = Instant::now() + AVAILABILITY_TIMEOUT;
    let Ok(client) = reqwest::blocking::Client::builder().build() else {
        return SeatState::Unknown;
    };
    let mut states: Vec<SeatState> = Vec::new();
    let mut saw_non_refusal = false;
    for port in PORT_START..=PROFILE_PORT_MAX {
        let Some(remaining) = remaining_before(deadline) else {
            // Deadline mid-scan: unscanned ports could hold anything, so a
            // partial scan can claim what it SAW but never Closed.
            saw_non_refusal = true;
            break;
        };
        if remaining.is_zero() {
            saw_non_refusal = true;
            break;
        }
        let url = format!("http://127.0.0.1:{}{}", port, HEALTH_PATH);
        match client.get(&url).timeout(remaining.min(PROBE_TIMEOUT)).send() {
            Ok(resp) if resp.status().is_success() => {
                let state = match resp.text().ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
                    Some(body) => parse_seat_state(&body),
                    None => SeatState::Running,
                };
                states.push(state);
            }
            Ok(_) => saw_non_refusal = true,
            Err(err) => {
                if !err.is_connect() {
                    saw_non_refusal = true;
                }
            }
        }
    }
    aggregate_seat_states(&states, saw_non_refusal)
}

#[cfg(test)]
mod seat_state_tests {
    use super::*;

    fn body(json: &str) -> Value {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn in_call_with_room_is_in_call() {
        assert_eq!(
            parse_seat_state(&body(
                r#"{"roomId":"abc-defg-hij","status":{"callStatus":"in-call"}}"#
            )),
            SeatState::InCall { room: "abc-defg-hij".into() }
        );
    }

    #[test]
    fn joining_and_waiting_are_joining_not_seated() {
        assert_eq!(
            parse_seat_state(&body(r#"{"roomId":"x","status":{"callStatus":"joining"}}"#)),
            SeatState::Joining { room: Some("x".into()) }
        );
        assert_eq!(
            parse_seat_state(&body(
                r#"{"status":{"callStatus":"waiting-to-be-admitted"}}"#
            )),
            SeatState::Joining { room: None }
        );
    }

    #[test]
    fn idle_and_left_are_idle() {
        assert_eq!(
            parse_seat_state(&body(r#"{"status":{"callStatus":"idle"}}"#)),
            SeatState::Idle
        );
        assert_eq!(
            parse_seat_state(&body(r#"{"roomId":"","status":{"callStatus":"left"}}"#)),
            SeatState::Idle
        );
    }

    #[test]
    fn an_idle_default_never_masks_an_in_call_profile() {
        // The codex P1: first-port-wins made the lowest port define every
        // row's seat state. Aggregation must let any in-call profile win.
        let states = [
            SeatState::Idle,
            SeatState::InCall { room: "abc-defg-hij".into() },
        ];
        assert_eq!(
            aggregate_seat_states(&states, false),
            SeatState::InCall { room: "abc-defg-hij".into() }
        );
    }

    #[test]
    fn an_unreadable_profile_beats_idle_because_it_could_be_in_a_call() {
        let states = [SeatState::Idle, SeatState::Running];
        assert_eq!(aggregate_seat_states(&states, false), SeatState::Running);
        // A non-refusal failure alongside an Idle response is the same doubt.
        assert_eq!(aggregate_seat_states(&[SeatState::Idle], true), SeatState::Running);
    }

    #[test]
    fn joining_outranks_idle_but_not_in_call() {
        let states = [SeatState::Idle, SeatState::Joining { room: None }];
        assert_eq!(aggregate_seat_states(&states, false), SeatState::Joining { room: None });
    }

    #[test]
    fn no_responses_is_closed_only_when_every_attempt_was_refused() {
        assert_eq!(aggregate_seat_states(&[], false), SeatState::Closed);
        assert_eq!(aggregate_seat_states(&[], true), SeatState::Unknown);
    }

    #[test]
    fn unrecognized_or_missing_shape_degrades_to_running_never_a_guess() {
        assert_eq!(parse_seat_state(&body(r#"{}"#)), SeatState::Running);
        assert_eq!(
            parse_seat_state(&body(r#"{"status":{"callStatus":"astral-projection"}}"#)),
            SeatState::Running
        );
        // in-call with no room is a shape we do not understand.
        assert_eq!(
            parse_seat_state(&body(r#"{"status":{"callStatus":"in-call"}}"#)),
            SeatState::Running
        );
    }
}

fn add_unique(candidates: &mut Vec<PathBuf>, candidate: PathBuf) {
    if !candidates.contains(&candidate) {
        candidates.push(candidate);
    }
}

fn versioned_node_candidates(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut candidates: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path().join("bin/node"))
        .collect();
    // Prefer the newest-looking installed version, while still trying every
    // installation if the directory names are not semver-sortable.
    candidates.sort_by(|a, b| b.cmp(a));
    candidates
}

fn node_candidates(home: Option<&Path>, path_env: Option<&OsStr>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(home) = home {
        add_unique(&mut candidates, home.join(".volta/bin/node"));
        add_unique(&mut candidates, home.join(".nvm/current/bin/node"));
        for candidate in versioned_node_candidates(&home.join(".nvm/versions/node")) {
            add_unique(&mut candidates, candidate);
        }
        add_unique(&mut candidates, home.join(".asdf/shims/node"));
        for candidate in versioned_node_candidates(&home.join(".asdf/installs/nodejs")) {
            add_unique(&mut candidates, candidate);
        }
    }

    for candidate in [
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
        PathBuf::from("/usr/bin/node"),
    ] {
        add_unique(&mut candidates, candidate);
    }

    if let Some(path_env) = path_env {
        for directory in env::split_paths(path_env) {
            add_unique(&mut candidates, directory.join("node"));
        }
    }

    candidates
}

fn resolve_node_with(
    home: Option<&Path>,
    path_env: Option<&OsStr>,
    exists: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    node_candidates(home, path_env)
        .into_iter()
        .find(|candidate| exists(candidate))
}

/// Resolve Node without trusting Finder's minimal PATH. The explicit manager
/// locations cover nvm, asdf and Volta, including versioned nvm/asdf installs.
fn node_binary() -> Option<PathBuf> {
    let home = dirs::home_dir();
    let path_env = env::var_os("PATH");
    resolve_node_with(home.as_deref(), path_env.as_deref(), Path::is_file)
}

fn mcp_server_candidates(home: Option<&Path>) -> Vec<PathBuf> {
    let mut candidates = vec![PathBuf::from("/Applications").join(MCP_APP_RELATIVE)];
    if let Some(home) = home {
        candidates.push(home.join("Applications").join(MCP_APP_RELATIVE));
    }
    candidates
}

fn resolve_mcp_server_with(
    home: Option<&Path>,
    exists: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    mcp_server_candidates(home)
        .into_iter()
        .find(|candidate| exists(candidate))
}

fn mcp_server_path() -> Option<PathBuf> {
    let home = dirs::home_dir();
    resolve_mcp_server_with(home.as_deref(), Path::is_file)
}

/// Pull a Meet code out of whatever prose the tool returns.
fn extract_meet_code(text: &str) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() < 12 {
        return None;
    }
    let lower = |c: char| c.is_ascii_lowercase();
    let boundary = |c: char| !(c.is_ascii_alphanumeric() || c == '-');

    for start in 0..=chars.len() - 12 {
        let shaped = chars[start..start + 3].iter().copied().all(lower)
            && chars[start + 3] == '-'
            && chars[start + 4..start + 8].iter().copied().all(lower)
            && chars[start + 8] == '-'
            && chars[start + 9..start + 12].iter().copied().all(lower);
        if !shaped {
            continue;
        }
        let before_ok = start == 0 || boundary(chars[start - 1]);
        let after_ok = chars.get(start + 12).copied().map_or(true, boundary);
        if before_ok && after_ok {
            return Some(chars[start..start + 12].iter().collect());
        }
    }
    None
}

/// The process surface is injected into the protocol runner. Production uses
/// `OsBridgeChild`; tests use an in-memory child whose pipes can break, block or
/// outlive their parent without launching the real conferencing app.
trait BridgeChild {
    type Input: Write;
    type Output: Read + Send + 'static;

    fn take_stdin(&mut self) -> Option<Self::Input>;
    fn take_stdout(&mut self) -> Option<Self::Output>;
    fn terminate_and_wait(&mut self);
}

struct OsBridgeChild {
    child: Child,
}

impl BridgeChild for OsBridgeChild {
    type Input = ChildStdin;
    type Output = ChildStdout;

    fn take_stdin(&mut self) -> Option<Self::Input> {
        self.child.stdin.take()
    }

    fn take_stdout(&mut self) -> Option<Self::Output> {
        self.child.stdout.take()
    }

    fn terminate_and_wait(&mut self) {
        // The bridge is launched as its own process group. Kill that group
        // first so a descendant which inherited stdout cannot keep the reader
        // thread blocked forever after the direct child exits.
        #[cfg(unix)]
        kill_process_group(self.child.id());
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(unix)]
fn kill_process_group(pid: u32) {
    use std::os::raw::c_int;

    extern "C" {
        fn kill(pid: c_int, signal: c_int) -> c_int;
    }

    const SIGKILL: c_int = 9;
    if pid <= c_int::MAX as u32 {
        // SAFETY: `pid` is the id returned by Child, and spawn_bridge places
        // that child in a process group whose id is the same pid. A negative id
        // asks POSIX kill(2) to signal only that group, never Buddy's group.
        unsafe {
            let _ = kill(-(pid as c_int), SIGKILL);
        }
    }
}

/// Owns the child from the instant spawn succeeds. Drop is the one exit door:
/// close/kill the process tree, reap the direct child, then join the retained
/// reader. This covers every `?`, including missing pipes and broken writes.
struct ChildGuard<C: BridgeChild> {
    child: C,
    reader: Option<JoinHandle<()>>,
}

impl<C: BridgeChild> ChildGuard<C> {
    fn new(child: C) -> Self {
        Self {
            child,
            reader: None,
        }
    }

    fn set_reader(&mut self, reader: JoinHandle<()>) {
        self.reader = Some(reader);
    }
}

impl<C: BridgeChild> Drop for ChildGuard<C> {
    fn drop(&mut self) {
        self.child.terminate_and_wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

enum ReaderEvent {
    Line(String),
    Failure(String),
}

/// Read one UTF-8 line without allowing `BufRead::lines()` to allocate until a
/// newline chosen by the child. At most one MiB is accumulated for any frame.
fn read_bounded_line<R: BufRead>(reader: &mut R) -> io::Result<Option<String>> {
    let mut line = Vec::new();

    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            if line.is_empty() {
                return Ok(None);
            }
            break;
        }

        if let Some(newline) = available.iter().position(|byte| *byte == b'\n') {
            if line.len() + newline > MAX_BRIDGE_LINE_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "bridge line exceeded 1 MiB",
                ));
            }
            line.extend_from_slice(&available[..newline]);
            reader.consume(newline + 1);
            break;
        }

        if line.len() + available.len() > MAX_BRIDGE_LINE_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "bridge line exceeded 1 MiB",
            ));
        }
        let consumed = available.len();
        line.extend_from_slice(available);
        reader.consume(consumed);
    }

    if line.last() == Some(&b'\r') {
        line.pop();
    }
    String::from_utf8(line)
        .map(Some)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "bridge emitted non-UTF-8"))
}

fn spawn_reader<R: Read + Send + 'static>(
    stdout: R,
    tx: SyncSender<ReaderEvent>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_bounded_line(&mut reader) {
                Ok(Some(line)) => {
                    // A sync channel bounds total queued output. If the caller
                    // returns, dropping its receiver releases this blocked send.
                    if tx.send(ReaderEvent::Line(line)).is_err() {
                        return;
                    }
                }
                Ok(None) => return,
                Err(error) => {
                    let _ = tx.send(ReaderEvent::Failure(error.to_string()));
                    return;
                }
            }
        }
    })
}

fn write_frame(writer: &mut impl Write, frame: &str) -> Result<(), String> {
    writer
        .write_all(frame.as_bytes())
        .and_then(|_| writer.write_all(b"\n"))
        .and_then(|_| writer.flush())
        .map_err(|error| format!("could not talk to the bridge: {error}"))
}

fn receive_response(
    rx: &Receiver<ReaderEvent>,
    expected_id: u64,
    deadline: Instant,
) -> Result<Value, String> {
    loop {
        let remaining = remaining_before(deadline)
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(|| "timed out waiting for Vibeconferencing".to_string())?;

        match rx.recv_timeout(remaining) {
            Ok(ReaderEvent::Line(line)) => {
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if message.get("id").and_then(Value::as_u64) == Some(expected_id) {
                    return Ok(message);
                }
            }
            Ok(ReaderEvent::Failure(error)) => {
                return Err(format!("invalid output from Vibeconferencing bridge: {error}"));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return Err("timed out waiting for Vibeconferencing".into());
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("the Vibeconferencing bridge closed unexpectedly".into());
            }
        }
    }
}

fn response_error(message: &Value, fallback: &str) -> Option<String> {
    message.get("error").map(|error| {
        error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or(fallback)
            .to_string()
    })
}

fn run_bridge<C: BridgeChild>(
    child: C,
    deadline: Instant,
    context: Option<&str>,
) -> Result<CallInfo, String> {
    let mut guard = ChildGuard::new(child);
    let mut stdin = guard.child.take_stdin().ok_or("no stdin on bridge")?;
    let stdout = guard.child.take_stdout().ok_or("no stdout on bridge")?;
    let (tx, rx) = mpsc::sync_channel::<ReaderEvent>(BRIDGE_CHANNEL_CAPACITY);
    guard.set_reader(spawn_reader(stdout, tx));

    // MCP initialization is a state transition, not a packet prelude. A strict
    // server is allowed to reject calls sent before its initialize response.
    write_frame(&mut stdin, INITIALIZE_REQUEST)?;
    let initialized = receive_response(&rx, 1, deadline)?;
    if let Some(error) = response_error(&initialized, "initialization was rejected") {
        return Err(format!("Vibeconferencing rejected initialization: {error}"));
    }
    if initialized.get("result").is_none() {
        return Err("Vibeconferencing returned an invalid initialize response".into());
    }

    write_frame(&mut stdin, INITIALIZED_NOTIFICATION)?;
    write_frame(&mut stdin, START_CALL_REQUEST)?;

    let response = receive_response(&rx, 2, deadline)?;
    if let Some(error) = response_error(&response, "the call could not be started") {
        return Err(error);
    }
    let text = response
        .pointer("/result/content/0/text")
        .and_then(Value::as_str)
        .unwrap_or("");
    let code = extract_meet_code(text)
        .ok_or_else(|| "the call started but returned no joinable link".to_string())?;

    // Seed the room with what it is about.
    //
    // A call started from a coding session should arrive pre-explained rather
    // than as an empty room someone has to talk their way into. The session
    // already IS the context — project, directory, what you are working on — so
    // it becomes the room's first artifact.
    //
    // Best effort by design: the call is already minted and the user's browser
    // is opening. Failing the whole operation because a courtesy message did
    // not post would trade the thing that worked for the thing that did not.
    if let Some(context) = context.filter(|c| !c.trim().is_empty()) {
        let request = json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": { "name": "send_chat", "arguments": { "text": context } }
        })
        .to_string();
        if write_frame(&mut stdin, &request).is_ok() {
            let _ = receive_response(&rx, 3, deadline);
        }
    }

    Ok(CallInfo {
        url: format!("https://meet.google.com/{code}"),
        code,
    })
}

fn spawn_bridge(node: &Path, mcp_server: &Path) -> Result<OsBridgeChild, String> {
    let mut command = Command::new(node);
    command
        .arg(mcp_server)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Descendants inherit this isolated group. ChildGuard can therefore
        // close every inherited stdout writer before joining the reader.
        command.process_group(0);
    }

    let child = command
        .spawn()
        .map_err(|error| format!("could not start the Vibeconferencing bridge: {error}"))?;
    Ok(OsBridgeChild { child })
}

/// Start a brand-new call: mint a Meet, send the user's bot in, and open the
/// browser. The deadline begins before the health probe and is passed unchanged
/// through spawn, initialization and the tool call.
#[tauri::command]
pub fn vibeconf_start_call(context: Option<String>) -> Result<CallInfo, String> {
    let deadline = Instant::now() + CALL_TIMEOUT;
    let mcp_server = mcp_server_path().ok_or(
        "Vibeconferencing app not found in /Applications or ~/Applications",
    )?;
    let node = node_binary().ok_or(
        "node not found — checked Homebrew, PATH, nvm, asdf and Volta",
    )?;

    if probe_available_before(deadline).is_none() {
        if remaining_before(deadline).is_none() {
            return Err("timed out checking Vibeconferencing".into());
        }
        return Err("Vibeconferencing isn't running on this Mac".into());
    }
    if remaining_before(deadline).is_none() {
        return Err("timed out before the Vibeconferencing bridge could start".into());
    }

    let child = spawn_bridge(&node, &mcp_server)?;
    run_bridge(child, deadline, context.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Arc, Condvar, Mutex};

    #[derive(Default)]
    struct FakeState {
        terminated: AtomicBool,
        reaped: AtomicBool,
        reader_finished: AtomicBool,
        released: Mutex<bool>,
        released_cv: Condvar,
        writes: Mutex<Vec<u8>>,
    }

    struct FakeInput {
        state: Arc<FakeState>,
        broken: bool,
    }

    impl Write for FakeInput {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if self.broken {
                return Err(io::Error::new(io::ErrorKind::BrokenPipe, "bridge exited"));
            }
            self.state.writes.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            if self.broken {
                Err(io::Error::new(io::ErrorKind::BrokenPipe, "bridge exited"))
            } else {
                Ok(())
            }
        }
    }

    struct TrackedReader<R> {
        inner: R,
        state: Arc<FakeState>,
    }

    impl<R: Read> Read for TrackedReader<R> {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            self.inner.read(buffer)
        }
    }

    impl<R> Drop for TrackedReader<R> {
        fn drop(&mut self) {
            self.state.reader_finished.store(true, Ordering::SeqCst);
        }
    }

    struct BlockingReader {
        prefix: Vec<u8>,
        position: usize,
        state: Arc<FakeState>,
    }

    impl Read for BlockingReader {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            if self.position < self.prefix.len() {
                let count = buffer.len().min(self.prefix.len() - self.position);
                buffer[..count]
                    .copy_from_slice(&self.prefix[self.position..self.position + count]);
                self.position += count;
                return Ok(count);
            }

            let mut released = self.state.released.lock().unwrap();
            while !*released {
                released = self.state.released_cv.wait(released).unwrap();
            }
            Ok(0)
        }
    }

    impl Drop for BlockingReader {
        fn drop(&mut self) {
            self.state.reader_finished.store(true, Ordering::SeqCst);
        }
    }

    struct FakeChild {
        input: Option<FakeInput>,
        output: Option<Box<dyn Read + Send>>,
        state: Arc<FakeState>,
    }

    impl FakeChild {
        fn finite(output: Vec<u8>) -> (Self, Arc<FakeState>) {
            let state = Arc::new(FakeState::default());
            let reader = TrackedReader {
                inner: Cursor::new(output),
                state: state.clone(),
            };
            (
                Self {
                    input: Some(FakeInput {
                        state: state.clone(),
                        broken: false,
                    }),
                    output: Some(Box::new(reader)),
                    state: state.clone(),
                },
                state,
            )
        }

        fn blocking(prefix: Vec<u8>, broken_input: bool) -> (Self, Arc<FakeState>) {
            let state = Arc::new(FakeState::default());
            let reader = BlockingReader {
                prefix,
                position: 0,
                state: state.clone(),
            };
            (
                Self {
                    input: Some(FakeInput {
                        state: state.clone(),
                        broken: broken_input,
                    }),
                    output: Some(Box::new(reader)),
                    state: state.clone(),
                },
                state,
            )
        }
    }

    impl BridgeChild for FakeChild {
        type Input = FakeInput;
        type Output = Box<dyn Read + Send>;

        fn take_stdin(&mut self) -> Option<Self::Input> {
            self.input.take()
        }

        fn take_stdout(&mut self) -> Option<Self::Output> {
            self.output.take()
        }

        fn terminate_and_wait(&mut self) {
            self.state.terminated.store(true, Ordering::SeqCst);
            *self.state.released.lock().unwrap() = true;
            self.state.released_cv.notify_all();
            self.state.reaped.store(true, Ordering::SeqCst);
        }
    }

    fn assert_cleaned_up(state: &FakeState) {
        assert!(state.terminated.load(Ordering::SeqCst));
        assert!(state.reaped.load(Ordering::SeqCst));
        assert!(state.reader_finished.load(Ordering::SeqCst));
    }

    fn short_deadline() -> Instant {
        Instant::now() + Duration::from_millis(100)
    }

    #[test]
    fn broken_pipe_does_not_leave_bridge_child_unreaped() {
        let (child, state) = FakeChild::blocking(Vec::new(), true);
        let error = run_bridge(child, short_deadline(), None).unwrap_err();

        assert!(error.contains("could not talk to the bridge"));
        assert_cleaned_up(&state);
    }

    #[test]
    fn missing_pipes_do_not_bypass_the_reaper_on_early_return() {
        let (mut no_stdin, stdin_state) = FakeChild::finite(Vec::new());
        no_stdin.input = None;
        assert!(run_bridge(no_stdin, short_deadline(), None)
            .unwrap_err()
            .contains("no stdin"));
        assert!(stdin_state.terminated.load(Ordering::SeqCst));
        assert!(stdin_state.reaped.load(Ordering::SeqCst));

        let (mut no_stdout, stdout_state) = FakeChild::finite(Vec::new());
        no_stdout.output = None;
        assert!(run_bridge(no_stdout, short_deadline(), None)
            .unwrap_err()
            .contains("no stdout"));
        assert!(stdout_state.terminated.load(Ordering::SeqCst));
        assert!(stdout_state.reaped.load(Ordering::SeqCst));
    }

    #[test]
    fn partial_line_cannot_outlive_the_end_to_end_deadline() {
        let partial = br#"{"jsonrpc":"2.0","id":1,"result":{}}"#.to_vec();
        let (child, state) = FakeChild::blocking(partial, false);
        let error = run_bridge(child, short_deadline(), None).unwrap_err();

        assert!(error.contains("timed out"));
        assert_cleaned_up(&state);
    }

    #[test]
    fn oversized_output_is_rejected_before_it_can_grow_without_bound() {
        let mut output = vec![b'x'; MAX_BRIDGE_LINE_BYTES + 1];
        output.push(b'\n');
        let (child, state) = FakeChild::finite(output);
        let error = run_bridge(child, short_deadline(), None).unwrap_err();

        assert!(error.contains("exceeded 1 MiB"));
        assert_cleaned_up(&state);
    }

    #[test]
    fn silent_bridge_times_out_and_is_reaped() {
        let (child, state) = FakeChild::blocking(Vec::new(), false);
        let error = run_bridge(child, short_deadline(), None).unwrap_err();

        assert!(error.contains("timed out"));
        assert_cleaned_up(&state);
    }

    #[test]
    fn descendant_held_stdout_is_closed_before_the_reader_is_joined() {
        let initialize = b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n".to_vec();
        let (child, state) = FakeChild::blocking(initialize, false);
        let error = run_bridge(child, short_deadline(), None).unwrap_err();

        assert!(error.contains("timed out"));
        assert_cleaned_up(&state);
        let writes = String::from_utf8(state.writes.lock().unwrap().clone()).unwrap();
        assert!(writes.contains("tools/call"));
    }

    #[test]
    fn initialize_rejection_never_sends_the_tool_call() {
        let output = b"{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"message\":\"unsupported\"}}\n".to_vec();
        let (child, state) = FakeChild::finite(output);
        let error = run_bridge(child, short_deadline(), None).unwrap_err();

        assert!(error.contains("rejected initialization: unsupported"));
        let writes = String::from_utf8(state.writes.lock().unwrap().clone()).unwrap();
        assert!(writes.contains("initialize"));
        assert!(!writes.contains("tools/call"));
        assert_cleaned_up(&state);
    }

    #[test]
    fn tool_call_is_sent_only_after_initialize_succeeds() {
        let output = concat!(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"content\":[{\"text\":\"Join abc-defg-hij\"}]}}\n"
        )
        .as_bytes()
        .to_vec();
        let (child, state) = FakeChild::finite(output);
        let call = run_bridge(child, short_deadline(), None).unwrap();

        assert_eq!(call.code, "abc-defg-hij");
        let writes = String::from_utf8(state.writes.lock().unwrap().clone()).unwrap();
        assert!(writes.find("initialize").unwrap() < writes.find("tools/call").unwrap());
        assert_cleaned_up(&state);
    }

    #[test]
    fn room_context_is_posted_after_the_call_is_minted() {
        // A call started from a coding session should arrive pre-explained.
        // The seed must be sent AFTER start_call — there is no room to post
        // into before one exists.
        let output = concat!(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"content\":[{\"text\":\"Join abc-defg-hij\"}]}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{\"content\":[{\"text\":\"ok\"}]}}\n"
        )
        .as_bytes()
        .to_vec();
        let (child, state) = FakeChild::finite(output);
        let call = run_bridge(child, short_deadline(), Some("working on: platform")).unwrap();

        assert_eq!(call.code, "abc-defg-hij");
        let writes = String::from_utf8(state.writes.lock().unwrap().clone()).unwrap();
        assert!(writes.contains("send_chat"), "context should be posted into the room");
        assert!(
            writes.find("start_call").unwrap() < writes.find("send_chat").unwrap(),
            "the room must exist before we post into it"
        );
        assert_cleaned_up(&state);
    }

    #[test]
    fn a_seed_that_never_answers_does_not_lose_the_call() {
        // The call is minted and the browser is already opening. Failing the
        // whole operation because a courtesy message went unanswered would
        // throw away the part that worked.
        let output = concat!(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"content\":[{\"text\":\"Join xyz-qrst-uvw\"}]}}\n"
        )
        .as_bytes()
        .to_vec();
        let (child, state) = FakeChild::finite(output);
        let call = run_bridge(child, short_deadline(), Some("context")).unwrap();

        assert_eq!(call.code, "xyz-qrst-uvw");
        assert_cleaned_up(&state);
    }

    #[test]
    fn finder_node_resolution_includes_nvm_asdf_and_volta() {
        static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);
        let home = env::temp_dir().join(format!(
            "vibe-buddy-node-test-{}-{}",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        let nvm = home.join(".nvm/versions/node/v22.1.0/bin/node");
        let asdf = home.join(".asdf/installs/nodejs/20.0.0/bin/node");
        let volta = home.join(".volta/bin/node");
        std::fs::create_dir_all(nvm.parent().unwrap()).unwrap();
        std::fs::create_dir_all(asdf.parent().unwrap()).unwrap();
        std::fs::create_dir_all(volta.parent().unwrap()).unwrap();
        std::fs::write(&nvm, b"").unwrap();
        std::fs::write(&asdf, b"").unwrap();
        std::fs::write(&volta, b"").unwrap();

        let candidates = node_candidates(Some(&home), None);
        assert!(candidates.contains(&nvm));
        assert!(candidates.contains(&asdf));
        assert!(candidates.contains(&volta));
        assert_eq!(
            resolve_node_with(Some(&home), None, |candidate| candidate == nvm.as_path()),
            Some(nvm)
        );

        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn user_applications_install_is_resolved() {
        let home = Path::new("/Users/tester");
        let expected = home.join("Applications").join(MCP_APP_RELATIVE);
        assert_eq!(
            resolve_mcp_server_with(Some(home), |candidate| candidate == expected.as_path()),
            Some(expected)
        );
    }

    #[test]
    fn finds_a_meet_code_in_prose() {
        assert_eq!(
            extract_meet_code("Call started! Join at https://meet.google.com/abc-defg-hij now"),
            Some("abc-defg-hij".to_string())
        );
    }

    #[test]
    fn finds_a_bare_code() {
        assert_eq!(
            extract_meet_code("code: xyz-qrst-uvw"),
            Some("xyz-qrst-uvw".to_string())
        );
    }

    #[test]
    fn rejects_text_with_no_code() {
        assert_eq!(extract_meet_code("The call could not be started."), None);
    }

    #[test]
    fn ignores_hyphenated_words_of_the_wrong_shape() {
        assert_eq!(extract_meet_code("a well-considered-thing here"), None);
    }
}
