# Working in this repo (for coding agents and new contributors)

This is the public source of Vibe Buddy, the Mac client for /vibe. Read
`README.md` first; it states the law every change must keep: **client state is
a cache and a presentation, never authority**, and every rendered claim names
its evidence and decays.

## Run it

```bash
pnpm install --frozen-lockfile   # pnpm only; npm would bypass the lockfile
pnpm test                        # vitest (mounted + source-guard tests in tests/)
npx tsc --noEmit                 # type gate
pnpm run build                   # frontend build; cargo needs ../dist to exist
cd src-tauri && cargo test --locked
```

Node 22 (CI) or newer, pnpm as pinned in `package.json` `packageManager`.
These four commands are the whole CI gate (`.github/workflows/ci.yml`), plus a
gitleaks secret scan.

**No environment variables are needed** to build or test. Nothing in `src/`
reads a `VITE_*` value in production; any `.env.local` you find locally is
leftover and not required. Never add a secret to the bundle: a value baked
into the webview ships in every public DMG.

## What a cloud session can and cannot do here

- Can: all of the above, open PRs, run the full test suite.
- Cannot: run the app with a real account (`pnpm tauri dev` needs a Mac and a
  signed-in `~/.vibe/auth.json`), sign, notarize, or release. Releases are
  produced separately by Slash Vibe, Inc. and published at
  `VibeCodingInc/vibe-buddy-releases`; no job or agent in this repo gets
  release credentials.
- Version lives in lockstep in `package.json`, `src-tauri/Cargo.toml`,
  `src-tauri/tauri.conf.json` (and `Cargo.lock`). Do not bump it in a feature
  PR; version bumps are their own release PR.

## Rules that have been paid for

- **Buddy is never a second sender for someone else's decision.** Terminal
  drafts (`src-tauri/src/drafts.rs`, `src/lib/terminalDrafts.ts`) are shown and
  decided here but sent only by the terminal package's `vibe-draft` CLI, bound
  to the exact revision the person saw. "Sent" is said only on the package's
  word. Uncertainty is a structured field (`may_have_sent`), never a regex over
  prose.
- **Green means verified live presence, now.** Reachability goes in words next
  to the dot, never in its color.
- **Staging, not submitting.** Buddy may put text into a session; the human
  presses enter. No submit path exists, keep it that way.
- **Never turn what someone did into an opinion they gave.** A read receipt is
  not agreement; a click is not a preference.
- **Race tests drive the component's real tick** (fake timers), not a resolved
  mock. Bump generation counters when a decision *completes*, and suppress polls
  while one is in flight.
- **A CLI or API error envelope must never deserialize into an outcome.**
- Everything a feature adds above the composer goes in one bounded region.
- Always call `https://www.slashvibe.dev` — the apex redirect drops POST bodies.

## Where decisions live

Durable decisions go in this repo (this file, `README.md`, PR descriptions).
If a rule only exists in a chat or a message, a new session cannot see it; add
it here in the same PR that depends on it.
