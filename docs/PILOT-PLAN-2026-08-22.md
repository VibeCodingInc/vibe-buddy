# Trusted-circle pilot — the shortest path to "I used it again"

2026-08-22 · the goal is the LOOP, not architecture:
install → find one person → send a real message → it waits honestly →
receive a useful reply → continue on Terminal or Buddy → use it again.

Two-week internal targets (not public traction): 5 installs · 3 real
communicating pairs · 2 unprompted repeat uses · 1 collaborator-initiated
invite.

**The filter applied to every item:** "Does this help a new person send,
understand, or repeat a real message this week?" If no → parked.

## Release-state truth (pinned)
- **Live 0.5.65** (`ea4e734`): first-message door + structure fidelity +
  FOR YOU zone + notifications. The *send* half of the loop already ships.
- **Merged, UNRELEASED on main** (`f86bc5c`): the visible Search affordance
  (#5) — the discoverable "find one person" entry point. Not in 0.5.65.
- **Open, CI-green** (#6): the reply needle (render-only) — the answer naming
  its question.
- **Not built yet:** explicit reply targeting (Buddy's reply action WRITING
  reply_to at send). Without it, needles never appear in real threads.
- **Platform dependency:** the authoritative reply_to security/privacy
  boundary (custody: you only see a parent you're a party to; no forgery).

## Shortest remaining ship list (pilot-blocking only)
1. **[Platform] Close the reply_to security/privacy boundary.** YES-filter:
   protects the reply loop from leaking a parent you weren't party to. Blocks
   release.
2. **[Buddy] Explicit reply targeting — write reply_to at send.** YES: it's
   what makes a reply land on the right question; the needle is inert without
   it. One small slice against existing storage (no schema). The last build.
3. **[Buddy] Reply needle render — PR #6.** YES: the reader sees which thought
   an answer belongs to. Merge on review.
4. **[Buddy] First-90-seconds audit** (install → sign in → find one person →
   send). YES: it's the whole onboarding. Findings feed only fixes that touch
   the loop; no redesign.
5. **[Release] 0.5.66** containing search (#5) + needle (#6) + reply
   targeting — cut ONLY after the canary.
6. **[Canary] One end-to-end linked reply passes:** A sends → B replies with
   targeting → the needle shows on A's correct question, both ends agree.
   Release gate.

Everything else PARKED: human stitch · mentalist cards · automatic matching ·
verified project/session reconnection · broad redesigns · any architecture
that doesn't move the loop.

## Exact pilot onboarding path (what a new person actually does)
1. Seth sends the person the **/buddy page** (slashvibe.dev/buddy) or the DMG
   link directly.
2. They download, drag to /Applications, open. macOS 13+ / Apple Silicon,
   signed + notarized (Gatekeeper-clean — 0.5.65 verified).
3. **Sign in with GitHub** (one OAuth; the only identity step).
4. Board opens. If they arrive alone: the quiet room says so honestly + the
   invite link. If Seth already messaged them: it's the first WAITING row.
5. **Find one person:** tap **⌕ Search**, type the exact @handle Seth gave
   them → **Message @handle ›** → composer opens.
6. **Send a real message.** It waits honestly across closed terminals.
7. **Receive a reply** — in Buddy, or in their terminal (`vibe` MCP), same
   durable thread. With reply targeting + needle: the answer names its
   question.
8. **Repeat** — the win condition is step 8 happening unprompted.

Terminal-side entry (for the agent-builders): `npx slashvibe-mcp`, then
`vibe dm @handle` — same thread, either door.

## What Seth must do manually
- Pick the five (below) and, for each, **send the first message himself** so
  their board opens with a real WAITING row, not an empty room (the empty
  room is the weakest first impression; a waiting message is the strongest).
- Hand each person their exact @handle to search for (the search box needs a
  real handle; there is no directory, by design).
- Run the **linked-reply canary** with one trusted handle before cutting
  0.5.66 (Seth in the loop; not @brightseth↔@vibetester1 for the real pairs —
  those are rehearsal identities).
- Approve the 0.5.66 release + the signed-lane run (Studio), as before.
- Keep a one-line log per pair (installed? sent? replied? repeated?) — the
  four pilot numbers are counted by hand, on platform#200.

## Five realistic pilot candidates (known, consented relationships only)
No cold outreach, no invented interest. Ranked by fit to the product AS IT
EXISTS (Mac + GitHub + builds with coding agents) and by evidence of a real,
current relationship.

1. **Camille Roux (@camilleroux)** — ALREADY mid-conversation with Seth (real
   genart-mint thread, replied substantively). Mac/GitHub builder, HumanCoders
   co-founder. Highest-signal: engagement is observed, not assumed. *Ask: none
   — already communicating; just bring him a repeat reason.*
2. **Brian Flynn (@bflynn4141)** — ALREADY installed Buddy (same-day). Real
   builder. *Ask: Seth re-engages with a real message to earn a repeat use.*
3. **Stan** — co-builder on the /vibe ecosystem (vibe-check), unambiguously
   Mac+GitHub+agents; a consented working relationship. Insider, so his
   friction is expert-level evidence. *Ask: Seth invites him as a pilot pair.*
4. **Chris** — named in the coordinator's earlier pilot-invite set
   (Stan/Chris/Brian); a known relationship Seth already flagged for this.
   *Ask: Seth confirms fit + invites.*
5. **Josh** — known relationship (Seth was already sharing vibeconf.app with
   him). Likely Mac/builder. *Ask: Seth confirms he builds with agents; if
   yes, invite; if he's more of a vibeconf user, keep him for that lane
   instead.*

**Honesty flags:** #1–2 have observed engagement; #3–5 are real relationships
whose pilot participation Seth must actually ask for — I'm not asserting they
have agreed or are interested. If any doesn't build with agents, their value
is language/onboarding feedback, not a communicating pair.

**Language-sense check only (NOT a pilot pair, not the market):** Kristi can
tell us whether Buddy's copy and the first 90 seconds make sense to a
non-agent-builder. Useful for wording; excluded from the pair/repeat counts.

## After this
Stop building. Recruit the circle. The next breakthrough is not a feature —
it is one person saying "I used /vibe again because it was easier."
