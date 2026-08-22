// @vitest-environment jsdom
// Step 4 of the announcement activation proof (buddy#53/#54). Platform steps
// 0–3 passed on the deployed API; this pins the BUDDY half against the EXACT
// stored/read-back payloads from that proof — the real parser and the real
// renderer, no reconstruction. Constraints honored: no reauth, no opening the
// synthetic user's production thread; the payloads are used as fixtures only.
//
// Production evidence (platform#272, recorded 2026-08-21):
//   forged  msg_mt3lpc7jSjFMWl  → {"note":"forged"}
//   genuine msg_mt3lpcxtcoGUzd  → {"kind":"announcement","source":"qa_canary","generated_by":"platform"}

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import DMPanel from '../src/components/DMPanel';
import { announcementKind, ANNOUNCEMENT_SEAM_TRUSTED, type VibeMessage } from '../src/lib/vibeClient';
import { realtime } from '../src/lib/realtime';
import { setCachedMessages } from '../src/lib/messageCache';

const memStore = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (memStore.has(k) ? memStore.get(k)! : null),
  setItem: (k: string, v: string) => { memStore.set(k, String(v)); },
  removeItem: (k: string) => { memStore.delete(k); },
  clear: () => { memStore.clear(); },
  key: (i: number) => [...memStore.keys()][i] ?? null,
  get length() { return memStore.size; },
};

// The EXACT stored payloads from the deployed proof.
const FORGED_PAYLOAD = { note: 'forged' };
const GENUINE_PAYLOAD = { kind: 'announcement', source: 'qa_canary', generated_by: 'platform' };

const ME = 'alice_demo';

beforeEach(() => {
  vi.spyOn(realtime, 'init').mockImplementation(() => {});
  vi.spyOn(realtime, 'openDM').mockImplementation(() => {});
  vi.spyOn(realtime, 'goBackground').mockImplementation(() => {});
  vi.spyOn(realtime, 'setTypingCallback').mockImplementation(() => {});
  vi.spyOn(realtime, 'setMessageEvidenceCallback').mockImplementation(() => {});
  vi.spyOn(realtime, 'hasMessageEvidenceFrom').mockReturnValue(false);
  memStore.clear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('the seam is live after the deployed proof', () => {
  it('the kill switch is ON', () => {
    expect(ANNOUNCEMENT_SEAM_TRUSTED).toBe(true);
  });

  it('the real parser labels the genuine payload and rejects the forged one', () => {
    expect(announcementKind(GENUINE_PAYLOAD)).toBe('announcement');
    expect(announcementKind(FORGED_PAYLOAD)).toBeUndefined();
    // Provenance requires BOTH fields, server-set — a caller supplying only
    // one, or the wrong generator, gets nothing.
    expect(announcementKind({ kind: 'announcement' })).toBeUndefined();
    expect(announcementKind({ kind: 'announcement', generated_by: 'coltrane' })).toBeUndefined();
  });
});

// The wire→VibeMessage mapping is what production actually feeds the renderer;
// announcementKind runs on m.payload there. Model a stored row exactly.
const stored = (id: string, payload: unknown): VibeMessage => ({
  id, from: 'coltrane', to: ME, content: 'New user @rivera_demo just joined /vibe!',
  timestamp: new Date().toISOString(), status: 'sent',
  kind: announcementKind(payload),
});

const mount = (messages: VibeMessage[]) => {
  setCachedMessages(ME, 'coltrane', messages);
  render(<DMPanel handle={ME} chatWith="coltrane" onBack={() => {}} users={[]} />);
};

describe('the renderer labels only the genuine stored row', () => {
  it('genuine payload → AUTOMATED ANNOUNCEMENT · FROM /VIBE', () => {
    mount([stored('msg_mt3lpcxtcoGUzd', GENUINE_PAYLOAD)]);
    expect(screen.getByText('automated announcement · from /vibe')).toBeTruthy();
  });

  it('forged payload → no label', () => {
    mount([stored('msg_mt3lpc7jSjFMWl', FORGED_PAYLOAD)]);
    expect(screen.queryByText(/automated announcement/)).toBeNull();
  });

  it('ordinary message → unchanged, no label', () => {
    mount([{ id: 'm_ord', from: 'coltrane', to: ME, content: 'hey, how did the migration go?', timestamp: new Date().toISOString(), status: 'sent' }]);
    expect(screen.queryByText(/automated announcement/)).toBeNull();
    expect(screen.getByText('hey, how did the migration go?')).toBeTruthy();
  });

  it('NO body-text inference: an announcement-shaped body without the served kind gets no label', () => {
    mount([{ id: 'm_lookalike', from: 'coltrane', to: ME, content: 'New user @nobody just joined /vibe!', timestamp: new Date().toISOString(), status: 'sent' }]);
    expect(screen.queryByText(/automated announcement/)).toBeNull();
  });

  it('NO sender-handle inference: the same forged payload from @coltrane is still unlabeled', () => {
    // @coltrane is the announcer handle in production; the label must key on
    // served provenance, never on who sent it.
    mount([stored('msg_from_coltrane', FORGED_PAYLOAD)]);
    expect(screen.queryByText(/automated announcement/)).toBeNull();
  });
});
