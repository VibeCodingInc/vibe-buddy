# Vibe Buddy

**The always-on Mac surface for /vibe — it owns the interval between turns.**

The terminal owns the turn you're taking. Buddy watches while you're not looking:
who's here, what's waiting on you, which of your sessions and agents are alive —
then it notifies, and hands off to the terminal (for work) or to vibeconf (for a
live room). It is a menu-bar-sized presence board, a DM client, and a doorbell.

Share it: **[slashvibe.dev/buddy](https://www.slashvibe.dev/buddy)** — one screen, one
download button, always the current version.

> **Version note:** source `main` is **unreleased 0.5.64**; the latest signed
> binary remains **0.5.63** (from
> [vibe-buddy-releases](https://github.com/VibeCodingInc/vibe-buddy-releases/releases)).
> Building from source gives you code ahead of the shipped release.

This README describes the client, not the product strategy. The public product
docs live at [docs.slashvibe.dev](https://docs.slashvibe.dev).

## The law

**Client state is a cache and a presentation, never authority** — and every
rendered claim names its evidence and decays:

- **green = verified live presence, now.** Nothing else, ever. Reachability
  ("not reading", "untested") is said in words beside the dot, never encoded in it.
- a failing read renders *can't see*, which is different from *no* — retained
  snapshots age visibly instead of impersonating the present.
- inferred states say they're guesses ("looks like debugging"), name their
  signal, and expire with their heartbeat.
- receipts before assertions: "Invisible" needs a server-acknowledged retraction,
  "archived" needs the acknowledged write, "seated" needs participant evidence
  no signal carries yet — so it is never claimed.

The regression suite (`tests/`, 330 tests) pins these as source-level guards;
most were produced by an internal honest-state audit of every rendered claim.

## Stack

| Layer | What |
|---|---|
| Shell | Tauri 2 — Rust backend, React 18 + TypeScript webview |
| Rust side | local trust boundary: read-only vibe-check SQLite extraction (`context_extractor.rs`), localhost OAuth callback (`auth.rs`), stdio MCP bridge to the Vibeconferencing app (`vibeconf.rs`), MCP auto-setup |
| React side | one list (`UnifiedBuddyList`) + DM panel + My Presence card; all state semantics live in pure derivation libs (`sessionLadder`, `presencePrefs`, `mySessionsState`, `intelligence`, `freshness`) so the UI and the tests read the same truth |
| Tests | vitest (mounted + source-guard) and cargo test |
| Distribution | notarized DMG + updater tarball on GitHub Releases; Tauri auto-update against `slashvibe.dev/api/buddy-update` (signed manifest) |

## Identity · storage · transport

**Identity.** GitHub OAuth → the platform mints a JWT for your handle. One handle
is one principal across every client (Buddy, MCP server, terminal). Agents are
the same kind of citizen with their own revocable per-agent credentials
(`x-agent-mint` → agent JWT; revocation = bump a generation env). No shared
secret ships in any binary. The server stamps
human/agent attribution on every message; clients never guess.

**Storage.** The platform owns all durable truth: Postgres for messages, threads,
read cursors and thread preferences; KV for TTL presence and caches. Locally,
Buddy persists the auth token (`~/.vibe/auth.json`), preferences, and
presentation caches in `localStorage`: confirmed message bodies for fast thread
reopen (up to 100 messages in each of the 50 most recent threads,
`src/lib/messageCache.ts`), plus arrival, call and updater records. Local caches
are presentation state, never authority, and never leave the machine.

**Context sharing (your choice).** Presence detail has two levels
(`src/lib/presencePrefs.ts`); **Minimal is the default** and announces that
you're online plus any status text you choose; it strips CodingDNA.
**Full Context**, if you turn it on, reads local coding data — including
recent human-message text, used only on-device for keyword extraction — and
sends *derived* metadata as presence enrichment:
project, branch, model, token counts, and topic keywords. **Raw prompts,
replies, and code are never sent** in either mode.

**Transport.** HTTPS polling (~6s) with SSE where available; presence is
heartbeat-TTL. Reachability is computed server-side from read-cursor and
stale-unread evidence — whether a handle's mail is being *read*, not whether it
is answered. The one non-platform transport is the local stdio bridge to the
vibeconf app. Always `www.slashvibe.dev` — the apex redirect drops POST bodies.

## The vibeconf seam

Buddy deleted its own WebRTC stack (~1,500 lines) to become the first external
client of the vibeconferencing harness. The integration is three verbs and three
vows.

**Verbs (shipped):**
1. **probe** availability at the moment of use — never cached; the app can quit
   and a Meet expires;
2. **start_call** through the app's bundled MCP server — it mints the Meet,
   sends the user's seat in, and Buddy seeds the room with the launching
   session's context as its first artifact;
3. **hand over the join line** — `/join-call <code>` on the clipboard for a
   human's session, or DM'd to an agent whose seat-consumer walks its body in.
   The paste/DM *is* the session-scoping: the brain arrives knowing the work.

**Vows (the contract that keeps the lanes compatible):**
1. **one Meet-spawner** — Buddy asks the app, never mints rooms itself;
2. **one driver per bot** — Buddy rings doorbells; it never speaks in a room;
3. **render only fetched evidence** — no who's-in-room, no bot state, and rung ③
   ("seated") renders the seat app's self-report as the assertion it is until
   vibeconf can hand over **participant evidence** — the one signal this client
   is still waiting on.

The session ladder (`src/lib/sessionLadder.ts`) renders the four facts of
bringing a session into a call as separately-evidenced rungs; rung ④ ("this
session drives the seat") is honestly `unknown` until a claim primitive exists.

## Build & ship

```bash
pnpm dev                                  # Vite only (:1421)
pnpm tauri dev                            # full dev app
pnpm test && npx tsc --noEmit             # the gate
pnpm tauri build --bundles app --no-sign  # local verification build
```

Version lives in four files in lockstep (`package.json`,
`src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `Cargo.lock`). Signed,
notarized releases are produced and published separately by Slash Vibe, Inc. at
[vibe-buddy-releases](https://github.com/VibeCodingInc/vibe-buddy-releases) —
this repository is the source, not the release channel.

## Read next

- [docs.slashvibe.dev](https://docs.slashvibe.dev) — public product docs (what /vibe is, limits, how Buddy fits)
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to contribute (MIT, no CLA)
- [`SECURITY.md`](SECURITY.md) — reporting a vulnerability

*(History note: an earlier iteration used a Matrix homeserver — retired 2026-07-25;
nothing Matrix-shaped remains in this codebase.)*
