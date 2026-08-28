//! Private Personal Mind transport.
//!
//! The renderer may provide only the active draft or the recent visible
//! thread excerpt it already holds. The bearer stays in the native process,
//! the destination is fixed to Seth's private Tailnet Studio, and every
//! failure becomes silence. Nothing in this module talks to slashvibe.dev.

use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

// The canonical binary knows exactly ONE origin: loopback. A person's Mind
// is a LOCAL capability awakened on their own machine (awaken.py binds
// 127.0.0.1 only). There is NO compiled fallback to anyone else's endpoint —
// a fallback list meant every canonical install would transmit a stranger's
// draft to the founder's Tailnet when nothing listened locally (review on
// #12: the auth would refuse it, but the bytes had already left the machine).
//
// A personal REMOTE Mind (the founder's always-on Studio, a future user's
// own server) must be EXPLICITLY activated: a private, mode-checked local
// file naming the endpoint — same posture as the bearer token, stored for
// this principal on this machine, never compiled into the product.
// NO ORIGIN IS COMPILED AT ALL (round-2 P1): even loopback-by-default let
// any local process bind 127.0.0.1:7788 and receive the bearer and a private
// draft. The ONLY origin ever dialed is the explicitly-activated endpoint
// from ~/.vibe/mind/endpoint (0600, no symlink, private-range IPv4) — the
// awakening writes that file next to the token it mints, so a working local
// Mind and its activation are created as one act. No file, no dial: an
// unactivated machine's Mind path is simply unreachable, which is the
// correct default for every machine that never opted in.
//
// Residual risk, stated honestly: if the activated local server dies and a
// hostile local process grabs the port before launchd (KeepAlive) respawns
// it, one request window exists. That requires local code execution, at
// which point the token file itself is readable anyway.

fn endpoint_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".vibe/mind/endpoint"))
}

/// The explicitly-activated personal endpoint, if any — read from disk and
/// validated by `personal_endpoint_from`, which the tests call DIRECTLY so
/// the exact production validator is the thing pinned.
fn personal_endpoint() -> Option<String> {
    personal_endpoint_from(&endpoint_path()?)
}

/// Applies the same refusals as the token read (no symlink, no group/other
/// bits) and then parses the origin ONCE with the same `url` crate reqwest
/// uses — validating with a hand-rolled splitter while reqwest parses for
/// real is exactly how `http://10.0.0.1:pw@attacker.example` walks through
/// (review P1). Requirements: plain http, EMPTY credentials, an IPv4 host in
/// a private range (loopback / RFC1918 / CGNAT 100.64/10), an explicit port,
/// and nothing else — no path beyond "/", no query, no fragment.
fn personal_endpoint_from(path: &Path) -> Option<String> {
    let meta = fs::symlink_metadata(path).ok()?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o077 != 0 {
            return None;
        }
    }
    let raw = fs::read_to_string(path).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 128 || trimmed.chars().any(char::is_whitespace) {
        return None;
    }
    let parsed = url::Url::parse(trimmed).ok()?;
    if parsed.scheme() != "http"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !matches!(parsed.path(), "" | "/")
    {
        return None;
    }
    let host = match parsed.host()? {
        url::Host::Ipv4(ip) => ip,
        _ => return None, // hostnames and IPv6 are refused outright
    };
    let o = host.octets();
    let private = o[0] == 127
        || o[0] == 10
        || (o[0] == 192 && o[1] == 168)
        || (o[0] == 172 && (16..=31).contains(&o[1]))
        || (o[0] == 100 && (64..=127).contains(&o[1])); // CGNAT — Tailscale
    if !private {
        return None;
    }
    let port = parsed.port()?; // explicit port required
    Some(format!("http://{}:{}", host, port))
}

fn mind_origins() -> Vec<String> {
    personal_endpoint().into_iter().collect()
}
const MAX_HANDLE_BYTES: usize = 64;
const MAX_DRAFT_BYTES: usize = 4_000;
const MAX_CONTEXT_BYTES: usize = 2_000;
const MAX_RESPONSE_BYTES: u64 = 256 * 1024;

#[derive(Serialize)]
struct MindRequest<'a> {
    handle: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    draft: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    context: Option<&'a str>,
}

#[derive(Clone, Copy)]
enum MindRoute {
    Prime,
    Facet,
}

impl MindRoute {
    fn path(self) -> &'static str {
        match self {
            Self::Prime => "/prime",
            Self::Facet => "/facet",
        }
    }

    fn timeout(self) -> Duration {
        match self {
            Self::Prime => Duration::from_secs(180),
            Self::Facet => Duration::from_secs(90),
        }
    }
}

fn token_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".vibe/mind/runtime-token"))
}

fn read_private_token(path: &Path) -> Option<String> {
    let meta = fs::symlink_metadata(path).ok()?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return None;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o077 != 0 {
            return None;
        }
    }

    let token = fs::read_to_string(path).ok()?;
    let token = token.trim();
    if token.len() < 24 || token.len() > 512 || token.chars().any(char::is_whitespace) {
        return None;
    }
    Some(token.to_owned())
}

fn valid_handle(handle: &str) -> bool {
    !handle.is_empty()
        && handle.len() <= MAX_HANDLE_BYTES
        && handle
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'@')
}

fn mind_client(route: MindRoute) -> Option<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        // System proxies would receive the bearer and the private payload for
        // ANY origin, activated or not (review P1) — this client never uses one.
        .no_proxy()
        .connect_timeout(Duration::from_secs(3))
        .timeout(route.timeout())
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .ok()
}

fn request(route: MindRoute, handle: &str, text: &str) -> Option<Value> {
    if !valid_handle(handle) || text.trim().is_empty() {
        return None;
    }
    let limit = match route {
        MindRoute::Prime => MAX_CONTEXT_BYTES,
        MindRoute::Facet => MAX_DRAFT_BYTES,
    };
    if text.len() > limit {
        // Never silently analyze different words from the ones the human sees.
        return None;
    }

    let token = read_private_token(&token_path()?)?;
    let payload = match route {
        MindRoute::Prime => MindRequest {
            handle,
            draft: None,
            context: Some(text),
        },
        MindRoute::Facet => MindRequest {
            handle,
            draft: Some(text),
            context: None,
        },
    };

    let client = mind_client(route)?;
    let body = serde_json::to_vec(&payload).ok()?;
    let response = mind_origins().iter().find_map(|origin| {
        client
            .post(format!("{}{}", origin, route.path()))
            .bearer_auth(&token)
            .header("Content-Type", "application/json")
            .body(body.clone())
            .send()
            .ok()
    })?;
    if !response.status().is_success()
        || response.content_length().unwrap_or(0) > MAX_RESPONSE_BYTES
    {
        return None;
    }
    let bytes = response.bytes().ok()?;
    if bytes.len() as u64 > MAX_RESPONSE_BYTES {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

#[tauri::command]
pub async fn mind_prime(handle: String, context: String) -> Option<Value> {
    tauri::async_runtime::spawn_blocking(move || request(MindRoute::Prime, &handle, &context))
        .await
        .ok()
        .flatten()
}

#[tauri::command]
pub async fn mind_facet(handle: String, draft: String) -> Option<Value> {
    tauri::async_runtime::spawn_blocking(move || request(MindRoute::Facet, &handle, &draft))
        .await
        .ok()
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;
    use std::thread;

    fn temp_token(mode: u32, body: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "vibe-mind-token-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut file = fs::File::create(&path).unwrap();
        file.write_all(body.as_bytes()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        }
        path
    }

    #[test]
    fn private_token_requires_a_regular_0600_file() {
        let good = temp_token(0o600, "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG");
        assert!(read_private_token(&good).is_some());
        fs::remove_file(&good).unwrap();

        let open = temp_token(0o644, "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG");
        assert!(read_private_token(&open).is_none());
        fs::remove_file(&open).unwrap();
    }

    #[test]
    fn no_capability_grants_the_renderer_a_private_origin() {
        // Rounds 2-6 taught one lesson: DESERIALIZE LIKE TAURI, then judge.
        // Every string-scanning variant lost to another escape shape
        // (\u0068ttp, \u003a, case). So: parse each capability file with the
        // real JSON/TOML deserializers — which perform full unescaping — and
        // judge every resulting string (keys and values) semantically with
        // the transport's own URL parser. A file that parses as NEITHER
        // format fails closed: an unparseable capability has no business in
        // the repo.
        fn private_http(sval: &str) -> bool {
            let trimmed = sval.trim();
            let lower = trimmed.to_ascii_lowercase();
            if !lower.starts_with("http://") && !lower.starts_with("https://") {
                return false; // not an http scope at all
            }
            // URLPattern SEMANTICS FAIL CLOSED (round-7): Tauri evaluates
            // scopes as patterns, so `http://127.0.0.1:*` and `http://*`
            // grant hosts/ports while never parsing as URLs. The ONLY
            // wildcard this repo permits is a single trailing path `/*`;
            // any other `*` in an http scope is judged PRIVATE (refused),
            // as is an http-prefixed string that will not parse.
            let candidate = trimmed.strip_suffix("/*").unwrap_or(trimmed);
            // ONE leading subdomain wildcard on a CONCRETE domain is a
            // legitimate public scope (https://*.githubusercontent.com);
            // judging the concrete suffix judges every match. Any OTHER
            // wildcard — host `*`, port `:*`, mid-host — fails closed.
            let candidate = candidate
                .replacen("://*.", "://", 1);
            if candidate.contains('*') {
                return true; // wildcard host/port/path — fail closed
            }
            let Ok(u) = url::Url::parse(&candidate) else {
                return true; // http-shaped but unparseable — fail closed
            };
            let scheme = u.scheme().to_ascii_lowercase();
            if scheme != "http" && scheme != "https" {
                return false;
            }
            match u.host() {
                Some(url::Host::Ipv4(ip)) => {
                    let o = ip.octets();
                    o[0] == 127
                        || o[0] == 10
                        || (o[0] == 192 && o[1] == 168)
                        || (o[0] == 172 && (16..=31).contains(&o[1]))
                        || (o[0] == 100 && (64..=127).contains(&o[1]))
                }
                Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
                Some(url::Host::Domain(d)) => {
                    // A trailing dot is the same host to resolvers and to
                    // urlpattern (round-8: https://*.localhost./* matched) —
                    // normalize it away before judging.
                    let d = d.to_ascii_lowercase();
                    let d = d.trim_end_matches('.');
                    d == "localhost" || d.ends_with(".local") || d.ends_with(".localhost")
                }
                None => false,
            }
        }
        fn judge_json(v: &Value, path: &std::path::Path) {
            match v {
                Value::String(s) => assert!(
                    !private_http(s),
                    "capability {:?} grants the renderer a private origin: {}", path, s
                ),
                Value::Array(a) => a.iter().for_each(|x| judge_json(x, path)),
                Value::Object(o) => {
                    for (k, x) in o {
                        assert!(!private_http(k), "capability {:?} key is a private origin", path);
                        judge_json(x, path);
                    }
                }
                _ => {}
            }
        }
        fn judge_toml(v: &toml::Value, path: &std::path::Path) {
            match v {
                toml::Value::String(s) => assert!(
                    !private_http(s),
                    "capability {:?} grants the renderer a private origin: {}", path, s
                ),
                toml::Value::Array(a) => a.iter().for_each(|x| judge_toml(x, path)),
                toml::Value::Table(t) => {
                    for (k, x) in t {
                        assert!(!private_http(k), "capability {:?} key is a private origin", path);
                        judge_toml(x, path);
                    }
                }
                _ => {}
            }
        }
        fn visit(dir: &std::path::Path) {
            for entry in fs::read_dir(dir).unwrap().flatten() {
                let p = entry.path();
                if p.is_dir() {
                    visit(&p);
                    continue;
                }
                let body = fs::read_to_string(&p).unwrap_or_default();
                if let Ok(parsed) = serde_json::from_str::<Value>(&body) {
                    judge_json(&parsed, &p);
                } else if let Ok(parsed) = body.parse::<toml::Value>() {
                    judge_toml(&parsed, &p);
                } else {
                    panic!("capability {:?} parses as neither JSON nor TOML — fail closed", p);
                }
            }
        }
        visit(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities"));
    }



    #[test]
    fn canonical_binary_compiles_no_endpoint_at_all() {
        // Round-2 ruling: NOTHING is dialed without explicit activation —
        // not even loopback, which any local process could squat. No
        // activation file = no origins = unreachable, silently.
        let dir = std::env::temp_dir().join(format!("vibe-noact-{}", std::process::id()));
        let _ = fs::remove_file(&dir);
        assert!(personal_endpoint_from(&dir).is_none(), "no file, no dial");
        // Scan PRODUCTION source only — the test fixtures below legitimately
        // use a Tailnet address as a valid explicitly-activated example.
        let src = include_str!("mind.rs");
        let production = src.split("#[cfg(test)]").next().unwrap();
        assert!(!production.contains("100.121.205.111"), "no compiled personal endpoint");
        // As a URL, not as a word — the module docstring legitimately NAMES
        // the wire to say it never talks to it.
        assert!(!production.contains("://slashvibe") && !production.contains("://www.slashvibe"),
                "the Mind never touches the wire");
    }

    #[test]
    fn personal_endpoint_validator_is_the_production_function() {
        // These call personal_endpoint_from DIRECTLY — the exact code the
        // binary runs — with every trick from the review: userinfo smuggling,
        // hostname suffixes that survive numeric filtering, paths, queries,
        // fragments, IPv6, trailing dots, whitespace, uppercase schemes,
        // loose file modes, and symlinks.
        let dir = std::env::temp_dir();
        let write = |name: &str, body: &str, mode: u32| -> PathBuf {
            let p = dir.join(format!("vibe-mind-ep-{}-{}", std::process::id(), name));
            fs::write(&p, body).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&p, fs::Permissions::from_mode(mode)).unwrap();
            }
            p
        };
        let ok = |name: &str, body: &str| personal_endpoint_from(&write(name, body, 0o600));
        assert_eq!(ok("good", "http://100.121.205.111:7788\n"),
                   Some("http://100.121.205.111:7788".into()));
        assert_eq!(ok("lo", "http://127.0.0.1:7788"), Some("http://127.0.0.1:7788".into()));
        // the review's exact exploits
        assert!(ok("suffix", "http://10.0.0.1.attacker.example:7788").is_none(),
                "hostname suffix must not survive numeric filtering");
        assert!(ok("userinfo", "http://10.0.0.1:pw@attacker.example:7788").is_none(),
                "userinfo smuggling must be refused");
        assert!(ok("user2", "http://a@10.0.0.1:7788").is_none(), "any credentials refused");
        assert!(ok("path", "http://10.0.0.1:7788/exfil").is_none(), "paths refused");
        assert!(ok("query", "http://10.0.0.1:7788/?x=1").is_none(), "queries refused");
        assert!(ok("frag", "http://10.0.0.1:7788/#f").is_none(), "fragments refused");
        assert!(ok("v6", "http://[::1]:7788").is_none(), "IPv6 refused outright");
        // A trailing dot is NORMALIZED to the same IPv4 by the one shared
        // parser — validator and reqwest agree by construction, so what is
        // returned (and dialed) is the canonical private origin. The exploit
        // was parser DISAGREEMENT; one parser closes it.
        assert_eq!(ok("dot", "http://10.0.0.1.:7788"), Some("http://10.0.0.1:7788".into()));
        assert!(ok("public", "http://8.8.8.8:7788").is_none(), "public IPv4 refused");
        assert!(ok("https", "https://10.0.0.1:7788").is_none(), "https (hostname-style trust) refused");
        // Scheme case is likewise normalized by the shared parser — the
        // canonical private origin is what gets dialed.
        assert_eq!(ok("upper", "HTTP://10.0.0.1:7788"), Some("http://10.0.0.1:7788".into()));
        assert!(ok("noport", "http://10.0.0.1").is_none(), "explicit port required");
        assert!(ok("ws", "http://10.0.0.1:7788 http://evil").is_none(), "inner whitespace refused");
        let loose = write("loose", "http://10.0.0.1:7788", 0o644);
        assert!(personal_endpoint_from(&loose).is_none(), "group/other-readable refused");
        let target = write("target", "http://10.0.0.1:7788", 0o600);
        let link = dir.join(format!("vibe-mind-ep-{}-link", std::process::id()));
        let _ = fs::remove_file(&link);
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(personal_endpoint_from(&link).is_none(), "symlinks refused");
    }

    #[test]
    fn payloads_contain_only_the_visible_scope() {
        let prime = serde_json::to_value(MindRequest {
            handle: "friend",
            draft: None,
            context: Some("recent visible thread"),
        })
        .unwrap();
        assert_eq!(prime, serde_json::json!({
            "handle": "friend",
            "context": "recent visible thread"
        }));

        let facet = serde_json::to_value(MindRequest {
            handle: "friend",
            draft: Some("the active draft"),
            context: None,
        })
        .unwrap();
        assert_eq!(facet, serde_json::json!({
            "handle": "friend",
            "draft": "the active draft"
        }));
    }

    #[test]
    fn boundary_rejects_invalid_handles() {
        assert!(!valid_handle("friend/../../token"));
        assert!(!valid_handle(&"a".repeat(MAX_HANDLE_BYTES + 1)));
        assert!(valid_handle("@friend-name"));
    }

    #[test]
    fn native_client_refuses_redirects_before_private_payload_can_follow() {
        let redirect_target = TcpListener::bind("127.0.0.1:0").unwrap();
        redirect_target.set_nonblocking(true).unwrap();
        let target_address = redirect_target.local_addr().unwrap();

        let redirector = TcpListener::bind("127.0.0.1:0").unwrap();
        let redirector_address = redirector.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = redirector.accept().unwrap();
            let response = format!(
                "HTTP/1.1 307 Temporary Redirect\r\nLocation: http://{target_address}/escaped\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            stream.write_all(response.as_bytes()).unwrap();
        });

        let client = mind_client(MindRoute::Facet).unwrap();
        let response = client
            .post(format!("http://{redirector_address}/private"))
            .body("private draft")
            .send()
            .unwrap();
        server.join().unwrap();

        assert_eq!(response.status(), reqwest::StatusCode::TEMPORARY_REDIRECT);
        thread::sleep(Duration::from_millis(25));
        assert!(redirect_target.accept().is_err());
    }
}
