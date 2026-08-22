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

## Platform's Stage-0 answers (2026-08-22) — binding constraints on this direction

Concept C is the selected direction (quiet composer intelligence first; the
mentalist FOR YOU card parked). Platform's answers to the five questions
above **narrow what may be rendered as truth**:

1. **Intent is NOT a served field.** "ANSWER" / "DECISION" etc. are literal
   sender-authored, human-approved message *text* — not a reserved field.
2. **No structured context bundle.** Spark + Charge travel as **one ordinary
   message**, inheriting today's message behavior and the **2,000-char
   refusal** boundary. No per-message context schema.
3. **"remote agent's inference: none" is NOT a network fact yet.** In
   Stage-0 it is an informative **author assertion inside untrusted text**.
   Buddy must **not** promote it (or any provenance label) into verified
   chrome.

Consequences for every mockup in this doc: the provenance labels and the
intent tag are, for Stage-0, **plain text a human typed and approved** — they
render exactly as message body renders (structure-faithful, untrusted),
never as elevated/served UI. No schema-dependent UI. The mentalist FOR YOU
card (moment 4 + "room where it's happening") stays **parked** until served
matching + `ACTOR_AUTH_MODE` exist. This sprint is the **interaction
direction, not shipped truth.**

**Spark + Charge, defined for Stage-0:**
- **Spark** = the immediately-readable top line: the ask + its one-word
  intent (`DECISION: is legacy_status safe to drop?`).
- **Charge** = the quiet context underneath, in the same message, that a
  recipient's *different local context* can act on — plain text, honest,
  brief.

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

---

## Pass 3A — authored rehearsal (Buddy design reader)

**Method note:** run as an authored rehearsal, not a live send. Sending a
real DM requires committing to a speaking identity, and M5's Buddy overlaps
@vibetester1/SETHBOT — an outward, hard-to-reverse action this project has
burned on before, so it needs Seth's explicit "send as <handle>" first.
Both local contexts here are synthetic and labeled; this is design evidence,
never demand. Watch-points 1–3 (Spark readable, Charge quiet, not
too-long/form-like/provenance-heavy) are properties of the OUTBOUND message
and need no reply to judge.

Each message is literal Stage-0 text (one ordinary message, ≤2000 chars,
provenance = plain typed words, no chrome).

### Exchange 1 — clean baseline (Spark clear, Charge quiet) ✅
```
DECISION: is legacy_status safe to drop?
context: my drop-legacy-status branch is ready; the only
thing reading the column is the rollback test.
```
- **Buddy render:** two lines. Spark ("DECISION: …") reads instantly as the
  first line; Charge is one faint-feeling sentence below. Structure-faithful
  (0.5.65) keeps the line break.
- **Terminal render:** identical text in the transcript; the recipient's
  `vibe inbox` shows the Spark as the preview line.
- **Verdict:** the target shape. One question, one supporting fact.

### Exchange 2 — more Charge, still quiet ✅ (near the ceiling)
```
REVIEW: does the retry backoff look right before I merge?
context: webhooks/retry.ts — I changed the dedupe key to
normalize before hashing, so retried rows stop colliding.
one open question: whether the 30s cap is too aggressive.
```
- **Buddy render:** Spark + a 3-line Charge. Still readable, but this is the
  ceiling: a fourth Charge line would start to feel like a form.
- **Flag:** Charge should stay ≤3 short lines. Past that, the recipient
  scrolls a paragraph to find the ask — Spark stops being telegraphic.

### Exchange 3 — the failure mode: too form-like / provenance-heavy ❌
```
DECISION: safe to drop legacy_status?
— network fact: branch drop-legacy-status
— supplied context: rollback test reads the column
— your agent's inference: safe after fixture update
— remote agent's inference: none
— human decision: yours
```
- **Buddy render:** five labeled lines — reads as a **receipt, not a
  message.** This is exactly what Platform's answer #3 forbids from becoming
  chrome, and it's ugly even as text.
- **Flag (load-bearing):** the provenance *vocabulary* is for OUR design
  reasoning; it must NOT leak into the sent message. A human writing a DM
  says "safe after the fixture update?" — they don't itemize
  `your agent's inference:`. **Grammar refinement below.**

### Exchange 4 — the playful beat, Stage-0-honest ✅🪄
```
FYI: you're closer to this than you think —
your ingest branch touches the same retry path I'm about to
merge. worth a look before one of us wastes a day?
```
- **Buddy render:** Spark = "FYI" (just-awareness intent), Charge = the
  surprising-but-true connection in one human sentence. The grin survives
  because it's phrased as a person noticing, not a system asserting.
- **Verdict:** this is how the mentalist beat lives in Stage-0 — **as a
  sentence a human chose to send**, not a served card. The card stays parked;
  the *feeling* ships as ordinary text.

### Grammar refinements (from the rehearsal)

1. **Spark = intent word + the ask, one line.** `DECISION:` / `ANSWER:` /
   `REVIEW:` / `FYI:` in caps, then the plain question. Immediately readable
   as the inbox preview line.
2. **Charge = at most ~3 short lines of plain context**, in the sender's
   voice. No label prefixes. The AskUserQuestion composer's job is to help
   the sender *choose* what one fact to include — the message that leaves is
   ordinary prose.
3. **The provenance labels are a COMPOSER-SIDE reasoning aid, never sent
   text.** They belong in the (future) composer UI that helps you decide
   what travels — not in the wire message. Exchange 3 is the anti-pattern.
4. **The intent word is the only "structured" thing, and it's just a
   convention** — cheap to test, honest (a human typed it), and it's what a
   future served field would formalize once Platform can.
5. **Playful stays in prose** (Exchange 4): the surprising connection is a
   human sentence, so it can't over-claim.

### Cross-surface critique (Terminal composer → Buddy reader)

- Terminal's native AskUserQuestion is the right **composer** for Stage-0:
  the sender picks intent (`what do you want back?`) and picks the one Charge
  fact (`include the branch? the error? nothing?`) via bounded chips — then
  Buddy (and Terminal inbox) just render the resulting ordinary message.
- The asymmetry is correct: **rich bounded questions at compose time
  (Terminal), quiet flat text at read time (Buddy).** Buddy stays a reader;
  the intelligence is a compose-time aid, not a read-time overlay. This keeps
  "no standing AI sidebar" and "Buddy renders platform truth" intact.
- Danger to watch across 3–5 real exchanges: senders over-charging the
  message (Exchange 2→3 drift). The composer must make "send less" the easy
  default.

### Smallest fixture-only composer prototype — recommended IF 3A holds

If 3–4 live 3A exchanges confirm the Spark stays readable and the Charge
stays quiet, the smallest next step is a **fixture-only DEV prototype of ONE
composer moment: the intent chooser (moment 1)**:

- Dev-harness only (`?compose=intent`), no shipped component change, no
  schema. Renders the composer with the quiet inline question
  (`what do you want back? [answer][decision][review][fyi]`); picking a chip
  **prepends the literal intent word** to the drafted message. That's the
  entire behavior — it writes plain text a human then sends.
- It proves the interaction (does a bounded intent chip feel better than
  typing `DECISION:`?) with zero platform dependency and nothing that could
  be mislabeled as served truth.
- Explicitly NOT in the prototype: Charge itemization UI, provenance chrome,
  the FOR YOU card, any served field. Those wait on Platform.

**Recommendation:** run 3–4 real 3A exchanges (Seth or a confirmed sending
identity → slashvibebot) to confirm the shape, THEN build only the intent-
chooser fixture prototype. Do not build ahead of the live evidence.

---

## Live Pass 3A — identity ruling + observation protocol (2026-08-22)

- **Sender:** @brightseth, fresh Terminal session.
- **Recipient:** @vibetester1 (occupied by slashvibebot — different local context).
- **Buddy lane (this reader):** cross-surface critic only. Does NOT send,
  reauthenticate, or occupy either identity. Observation is of the named
  @vibetester1 thread as surfaced by Seth (screenshot/paste) — reading via
  the vibe MCP would mean acting as an identity, which the ruling forbids.

**Adopted grammar (supersedes the rehearsal's label vocabulary for sent text):**
- one intent word: `ANSWER` / `DECISION` / `REVIEW` / `FYI`.
- Charge ≤ 3 short sentences, in the human's voice.
- NO receipt-like fields ("local-agent inference:" etc.) in the message.
- provenance lives **naturally in prose**: "my agent noticed…", "I know…",
  "my read is…" — the honesty stays, the form disappears.
- the rare playful connection sounds like a person noticing, never a platform
  assertion.

**On arrival of the one real question, the reader checks:** (1) Spark
understood immediately · (2) Charge stays quiet/readable · (3) provenance
clear without becoming form-like · (4) reply contributes genuinely new
recipient-side context · (5) report cross-surface. **Do not implement the
fixture prototype yet.**

### Live 3A — send recorded (reply pending)

- @brightseth → @vibetester1, human-approved, **439 chars sent verbatim**,
  inbox untouched. The semantic messaging experiment is VALID.
- **Protocol deviation (separate evidence, NOT an intelligent-message
  failure):** the running client stayed **0.8.16** while the cwd config pins
  **0.8.17**, so the response lacked a message ID + server timestamp — the
  **rich-receipt gate is NOT passed**. This is **onboarding/update evidence**
  (stale-runtime vs pinned-config drift; an MCP-CLI/update lane concern),
  reported apart from the Spark/Charge reading. No resend.

### Live 3A — reconciled: cross-session interleaving (not a mismatch)

**Correction (supersedes the earlier "envelope mismatch" reading below was
based on):** there was **no 439→1,219 mutation and no transport corruption.**
Two different @brightseth sessions sent two different questions into the *same
named thread* — a 439-char sealed-envelope INTENT question and a newer
1,219-char 0.8.18 question. Slashvibebot selected the **newer** one and
drafted against it; it has now been directed to target the earlier 439-char
message.

**Requirement, corrected:** not "exact bytes." The platform sanitizes
content, so the right requirement is that **both ends agree on the same
durable message record and its semantic body** — the record, not the raw
bytes.

**The stale 0.8.16 runtime** reduced receipt evidence (no message ID /
timestamp) but **did NOT cause the confusion** — it stays purely
onboarding/update evidence.

**The actual finding — cross-session interleaving:**
- multiple sessions share the one @brightseth handle;
- independent asks from those sessions land in one thread;
- the recipient view exposes **no reply-target / message ID**;
- so "answer the newest message" can reconnect a reply to the **wrong
  originating task**.

This is a real intelligent-messaging requirement and it is cross-surface:
a reply must target a **specific durable message record**, and both the
recipient's reader (Buddy/Terminal inbox) and the composer must make *which
message am I answering* explicit — otherwise Charge/intent from ask A gets a
reply shaped for ask B. It sits alongside provenance, not above Spark/Charge.

**Status:** Pass 3A is **no longer globally inconclusive.** The semantic
critique **resumes** when slashvibebot's reply to the **439-char INTENT
message** is surfaced. The newer 1,219-char draft/message is **out of that
specific score.** No resend, no prototype; reader posture holds.

### Live 3A — first reply surfaced: it answers the OUT-OF-SCOPE message

The surfaced blue sent-bubble is the **verbose message**, not the 439-char
sealed-envelope INTENT one. Tells:
- it carries labeled receipt fields in the wire text — "Supplied facts:",
  "Local-agent inference: … an inference by Seth's agent", "Approved by:
  @brightseth" — and a "(reply format request: ANSWER first · CALLBACK ·
  LOCAL CONNECTION · PROVENANCE … · NEXT HUMAN DECISION)" schema. That's far
  past 439 chars and is exactly the message the ruling put **outside the
  score**.
- Therefore the **formal five-point semantic critique stays paused** for the
  439-char INTENT reply. What follows is in-bounds observation only.

**In-bounds observation #1 — the out-of-scope message is a live instance of
the rehearsal anti-pattern (Exchange 3).** It sends the provenance
*vocabulary as wire fields* ("Local-agent inference:") and appends a rigid
reply-format schema. In Buddy it renders as a **large blue wall** you scroll
to find the ask. This is precisely what the adopted Stage-0 grammar forbids
("do not send receipt-like fields"; "provenance in prose"). Useful negative
evidence: it confirms *why* the 439 sealed-envelope shape is the one to test.

**In-bounds observation #2 — the reply itself renders well and is genuinely
substantive.** Structure-faithful prose paragraphs (0.5.65), readable at
width. It contributes **genuinely new recipient-side context** — that "what
we removed" already shipped as a public story (the deleted fake green), so
leading with it again would make /vibe "a confession brand" — a real,
recipient-held fact the sender didn't supply. And it closes with honest
identity: "slashvibebot, currently using the temporary @vibetester1 account."
That last line is **provenance-in-prose done right** — the exact register the
adopted grammar wants.

**In-bounds observation #3 — the reply IGNORED the requested rigid schema**
and answered in human prose anyway. Strong signal that the "(reply format
request: ANSWER · CALLBACK · LOCAL CONNECTION · PROVENANCE · NEXT HUMAN
DECISION)" schema **adds nothing** — the honest prose reply is better than
the form it was asked to fill. Reinforces: keep the composer's intelligence a
compose-time *aid*, do not impose a wire schema on either end.

**Still pending for the actual score:** slashvibebot's reply to the
**439-char INTENT** message. No score, no prototype until then. Reader
posture holds.

### Live 3A — SCORED · reply reattributed to the 439-char INTENT question

**Reclassification:** the "Lead with two doors, one conversation" reply IS
slashvibebot's approved answer to the **439-char INTENT** question (matches
the approved draft: two-doors headline · "what we removed already shipped as
a public story" · "would make /vibe a confession brand" · sealed envelope =
soul/law). It does **not** answer the 0.8.18 message. My earlier
misclassification was caused by the reader surface itself — see cross-surface
report #2. Not transport corruption; contents succeeded, association failed.
No resend.

#### Five-point semantic critique

Spark = the 439-char INTENT body (known record/semantic body: an INTENT-tagged
ask on how to lead Buddy's product narrative once the four public surfaces
pass, sealed envelope preserved). Reply = "Lead with two doors…".

1. **Spark understood immediately? PASS.** The answer proves comprehension:
   slashvibebot split the exact tension the Spark posed — *soul* (the sealed
   envelope, the law) vs *headline* (the actionable first sentence) — and
   answered the headline question directly ("two doors, one conversation").
   You don't answer that precisely unless the Spark landed cleanly.
2. **Charge quiet/readable? PASS (by known shape).** The 439-char body kept
   context to a few sentences; the reply engaged the right facts with no
   "which do you mean?" — the clarification-turn count is zero, the win the
   grammar optimizes for.
3. **Provenance clear-in-prose, not form-like? PASS — exemplary.** The reply
   is the target register: *"My inference is your instinct is right about the
   soul and wrong about the headline"* (inference labeled as inference, in
   prose), *"I found on X that…"* (names the source of a recipient-side
   fact), and the closing *"slashvibebot, currently using the temporary
   @vibetester1 account"* (honest identity). Zero receipt fields.
4. **Reply adds genuinely new recipient-side context? PASS — best case.**
   *"what we removed already shipped as a public story: the deleted fake
   green"* is a fact the recipient discovered from ITS different local world
   (access to X, memory of the prior public narrative) — not supplied by the
   sender. This is the whole point of cross-context messaging: the other room
   knew something you didn't, and said why. It reframed soul-vs-headline into
   an actionable recommendation. Strong.

**Semantic intelligence verdict: strong pass. The agents understood each
other and the correct answer added useful, genuinely different context.**

#### Cross-surface linkage report (reported separately, per ruling)

- **Semantic intelligence:** ✅ succeeded (above). The message contents and
  the cross-context value both worked.
- **Visual conversation structure:** ❌ **failed.** Buddy could not prove
  which earlier message the reply answered. The verbose 0.8.18 message sat
  immediately above the reply with **no reply-to marker**, so a careful
  reader (this lane) bound the answer to the wrong question. The association
  lives only in slashvibebot's head, not on the surface.

#### The finding (elevated — possibly the experiment's best result)

> The agents understood each other, but the conversation UI could not show
> which thought the answer belonged to.

This is concrete and non-theoretical. It unifies with the earlier
cross-session-interleaving note: **messages need a durable record reference,
replies need a reply-to pointer to that record, and Buddy must RENDER it.**
The design target (not implemented): when a message is a reply to a specific
durable message record, Buddy shows a small quoted stub above it —
`↳ replying to: DECISION: is legacy_status safe to drop?` — so the answer's
thought is visible, not inferred. Ordinary chat doesn't do this; doing it is
a concrete way /vibe is *more* intelligent than chat, and it makes the
honest-provenance work legible (you can't trust "answers your DECISION" if
you can't see which decision).

**Platform question (new):** does a reply carry a `reply_to` reference to the
originating durable message record, and can Buddy render it? This is the
smallest surface that would have prevented the misattribution — and it's a
reader-side requirement, distinct from the (parked) served-matching work.

No implementation, no prototype, no resend. Reader posture holds.

### Direction (2026-08-22): reply association first, but frame it correctly

**Priority:** reply association over the fixture composer prototype.

**Framing (do not conflate):**
- A quoted reply marker is **messaging foundation / parity** — ordinary chat
  has it; it is NOT by itself the intelligent-messaging differentiator.
- The **differentiator** is using the durable reply target to **reconnect an
  answer to the correct project / session / decision** — the thing ordinary
  chat can't do. The marker is the substrate that makes that reconnection
  honest and visible.

**Gate:** wait for **Platform's read-only contract audit** of what actually
exists. **Do NOT implement or assume a `reply_to` field.** Concepts below are
QUEUED, not designed, until Platform reports the real contract shape.

**Queued screenshot-first concepts (after the audit):**
1. a **compact quoted Spark** above the reply (parity — "↳ replying to: …").
2. the **originating session / project shown only when served** (the
   differentiator groundwork — never inferred; rendered only if the platform
   actually carries the origin).
3. **truthful unknown** when no origin is available ("origin not recorded" —
   never a guess, never a fabricated link).

**Camille (warm human move):** stays queued. **Platform drafts** the message;
**this lane approves the wording** before it goes to a real person, with
explicit consent. Pass 3B only after that.

No build, merge, or release. Reader posture holds pending Platform's audit.
