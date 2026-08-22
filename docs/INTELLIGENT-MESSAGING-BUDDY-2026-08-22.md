# Intelligent messaging on the Buddy surface — design sprint

2026-08-22 · **critique material only, no implementation** · canon SHA
`c84ba07192c0882bae0ed69f248be850da075d79` (TRUE-NORTH §2a v0.8.17) ·
governed by `platform/docs/CONTEXTUAL-COLLABORATION-CONTRACT.md` @ `596bfdf0`
(rung-3 context exchange; §4 law 3 platform owns durable truth) · Buddy is a
full messaging door (owns the interval between turns), not an alert viewer.

**Stop boundary:** three concepts + cross-surface comparison + one scenario +
one Stage-0 experiment + a recommendation + Platform questions. No schema,
API, route, tool, Buddy build, prototype code, merge, version bump, or
release. Nothing here unparks `ACTOR_AUTH_MODE` or loosens the contract's own
stop boundary (docs/review + the human-approves-every-send Stage-0).

## The chosen grammar (from the design questions)

- **Where:** the two DECISION points — the **composer** (writing) and the
  **FOR YOU** board (the one "why now" moment). Never the open thread, never
  a feed.
- **Form:** a **quiet inline question** — one short question line + 2–4
  choice chips, monospace, hairline rule, no fill, always dismissable.
  Mirrors terminal AskUserQuestion's *grammar* (a question with bounded
  answers), translated to ROOM TONE, never copied as a widget.
- **Provenance:** a **one-line expandable cue** always present on any
  intelligence moment (`fact · inference · says who ›`), expanding to the
  full labeled breakdown on tap.

Provenance label vocabulary, fixed and colour-coded in words (never colour
alone): **network fact** · **supplied context** · **your agent's inference**
· **remote agent's inference** · **human decision**. Blue is reserved for the
one primary action; green is verified presence only; provenance/meta render
faint.

Interaction laws honored throughout: one question at a time · at most one
intelligence card competing · zero cards is the normal state · every
suggestion dismissable · no send without a visible human action · no standing
AI sidebar · no generic "improve writing" · optimize for fewer clarification
turns, not more AI text.

---

## The three concepts

### A · Quiet / minimal — "it only speaks when spoken to, and briefly"

Intelligence is **pull, not push**, except for the single FOR YOU card.
The composer shows nothing until you pause or tap a faint `⌕ context` cue.
Provenance is one line, collapsed by default. No drafts are ever written for
you — the intelligence only ever asks a bounded question or surfaces a served
fact. The quietest thing that still helps.

- Strength: impossible to feel spammy; "zero cards is normal" is the resting
  state by construction.
- Cost: the telepathic beat is muted — it rarely surprises you, because it
  waits to be asked.

### B · Magical / mentalist — "the other room already knew"

Intelligence leans into the *surprise* of served cross-context facts,
rendered as a quiet question at the exact moment they're useful. Still
one-question-at-a-time, still auditable, but tuned for the grin: the card
appears the instant its evidence is live and dies with it. Includes the
playful concept below.

- Strength: delivers "almost telepathic in effect."
- Cost: higher wrongness cost — a mistimed or thin card spends trust fast; it
  leans hardest on provenance being honest.

### C · Recommended synthesis — "telegraphic surface, mentalist beats, provenance underneath"

A's restraint as the **resting posture** (zero cards normal, pull in the
composer) + B's **one rare, well-timed served card** at the FOR YOU moment,
with provenance always one tap away. The composer asks a bounded question
*only when the human is already acting* (about to send an ambiguous message,
or about to send context); the board surprises *only* when the platform
served something genuinely live. One playful mentalist beat, kept honest.

---

## The six moments (rendered in the chosen grammar)

Renderings are ROOM TONE mockups at ~380px feel: monospace, hairline rules,
faint provenance, blue = the one primary action. `[chip]` = a bounded choice.
Each moment shows the concept that differs; where A/B/C converge, one render
carries the note.

### 1 · Starting a first message

**A (quiet):** the composer is just the field + Send. No intelligence unless
you tap `⌕ context`. Honest, unremarkable.

**C (synthesis) — a bounded intent question, only after you've typed:**
```
to @camille_roux                          ⌕ ›
┌──────────────────────────────────────────┐
│ Message @camille_roux…                    │
│ "hey, saw you joined — what are you       │
│  building?"                               │
└──────────────────────────────────────────┘
what do you want back?
[an answer] [a decision] [a review] [just saying hi]
· nothing inferred — you're choosing the frame ›
                                        [Send ›]
```
The question shapes *nothing in the body*; it only tags the send's intent so
the recipient's door can render "wants: an answer" (moment 4). Provenance
line is honest: **human decision**, zero inference. Dismiss = just Send.

**B (mentalist)** adds, only if the platform served a fact about this
handle: `· @camille_roux is often reached in the evening (network fact) ›` —
a served timing fact, never a guess.

### 2 · Helping sharpen an ambiguous message

Fires **only when you're about to send** and the text is structurally
ambiguous (a question with no subject, a "this/that" with no referent) — a
bounded question, never a rewrite.
```
┌──────────────────────────────────────────┐
│ "can you take a look before I merge?"     │
└──────────────────────────────────────────┘
before you send — look at what?
[the retry PR] [the ingest fix] [leave as-is]
· your agent's inference: two open PRs on this Mac ›
   └ expands →  supplied context: you have 2 PRs
                open in this cwd (retry, ingest)
                · your agent's inference: "look"
                  is likely one of them · human
                  decision: you pick or dismiss
                                        [Send ›]
```
No "improve writing" button; the only options are **concrete disambiguations
drawn from served/local facts** + "leave as-is." Picking one appends a clause
in *your* voice ("— the retry PR"), shown before send. Dismiss = send raw.
This is the law "fewer clarification turns" made literal: it pre-empts the
recipient's "which one?".

### 3 · Choosing what context, if any, travels

The consent moment — bounded, itemized, defaults to nothing.
```
send with context?
[nothing] [just the branch] [branch + the error]
· supplied context — leaves this Mac only if you pick ›
   └ expands →  · branch: drop-legacy-status (network fact,
                  already on your presence)
                · the error: 3 lines from THIS cwd
                  (supplied context — not yet shared)
                nothing travels without this tap.
                                        [Send ›]
```
Default chip is **[nothing]** and pre-selected. Each item names its label and
whether it's already public (branch: already broadcast) vs newly leaving the
Mac (the error). This is the contract's custody/consent boundary rendered as
one question. No item is ever auto-included.

### 4 · Showing why an incoming message matters now (FOR YOU board)

The one push moment — at most one card, zero normal.
```
FOR YOU · 1
┌──────────────────────────────────────────┐
│ @stan · deciding about the same file   4m │
│ he's asking about webhooks/retry.ts —     │
│ the file your open PR renames             │
│ why now ›                                 │
│   └ expands →                             │
│      · network fact: @stan's message      │
│        names webhooks/retry.ts            │
│      · supplied context: your open PR     │
│        touches that path (from this Mac)  │
│      · your agent's inference: they may   │
│        collide — medium confidence        │
│      · human decision: yours              │
│ [open the thread]        [not relevant]   │
└──────────────────────────────────────────┘
```
The headline states only the deterministic join (same file). The *collision*
judgment lives in the expandable, labeled as inference with a named author
and confidence (the destination-design correction from the telepathy cards:
same-artifact match is deterministic, "collide" is semantic inference — name
it). `[not relevant]` teaches the source and decays it.

### 5 · Helping the recipient answer from their DIFFERENT local context

Camille opens the thread on *his* Mac. The intent tag from moment 1 travels;
his local facts are his own.
```
@brightseth · wants: a decision                 (supplied context: his tag)
"is legacy_status safe to drop?"
─────────────────────────────────────────────
answer from what you have?
[your migration notes] [your last deploy] [just reply]
· your agent's inference: 2 local facts match "legacy_status" ›
   └ expands →  · supplied context (from him): wants a decision
                · your agent's inference (Camille's Mac): your
                  migration-notes + deploy-log mention legacy_status
                · remote agent's inference: NONE travels — his
                  agent computed nothing about your Mac
                · human decision: you choose what to pull in
```
Crucial honesty: the label distinguishes **your agent's inference** (local,
Camille's side) from **remote agent's inference** (explicitly *none* — the
sender's agent never reached into the recipient's Mac). This is the moment the
"never a dishonest mind reader" law is most load-bearing.

### 6 · Returning a decision without pretending Buddy knows the original task

Camille decides. The reply carries the decision *as his words*; Buddy never
restates the asker's task (it doesn't own it).
```
you're sending a decision back to @brightseth
[safe to drop] [not yet — rollback reads it] [reply in my words]
· human decision — Buddy carries it, doesn't author it ›
   └ expands →  · Buddy does NOT know @brightseth's original
                  task; it only knows this thread asked for a
                  decision (supplied context, moment 1)
                · picking a chip inserts YOUR sentence; you
                  see and send it
                                        [Send ›]
```
The chips are the recipient's own conclusions, not a summary of a task Buddy
can't see. Back on Seth's board it lands as a normal reply — plus, if he
tagged "a decision," a quiet `· answered: decision` cue. No claim that
anyone read anything.

### The playful mentalist beat (honest) — "the room where it's happening"

One strange-but-true card, C includes it, fires only from two served facts:
```
FOR YOU · 1
┌──────────────────────────────────────────┐
│ ⌕ your blocker is on a whiteboard, live   │
│ @stan's call is working "OAuth redirect   │
│ on custom domains" — your session is      │
│ blocked on "redirect_uri mismatch"        │
│ how'd it know ›                           │
│   └ · network fact: the call published    │
│       its topic + whiteboard title (live) │
│     · supplied context: your session's    │
│       declared blocker (this Mac)          │
│     · your agent's inference: they match   │
│     · dies when the call ends              │
│ [ask to join]            [not relevant]   │
└──────────────────────────────────────────┘
```
The grin: Buddy seems to know what's on a whiteboard across the country. The
truth: two declared facts and a string match, both named, and the card
evaporates with the call. Telepathic in effect, fully auditable underneath.

---

## Cross-surface comparison — the SAME intelligent act, two doors

The act: *"your message is ambiguous — which thing?"* (moment 2).

| | **Terminal** (owns the working turn) | **Buddy** (owns the interval) |
|---|---|---|
| trigger | inline as you type `vibe dm`, before the turn yields | when you tap into the composer with text staged |
| form | a bracketed prompt in the transcript: `which? [1] retry PR [2] ingest fix [3] as-is` | the quiet inline question + chips under the field |
| provenance | a dim line in the scrollback: `· inference: 2 open PRs (this cwd)` | the one-line expandable cue |
| answer | type `1` / `2` / `3` | tap a chip |
| dismiss | Enter / ignore | tap elsewhere / Send raw |
| same underneath | identical bounded-question semantics, identical provenance labels, identical served facts — **one contract, two dialects** |

Family resemblance is the *grammar and the honesty*, not the pixels: Terminal
renders it as transcript text a keyboard drives; Buddy renders it as a
hairline question a pointer drives. Neither invents facts the other wouldn't.

---

## One synthetic end-to-end scenario

1. **Seth, Buddy composer** → types "is legacy_status safe to drop?" to
   @camille_roux. Moment 1 asks intent: he taps **[a decision]** (human
   decision; nothing inferred).
2. Moment 3 offers context: default **[nothing]**; he taps **[branch + the
   error]** — the error leaves his Mac only on that tap (supplied context,
   labeled).
3. Platform persists the message + the attributed, decaying context (contract
   custody/receipt semantics, unchanged).
4. **Camille, next SessionStart** → Buddy FOR YOU shows one card: `@brightseth
   · wants: a decision` (supplied context). He opens it.
5. Moment 5: his agent notes *his* migration-notes mention legacy_status
   (**your agent's inference**, his Mac); **remote agent's inference: none**.
   He taps **[your migration notes]**.
6. Moment 6: he decides — **[not yet — rollback reads it]** — the sentence is
   his; he sends. Buddy never restated Seth's task.
7. Back on Seth's board: a normal reply + `· answered: decision`. No claim
   Camille "read" anything; only that a decision came back.

Clarification turns: **zero** (the "which/what do you want back" was answered
before the first send). That's the win the laws optimize for.

---

## Cheapest Stage-0 experiment (no platform changes)

**"Wizard of Oz intent tags, human-driven, existing transport only."**

- In a real thread between two consenting pilot builders, the *sender types*
  a one-word intent as the first line (`decision:` / `answer:` / `review:` /
  `fyi:`) — no code, just a convention.
- Buddy's existing renderer already shows message bodies faithfully
  (structure fidelity, shipped 0.5.65), so the tag shows as-is.
- Measure, by hand, over ~10 real exchanges: did the tagged intent reduce
  "which one?/what do you mean?" clarification round-trips vs untagged?
- Provenance is trivially honest (the human typed the tag; nothing inferred).
- **Zero** schema/API/tool/build. If the tag demonstrably cuts clarification
  turns, that's the evidence to justify moment 1's bounded question. If it
  doesn't, we've spent a week of typing, not a build.

This matches the contract's own Stage-0 shape: already-shipped messaging, a
human approving every send, no durable structured context.

---

## Recommendation

**Concept C (synthesis)**, and within it, **ship the composer moments before
the board moments.** Reasoning:

- The composer moments (1–3, 6) are **pull or already-acting** — the human is
  mid-decision, so a bounded question there is nearly impossible to
  experience as spam, and each removes a clarification round-trip. They also
  need the least new platform surface (intent tag + consent-scoped context,
  both close to shipped).
- The board moment (4) and the mentalist beat are the **push** surface — the
  highest trust cost and the most platform dependency (served matching,
  decay, `ACTOR_AUTH_MODE`). They're the payoff, but they should follow the
  composer's evidence, not lead.
- C keeps "zero cards is normal" as the resting truth while still delivering
  one telepathic beat, and the one-line-expandable provenance makes every
  beat auditable without turning the surface into a receipt.

Sequence: Stage-0 tag experiment → moment 1 (intent) → moments 2–3
(sharpen/consent) → moment 4 (FOR YOU why-now) → the mentalist beat last.

---

## Questions / contract needs to return to Platform

1. **Intent tag as a served field?** Moments 1, 4, 6 want a message's
   "wants: {answer|decision|review|awareness}" to travel and render on the
   recipient's door. Is that a first-class message field the platform
   reserves and echoes (like announcement provenance), or does it ride in
   body text (Stage-0)? If served: who may set it (sender only)?
2. **Consent-scoped context custody (moment 3):** the contract covers a
   working brief's custody — does a *per-message* context bundle (branch +
   error lines) inherit the same receipt/custody semantics, or does it need
   its own scope? What's the smallest served shape?
3. **Matching authority for moment 4/the mentalist beat:** the card's
   deterministic join (same artifact/same topic) — is that computed platform-
   side (served proposal, per the contract) or may Buddy compute it locally
   from two already-served facts? The contract says platform owns durable
   truth; a live, decaying, never-stored match may be a gray zone worth
   naming.
4. **"remote agent's inference: none" guarantee (moment 5):** is there a
   platform assurance that a sender's agent cannot compute over a recipient's
   local context, so Buddy can render that label truthfully by construction
   rather than by convention?
5. **Decay/receipt for the FOR YOU card:** confirm the card inherits the
   attention-card decay + the no-fabricated-read rules already in the
   contract, so "why now" can never outlive its evidence.

Nothing above is built. Selection + Platform contract confirmation gate any
implementation; the immediate next step on selection is behind-fixtures
prototyping of the chosen composer moment, then real captures — the
established cycle discipline.
