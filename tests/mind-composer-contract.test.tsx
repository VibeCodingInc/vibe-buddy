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
