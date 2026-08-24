# The mentalist experience — Buddy + iOS design prototype

2026-08-24 · design branch only · fixtures synthetic (real people/facts never
committed; the founder's real Mind data lives only in ~/.vibe/mind) · no
release or merge without review.

Governing distinction: **Gmail completes the sentence. /vibe completes the
circuit between minds.** Every concept below surfaces something the OTHER
side of the circuit needs — never autocomplete.

The visible product stays: conversation list → thread → composer.
Live states: `?mind-proto=quiet|offer|sheet|threshold|invite`
Screenshots: docs/mentalist-proto/*.png

## THREE CONCEPTS (distinct, not variations)

### 1 · THE MIND PASS — "You wrote this Tuesday"        [offer.png, sheet.png]
After typing begins, one line above the composer states a RETRIEVAL FACT:
  You wrote this Tuesday: "the seams are the provenance" · include? ›
Tap → sheet: the exact retrieved quote · source + as-of + consent-age ·
"your agent's retrieval" label · the exact prose that would be added ·
add & review / edit / don't add. One strong connection or silence. Sending
never waits. The circuit: YOUR past self joins the conversation, cited.
Failure guarded: per-thread dismissal memory; no offers on trivial drafts.

### 2 · INVITE A MIND — the question as the door        [invite.png]
The new-conversation door for a mind not yet here doesn't ask "who?" — it
asks: **"What thought would be better with them in it?"** The Mind proposes:
the unresolved thought (from your open threads, cited) · why this person
(labeled inference) · one unexpected connection · a three-sentence
invitation. Human selects the person, edits, approves. No streaks, no
address-book mining, no people-you-may-know — one person, one reason,
nothing recurring (footer says so on the surface itself).
The circuit: the invitation IS a thought, so the relationship starts mid-
conversation instead of at "hey, try my app."

### 3 · THE ANSWER FINDS ITS THOUGHT — the needle grows roots
Extend the shipped reply needle one segment when VERIFIED origin exists:
  ↳ answering "which story should lead…" · began in your work: vibe-app ›
Tap returns to the originating work (session/repo/decision). Where origin
is unverified: the needle stays exactly as it ships today — nothing said,
or an honest unknown. NEVER an inferred project relationship rendered as
fact. The circuit: the answer pays its debt to the flow it interrupted —
the "return" arc of the loop, which currently has no story anywhere.

## THE BOLDEST — THE THRESHOLD                          [threshold.png]
Crossing into a thread, ONE line of your own remembered history with this
mind, before any typing:
  You noted in March: you and @renata were both at the Marfa print fair, '23 ›
Rank-1 (direct shared history) facts ONLY · retrieval-fact copy · your-note
attribution + date visible inline · dismissible · once per thread ever.
Why it's the "how did it know?" moment: it's the founder evidence replayed —
the system reminding you WHO THIS PERSON IS TO YOU at the exact moment you
enter the room (the reunion moment, generalized). Also the most dangerous
concept: anything below rank-1 confidence here reads as surveillance, so
the quality floor is absolute and silence is the overwhelming default.

## SMALLEST LIVE FOUNDER-ONLY PROTOTYPE
1. (done) This fixture prototype — screenshot-first, synthetic data.
2. (next, ~1 hr) `mind.py --serve`: localhost-only endpoint returning the
   candidate JSON for a thread id; MindPrototype gains `?live=1` reading
   http://127.0.0.1:<port> — Seth's real Camille candidate renders in the
   real Buddy dev shell on M5 only. Nothing committed, nothing synced,
   production bundles unchanged (DEV-gated import).
3. Rollout gate: ten real-message evidence points in the experiment log.

## PLATFORM TRUTH EACH CONCEPT REQUIRES
- Mind Pass: NONE — edge-only (local Mind + composer). Recipient disclosure
  of assisted prose = contract gap #4, deferred to the product gate.
- Invite a Mind: tracked invite URL (exists) + repaired completion (#284) so
  the invitee lands on "Message @inviter". No new endpoint.
- Answer-finds-its-thought: verified origin = contract gaps #6 (session ↔
  principal identity) and #3 (canonical thread/work address). BLOCKED on
  platform truth by design — prototype may only use fixture origins.
- Threshold: NONE beyond the local Mind — but its quality floor wants the
  Mind's rank-1 bucket only.

## WHAT STAYS INVISIBLE
The index and ranking · misses (silence, never "nothing found") · source
scanning · cross-machine sync state · confidence scores · any Mind activity
outside a composing/threshold moment · dashboards, memory tabs, insight
feeds, suggestion streams (banned destinations) · and the Mind itself as a
nameable UI object — it has no icon, no screen, no brand. Only its one line.
