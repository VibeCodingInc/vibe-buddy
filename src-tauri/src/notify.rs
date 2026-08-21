//! Native notification routing — the fix for buddy#39.
//!
//! tauri-plugin-notification 2.3.3's desktop backend builds a banner from
//! title/body/icon/sound ONLY: `extra` and `action_type_id` are dropped, and
//! `register_action_types` exists solely in its mobile.rs. So on macOS a click
//! activated Buddy without saying which banner was clicked, and inline reply
//! never functioned (verified 2026-08-14 against the crate source).
//!
//! WHY NOT mac-notification-sys's blocking API. That crate CAN return the
//! click/reply — but each `send` allocs a fresh delegate and installs it on
//! the SHARED default NSUserNotificationCenter, then spins a runloop until
//! that delegate hears back. A second concurrent send replaces the delegate,
//! orphaning the first wait forever (their own notify.m carries the TODO).
//! Buddy fires DM banners, session alerts and arrivals off independent polls;
//! concurrent sends are the normal case, not the edge.
//!
//! THE DESIGN INSTEAD: one delegate, installed once, owning the center for
//! the life of the app.
//!
//!   deliverNotification(userInfo: {kind, thread, from, cwd})   — never blocks
//!            │  user clicks the banner / submits the reply field
//!            ▼
//!   didActivateNotification → read userInfo + activationType (+ reply text)
//!            ▼
//!   emit "buddy://notification-action" → the webview routes it exactly as
//!   lib/notifications.ts always intended: session → front the terminal,
//!   reply → send WITHOUT focusing, click → focus + open the thread.
//!
//! NSUserNotification is deprecated — and it is also precisely what the
//! plugin's own desktop path (notify-rust → mac-notification-sys) uses, so
//! this adds no API surface the app was not already shipping. Moving to
//! UNUserNotificationCenter is a separate project for whenever Apple actually
//! removes the old center; the payload contract here (the event and its JSON)
//! is designed to survive that swap untouched.

use serde::Deserialize;
use tauri::AppHandle;

#[derive(Debug, Clone, Deserialize)]
pub struct NativeNotification {
    pub title: String,
    pub body: String,
    /// "dm" | "session" | "arrival" — routing class, echoed back on the event.
    pub kind: String,
    /// DM/arrival routing target (a handle).
    #[serde(default)]
    pub thread: Option<String>,
    #[serde(default)]
    pub from: Option<String>,
    /// Session-alert routing target (the session's working directory).
    #[serde(default)]
    pub cwd: Option<String>,
    /// Offer macOS's inline reply field on the banner.
    #[serde(default)]
    pub reply: bool,
    /// The signed-in handle that OWNS this banner. Echoed back on the event
    /// so the webview can refuse to act on a banner delivered to a previous
    /// account — without it, A's banner clicked after B signs in would send
    /// A's reply as B (codex P1).
    #[serde(default)]
    pub owner: Option<String>,
}

/// Is the native path present AND usable in this build? Two conditions:
/// macOS (compile-time), and a real bundle identifier (runtime) —
/// `pnpm tauri dev` runs Buddy as a plain binary with no bundle id
/// (CLAUDE.md documents this), and NSUserNotificationCenter cannot attribute
/// or deliver for an identity-less process. The plugin path CAN (its
/// mac-notification-sys backend establishes a substitute identity), so dev
/// builds must answer false here and keep the fallback (codex P2). A wrong
/// answer silently reroutes every notification, so nothing here guesses.
#[tauri::command]
pub fn native_notify_available() -> bool {
    #[cfg(target_os = "macos")]
    {
        return macos::has_bundle_identity();
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Deliver a banner through the native path. The command lives at module top
/// level because tauri::command generates `__cmd__` glue next to the fn — a
/// `pub use` re-export from a cfg'd submodule doesn't carry it, and the build
/// fails exactly the way it just did when this was written the tidy way.
#[tauri::command]
pub fn notify_native(app: AppHandle, n: NativeNotification) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return macos::deliver(app, n);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, n);
        // The webview never calls this off-macOS (the probe said no), but a
        // stub beats a missing-command error if it ever does.
        Err("native notifications are macOS-only; use the plugin path".into())
    }
}

/// Actions that fired before the webview could listen. macOS launches the app
/// when a banner is clicked while Buddy is quit; the delegate then runs long
/// before initNotificationClicks registers its listener, and Tauri events are
/// not queued — the click would simply vanish (codex P2). Every action is
/// buffered here with a monotonic id; the webview drains once after
/// registering and dedupes by id, so an action is handled exactly once
/// whether it arrived live, buffered, or both.
#[tauri::command]
pub fn drain_notification_actions() -> Vec<serde_json::Value> {
    #[cfg(target_os = "macos")]
    {
        return macos::drain_pending();
    }
    #[cfg(not(target_os = "macos"))]
    {
        Vec::new()
    }
}

/// The webview handled this action from the live event — remove it from the
/// pending buffer so a webview reload cannot drain and re-route it.
#[tauri::command]
pub fn ack_notification_action(id: String) {
    #[cfg(target_os = "macos")]
    {
        macos::ack_pending(&id);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = id;
    }
}

/// Remove every delivered Buddy banner from Notification Center. Called on
/// sign-out: a banner owned by account A must not sit clickable while B is
/// signed in (codex P1 — the owner check in the webview is the second lock;
/// this is the first).
#[tauri::command]
pub fn clear_native_notifications(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return macos::clear_delivered(app);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
pub fn early_init() {}

#[cfg(not(target_os = "macos"))]
pub fn init(_app: &AppHandle) {}

#[cfg(target_os = "macos")]
pub use macos::{early_init, init};

#[cfg(target_os = "macos")]
mod macos {
    use super::NativeNotification;
    use cocoa::base::{id, nil};
    use cocoa::foundation::NSString;
    use objc::declare::ClassDecl;
    use objc::runtime::{Class, Object, Sel, BOOL, YES};
    use objc::{class, msg_send, sel, sel_impl};
    use std::sync::OnceLock;
    use tauri::{AppHandle, Emitter};

    /// The one AppHandle the delegate emits through. A delegate callback has
    /// no way to carry Rust state, so this is the bridge.
    static APP: OnceLock<AppHandle> = OnceLock::new();

    /// Buffered actions + the id counter — see drain_notification_actions.
    /// Capped: an unbounded buffer nobody drains is a leak wearing a feature.
    static PENDING: std::sync::Mutex<Vec<serde_json::Value>> = std::sync::Mutex::new(Vec::new());
    static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    const PENDING_CAP: usize = 16;

    /// nids must be unique ACROSS RESTARTS, not just within one: Notification
    /// Center retains banners past a relaunch, and a bare counter restarts at
    /// 1 — an old banner and a new one could share a nid, and clicking either
    /// would silently swallow the other's action (codex P2). Startup millis
    /// in the high bits, counter in the low 16: a collision needs two runs
    /// started in the same millisecond.
    fn fresh_nid() -> u64 {
        static BASE: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
        let base = *BASE.get_or_init(|| {
            let ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            ms << 16
        });
        base | (NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed) & 0xFFFF)
    }

    /// Does this process have a real bundle identity? See
    /// native_notify_available.
    pub fn has_bundle_identity() -> bool {
        unsafe {
            let bundle: id = msg_send![class!(NSBundle), mainBundle];
            if bundle == nil {
                return false;
            }
            let ident: id = msg_send![bundle, bundleIdentifier];
            ident != nil
        }
    }

    pub fn drain_pending() -> Vec<serde_json::Value> {
        PENDING.lock().map(|mut v| std::mem::take(&mut *v)).unwrap_or_default()
    }

    /// The frontend handled action `id` (live, off the event) — drop it from
    /// the buffer. Without this, every warm action stayed in PENDING and a
    /// webview RELOAD re-drained and re-routed all of them; for an inline
    /// reply that posted the same message twice (codex P2).
    pub fn ack_pending(id: &str) {
        if let Ok(mut pending) = PENDING.lock() {
            pending.retain(|v| v.get("id").and_then(|i| i.as_str()) != Some(id));
        }
    }

    pub fn clear_delivered(app: AppHandle) -> Result<(), String> {
        app.run_on_main_thread(|| unsafe {
            let center: id = msg_send![class!(NSUserNotificationCenter), defaultUserNotificationCenter];
            let _: () = msg_send![center, removeAllDeliveredNotifications];
        })
        .map_err(|e| format!("main-thread dispatch failed: {e}"))
    }

    /// Read an NSString into Rust, tolerating nil.
    unsafe fn ns_to_string(s: id) -> Option<String> {
        if s == nil {
            return None;
        }
        let utf8: *const std::os::raw::c_char = msg_send![s, UTF8String];
        if utf8.is_null() {
            return None;
        }
        Some(
            std::ffi::CStr::from_ptr(utf8)
                .to_string_lossy()
                .into_owned(),
        )
    }

    unsafe fn user_info_string(info: id, key: &str) -> Option<String> {
        if info == nil {
            return None;
        }
        let k = NSString::alloc(nil).init_str(key);
        let v: id = msg_send![info, objectForKey: k];
        let _: () = msg_send![k, release];
        ns_to_string(v)
    }

    /// Banner-identity dedupe for the two arrival paths. Every DELIVERED
    /// banner is stamped with a unique nid in its userInfo, so however many
    /// times macOS reports the same physical interaction (launch payload AND
    /// a delegate re-fire), it is one nid, handled once. A content
    /// fingerprint sat here first and codex correctly killed it: two real
    /// banners for the same thread inside its window collapsed into one, and
    /// the same short reply to two DM banners suppressed the second
    /// legitimate send. Identity, not similarity.
    static HANDLED_NIDS: std::sync::Mutex<Vec<u64>> = std::sync::Mutex::new(Vec::new());
    const HANDLED_NIDS_CAP: usize = 64;

    fn already_handled_nid(nid: u64) -> bool {
        let Ok(mut seen) = HANDLED_NIDS.lock() else { return false };
        if seen.contains(&nid) {
            return true;
        }
        if seen.len() >= HANDLED_NIDS_CAP {
            seen.remove(0);
        }
        seen.push(nid);
        false
    }

    /// didActivateNotification — every interaction with every Buddy banner
    /// lands here, on the main thread, for the life of the app.
    extern "C" fn did_activate(_this: &Object, _sel: Sel, _center: id, notification: id) {
        unsafe { handle_notification(notification) }
    }

    /// applicationDidFinishLaunching (observed, not the app delegate): when a
    /// banner click LAUNCHES Buddy, macOS delivers that notification here in
    /// the launch userInfo — before any center delegate could have received
    /// it. Without this, the cold-launch click was captured by nobody and the
    /// pending buffer stayed empty (codex P1, round 2: the buffer alone only
    /// fixed the warm case where the delegate exists but the webview lags).
    extern "C" fn app_did_finish_launching(_this: &Object, _sel: Sel, ns_notification: id) {
        unsafe {
            let info: id = msg_send![ns_notification, userInfo];
            if info == nil {
                return;
            }
            let key = NSString::alloc(nil).init_str("NSApplicationLaunchUserNotificationKey");
            let launch_notification: id = msg_send![info, objectForKey: key];
            let _: () = msg_send![key, release];
            if launch_notification != nil {
                handle_notification(launch_notification);
            }
        }
    }

    unsafe fn handle_notification(notification: id) {
        {
            let info: id = msg_send![notification, userInfo];
            let kind = user_info_string(info, "kind").unwrap_or_default();
            let thread = user_info_string(info, "thread");
            let cwd = user_info_string(info, "cwd");
            let owner = user_info_string(info, "owner");

            // NSUserNotificationActivationType: 1 = contents clicked,
            // 2 = action button, 3 = replied (text lives on .response).
            let activation: i64 = msg_send![notification, activationType];
            let reply_text = if activation == 3 {
                let response: id = msg_send![notification, response];
                if response != nil {
                    let s: id = msg_send![response, string];
                    ns_to_string(s)
                } else {
                    None
                }
            } else {
                None
            };

            // One physical banner = one nid = one action, whichever path
            // (or both) reported it. Banners from a build predating the
            // stamp have no nid and pass through un-deduped — no worse than
            // before the stamp existed.
            if let Some(nid) = user_info_string(info, "nid").and_then(|v| v.parse::<u64>().ok()) {
                if already_handled_nid(nid) {
                    return;
                }
            }

            // The payload is the contract with lib/notifications.ts — it says
            // what happened and to whom, never how to react. Routing policy
            // stays in one place, in the webview.
            let payload = serde_json::json!({
                // A STRING, deliberately: fresh_nid() ≈ startup-millis<<16
                // ≈ 1.2e17, which exceeds JS Number.MAX_SAFE_INTEGER — as a
                // JSON number, adjacent ids rounded to the SAME value in the
                // webview, so its dedupe dropped legitimate later clicks and
                // its acks named an id Rust never issued (codex P1 r5).
                "id": fresh_nid().to_string(),
                "kind": kind,
                "thread": thread,
                "cwd": cwd,
                "owner": owner,
                "reply": reply_text,
            });
            // Buffer FIRST, emit second: if the webview is not up yet the
            // emit is a no-op and the buffer is the only copy.
            if let Ok(mut pending) = PENDING.lock() {
                if pending.len() >= PENDING_CAP {
                    pending.remove(0);
                }
                pending.push(payload.clone());
            }
            // No AppHandle yet = launch-time action: the buffer above is the
            // only copy, and the webview's startup drain is its delivery.
            if let Some(app) = APP.get() {
                let _ = app.emit("buddy://notification-action", payload);
            }

            // The banner was acted on; leaving it in Notification Center
            // invites a second click that would re-fire the action.
            let center: id = msg_send![class!(NSUserNotificationCenter), defaultUserNotificationCenter];
            let _: () = msg_send![center, removeDeliveredNotification: notification];
        }
    }

    /// Present banners even while Buddy is frontmost? NO — parity with the
    /// plugin path and with the OS default: the operator looking at Buddy is
    /// already being told by the board. (lib/notifications.ts additionally
    /// suppresses session alerts on focus; this keeps DM banners consistent.)
    extern "C" fn should_present(_this: &Object, _sel: Sel, _center: id, _n: id) -> BOOL {
        objc::runtime::NO
    }

    fn delegate_class() -> &'static Class {
        static CLASS: OnceLock<&'static Class> = OnceLock::new();
        CLASS.get_or_init(|| {
            let mut decl = ClassDecl::new("BuddyNotificationDelegate", class!(NSObject))
                .expect("BuddyNotificationDelegate already registered");
            unsafe {
                decl.add_method(
                    sel!(userNotificationCenter:didActivateNotification:),
                    did_activate as extern "C" fn(&Object, Sel, id, id),
                );
                decl.add_method(
                    sel!(userNotificationCenter:shouldPresentNotification:),
                    should_present as extern "C" fn(&Object, Sel, id, id) -> BOOL,
                );
                decl.add_method(
                    sel!(buddyAppDidFinishLaunching:),
                    app_did_finish_launching as extern "C" fn(&Object, Sel, id),
                );
            }
            decl.register()
        })
    }

    /// Register the delegate and the launch observer. MUST run from main()
    /// BEFORE tauri::Builder::run(): Tao emits RunEvent::Ready — where the
    /// setup hook runs — from INSIDE its own applicationDidFinishLaunching:,
    /// and observers added during an in-flight notification do not receive
    /// it, so a setup-time registration reads the launch payload exactly one
    /// callback too late and the cold-launch click is lost (codex P1, round
    /// 3 — the round-2 fix had precisely this race). Before NSApplication
    /// runs there is nothing in flight to miss; NSNotificationCenter and
    /// NSUserNotificationCenter both exist pre-run.
    ///
    /// The handler tolerates the missing AppHandle at this stage: an action
    /// with no APP set is buffered and not emitted, and the webview's drain
    /// picks it up — which is the cold-launch delivery path anyway.
    ///
    /// NSUserNotificationCenter.delegate is an ASSIGN property — it retains
    /// nothing — so the instance is deliberately leaked: it must outlive
    /// every banner the app will ever show, and the app's lifetime is exactly
    /// that. A released delegate here is a use-after-free on the first click.
    pub fn early_init() {
        unsafe {
            let delegate: id = msg_send![delegate_class(), new];
            let center: id = msg_send![class!(NSUserNotificationCenter), defaultUserNotificationCenter];
            let _: () = msg_send![center, setDelegate: delegate];

            let name = NSString::alloc(nil).init_str("NSApplicationDidFinishLaunchingNotification");
            let nc: id = msg_send![class!(NSNotificationCenter), defaultCenter];
            let _: () = msg_send![nc, addObserver: delegate
                selector: sel!(buddyAppDidFinishLaunching:)
                name: name
                object: nil];
            let _: () = msg_send![name, release];
            // `delegate` is intentionally not released — see above.
        }
    }

    /// Hand over the AppHandle once Tauri has one (the setup hook). Emitting
    /// starts here; everything before this buffered.
    pub fn init(app: &AppHandle) {
        let _ = APP.set(app.clone());
    }

    pub fn deliver(app: AppHandle, n: NativeNotification) -> Result<(), String> {
        // Deliver from the main thread. The center tolerates other threads in
        // practice, but the delegate lives there and AppKit's documented
        // happy path is the main thread — this is not the place to discover
        // an edge.
        app.run_on_main_thread(move || unsafe {
            let notif: id = msg_send![class!(NSUserNotification), new];

            let title = NSString::alloc(nil).init_str(&n.title);
            let _: () = msg_send![notif, setTitle: title];
            let _: () = msg_send![title, release];

            let body = NSString::alloc(nil).init_str(&n.body);
            let _: () = msg_send![notif, setInformativeText: body];
            let _: () = msg_send![body, release];

            if n.reply {
                let _: () = msg_send![notif, setHasReplyButton: YES];
                let ph = NSString::alloc(nil).init_str("Reply…");
                let _: () = msg_send![notif, setResponsePlaceholder: ph];
                let _: () = msg_send![ph, release];
            }

            // userInfo carries the routing target. Strings only — the
            // delegate reads exactly these keys and nothing else.
            let info: id = msg_send![class!(NSMutableDictionary), new];
            let mut put = |key: &str, value: &str| {
                let k = NSString::alloc(nil).init_str(key);
                let v = NSString::alloc(nil).init_str(value);
                let _: () = msg_send![info, setObject: v forKey: k];
                let _: () = msg_send![k, release];
                let _: () = msg_send![v, release];
            };
            put("kind", &n.kind);
            // The banner's identity, for exactly-once handling across the
            // delegate and launch paths — see already_handled_nid.
            put("nid", &fresh_nid().to_string());
            if let Some(o) = &n.owner {
                put("owner", o);
            }
            if let Some(t) = &n.thread {
                put("thread", t);
            }
            if let Some(f) = &n.from {
                put("from", f);
            }
            if let Some(c) = &n.cwd {
                put("cwd", c);
            }
            let _: () = msg_send![notif, setUserInfo: info];
            let _: () = msg_send![info, release];

            let center: id = msg_send![class!(NSUserNotificationCenter), defaultUserNotificationCenter];
            // deliverNotification COPIES the notification (documented), so
            // releasing ours immediately after is correct, not risky.
            let _: () = msg_send![center, deliverNotification: notif];
            let _: () = msg_send![notif, release];
        })
        .map_err(|e| format!("main-thread dispatch failed: {e}"))
    }
}
