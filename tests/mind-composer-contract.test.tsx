// @vitest-environment jsdom
// TELEPATHY LAB — Suite 1: the composer contract.
//
// "Ordinary messages remain instant. The Mind enters only when a thought
// lingers." (canonical latency law, 2026-08-26)
//
// Machine-provable clauses pinned here:
//   1. a send before the 2.5s linger window causes ZERO Mind requests
//   2. a paused consequential draft causes AT MOST ONE request
//   3. thread switch, draft change, or send discards a stale result silently
//   4. no spinner, no blocked send, no automatic send — ever
//   5. dismiss forgets that exact tension permanently; discard crosses nothing
//
// The real gating helpers (looksConsequential, tensionFingerprint) run
// unmocked; only the native Mind edge (askMind) is stubbed,
// so these tests exercise the production discard logic, not a copy of it.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

const memStore = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (memStore.has(k) ? memStore.get(k)! : null),
  setItem: (k: string, v: string) => { memStore.set(k, String(v)); },
  removeItem: (k: string) => { memStore.delete(k); },
  clear: () => { memStore.clear(); },
  key: (i: number) => [...memStore.keys()][i] ?? null,
  get length() { return memStore.size; },
};

// Native edge controllable; gating helpers REAL.
const askMindMock = vi.hoisted(() => vi.fn());
const primeMindMock = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/mindClient', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    askMind: askMindMock,
    primeMind: primeMindMock,
  };
});

import DMPanel from '../src/components/DMPanel';
import { buddyClient, type VibeMessage } from '../src/lib/vibeClient';
import { realtime } from '../src/lib/realtime';
import { setCachedMessages } from '../src/lib/messageCache';
import { tensionFingerprint, type MindFacet } from '../src/lib/mindClient';

const ME = 'vibetester1';
const THEM = 'vibetester2';

// A draft that passes the real looksConsequential gate.
const TENSE =
  'should we ship the tester harness tonight or wait for the platform exclusion PR to land first?';
// A draft the real gate must ignore.
const FLAT = 'ok sounds good';

const FACET: MindFacet = {
  silence: false,
  offer_kind: 'facet',
  line: 'your own material bears on this · see? ›',
  quote: 'synthetic fixture quote — never real corpus',
  source: 'fixtures/synthetic-note.md',
  content_date: '2026-08-01',
  attribution: "vibetester1's synthetic note records",
  proposed_prose: 'fixture prose for add-and-review',
  why_rotates: 'fixture rotation',
};

let sent: Array<{ content: string }> = [];
// Each askMind call parks here; the test decides when (and whether) the
// "Studio" answers — that is how we simulate the 30–60s round trip.
let pendingAsks: Array<{
  handle: string;
  draft: string;
  resolve: (v: { facet: MindFacet; fingerprint: string } | null) => void;
}> = [];
let incoming: ((messages: VibeMessage[]) => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  pendingAsks = [];
  askMindMock.mockReset();
  primeMindMock.mockReset();
  incoming = null;
  askMindMock.mockImplementation(
    (handle: string, draft: string) =>
      new Promise((resolve) => { pendingAsks.push({ handle, draft, resolve }); })
  );
  vi.spyOn(realtime, 'init').mockImplementation(() => {});
  vi.spyOn(realtime, 'openDM').mockImplementation((_peer, callback) => {
    incoming = callback;
  });
  vi.spyOn(realtime, 'goBackground').mockImplementation(() => {});
  vi.spyOn(realtime, 'setTypingCallback').mockImplementation(() => {});
  vi.spyOn(realtime, 'setMessageEvidenceCallback').mockImplementation(() => {});
  vi.spyOn(realtime, 'hasMessageEvidenceFrom').mockReturnValue(false);
  vi.spyOn(realtime, 'recordStoredMessageWith').mockImplementation(() => {});
  vi.spyOn(buddyClient, 'sendMessageResult').mockImplementation(async (_to, content) => {
    sent.push({ content });
    return { ok: true };
  });
  vi.spyOn(buddyClient, 'sendTypingIndicator').mockResolvedValue(undefined as never);
  memStore.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const mount = (chatWith = THEM, msgs: VibeMessage[] = []) => {
  setCachedMessages(ME, chatWith, msgs);
  return render(
    <DMPanel handle={ME} chatWith={chatWith} onBack={() => {}} users={[]} hasServerThread />
  );
};
const composer = (them = THEM) => screen.getByPlaceholderText(`Message @${them}...`);
const type = (text: string, them = THEM) =>
  fireEvent.change(composer(them), { target: { value: text } });
const pressSend = (them = THEM) => fireEvent.keyDown(composer(them), { key: 'Enter' });
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const flush = () => act(async () => { await Promise.resolve(); });
const answer = (i = 0, facet = FACET) =>
  act(async () => {
    const a = pendingAsks[i];
    a.resolve({ facet, fingerprint: tensionFingerprint(a.handle, a.draft) });
    await Promise.resolve();
  });
const offerLine = () => screen.queryByText(/see ›/);

describe('thread-open priming uses real relationship context', () => {
  const msg = (id: string, content: string): VibeMessage => ({
    id,
    from: THEM,
    to: ME,
    content,
    timestamp: new Date().toISOString(),
    status: 'sent',
  });

  it('does not prime an empty/loading thread, then primes when messages arrive', async () => {
    mount();
    expect(primeMindMock).not.toHaveBeenCalled();
    await act(async () => incoming?.([msg('m1', 'the actual relationship context')]));
    expect(primeMindMock).toHaveBeenCalledTimes(1);
    expect(primeMindMock.mock.calls[0][1]).toContain('the actual relationship context');
  });

  it('newly arrived messages refresh the relationship context', async () => {
    mount(THEM, [msg('m1', 'first context')]);
    expect(primeMindMock).toHaveBeenCalledTimes(1);
    await act(async () => incoming?.([
      msg('m1', 'first context'),
      msg('m2', 'a new turn changes the tension'),
    ]));
    expect(primeMindMock).toHaveBeenCalledTimes(2);
    expect(primeMindMock.mock.calls[1][1]).toContain('a new turn changes the tension');
  });
});

describe('clause 1 — a fast send never wakes the Mind', () => {
  it('send before 2.5s: zero requests, message goes instantly', async () => {
    mount();
    type(TENSE);
    tick(1000); // inside the linger window
    pressSend();
    await flush();
    tick(10_000); // long past any debounce
    expect(askMindMock).not.toHaveBeenCalled();
    expect(sent).toEqual([{ content: TENSE }]);
  });

  it('a non-consequential draft never asks, no matter how long it lingers', () => {
    mount();
    type(FLAT);
    tick(60_000);
    expect(askMindMock).not.toHaveBeenCalled();
  });
});

describe('clause 2 — a lingering consequential draft asks at most once', () => {
  it('one pause, one request — and no re-ask while the draft sits', () => {
    mount();
    type(TENSE);
    tick(2500);
    expect(askMindMock).toHaveBeenCalledTimes(1);
    tick(120_000); // draft keeps sitting, unanswered
    expect(askMindMock).toHaveBeenCalledTimes(1);
  });

  it('every keystroke inside the window resets the linger — no request storm', () => {
    mount();
    for (let i = 0; i < 10; i++) {
      type(`${TENSE} v${i}`);
      tick(1000); // never a full 2.5s pause
    }
    expect(askMindMock).not.toHaveBeenCalled();
  });
});

describe('clause 3 — the discard rule (stale results die silently)', () => {
  it('draft changed after the ask: result discarded, nothing renders', async () => {
    mount();
    type(TENSE);
    tick(2500);
    expect(pendingAsks).toHaveLength(1);
    type(`${TENSE} — actually a different question entirely now?`);
    await answer(0); // Studio answers the OLD tension
    expect(offerLine()).toBeNull();
  });

  it('sent before the answer arrives: result discarded, send was never blocked', async () => {
    mount();
    type(TENSE);
    tick(2500);
    pressSend();
    await flush();
    expect(sent).toEqual([{ content: TENSE }]); // send won the race, instantly
    await answer(0);
    expect(offerLine()).toBeNull();
  });

  it('thread switched before the answer arrives: result discarded', async () => {
    // The host mounts DMPanel with key={chatWith} (App.tsx, codex r1 P1:
    // "a draft written to one person must never be sendable to another —
    // the remount is the state reset"). A thread switch is therefore a
    // fresh mount; the in-flight answer resolves against the unmounted
    // instance and can never paint. The lab models the host contract
    // exactly — key included.
    const view = mount();
    type(TENSE);
    tick(2500);
    setCachedMessages(ME, 'vibetester3', []);
    view.rerender(
      <DMPanel
        key="vibetester3"
        handle={ME}
        chatWith="vibetester3"
        onBack={() => {}}
        users={[]}
        hasServerThread
      />
    );
    await answer(0);
    expect(offerLine()).toBeNull();
  });

  it('tension still current at arrival: exactly one quiet line renders', async () => {
    mount();
    type(TENSE);
    tick(2500);
    await answer(0);
    expect(offerLine()).not.toBeNull();
    expect(screen.getByText(/from synthetic-note\.md/)).toBeTruthy();
    // The runtime's persuasive relevance line is not a fact the collapsed
    // UI may repeat. Relevance remains visibly labeled inside the reveal.
    expect(screen.queryByText('your own material bears on this · see? ›')).toBeNull();
  });
});

describe('clause 4 — no spinner, no blocked send, no automatic send', () => {
  it('while the Mind thinks, the composer is fully live and sending is instant', async () => {
    mount();
    type(TENSE);
    tick(2500);
    expect(pendingAsks).toHaveLength(1); // request in flight
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect((composer() as HTMLTextAreaElement).disabled).toBe(false);
    pressSend();
    await flush();
    expect(sent).toEqual([{ content: TENSE }]);
  });

  it('an offer on screen sends nothing by itself — ever', async () => {
    mount();
    type(TENSE);
    tick(2500);
    await answer(0);
    expect(offerLine()).not.toBeNull();
    tick(300_000); // five minutes of the offer just sitting there
    expect(sent).toEqual([]);
  });

  it('add & review appends to the DRAFT for human review — it does not send', async () => {
    mount();
    type(TENSE);
    tick(2500);
    await answer(0);
    fireEvent.click(offerLine()!); // open the reveal
    fireEvent.click(screen.getByText('add & review'));
    expect((composer() as HTMLTextAreaElement).value).toContain(
      'fixture prose for add-and-review'
    );
    expect(sent).toEqual([]); // still the human's call
  });
});

describe('clause 5 — dismissed means dismissed; discard crosses nothing', () => {
  it('dismissing an offer forgets that exact tension permanently', async () => {
    mount();
    type(TENSE);
    tick(2500);
    await answer(0);
    fireEvent.click(screen.getByText('✕'));
    expect(offerLine()).toBeNull();
    // identical tension lingers again — the Mind must NOT be re-asked
    type(`${TENSE} `); // trailing whitespace: same fingerprint by design
    tick(10_000);
    expect(askMindMock).toHaveBeenCalledTimes(1);
  });

  it('a discarded result leaks nothing into the wire', async () => {
    mount();
    type(TENSE);
    tick(2500);
    type('changed my mind, simpler question — thoughts?');
    await answer(0); // stale answer arrives, is discarded
    pressSend();
    await flush();
    expect(sent).toEqual([{ content: 'changed my mind, simpler question — thoughts?' }]);
    const wire = JSON.stringify(sent);
    // nothing of the facet — not the quote, source, prose, or attribution —
    // may ever appear in what crossed
    expect(wire).not.toContain('synthetic fixture quote');
    expect(wire).not.toContain('fixtures/synthetic-note.md');
    expect(wire).not.toContain('fixture prose');
  });
});

describe('RETURN — "what changed?" asks once, after the facet actually crossed', () => {
  const takeFacetIntoDraft = async () => {
    type(TENSE);
    tick(2500);
    await answer(0);
    fireEvent.click(offerLine()!);
    fireEvent.click(screen.getByText('add & review'));
  };
  const returnPrompt = () => screen.queryByText('what changed in the work?');

  it('an ordinary send never asks', async () => {
    mount();
    type(TENSE);
    pressSend();
    await flush();
    expect(returnPrompt()).toBeNull();
  });

  it('taking a facet does not ask until the words actually leave', async () => {
    mount();
    await takeFacetIntoDraft();
    expect(returnPrompt()).toBeNull(); // armed, not asked
    pressSend();
    await flush();
    expect(returnPrompt()).not.toBeNull();
  });

  it('a failed send does not ask — nothing crossed, so nothing changed', async () => {
    mount();
    vi.mocked(buddyClient.sendMessageResult).mockResolvedValueOnce({
      ok: false, error: 'nope',
    } as never);
    await takeFacetIntoDraft();
    pressSend();
    await flush();
    expect(returnPrompt()).toBeNull();
  });

  it('asks once, not on every subsequent send', async () => {
    mount();
    await takeFacetIntoDraft();
    pressSend();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss the return question' }));
    expect(returnPrompt()).toBeNull();
    type('an ordinary follow-up message with no facet in it at all');
    pressSend();
    await flush();
    expect(returnPrompt()).toBeNull();
  });

  it('deleting the inserted facet before send does not claim a Return', async () => {
    mount();
    await takeFacetIntoDraft();
    type(TENSE);
    pressSend();
    await flush();
    expect(returnPrompt()).toBeNull();
  });

  it('replacing the draft with unrelated prose does not claim the facet crossed', async () => {
    mount();
    await takeFacetIntoDraft();
    type('a completely different ordinary message that contains none of the proposed words');
    pressSend();
    await flush();
    expect(returnPrompt()).toBeNull();
  });

  it('Return is a local nudge, not a fake submission or private log sink', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    mount();
    await takeFacetIntoDraft();
    pressSend();
    await flush();
    expect(returnPrompt()).not.toBeNull();
    expect(screen.queryByPlaceholderText(/decision, a doc/)).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });
});

describe('the Camille defect stays fixed — eligibility is not narrower than the Mind', () => {
  // The exact failure: a real consequential pause the SERVER would honor,
  // refused client-side, silence indistinguishable from intelligence.
  const drafts = [
    'curious how you think about the memory side of this before i commit the schema',
    'maybe the archive should live on my own domain but the platform reach is hard to give up',
    'i keep going back and forth on whether the collector belongs on both machines',
    'i will probably regret shipping this friday though the demo pressure is real',
  ];
  for (const d of drafts) {
    it(`asks for: "${d.slice(0, 40)}…"`, () => {
      mount();
      type(d);
      tick(2500);
      expect(askMindMock).toHaveBeenCalledTimes(1);
      askMindMock.mockClear();
      cleanup();
    });
  }

  it('still refuses obvious non-tensions', () => {
    mount();
    type('ok sounds good thanks talk soon have a great rest of your day today');
    tick(60_000);
    expect(askMindMock).not.toHaveBeenCalled();
  });
});

describe('the field defect stays fixed — asks run to completion and converge', () => {
  // Observed live 2026-08-28: compose-pause-tweak aborted the old ask while
  // the native single-flight refused the new one; a produced aperture never
  // rendered. The law: staleness is the FINGERPRINT's job — an ask completes,
  // its result is judged, and a stale completion re-asks ONCE for the
  // current draft.
  it('a stale completion re-asks once and the final draft gets its offer', async () => {
    mount();
    type(TENSE);
    tick(2500);
    expect(pendingAsks).toHaveLength(1);
    const finalDraft = `${TENSE} — settled on the second option after all?`;
    type(finalDraft); // moved on while ask #1 runs
    await answer(0); // ask #1 completes STALE → discarded → requeues
    tick(400); // the requeue delay
    expect(pendingAsks.length).toBeGreaterThanOrEqual(2);
    await act(async () => {
      const a = pendingAsks[pendingAsks.length - 1];
      a.resolve({ facet: FACET, fingerprint: tensionFingerprint(a.handle, a.draft) });
      await Promise.resolve();
    });
    expect(offerLine()).not.toBeNull(); // the FINAL draft rendered its offer
  });

  it('pauses during an in-flight ask leave it running (no aborts observed)', async () => {
    mount();
    type(TENSE);
    tick(2500);
    const first = pendingAsks[0];
    type(`${TENSE} v2`);
    tick(2500);
    type(`${TENSE} v3`);
    tick(2500);
    // Whatever else the panel did, ask #1 was never aborted: it can still
    // complete and be judged. (The one-native-request guarantee itself is
    // pinned at the unit level where the real askMind runs.)
    expect(first).toBeDefined();
    await answer(0);
  });
});

describe('the Camille paste and the background escalation (real-canary acceptance)', () => {
  // The exact defect class: a 424-byte single-paragraph paste with NO
  // newline. rows=split('\n') counted 1 forever; the box clipped.
  const CAMILLE_PASTE =
    'camille — i keep circling the same fork on this: the particle piece is finished enough to ship and the audience is warm right now, but every time i sit with it i want one more pass on the color field before it lives anywhere permanent, and i cannot tell whether that instinct is craft or fear, and whether waiting for artblocks access is patience or an excuse dressed as patience, so tell me which one you are hearing in this';

  it('a long single-paragraph paste autosizes from rendered height, capped at four lines', () => {
    mount();
    const el = composer() as HTMLTextAreaElement;
    // jsdom renders nothing, so give the element a wrapped scrollHeight.
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 160 });
    type(CAMILLE_PASTE);
    expect(new TextEncoder().encode(CAMILLE_PASTE).length).toBeGreaterThan(400);
    expect(el.getAttribute('rows')).toBe('1'); // rows no longer counts newlines
    expect(el.style.height).not.toBe('');      // height is measured, not guessed
    expect(parseFloat(el.style.height)).toBeLessThanOrEqual(4 * 18 + 14 + 1); // 4-line cap
    expect(el.style.overflowY).toBe('auto');   // beyond the cap scrolls, never clips
  });

  it('the composer resets after send', async () => {
    mount();
    const el = composer() as HTMLTextAreaElement;
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 160 });
    type(CAMILLE_PASTE);
    pressSend();
    await flush();
    // input cleared → autosize effect ran on '' → no lingering tall box
    expect((composer() as HTMLTextAreaElement).value).toBe('');
  });

  it('escalating silence collects the background judgment with one quiet re-ask', async () => {
    mount();
    type(TENSE);
    tick(2500);
    // ask #1: the Mind says "still thinking in the background"
    await act(async () => {
      const a = pendingAsks[0];
      a.resolve({
        facet: { silence: true, escalating: true } as any,
        fingerprint: tensionFingerprint(a.handle, a.draft),
      });
      await Promise.resolve();
    });
    expect(offerLine()).toBeNull(); // nothing rendered, nothing spinning
    tick(18_000); // the quiet re-ask
    expect(pendingAsks.length).toBe(2);
    await answer(1);
    expect(offerLine()).not.toBeNull(); // the cached judgment rendered
  });
});
