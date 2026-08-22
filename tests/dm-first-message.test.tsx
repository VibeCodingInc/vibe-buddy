// @vitest-environment jsdom
// The first-message door (buddy#53, critique-approved): Buddy can originate
// a conversation. Three affordances, one contract:
//   · @handles in message bodies are clickable — LINKING ONLY, claiming
//     nothing about the handle
//   · exact-handle search falls back to "Message @x ›"
//   · the composer opens with NOTHING sent; a thread reaches RECENT only via
//     the server's stored-message receipt; recipient_not_found renders its
//     honest reason and fabricates no thread; nothing ever says "verified"
//     (the server's lookup fails open).

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';

const memStore = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (memStore.has(k) ? memStore.get(k)! : null),
  setItem: (k: string, v: string) => { memStore.set(k, String(v)); },
  removeItem: (k: string) => { memStore.delete(k); },
  clear: () => { memStore.clear(); },
  key: (i: number) => [...memStore.keys()][i] ?? null,
  get length() { return memStore.size; },
};
import DMPanel, { renderBodyWithHandles } from '../src/components/DMPanel';
import { announcementKind, ANNOUNCEMENT_SEAM_TRUSTED } from '../src/lib/vibeClient';
import { buddyClient, type VibeMessage, type VibeUser } from '../src/lib/vibeClient';
import { realtime } from '../src/lib/realtime';
import { setCachedMessages } from '../src/lib/messageCache';

const ME = 'alice_demo';
const THEM = 'coltrane';

const msg = (id: string, from: string, content: string): VibeMessage => ({
  id,
  from,
  to: from === ME ? THEM : ME,
  content,
  timestamp: new Date().toISOString(),
  status: 'sent',
});

let sendResult: { ok: boolean; error?: string } = { ok: true };
beforeEach(() => {
  sendResult = { ok: true };
  vi.spyOn(realtime, 'init').mockImplementation(() => {});
  vi.spyOn(realtime, 'openDM').mockImplementation(() => {});
  vi.spyOn(realtime, 'goBackground').mockImplementation(() => {});
  vi.spyOn(realtime, 'setTypingCallback').mockImplementation(() => {});
  vi.spyOn(realtime, 'setMessageEvidenceCallback');
  // No call-through: the evidence set is a module singleton, and a real
  // write from one test would arm panels in every later test.
  vi.spyOn(realtime, 'recordStoredMessageWith').mockImplementation(() => {});
  vi.spyOn(realtime, 'hasMessageEvidenceFrom').mockReturnValue(false);
  vi.spyOn(buddyClient, 'sendMessageResult').mockImplementation(async () => sendResult);
  vi.spyOn(buddyClient, 'sendTypingIndicator').mockImplementation(async () => {});
  memStore.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const mount = (messages: VibeMessage[], them?: VibeUser, onOpenThread?: (h: string) => void, hasServerThread = true) => {
  setCachedMessages(ME, THEM, messages);
  return render(
    <DMPanel
      handle={ME}
      chatWith={THEM}
      onBack={() => {}}
      users={them ? [them] : []}
      onOpenThread={onOpenThread}
      hasServerThread={hasServerThread}
    />,
  );
};

describe('@handles in bodies are linking only', () => {
  it('tokenizes a mention at a word boundary and lowercases the target', () => {
    const parts = renderBodyWithHandles('welcome @Camille_Demo to /vibe', () => {});
    const link = parts.find((p) => typeof p !== 'string') as { handle: string; text: string };
    expect(link.handle).toBe('camille_demo');
    expect(link.text).toBe('@Camille_Demo');
    // The surrounding text survives byte-exact.
    expect(parts.map((p) => (typeof p === 'string' ? p : p.text)).join('')).toBe('welcome @Camille_Demo to /vibe');
  });

  it('canonicalizes hyphens to underscores — the platform handle rule — while display keeps the text', () => {
    const parts = renderBodyWithHandles('ping @foo-bar please', () => {});
    const link = parts.find((p) => typeof p !== 'string') as { handle: string; text: string };
    expect(link.handle).toBe('foo_bar');
    expect(link.text).toBe('@foo-bar');
  });

  it('never links the domain half of an email', () => {
    const parts = renderBodyWithHandles('mail me at seth@example.com ok?', () => {});
    expect(parts.every((p) => typeof p === 'string')).toBe(true);
  });

  it('without a navigation host the body stays one plain string', () => {
    expect(renderBodyWithHandles('hi @bob_demo', undefined)).toEqual(['hi @bob_demo']);
  });

  it('clicking a mention opens that thread with nothing sent', () => {
    const opened: string[] = [];
    mount([msg('m1', THEM, 'New user @camille_demo just joined /vibe!')], undefined, (h) => opened.push(h));
    fireEvent.click(screen.getByText('@camille_demo'));
    expect(opened).toEqual(['camille_demo']);
    // Linking sent nothing.
    expect(buddyClient.sendMessageResult).not.toHaveBeenCalled();
  });
});

describe('the thread header speaks served words only', () => {
  const base: VibeUser = { handle: THEM, status: 'active', oneLiner: '', isAgent: true };

  it('broadcast-only reads as not-reading; heartbeat age is its own clause', () => {
    mount([], { ...base, status: 'away', ago: '2h', reachability: 'broadcast-only' });
    // The board's chip word, so board and thread agree; the full sentence
    // renders ONCE, at the composer moment (mounted-honesty pins that).
    expect(screen.getByText(/away 2h · not reading/)).toBeTruthy();
  });

  it('an agent with unknown reachability reads as reading unknown — a gap, not a claim', () => {
    mount([], { ...base, reachability: 'unknown' });
    expect(screen.getByText('reading unknown')).toBeTruthy();
  });

  it('listening renders SILENCE — arriving mail is not evidence of reading', () => {
    // classifyReachability flips to listening on fresh unread alone
    // (codex r1 P1); "at most reading messages" permits less, and less is
    // what the evidence supports.
    mount([], { ...base, reachability: 'listening' });
    expect(screen.queryByText(/reading/)).toBeNull();
  });

  it('a human without annotation gets silence, and no copy ever promises a reply', () => {
    mount([], { handle: THEM, status: 'active', oneLiner: '' });
    expect(screen.queryByText(/reading/)).toBeNull();
    const src = readFileSync(join(process.cwd(), 'src/components/DMPanel.tsx'), 'utf8');
    expect(src).not.toMatch(/will reply/i);
    // The rendered copy never claims verification (the server's recipient
    // lookup fails open) — the word may appear in comments explaining the
    // refusal, never in user-facing strings.
    expect(screen.queryByText(/verified/i)).toBeNull();
  });
});

describe('recipient_not_found is an honest refusal, not a phantom thread', () => {
  it('renders the reason with Failed/Retry and clears it on retry', async () => {
    sendResult = { ok: false, error: 'recipient_not_found' };
    mount([]);
    const box = screen.getByPlaceholderText(`Message @${THEM}...`);
    fireEvent.change(box, { target: { value: 'hello?' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText(/the server couldn[’']t find @coltrane when this was/)).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
    sendResult = { ok: true };
    fireEvent.click(screen.getByText('Retry'));
    // The reason is presentation state for a specific refusal; a retry that
    // was accepted must not keep accusing.
    expect(screen.queryByText(/the server couldn[’']t find/)).toBeNull();
  });

  it('no client-side thread creation path exists — RECENT is server-served', () => {
    // The panel presents; the platform owns the thread list. A failed or
    // never-sent composer session must leave nothing behind.
    const src = readFileSync(join(process.cwd(), 'src/components/DMPanel.tsx'), 'utf8');
    expect(src).not.toMatch(/createThread|addThread|threads\.push/);
    const app = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8');
    expect(app).not.toMatch(/createThread|addThread/);
  });
});

describe('exact-handle search is the fallback door', () => {
  it('one fallback definition serves BOTH rooms — populated dead end and quiet room (source pin)', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/UnifiedBuddyList.tsx'), 'utf8');
    // Handle-shaped queries only, canonicalized like the platform
    // (lowercase, hyphens→underscores), opening via the normal onUserClick
    // path; ONE definition so the two rooms can never drift (codex r3 P2).
    // Handle-shaped, canonicalized (lowercase, hyphens→underscores), and
    // filtered through the platform grammar + synthetic exclusion before a
    // door may render.
    expect(src).toMatch(/const composeCandidate = \(\(\) => \{/);
    expect(src).toMatch(/!isTestAccount\(composeCandidate\)/);
    // Served form first; aliasing to underscores only when no served
    // identity claims the raw form (codex r13 P1).
    expect(src).toMatch(/servedRaw \? raw : raw\.replace\(\/-\/g, '_'\)/);
    expect(src).toMatch(/onUserClick\(composeQuery\)/);
    // THREE rooms now: populated dead end, quiet room, outage (codex r13).
    expect((src.match(/firstMessageFallback\}/g) || []).length).toBe(3);
    expect(src).toMatch(/Message @\{composeQuery\} ›/);
    // Exact beats fuzzy (codex r4 P2): the door renders whenever no
    // presented principal IS the target — a substring match cannot shadow it.
    // ...and hides only when the target's own row is ACTUALLY RENDERED —
    // an alias search for a known-but-filtered principal still gets the
    // door (codex r5 P2).
    // Suppression checks BOTH forms — a rendered hyphenated row must not
    // coexist with a canonicalized door stealing Enter (codex r13 P1).
    expect(src).toMatch(/presentedHandles\.has\(composeQuery\) \|\| presentedHandles\.has\(composeQuery\.replace\(\/_\/g, '-'\)\)/);
    expect(src).toMatch(/composeQuery && !composeTargetPresented \?/);
    expect(src).toMatch(/filteredWaiting\.map\(\(t\) => t\.with\.toLowerCase\(\)\)/);
  });
});

describe('the receipt boundary: opening a composer creates nothing', () => {
  it('a never-messaged principal is not polled — the platform GET would create the thread', () => {
    mount([], undefined, undefined, false);
    expect(realtime.openDM).not.toHaveBeenCalled();
  });

  it('a stored-message receipt arms polling', async () => {
    mount([], undefined, undefined, false);
    const box = screen.getByPlaceholderText(`Message @${THEM}...`);
    fireEvent.change(box, { target: { value: 'first message' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await screen.findByText('first message');
    expect(realtime.openDM).toHaveBeenCalled();
  });

  it('a REFUSED send arms nothing', async () => {
    sendResult = { ok: false, error: 'recipient_not_found' };
    mount([], undefined, undefined, false);
    const box = screen.getByPlaceholderText(`Message @${THEM}...`);
    fireEvent.change(box, { target: { value: 'hello?' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await screen.findByText('Failed');
    expect(realtime.openDM).not.toHaveBeenCalled();
  });

  it('an existing server thread polls exactly as before', () => {
    mount([], undefined, undefined, true);
    expect(realtime.openDM).toHaveBeenCalled();
  });
});

describe('the announcement label obeys the served kind only', () => {
  it('renders the label and bulletin frame when the platform marked the message', () => {
    mount([{ ...msg('a1', THEM, 'New user @x_demo just joined /vibe!'), kind: 'announcement' }]);
    expect(screen.getByText('automated announcement · from /vibe')).toBeTruthy();
  });

  it('an announcement-LOOKING body without the served kind gets no label — no inference', () => {
    mount([msg('a2', THEM, 'New user @y_demo just joined /vibe!')]);
    expect(screen.queryByText(/automated announcement/)).toBeNull();
    // And the RENDERED label never names the carrying handle as the author
    // (the comment explaining that rule may use the words; copy may not).
    expect(screen.queryByText(/via @/)).toBeNull();
  });
});

describe('announcement kind is validated at the client edge', () => {
  it('the seam is TRUSTED now that the deployed activation proof passed (platform#272)', () => {
    // The write boundary owns the provenance fields (audit: 42,275 prod
    // rows clean; forged ordinary-JWT send stored no fields; genuine
    // internal announcement stored both). Full step-4 coverage against the
    // exact stored payloads lives in dm-announcement-activation.test.tsx.
    expect(ANNOUNCEMENT_SEAM_TRUSTED).toBe(true);
    expect(announcementKind({ kind: 'announcement', generated_by: 'platform' })).toBe('announcement');
  });

  it('requires BOTH payload.kind=announcement AND generated_by=platform', () => {
    expect(announcementKind({ kind: 'announcement', generated_by: 'platform' })).toBe('announcement');
    // A sender-authored payload claiming to be an announcement is not one.
    expect(announcementKind({ kind: 'announcement', generated_by: 'coltrane' })).toBeUndefined();
    expect(announcementKind({ kind: 'announcement' })).toBeUndefined();
    expect(announcementKind({ generated_by: 'platform' })).toBeUndefined();
    expect(announcementKind(undefined)).toBeUndefined();
    expect(announcementKind('announcement')).toBeUndefined();
  });
});

describe('late-arriving server truth and invalid tokens', () => {
  it('a thread appearing after mount arms polling without a send (codex r2 P1)', () => {
    setCachedMessages(ME, THEM, []);
    const view = render(
      <DMPanel handle={ME} chatWith={THEM} onBack={() => {}} users={[]} hasServerThread={false} />,
    );
    expect(realtime.openDM).not.toHaveBeenCalled();
    view.rerender(
      <DMPanel handle={ME} chatWith={THEM} onBack={() => {}} users={[]} hasServerThread={true} />,
    );
    expect(realtime.openDM).toHaveBeenCalled();
  });

  it('an overlong run stays text — never a link to a truncated other handle (codex r2 P2)', () => {
    const parts = renderBodyWithHandles('see @' + 'a'.repeat(45) + ' there', () => {});
    expect(parts.every((p) => typeof p === 'string')).toBe(true);
  });

  it('an accepted send is a storage receipt, never identity — the glyph stays until a roster row (codex r6 P2)', async () => {
    setCachedMessages(ME, THEM, []);
    const { container } = render(
      <DMPanel handle={ME} chatWith={THEM} onBack={() => {}} users={[]} hasServerThread={false} />,
    );
    const box = screen.getByPlaceholderText(`Message @${THEM}...`);
    fireEvent.change(box, { target: { value: 'first' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await screen.findByText('first');
    // Send accepted (fail-open lookup) — still no same-named GitHub face.
    expect(container.querySelector('img[src*="github.com"]')).toBeNull();
  });

  it('stale presence suppresses the served-words line — words never outlive evidence (codex r6 P2)', () => {
    setCachedMessages(ME, THEM, []);
    render(
      <DMPanel handle={ME} chatWith={THEM} onBack={() => {}}
        users={[{ handle: THEM, status: 'away', ago: '2h', isAgent: true, reachability: 'broadcast-only', oneLiner: '' }]}
        presenceStale={true} />,
    );
    expect(screen.queryByText(/away 2h/)).toBeNull();
    expect(screen.queryByText(/not reading/)).toBeNull();
  });

  it('an unverified composer shows a neutral glyph, never a same-named GitHub face (codex r2 P2)', () => {
    setCachedMessages(ME, THEM, []);
    const { container } = render(
      <DMPanel handle={ME} chatWith={THEM} onBack={() => {}} users={[]} hasServerThread={false} />,
    );
    expect(container.querySelector('img[src*="github.com"]')).toBeNull();
    // With a served roster row, the face returns.
    cleanup();
    setCachedMessages(ME, THEM, []);
    const withUser = render(
      <DMPanel handle={ME} chatWith={THEM} onBack={() => {}} users={[{ handle: THEM, status: 'active', oneLiner: '' }]} hasServerThread={false} />,
    );
    expect(withUser.container.querySelector('img[src*="github.com"]')).toBeTruthy();
  });
});

describe('archived conversations wake on stored-message evidence (codex r7 P2)', () => {
  it('an unarmed panel listens passively, and the peer writing arms polling', async () => {
    setCachedMessages(ME, THEM, []);
    render(
      <DMPanel handle={ME} chatWith={THEM} onBack={() => {}} users={[]} hasServerThread={false} />,
    );
    expect(realtime.openDM).not.toHaveBeenCalled();
    // The evidence listener is registered (SSE only — no fetch, no create)...
    const calls = (realtime.setMessageEvidenceCallback as ReturnType<typeof vi.fn>).mock.calls;
    const cb = calls.find((c) => typeof c[0] === 'function')?.[0] as (from: string) => void;
    expect(cb).toBeTruthy();
    // ...a stranger writing arms nothing; THIS peer writing arms polling.
    act(() => cb('someone_else'));
    expect(realtime.openDM).not.toHaveBeenCalled();
    act(() => cb(THEM));
    await waitFor(() => expect(realtime.openDM).toHaveBeenCalled());
  });
});

describe('synthetic principals and retained evidence (codex r9)', () => {
  it('a synthetic mention stays text — the board hides those conversations', () => {
    const parts = renderBodyWithHandles('ping @test_qa_bot and @synth-check now', () => {});
    expect(parts.every((p) => typeof p === 'string' || !/^(test_|synth)/.test((p as {handle:string}).handle))).toBe(true);
  });

  it('retained SSE evidence arms an archived thread at mount', () => {
    vi.spyOn(realtime, 'hasMessageEvidenceFrom').mockReturnValue(true);
    setCachedMessages(ME, THEM, []);
    render(<DMPanel handle={ME} chatWith={THEM} onBack={() => {}} users={[]} hasServerThread={false} />);
    expect(realtime.openDM).toHaveBeenCalled();
  });

  it('the refusal outranks a stale roster row — only an accepted retry clears it', async () => {
    sendResult = { ok: false, error: 'recipient_not_found' };
    setCachedMessages(ME, THEM, []);
    render(
      <DMPanel handle={ME} chatWith={THEM} onBack={() => {}}
        users={[{ handle: THEM, status: 'active', oneLiner: '' }]} hasServerThread={false} />,
    );
    const box = screen.getByPlaceholderText(`Message @${THEM}...`);
    fireEvent.change(box, { target: { value: 'hello?' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    // The roster row is on screen AND the refusal renders: retained
    // snapshots are not newer proof than the send path.
    expect(await screen.findByText(/the server couldn[\u2019']t find @coltrane/)).toBeTruthy();
  });
});

describe('the door obeys the platform handle grammar; drafting notifies nobody (codex r10)', () => {
  it('impossible candidates never mint a composer (source pin)', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/UnifiedBuddyList.tsx'), 'utf8');
    // 3–20 chars, no leading underscore, not numeric-only — validateHandle's
    // own rules, so a one-letter prefix search cannot steal Enter from a
    // visible match.
    expect(src).toMatch(/if \(c\.length < 3 \|\| c\.length > 20\) return null/);
    expect(src).toMatch(/c\.startsWith\('_'\) \|\| \/\^\[0-9\]\+\$\/\.test\(c\)/);
  });

  it('drafting toward an unverified target sends no typing event', () => {
    setCachedMessages(ME, THEM, []);
    render(<DMPanel handle={ME} chatWith={THEM} onBack={() => {}} users={[]} hasServerThread={false} />);
    const box = screen.getByPlaceholderText(`Message @${THEM}...`);
    fireEvent.change(box, { target: { value: 'drafting a first message' } });
    expect(buddyClient.sendTypingIndicator).not.toHaveBeenCalled();
  });

  it('with thread evidence, typing indicators flow as before', () => {
    setCachedMessages(ME, THEM, []);
    render(<DMPanel handle={ME} chatWith={THEM} onBack={() => {}} users={[]} hasServerThread={true} />);
    const box = screen.getByPlaceholderText(`Message @${THEM}...`);
    fireEvent.change(box, { target: { value: 'hi' } });
    expect(buddyClient.sendTypingIndicator).toHaveBeenCalled();
  });
});

describe('certainty and grammar at the edges (codex r12)', () => {
  it('a failed thread-list read renders uncertainty, never an existence claim', () => {
    setCachedMessages(ME, THEM, []);
    render(<DMPanel handle={ME} chatWith={THEM} onBack={() => {}} users={[]} hasServerThread={false} threadsCertain={false} />);
    expect(screen.queryByText(/Write a message to/)).toBeNull();
    expect(screen.getByText(/can[\u2019']t check for history right now/)).toBeTruthy();
    // And no fetch happened — uncertainty must not trigger the creating GET.
    expect(realtime.openDM).not.toHaveBeenCalled();
  });

  it('with certainty and no thread, the invitation is honest', () => {
    setCachedMessages(ME, THEM, []);
    render(<DMPanel handle={ME} chatWith={THEM} onBack={() => {}} users={[]} hasServerThread={false} threadsCertain={true} />);
    expect(screen.getByText(`Write a message to @${THEM}`)).toBeTruthy();
  });

  it('unregisterable tokens stay text — too short, numeric-only, too long', () => {
    const body = 'cc @ab and @123 and @' + 'x'.repeat(21) + ' but @real_one works';
    const parts = renderBodyWithHandles(body, () => {});
    const links = parts.filter((p) => typeof p !== 'string') as Array<{ handle: string }>;
    expect(links.map((l) => l.handle)).toEqual(['real_one']);
  });
});

describe('the door and Enter stay aligned in every branch (codex r13 P2)', () => {
  it('all three rooms render the same fallback definition (source pin)', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/UnifiedBuddyList.tsx'), 'utf8');
    // Populated dead end, quiet room, AND the outage branch — Enter must
    // never reach a target no branch renders.
    expect((src.match(/firstMessageFallback\}/g) || []).length).toBe(3);
  });
});

describe('certainty tracks the latest read; sightings include the thread itself (codex r14)', () => {
  it('a sender already in the served thread keeps their hyphenated form', () => {
    setCachedMessages(ME, 'vibe-bot', [
      { id: 'm1', from: 'vibe-bot', to: ME, content: 'hello from @vibe-bot', timestamp: new Date().toISOString(), status: 'sent' },
    ]);
    const opened: string[] = [];
    render(
      <DMPanel handle={ME} chatWith={'vibe-bot'} onBack={() => {}} users={[]}
        hasServerThread={true} onOpenThread={(h) => opened.push(h)} />,
    );
    // The mention links to the thread's own sender VERBATIM, not an alias.
    fireEvent.click(screen.getByText('@vibe-bot'));
    expect(opened).toEqual(['vibe-bot']);
  });

  it('certainty downgrade is pinned at the source (latest read, not first-ever)', () => {
    const app = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8');
    expect(app).toMatch(/setThreadsCertain\(!threadResult\.error\)/);
  });
});

describe('receipts and peers survive their panel (codex r15)', () => {
  it('an accepted first send records module-level evidence', async () => {
    setCachedMessages(ME, THEM, []);
    render(<DMPanel handle={ME} chatWith={THEM} onBack={() => {}} users={[]} hasServerThread={false} />);
    const box = screen.getByPlaceholderText(`Message @${THEM}...`);
    fireEvent.change(box, { target: { value: 'first' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await screen.findByText('first');
    expect(realtime.recordStoredMessageWith).toHaveBeenCalledWith(THEM);
  });

  it('an all-outbound hyphenated thread still links its own peer verbatim', () => {
    setCachedMessages(ME, 'vibe-bot', [
      { id: 'm1', from: ME, to: 'vibe-bot', content: 'ping @vibe-bot again', timestamp: new Date().toISOString(), status: 'sent' },
    ]);
    const opened: string[] = [];
    render(
      <DMPanel handle={ME} chatWith={'vibe-bot'} onBack={() => {}} users={[]}
        hasServerThread={true} onOpenThread={(h) => opened.push(h)} />,
    );
    fireEvent.click(screen.getByText('@vibe-bot'));
    expect(opened).toEqual(['vibe-bot']);
  });
});
