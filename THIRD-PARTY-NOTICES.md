# Third-party notices

Vibe Buddy is MIT-licensed (© 2026 Slash Vibe, Inc.). It depends on third-party
packages, each under its own license. Versions below are the **exact locked
versions** from the committed lockfiles (`pnpm-lock.yaml`,
`src-tauri/Cargo.lock`) at the time of this export. The lockfiles pin versions
and integrity checksums; the license texts themselves ship with each package.

## npm — runtime dependencies

| Package | Locked version | License |
| --- | --- | --- |
| @tauri-apps/api | 2.10.1 | Apache-2.0 OR MIT |
| @tauri-apps/plugin-http | 2.5.7 | MIT OR Apache-2.0 |
| @tauri-apps/plugin-notification | 2.3.3 | MIT OR Apache-2.0 |
| @tauri-apps/plugin-process | 2.3.1 | MIT OR Apache-2.0 |
| @tauri-apps/plugin-shell | 2.3.5 | MIT OR Apache-2.0 |
| @tauri-apps/plugin-updater | 2.10.0 | MIT OR Apache-2.0 |
| react | 18.3.1 | MIT |
| react-dom | 18.3.1 | MIT |

## npm — development-only dependencies (not distributed in the app)

| Package | Locked version | License |
| --- | --- | --- |
| @tauri-apps/cli | 2.10.0 | Apache-2.0 OR MIT |
| @testing-library/jest-dom | 7.0.0 | MIT |
| @testing-library/react | 16.3.2 | MIT |
| @testing-library/user-event | 14.6.3 | MIT |
| @types/react | 18.3.28 | MIT |
| @types/react-dom | 18.3.7 | MIT |
| @vitejs/plugin-react | 4.7.0 | MIT |
| jsdom | 30.0.1 | MIT |
| typescript | 5.9.3 | Apache-2.0 |
| vite | 5.4.21 | MIT |
| vitest | 2.1.9 | MIT |

## Rust (Cargo) — complete locked graph, all target platforms

`Cargo.lock` contains 601 third-party packages across all supported targets;
not every package compiles into a given platform binary (the
aarch64-apple-darwin build tree resolves to ~500 packages including the app).
The lockfile is the authoritative list with exact versions and checksums. By declared license, the graph is predominantly
**MIT and/or Apache-2.0** (dual-licensed or single), with smaller families:
**Zlib** (e.g. zlib-family triples), **Unicode-3.0** (ICU/unicode crates),
**MPL-2.0** (5 crates), **BSD-2/3-Clause**, **ISC**, **0BSD**, **Unlicense OR
MIT**, **BSL-1.0**, **CC0-1.0/MIT-0**, **CDLA-Permissive-2.0**, and
**Apache-2.0 WITH LLVM-exception**. One crate (`r-efi`) is tri-licensed
`MIT OR Apache-2.0 OR LGPL-2.1-or-later`; MIT is elected. Every crate in the
graph is available under a permissive or weak-copyleft (file-level MPL-2.0)
license compatible with distributing this application; no crate requires a
GPL/AGPL/strong-copyleft license, and none has an unspecified license. Regenerate the full per-crate
list any time with:

```bash
cd src-tauri && cargo metadata --locked --format-version 1 \
  | python3 -c "import json,sys;[print(p['name'],p['version'],p.get('license')) for p in json.load(sys.stdin)['packages']]"
```

## Assets

All icons and images in `src-tauri/icons/` (including the /vibe logo and DMG
background) are original works owned by Slash Vibe, Inc. The /vibe name and
logo are trademarks of Slash Vibe, Inc.; the MIT license covers the code, not
the trademarks. No third-party fonts, stock imagery, or externally sourced
assets are bundled.
