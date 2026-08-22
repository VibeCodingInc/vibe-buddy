# Invitation-loop audit — repair before promotion

2026-08-22 · verify-first audit · read-only; no repairs built pending GO.
North star: an invitation begins when a human tries to message a KNOWN
collaborator who is not on /vibe. Not discovery, cold outreach, rewards, or a
referral dashboard. Magical sentence: *the person wasn't on /vibe yet, so the
message helped bring them there.*

## Verify results

| # | Check | Verdict | Evidence |
|---|---|---|---|
| 1 | Copy invite link works with the current GitHub JWT | **CODE-CORRECT, live-unconfirmed** | `getInviteLink()` → authed `GET /api/invites/my` then `POST /api/invites`; both use the Bearer JWT. Not live-tested (won't send/act as an identity). Unauthed → falls back to the bare `/invite/{handle}` referral page. |
| 2 | Returns a real tracked /join/{code} URL | **PASS** | `POST /api/invites` → `share_url: https://www.slashvibe.dev/join/{code}`. |
| 3 | Invite survives GitHub OAuth and preserves the inviter | **PASS (data)** | `/join/{code}` → `/api/auth/github?invite_code=…` → callback decodes `invite_code` from OAuth state, redeems, writes `referral_chains.invitee_handle` + `invited_by`. The inviter is durably preserved. |
| 4 | Completion screen names the inviter and offers "Message @inviter" | **FAIL** | The inviter IS named on the PRE-signup `/join/{code}` page (`Invited by @X`). But a NEW user's post-OAuth `successUrl = /welcome`, and `/welcome` **redirects to /join** (generic, no code). No post-signup completion names the inviter, and **"Message @inviter" exists nowhere.** The loop dead-ends at the exact moment the magic should land. |
| 5 | No page claims pairing / live-session watching / autonomous context / built-in voice calling | **PASS** | No such claims on `buddy-page.js`, `join/[code].js`, or `join/index.js`. |
| 6 | All Buddy download/version copy reflects the live signed release | **PASS with one lag** | Download URLs + the requirement line = `v${BUDDY_VERSION}` = **0.5.65** (live). BUT the /buddy board SHOT is captioned `v${BUDDY_BOARD_VERSION}`, which trails BUDDY_VERSION — a version-labeled element not reflecting the live release. Minor. |

Also checked (all clean): no rewards / quota / badge / K-factor language
**surfaced** to users (the backend has referral_chains/max_codes, but the
invite UX shows none of it; `.event-badge` on /join is just the styled
"Invited by @X" line, not gamification). Nothing auto-sends or auto-invites.

## The smallest Buddy interaction — gap

Spec: on `recipient_not_found`, preserve draft/retry AND render one action
"Copy an invite for @handle."
- **Preserve draft/retry: PASS** — the honest historical refusal + Retry
  keeps the attempt (buddy#53).
- **"Copy an invite for @handle": MISSING** — today it only says
  "double-check the handle, or retry." This is the north-star moment itself
  (messaging a known collaborator who isn't on /vibe yet) and the one place
  Buddy should offer the invite. **The key Buddy repair.**

## Repairs (smallest, prioritized) — NOT built pending GO

1. **[Platform · highest] Close the completion loop.** After OAuth, a new
   invited user must reach a completion that **names the inviter** and offers
   **"Message @inviter"** — instead of `/welcome → /join`. The inviter is
   already in `invited_by`/`referral_chains`; the fix carries it to the
   completion (or resolves it there) and renders the one action. This is the
   magical sentence made real: the newcomer is handed straight back to the
   person who brought them.
2. **[Buddy] The Copy-invite action.** On `recipient_not_found`, alongside
   the existing refusal + Retry, render exactly one quiet action:
   **"Copy an invite for @handle"** → copies the tracked `/join/{code}`.
   Never send, never auto-invite; no rewards/quota/badge/K-factor. ROOM TONE:
   one action, appearing exactly when it solves a real human problem.
3. **[Platform · minor] Refresh the /buddy board shot** to 0.5.65 so every
   version-labeled element reflects the live release (or relabel the shot).

## Stage-0 Terminal interaction (spec, for the compose side — not built)
When the recipient isn't on /vibe, the terminal asks what should travel:
`[question only] [question + short context] [link only]`, drafts plain
invitation text, shows the COMPLETE text, requires human approval. No
auto-send.

## Measure (loop, not counts)
attempted real message → invite copied → invite redeemed → original message
sent → useful reply. Do NOT optimize invite counts.

## Recommendation
Repair #1 (platform completion) and #2 (Buddy Copy-invite) are the two that
actually move the loop; #3 is cosmetic. #2 is squarely the Buddy lane and
small — ready to build on GO. #1 and #3 are platform lane.
