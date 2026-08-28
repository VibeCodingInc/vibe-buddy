#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod botfile;
mod auth;
mod context_extractor;
mod mcp_setup;
mod vibeconf;
mod terminal;
mod transcript;
mod notify;
mod mind;

use auth::{AuthResult, AuthStatus};
use context_extractor::CodingDNA;
use mcp_setup::{McpInstallResult, McpStatus};
use std::time::Duration;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// Is Buddy set to open at login? Never panics — a platform that can't answer
/// is reported as "off" rather than taking the app down.
fn autostart_enabled<R: tauri::Runtime, M: Manager<R>>(app: &M) -> bool {
    app.app_handle().autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn check_auth_status() -> AuthStatus {
    auth::check_auth()
}

/// The real OS string for a diagnostic report (G6). navigator.userAgent lies in
/// WKWebView — it reports a frozen "Mac OS X 10_15_7" on every current macOS,
/// Apple Silicon included — so the frontend asks the native side instead.
#[tauri::command]
fn get_os_info() -> String {
    let arch = std::env::consts::ARCH;
    #[cfg(target_os = "macos")]
    {
        let version = std::process::Command::new("sw_vers")
            .arg("-productVersion")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        match version {
            Some(v) => format!("macOS {} ({})", v, arch),
            None => format!("macOS ({})", arch),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        format!("{} ({})", std::env::consts::OS, arch)
    }
}

/// Write a refreshed token back to `~/.vibe/auth.json`.
///
/// The frontend refreshes its own JWT, and without this the new token lived only
/// in memory — so a restart after the ORIGINAL token expired showed the sign-in
/// screen despite a valid session having existed seconds earlier.
#[tauri::command]
fn save_auth_token(token: String, handle: String) -> Result<(), String> {
    if token.is_empty() || handle.is_empty() {
        return Err("refusing to persist an empty token or handle".to_string());
    }
    auth::update_token(&token, &handle)
}

/// Clear the persisted session ONLY if it still holds this exact token — the
/// guard that keeps a stale asynchronous revocation verdict from erasing a
/// session re-established while the probe was in flight. The MCP config's
/// matching credential aliases are invalidated regardless.
#[tauri::command]
fn clear_revoked_auth(token: String) -> Result<(), String> {
    if token.is_empty() {
        return Err("refusing to clear against an empty token".to_string());
    }
    auth::clear_auth_if_token(&token)
}

/// Best-effort offline beacon, fired synchronously right before the app exits.
/// Presence is TTL-based on `last_seen`, so without this a user who quits Buddy
/// keeps showing 'active' for up to 30 min. This tells the server to flip them
/// offline now. Capped at ~2s, ignores every error so it can never wedge quit.
/// Uses a manual JSON body to avoid pulling in reqwest's `json` feature.
fn send_offline_beacon() {
    let auth = auth::check_auth();
    let (handle, token) = match (auth.handle, auth.token) {
        (Some(h), Some(t)) => (h, t),
        _ => return,
    };
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    {
        Ok(c) => c,
        Err(_) => return,
    };
    let body = serde_json::json!({ "action": "offline", "username": handle }).to_string();
    let _ = client
        .post("https://www.slashvibe.dev/api/v2/presence")
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .body(body)
        .send();
}

#[tauri::command]
fn start_login() -> Result<String, String> {
    let flow = auth::start_login()?;
    let url = flow.login_url.clone();

    std::thread::spawn(move || {
        match flow.wait_for_callback(Duration::from_secs(300)) {
            AuthResult::Success(data) => {
                let _ = auth::save_auth(&data.token, &data.handle);
                // Best-effort MCP auto-install after auth
                let result = mcp_setup::install_mcp();
                if result.success {
                    eprintln!("[Auth] MCP auto-installed for @{}", data.handle);
                } else {
                    eprintln!("[Auth] MCP auto-install skipped: {}", result.message);
                }
            }
            AuthResult::Error(e) => {
                eprintln!("[Auth] Login error: {}", e);
            }
            AuthResult::Timeout => {
                eprintln!("[Auth] Login timed out");
            }
        }
    });

    Ok(url)
}

#[tauri::command]
fn logout() -> Result<(), String> {
    auth::clear_auth()
}

// NOTE: these commands open the (potentially multi-GB) vibe-check SQLite DB and
// run aggregate scans. They MUST be `async` + run via `spawn_blocking` so the work
// lands on a worker thread — a sync command runs on the UI thread and freezes the
// WebView (macOS beach ball) at login, when the first heartbeat fires the extract.
#[tauri::command]
async fn extract_coding_context() -> CodingDNA {
    tauri::async_runtime::spawn_blocking(context_extractor::extract_coding_context)
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn check_mcp_status() -> McpStatus {
    // Shells out (`which npx`) + reads config — keep it off the UI thread too.
    tauri::async_runtime::spawn_blocking(mcp_setup::get_mcp_status)
        .await
        .unwrap_or_else(|_| McpStatus {
            installed: false,
            npx_available: false,
            config_path: None,
            hosts: Vec::new(),
        })
}

#[tauri::command]
fn install_mcp() -> McpInstallResult {
    mcp_setup::install_mcp()
}

/// The LaunchAgent label and plist the autostart plugin writes.
const LAUNCH_AGENT_LABEL: &str = "Vibe Buddy";

fn launch_agent_plist() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| {
        h.join("Library")
            .join("LaunchAgents")
            .join(format!("{}.plist", LAUNCH_AGENT_LABEL))
    })
}

/// The GUI domain launchd wants, cached — `id -u` is a process spawn and
/// get_autostart is called on every settings render.
fn gui_domain() -> Option<&'static str> {
    use std::sync::OnceLock;
    static DOMAIN: OnceLock<Option<String>> = OnceLock::new();
    DOMAIN
        .get_or_init(|| {
            let out = std::process::Command::new("id").arg("-u").output().ok()?;
            let uid = String::from_utf8(out.stdout).ok()?.trim().to_string();
            if uid.is_empty() { None } else { Some(format!("gui/{}", uid)) }
        })
        .as_deref()
}

/// Is launchd ACTUALLY going to start us at login?
///
/// The distinction that matters: `tauri-plugin-autostart` writes the plist to
/// ~/Library/LaunchAgents and reports enabled, but does not register it with
/// launchd — so the toggle read "on" while `launchctl print` answered
/// "Could not find service". Nothing would have started Buddy at the next login
/// until launchd rescanned the directory, and a Buddy that is not running cannot
/// check for updates, notify, or hold presence. That is exactly how an install
/// sits frozen on an old build: it was never running to learn there was a new one.
fn launch_agent_registered() -> bool {
    let Some(domain) = gui_domain() else { return false };
    std::process::Command::new("launchctl")
        .arg("print")
        .arg(format!("{}/{}", domain, LAUNCH_AGENT_LABEL))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Register (or unregister) the plist so the setting is true NOW, not next login.
fn set_launch_agent_registration(enabled: bool) {
    let Some(domain) = gui_domain() else { return };
    let mut cmd = std::process::Command::new("launchctl");
    if enabled {
        let Some(plist) = launch_agent_plist() else { return };
        if !plist.exists() {
            return;
        }
        cmd.arg("bootstrap").arg(domain).arg(plist);
    } else {
        cmd.arg("bootout")
            .arg(format!("{}/{}", domain, LAUNCH_AGENT_LABEL));
    }
    // Best effort, and deliberately quiet: an already-bootstrapped agent returns
    // a non-zero "service already loaded", which is the desired end state rather
    // than a failure. get_autostart reports the truth either way.
    let _ = cmd
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

/// Will Buddy actually start at login?
///
/// BOTH halves are required, because either alone is a claim we cannot back: a
/// plist with no launchd registration never runs, and a registration whose plist
/// the plugin has removed is a ghost. Reporting "on" for the first case is what
/// left Buddy not running — and a Buddy that is not running cannot discover that
/// an update exists.
fn autostart_truth(plist_enabled: bool, registered: bool) -> bool {
    plist_enabled && registered
}

#[cfg(test)]
mod autostart_tests {
    use super::*;

    #[test]
    fn the_plist_path_matches_where_the_plugin_writes_it() {
        // tauri-plugin-autostart with MacosLauncher::LaunchAgent writes
        // ~/Library/LaunchAgents/<Label>.plist. If this drifts, we would
        // bootstrap a file that does not exist and silently do nothing.
        let p = launch_agent_plist().expect("home dir");
        assert!(p.ends_with("Library/LaunchAgents/Vibe Buddy.plist"), "got {:?}", p);
    }

    #[test]
    fn the_gui_domain_is_shaped_the_way_launchctl_wants() {
        // launchctl rejects anything that is not gui/<uid>.
        if let Some(d) = gui_domain() {
            assert!(d.starts_with("gui/"), "got {}", d);
            assert!(d["gui/".len()..].chars().all(|c| c.is_ascii_digit()), "got {}", d);
        }
    }

    /// The bug this whole path exists for: a plist on disk is NOT a registration.
    #[test]
    fn a_written_plist_is_not_enough_to_claim_autostart() {
        // THE case that actually happened: the plugin wrote the plist and
        // reported enabled, launchd had never heard of it, and Buddy said "on".
        assert!(!autostart_truth(true, false), "a plist nobody loaded never runs");
        // A registration whose plist is gone is equally a lie.
        assert!(!autostart_truth(false, true), "a registration with no plist is a ghost");
        assert!(!autostart_truth(false, false));
        // Only both.
        assert!(autostart_truth(true, true));
    }
}

#[tauri::command]
fn get_autostart() -> bool {
    // Read via the process-wide handle rather than taking &AppHandle here so
    // the frontend can call this before the window is fully wired.
    let plist_enabled = AUTOSTART_HANDLE
        .get()
        .map(|app| autostart_enabled(app))
        .unwrap_or(false);
    autostart_truth(plist_enabled, launch_agent_registered())
}

#[tauri::command]
fn set_autostart(enabled: bool) -> bool {
    if let Some(app) = AUTOSTART_HANDLE.get() {
        let al = app.autolaunch();
        let _ = if enabled { al.enable() } else { al.disable() };
        // The plugin writes the plist; this is what makes launchd honour it.
        set_launch_agent_registration(enabled);
        return get_autostart();
    }
    false
}

/// The menu-bar glance: put presence in the tray TITLE so the buddy list can
/// be read without opening it. That ambient read is the whole point of a buddy
/// list — before this, the tray showed a static app icon and you had to open
/// the window to learn anything.
///
/// Kept deliberately terse, because it sits in everyone's menu bar forever:
///   3 unread → "3"      (unread always wins; it's the thing you act on)
///   5 online → "·5"     (a dot, so it reads as ambient rather than urgent)
///   nobody   → ""       (empty: no clutter when there's nothing to say)
#[tauri::command]
fn set_tray_status(app: tauri::AppHandle, online: u32, unread: u32) {
    let title = if unread > 0 {
        unread.to_string()
    } else if online > 0 {
        format!("·{}", online)
    } else {
        String::new()
    };
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_title(Some(&title));
        let tooltip = match (online, unread) {
            (_, u) if u > 0 => format!("/vibe — {} unread, {} online", u, online),
            (o, _) if o > 0 => format!("/vibe — {} online", o),
            _ => "/vibe — nobody around".to_string(),
        };
        let _ = tray.set_tooltip(Some(&tooltip));
    }
}

#[tauri::command]
fn set_dock_badge(count: u32) {
    #[cfg(target_os = "macos")]
    {
        use cocoa::appkit::NSApp;
        use cocoa::base::nil;
        use cocoa::foundation::NSString;
        use objc::{msg_send, sel, sel_impl};
        unsafe {
            let app = NSApp();
            let dock_tile: cocoa::base::id = msg_send![app, dockTile];
            if count > 0 {
                let label = NSString::alloc(nil).init_str(&count.to_string());
                let _: () = msg_send![dock_tile, setBadgeLabel: label];
            } else {
                let _: () = msg_send![dock_tile, setBadgeLabel: nil];
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = count;
}

/// Stable id so set_tray_status can find the tray after setup.
const TRAY_ID: &str = "vibe-tray";

/// App handle captured at setup so the autostart commands (which the frontend
/// calls without a window context) can reach the plugin.
static AUTOSTART_HANDLE: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

fn main() {
    // BEFORE the builder runs: Tao emits RunEvent::Ready (where .setup runs)
    // from inside applicationDidFinishLaunching:, so anything registered in
    // setup is one callback too late to see the launch notification a banner
    // click rides in on. Here, nothing has launched yet. No-op off macOS.
    notify::early_init();

    let shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyV);

    tauri::Builder::default()
        // MUST be registered first, per the plugin's contract.
        //
        // Two copies of Buddy are not two clients — they are one identity
        // fighting itself. They share ~/.vibe/auth.json and the same
        // localStorage, both heartbeat, both notify (so every DM buzzes
        // twice), and — the part that actually loses data — both open the DM
        // event stream, whose server-side queue is DESTRUCTIVE per read. One
        // copy consumes an event the other will now never see. Signing out of
        // one silently signs out the other; quitting one marks the shared
        // handle offline while the other still thinks it is online.
        //
        // A second launch focuses the window you already have.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Open at login. A presence app that vanishes on reboot stops being
        // presence — your dot goes dark and you're the only one who doesn't
        // know. Off until enabled; disclosed at sign-in and toggleable from
        // the tray menu.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(),
        )
        .setup(move |app| {
            let _ = AUTOSTART_HANDLE.set(app.handle().clone());

            // buddy#39: one persistent NSUserNotificationCenter delegate so
            // banner clicks and inline replies route back into the webview.
            // No-op off macOS.
            notify::init(app.handle());

            // The macOS application menu.
            //
            // START FROM TAURI'S DEFAULT and insert into it. Building this menu
            // from scratch — an app submenu plus Edit — silently deleted File,
            // View, Window and Help, taking Close, Fullscreen, Minimize and Zoom
            // with them. That shipped in 0.5.27. Copy and paste survived only
            // because Edit was rebuilt by hand, which is precisely the trap:
            // the parts you remember to rebuild work, and the rest vanish
            // without an error.
            //
            // "Check for Updates…" goes directly under About, where macOS apps
            // conventionally put it and where people look for it first.
            let check_updates_app = MenuItem::with_id(
                app, "check_updates", "Check for Updates…", true, None::<&str>,
            )?;
            // Report a Problem… — the debuggability affordance (G6). A user who
            // suspects Buddy is broken needs a way to hand over what it knows;
            // this opens the report panel in the webview.
            let report_problem_app = MenuItem::with_id(
                app, "report_problem", "Report a Problem…", true, None::<&str>,
            )?;
            let app_menu = Menu::default(app.handle())?;
            if let Some(first) = app_menu.items()?.into_iter().next() {
                if let Some(app_submenu) = first.as_submenu() {
                    // index 1 = immediately after About
                    let _ = app_submenu.insert(&check_updates_app, 1);
                    let _ = app_submenu.insert(&report_problem_app, 2);
                }
            }
            app.set_menu(app_menu)?;
            app.on_menu_event(|app, event| match event.id.as_ref() {
                "check_updates" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                    let _ = app.emit("check-updates", ());
                }
                "report_problem" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                    let _ = app.emit("report-problem", ());
                }
                _ => {}
            });

            let show = MenuItem::with_id(app, "show", "Show Buddy List", true, None::<&str>)?;
            let launch = CheckMenuItem::with_id(
                app,
                "launch",
                "Open at Login",
                true,
                autostart_enabled(app),
                None::<&str>,
            )?;
            // The affordance a user reaches for when they suspect they are stale.
            // Buddy checks on launch, every 6h, and on wake — but an ambient app
            // gives you no way to KNOW that, and the absence of any manual check
            // is indistinguishable from an app that never updates.
            let updates = MenuItem::with_id(app, "check_updates", "Check for Updates…", true, None::<&str>)?;
            // Reachable from the menu bar even with the window hidden — the
            // state a confused user is in when they most need to report (G6).
            let report_problem = MenuItem::with_id(app, "report_problem", "Report a Problem…", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &updates, &report_problem, &launch, &quit])?;

            TrayIconBuilder::with_id(TRAY_ID)
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "launch" => {
                        // Toggle open-at-login straight from the menu bar, so
                        // it's as easy to turn off as it was to turn on.
                        let al = app.autolaunch();
                        if al.is_enabled().unwrap_or(false) {
                            let _ = al.disable();
                        } else {
                            let _ = al.enable();
                        }
                    }
                    "check_updates" => {
                        // The updater lives in the webview, so surface the
                        // window first: an update prompt behind a hidden window
                        // is the same as no prompt.
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                        let _ = app.emit("check-updates", ());
                    }
                    "report_problem" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                        let _ = app.emit("report-problem", ());
                    }
                    "quit" => {
                        // app.exit() rather than process::exit() so this leaves
                        // through the same door as Cmd-Q and the menu, and the
                        // beacon lives in exactly one place.
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Register Cmd+Shift+V global hotkey
            app.global_shortcut().register(shortcut)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            check_auth_status,
            get_os_info,
            save_auth_token,
            clear_revoked_auth,
            botfile::read_botfile,
            start_login,
            logout,
            extract_coding_context,
            set_dock_badge,
            notify::notify_native,
            notify::native_notify_available,
            notify::drain_notification_actions,
            notify::ack_notification_action,
            notify::clear_native_notifications,
            set_tray_status,
            get_autostart,
            set_autostart,
            check_mcp_status,
            install_mcp,
            vibeconf::vibeconf_available,
            vibeconf::vibeconf_seat_state,
            vibeconf::vibeconf_start_call,
            terminal::terminal_sessions,
            terminal::front_terminal_session,
            terminal::place_in_terminal_session,
            transcript::transcript_signal,
            mind::mind_prime,
            mind::mind_facet,
            mind::mind_trace,
        ])
        .build(tauri::generate_context!())
        .expect("error while running vibe buddy")
        .run(|_app, event| {
            // Tell the server we are gone, however the user left.
            //
            // The beacon used to hang off the tray's Quit item alone, so Cmd-Q
            // and the application menu — the two ways most people quit a Mac
            // app — exited silently and left the user rendered green until the
            // presence TTL expired. Anyone looking at the board saw someone who
            // had already gone. Exactly the promise presence must not make.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                send_offline_beacon();
            }
        });
}
