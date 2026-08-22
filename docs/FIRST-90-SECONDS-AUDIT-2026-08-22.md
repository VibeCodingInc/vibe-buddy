# First-90-seconds audit — Pass A (public reality) + Pass B (0.5.66 candidate)

2026-08-22 · read-only, no redesign/implementation · the loop under test:
install → find one person → send a real message → receive a useful reply.

## Exact-head SHAs returned for Codex review (no merge)
- **Buddy #6 (reply needle, read side):** `50c42427ed488ddb3f8d7b39c338ed3e47511c17`
- **Buddy #7 (reply targeting, write side):** `ab13f7b537d7f77ed92a30d1731808c65e9583bc`

## Pass A — public reality (as a stranger, read-only; nothing created/redeemed)

Timings are labeled ESTIMATES — a real install was not performed (it means a
real GitHub sign-in + install, hard-to-reverse identity actions this lane
does not take). Surface facts below are live-observed.

| step | observed | est. time |
|---|---|---|
| land on slashvibe.dev/buddy | copy is clean; no forbidden claims (no pairing / live-session watching / autonomous context / voice calling). Privacy line present ("checks the structure of local Claude Code sessions … does not upload prompts/code/replies"). | ~5s read |
| download | "download for mac **v0.5.64**" → `/api/buddy-download` → 302 → GitHub releases **0.5.64** DMG (10.6MB) | ~10s |
| install | drag to /Applications, open; signed + notarized → opens without the right-click-Open dance | ~15s |
| GitHub sign-in | OAuth round-trip (browser authorize) | ~20–40s |
| find a known handle | **BLOCKED on the served build** — see F1/F3 | — |
| first stored message | reachable only if the person was already messaged (WAITING row) | ~5s |

**The served build is 0.5.64** (page + feed + download all agree on 0.5.64).
That build predates BOTH the first-message door and search — so a stranger
who wasn't already messaged has **no way to originate a first message**.

Copy-invite destination (inspected, not created/redeemed): `Copy invite link`
→ `/join/{code}` (tracked). Not exercised.

## Pass B — 0.5.66 candidate (local integration: search + writer + needle)

Rehearsed on a local build combining main (search) + #6 (needle) + #7
(writer). Screenshots: `docs/pilot-audit/writer-chip.png`,
`docs/pilot-audit/needle.png`.

| question | verdict |
|---|---|
| understand "reply"? | **PARTIAL** — the per-message `reply` action is faint and tucked by the timestamp; findable but easy to miss (F4). |
| select the intended parent? | **YES** — clicking a message's reply sets it as target; the chip quotes it verbatim. |
| cancel? | **YES** — the chip's `✕` returns to an ordinary send. |
| send unlinked? | **YES** — default; type and send, no action needed. |
| recognize the quoted answer? | **YES** — `↳ answering "DECISION: which story…" ›` reads without explanation. |

So the 0.5.66 candidate makes the loop legible; the one soft spot is the
discoverability of the `reply` entry action.

## The five highest-cost frictions

1. **Prod serves 0.5.64 — the loop's "find + send" half is absent.** Page,
   feed, and `/api/buddy-download` all serve 0.5.64, which predates the
   first-message door AND search. 0.5.65 was cut but prod has regressed to
   0.5.64; v0.5.65 artifacts exist unreferenced. **Highest cost: the pilot
   loop cannot run on what a stranger downloads today.** (Platform deploy /
   version-integrity; release still gated on the canary.)
2. **Three version numbers a stranger can see.** Download says v0.5.64, the
   board shot says v0.5.63, the latest artifact is v0.5.65. Mismatch erodes
   "is this current?" trust.
3. **No discoverable "find a person" on the served build.** 0.5.64 has no
   visible search; the `/` shortcut is invisible. (Fixed in the 0.5.66
   candidate — search is discoverable there.)
4. **The `reply` affordance is too quiet to discover** (0.5.66 candidate).
   Everything after selecting a parent is clear; the entry action is the
   cost. A candidate one-line tweak later — not now.
5. **Cold-start seed dependency.** Onboarding needs Seth to hand the exact
   @handle (no directory, by design) AND send the first message so the board
   opens with a WAITING row, not an empty room. A pilot checklist item, not a
   bug — but it is where Seth must help.

## These become the one-page pilot checklist
The dominant blocker (F1/F2/F3) is *shipping what's already built* — the
0.5.66 release (search + writer + needle) once the canary passes — plus
fixing the prod version regression so a stranger downloads the real latest.
F4 is a small later tweak; F5 is Seth's manual seed step.
