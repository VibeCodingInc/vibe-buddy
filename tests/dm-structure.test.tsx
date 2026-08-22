// @vitest-environment jsdom
// Structure fidelity in the messaging door (joint critique on buddy#49).
//
// The objective is exact: newline fidelity 0% → 100%. Between builders and
// agents the payload IS structure — numbered lists, blank-line separations,
// indented commands — and the shipped thread collapsed every \n to a space
// while the composer could not author one at all. These tests pin both
// directions, plus the boundaries the critique named: whitespace-only sends
// stay blocked, outbound bodies leave byte-exact (interior whitespace
// untouched; edge-trim is the pre-existing send contract, unchanged), and
// nothing here renders rich content or touches read state.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

// The runtime's own localStorage global is half-implemented under the test
// runner (Node's shadow of jsdom's), and messageCache swallows its throws by
// design — which silently turns "seeded thread" into "empty thread". Install
// a real store before anything touches it (same pattern as
// revoked-token.test.ts).
const memStore = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (memStore.has(k) ? memStore.get(k)! : null),
  setItem: (k: string, v: string) => { memStore.set(k, String(v)); },
  removeItem: (k: string) => { memStore.delete(k); },
  clear: () => { memStore.clear(); },
  key: (i: number) => [...memStore.keys()][i] ?? null,
  get length() { return memStore.size; },
};
import DMPanel from '../src/components/DMPanel';
import { buddyClient, type VibeMessage } from '../src/lib/vibeClient';
import { realtime } from '../src/lib/realtime';
import { setCachedMessages } from '../src/lib/messageCache';

const ME = 'alice_demo';
const THEM = 'bob_demo';

const msg = (id: string, from: string, content: string): VibeMessage => ({
  id,
  from,
  to: from === ME ? THEM : ME,
  content,
  timestamp: new Date().toISOString(),
  status: 'sent',
});

// The component runs for real; only the wire is disconnected.
let sent: Array<{ to: string; content: string }> = [];
beforeEach(() => {
  sent = [];
  vi.spyOn(realtime, 'init').mockImplementation(() => {});
  vi.spyOn(realtime, 'openDM').mockImplementation(() => {});
  vi.spyOn(realtime, 'goBackground').mockImplementation(() => {});
  vi.spyOn(realtime, 'setTypingCallback').mockImplementation(() => {});
  vi.spyOn(buddyClient, 'sendMessageResult').mockImplementation(async (to, content) => {
    sent.push({ to, content });
    return { ok: true };
  });
  vi.spyOn(buddyClient, 'sendTypingIndicator').mockImplementation(async () => {});
  memStore.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const mount = (messages: VibeMessage[]) => {
  setCachedMessages(ME, THEM, messages);
  return render(<DMPanel handle={ME} chatWith={THEM} onBack={() => {}} users={[]} />);
};

const composer = () => screen.getByPlaceholderText(`Message @${THEM}...`) as HTMLTextAreaElement;

describe('inbound structure renders byte-faithfully, as inert text', () => {
  it('a numbered/bulleted list keeps its lines', () => {
    const body = 'Three findings:\n1. ingest dedupe\n2. flaky retry\n- docs lockfile';
    mount([msg('m1', THEM, body)]);
    const node = screen.getByText((_, el) => el?.textContent === body && el?.tagName === 'DIV');
    // The DOM holds the exact bytes AND the style that makes them visible:
    // textContent preserves \n regardless of CSS, so asserting content alone
    // would pass against the collapsed shipped render.
    expect(node.style.whiteSpace).toBe('pre-wrap');
    expect(node.textContent).toBe(body);
  });

  it('consecutive blank lines survive', () => {
    const body = 'first paragraph\n\n\nsecond paragraph';
    mount([msg('m1', THEM, body)]);
    const node = screen.getByText((_, el) => el?.textContent === body && el?.tagName === 'DIV');
    expect(node.textContent).toBe(body);
    expect(node.style.whiteSpace).toBe('pre-wrap');
  });

  it('a long unbroken string is given a wrap rule instead of forcing the thread sideways', () => {
    const body = 'x'.repeat(300);
    mount([msg('m1', THEM, body)]);
    const node = screen.getByText((_, el) => el?.textContent === body && el?.tagName === 'DIV');
    expect(node.style.overflowWrap).toBe('anywhere');
  });

  it('bodies are inert plain text — no rich rendering path exists', () => {
    // A markdown/HTML body must arrive as its literal characters. React text
    // nodes escape by construction; the source pin below keeps it that way.
    const body = '**not bold** <b>not bold either</b>\n`not code`';
    mount([msg('m1', THEM, body)]);
    const node = screen.getByText((_, el) => el?.textContent === body && el?.tagName === 'DIV');
    expect(node.textContent).toBe(body);
    expect(node.querySelector('b')).toBeNull();
    const src = readFileSync(join(process.cwd(), 'src/components/DMPanel.tsx'), 'utf8');
    expect(src).not.toMatch(/dangerouslySetInnerHTML/);
    // No rich-render dependency may enter this component (imports, not
    // prose — the slice's own comments name what it refuses).
    expect(src).not.toMatch(/from ['"](react-)?(markdown|marked|remark|rehype)/i);
  });
});

describe('the composer authors structure without changing the send contract', () => {
  it('Return sends; the outbound body is byte-exact including interior newlines', () => {
    mount([]);
    const box = composer();
    fireEvent.change(box, { target: { value: 'line one\nline two\n\nline four' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(sent).toEqual([{ to: THEM, content: 'line one\nline two\n\nline four' }]);
  });

  it('Shift+Return does NOT send — it composes', () => {
    mount([]);
    const box = composer();
    fireEvent.change(box, { target: { value: 'first line' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(sent).toEqual([]);
    // jsdom does not run the browser's default text-insertion, so the
    // newline itself is asserted through the real browser capture harness
    // (?dm=…) and through the preventDefault split below: unshifted Return
    // is consumed by Buddy, shifted Return is left to the platform default.
    const defaultPrevented = fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(defaultPrevented).toBe(true); // not prevented → browser inserts \n
    const unshifted = fireEvent.keyDown(box, { key: 'Enter' });
    expect(unshifted).toBe(false); // prevented → Buddy sent instead
  });

  it('whitespace-only input does not send — including whitespace with newlines', () => {
    mount([]);
    const box = composer();
    for (const value of ['   ', '\n', ' \n \n ', '\t\n']) {
      fireEvent.change(box, { target: { value } });
      fireEvent.keyDown(box, { key: 'Enter' });
    }
    expect(sent).toEqual([]);
  });

  it('edge-trim is the pre-existing contract and interior whitespace is not touched', () => {
    mount([]);
    const box = composer();
    fireEvent.change(box, { target: { value: '\n  kept \n interior  \n' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(sent).toEqual([{ to: THEM, content: 'kept \n interior' }]);
  });

  it('the box grows 1→4 lines with explicit newlines and no further', () => {
    mount([]);
    const box = composer();
    expect(box.rows).toBe(1);
    fireEvent.change(box, { target: { value: 'a\nb\nc' } });
    expect(box.rows).toBe(3);
    fireEvent.change(box, { target: { value: 'a\nb\nc\nd\ne\nf' } });
    expect(box.rows).toBe(4);
  });

  it('the shortcut is discoverable at the moment of composition', () => {
    mount([]);
    const box = composer();
    fireEvent.focus(box);
    expect(screen.getByText(/return sends · shift-return for a new line/)).toBeTruthy();
    fireEvent.blur(box);
    expect(screen.queryByText(/return sends/)).toBeNull();
  });
});

describe('nothing else moved', () => {
  it('read state stays untouched — still zero markThreadRead callers (kill switch 0a)', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/DMPanel.tsx'), 'utf8');
    expect(src).not.toMatch(/markThreadRead|markRead|read_cursor/);
    // And none of the deferred concepts leaked into this slice as RENDERED
    // copy (isFreshLastSeen, the presence-dot gate, is not that).
    expect(src).not.toMatch(/['"`]seen |read receipt|new since/i);
  });

  it('send/failure honesty unchanged: a failed send renders the word and a Retry', async () => {
    // Driven through the real send path (the cache deliberately refuses to
    // seed failed/optimistic messages): the wire refuses once, the bubble
    // must say the word and offer the action.
    (buddyClient.sendMessageResult as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ ok: false }));
    mount([]);
    const box = composer();
    fireEvent.change(box, { target: { value: 'did this land?' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText('Failed')).toBeTruthy();
    expect(screen.getByText('Retry')).toBeTruthy();
    // The failed body keeps its structure too.
    expect(screen.getByText('did this land?')).toBeTruthy();
  });

  it('the message list does not remount when the composer grows', () => {
    // The composer and the thread are sibling subtrees; typing must never
    // rebuild the messages. Pin the observable: the same DOM node survives
    // composer changes.
    const body = 'anchor message';
    mount([msg('m1', THEM, body)]);
    const before = screen.getByText(body);
    const box = composer();
    fireEvent.change(box, { target: { value: 'a\nb\nc' } });
    expect(screen.getByText(body)).toBe(before);
  });
});
