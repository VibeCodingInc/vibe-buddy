# Contributing to Vibe Buddy

Thanks for helping. A few ground rules keep contributions easy on both sides.

## License

This repository is MIT-licensed (© 2026 Slash Vibe, Inc.). **By submitting a
contribution (pull request, patch, or suggestion incorporated into the code),
you agree it is licensed under the repository's MIT license.** There is no CLA.

## Getting started

Requires **Node 22+** (the test suite uses Node's global `navigator`, present
since Node 21; CI runs Node 22) and pnpm (version pinned via `packageManager`).

```bash
pnpm install --frozen-lockfile   # install the reviewed dependency graph
pnpm dev                         # vite dev server (frontend)
pnpm tauri dev                   # full app (requires Rust + Tauri prerequisites)
pnpm test                        # vitest suite
```

This repository uses pnpm (see `packageManager` in package.json); `npm install`
would bypass `pnpm-lock.yaml` and test an unreviewed graph.

## What makes a good change

- Honest states first: Buddy never claims a state it has not verified.
  Green means verified live presence, now — nothing else.
- One definition per concept; if a concept already has a module, extend it.
- A user-visible fix should come with a regression test.
- Keep system copy quiet: no exclamation marks, errors name the fix.

## What we will not merge

- Claims the platform has not verified (presence, delivery, read state).
- A second source of truth for identity, unread state, or receipts.
- Analytics or behavioral telemetry of any kind — usage tracking, crash
  reporting to third parties, fingerprinting. (Distinct from the product's
  own user-controlled presence/context sharing, which is minimal by default,
  documented in the README, and always the user's explicit choice.)

Releases are signed and published separately by Slash Vibe, Inc.; this
repository is the source, not the release channel.
