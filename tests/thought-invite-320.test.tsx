// @vitest-environment jsdom
// #320 + #322: the ritual surface. These tests exercise the REAL decoder and
// the REAL deep-link route — never a copy — so they cannot pass while the
// product regresses.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const inviteMock = vi.hoisted(() => vi.fn());
const reauthMock = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/vibeClient', async (importOriginal) => {
  const real = (await importOriginal()) as any;
  real.buddyClient.createThoughtInvite = inviteMock;
  real.buddyClient.reauthorizePrincipal = reauthMock;
  return real;
});

import {
  decodeThoughtInvite,
  normalizeGithub,
  principalFromToken,
} from '../src/lib/vibeClient';
import { routeDeepLink } from '../src/lib/deepLink';
import { ThoughtInvite } from '../src/components/list/ThoughtInvite';

beforeEach(() => {
  cleanup();
  inviteMock.mockReset();
  reauthMock.mockReset();
});

// ── the REAL decoder: served truths gate success (#322) ───────────────────
describe('decodeThoughtInvite — success is the served truth, not the 200', () => {
  const full = {
    success: true,
    share_url: 'https://www.slashvibe.dev/join/VIBE-X',
    carries_thought: true,
    named_for: 'wanderingstan',
    expires_at: '2026-09-04T00:00:00Z',
  };

  it('created only when carries_thought, named_for match, and expires_at all hold', () => {
    const out = decodeThoughtInvite(true, full, '@WanderingStan ');
    expect(out).toEqual({
      kind: 'created',
      shareUrl: full.share_url,
      namedFor: 'wanderingstan',
      expiresAt: full.expires_at,
    });
  });

  it('a 200 without the thought is an honest incompletion, never success', () => {
    const out = decodeThoughtInvite(true, { ...full, carries_thought: false }, 'wanderingstan');
    expect(out.kind).toBe('refused');
    expect((out as any).error).toMatch(/did not accept the thought/);
  });

  it('a 200 bound to the WRONG person is refused', () => {
    const out = decodeThoughtInvite(true, { ...full, named_for: 'someoneelse' }, 'wanderingstan');
    expect(out.kind).toBe('refused');
    expect((out as any).error).toMatch(/person you named/);
  });

  it('a 200 without expiry is refused', () => {
    const out = decodeThoughtInvite(true, { ...full, expires_at: undefined }, 'wanderingstan');
    expect(out.kind).toBe('refused');
    expect((out as any).error).toMatch(/expires/);
  });

  it('principal_required decodes to its served action, not the error string', () => {
    const out = decodeThoughtInvite(false, {
      success: false,
      code: 'principal_required',
      error: 'raw fallback prose',
      action: { type: 'reauth', url: 'https://www.slashvibe.dev/api/auth/github', label: 'Refresh your /vibe session', hint: 'Sign in again.' },
    }, 'wanderingstan');
    expect(out).toEqual({
      kind: 'principal_required',
      label: 'Refresh your /vibe session',
      url: 'https://www.slashvibe.dev/api/auth/github',
      hint: 'Sign in again.',
    });
  });
});

describe('normalization and principal decoding (the real helpers)', () => {
  it('normalizeGithub mirrors the server: trim, lowercase, one leading @', () => {
    expect(normalizeGithub(' @Wandering-Stan ')).toBe('wandering-stan');
  });
  it('principalFromToken reads the claim and only the claim', () => {
    const claims = btoa(JSON.stringify({ sub: 'x', principal_id: 'prin_1' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(principalFromToken(`h.${claims}.s`)).toBe('prin_1');
    const bare = btoa(JSON.stringify({ sub: 'x' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(principalFromToken(`h.${bare}.s`)).toBeNull();
  });
});

// ── the REAL deep-link route (#320 finding 4) ─────────────────────────────
describe('routeDeepLink — the redemption landing', () => {
  it('vibe://t/{id} routes to the exact thread', () => {
    expect(routeDeepLink('vibe://t/th_abc123')).toEqual({ kind: 'thread', threadId: 'th_abc123' });
  });
  it('refuses malformed ids, foreign schemes, and extra segments', () => {
    expect(routeDeepLink('vibe://t/!!bad!!')).toBeNull();
    expect(routeDeepLink('https://www.slashvibe.dev/t/th_abc')).toBeNull();
    expect(routeDeepLink('vibe://t/a/b')).toBeNull();
  });
  it('vibe://dm/{handle} still routes to the person', () => {
    expect(routeDeepLink('vibe://dm/WanderingStan')).toEqual({ kind: 'dm', handle: 'wanderingstan' });
  });
});

// ── the ritual surface requires BOTH halves ───────────────────────────────
describe('ThoughtInvite composer — a thought FOR one person, or nothing', () => {
  const type = (placeholder: RegExp | string, value: string) =>
    fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } });

  it('create stays disabled until both the thought and the recipient exist', () => {
    render(<ThoughtInvite onClose={() => {}} />);
    const btn = screen.getByText('Create invitation') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    type(/real question/, 'a genuine unresolved question for one named mind');
    expect(btn.disabled).toBe(true); // still no recipient
    type('their-github-login', 'wanderingstan');
    expect(btn.disabled).toBe(false);
    expect(inviteMock).not.toHaveBeenCalled();
  });

  it('created shows who it is for and when it lapses — served truths, no celebration', async () => {
    inviteMock.mockResolvedValue({
      kind: 'created',
      shareUrl: 'https://www.slashvibe.dev/join/VIBE-X',
      namedFor: 'wanderingstan',
      expiresAt: '2026-09-04T00:00:00Z',
    });
    render(<ThoughtInvite onClose={() => {}} />);
    type(/real question/, 'a genuine unresolved question for one named mind');
    type('their-github-login', 'wanderingstan');
    fireEvent.click(screen.getByText('Create invitation'));
    await waitFor(() => expect(screen.getByText(/For @wanderingstan/)).toBeTruthy());
    expect(screen.getByText(/lapses/)).toBeTruthy();
    expect(screen.queryByText(/Copied!/)).toBeNull(); // ROOM TONE: no exclamation
  });

  it('the EXACT prose travels — original bytes, not a trimmed copy', async () => {
    inviteMock.mockResolvedValue({ kind: 'unreachable' });
    render(<ThoughtInvite onClose={() => {}} />);
    const raw = '  two leading spaces, and a trailing one ';
    type(/real question/, raw);
    type('their-github-login', 'wanderingstan');
    fireEvent.click(screen.getByText('Create invitation'));
    await waitFor(() => expect(inviteMock).toHaveBeenCalled());
    expect(inviteMock).toHaveBeenCalledWith(raw, 'wanderingstan');
  });

  it('principal_required runs the REAL reauth round trip then retries once', async () => {
    inviteMock
      .mockResolvedValueOnce({
        kind: 'principal_required',
        label: 'Refresh your /vibe session',
        url: 'https://www.slashvibe.dev/api/auth/github',
        hint: 'Sign in again.',
      })
      .mockResolvedValueOnce({
        kind: 'created',
        shareUrl: 'https://www.slashvibe.dev/join/VIBE-Y',
        namedFor: 'wanderingstan',
        expiresAt: '2026-09-04T00:00:00Z',
      });
    reauthMock.mockResolvedValue(true);
    render(<ThoughtInvite onClose={() => {}} />);
    type(/real question/, 'a genuine unresolved question for one named mind');
    type('their-github-login', 'wanderingstan');
    fireEvent.click(screen.getByText('Create invitation'));
    await waitFor(() => expect(screen.getByText(/For @wanderingstan/)).toBeTruthy());
    expect(reauthMock).toHaveBeenCalledTimes(1);
    expect(inviteMock).toHaveBeenCalledTimes(2);
  });

  it('a failed principal proof is an honest refusal, not a success', async () => {
    inviteMock.mockResolvedValue({
      kind: 'principal_required',
      label: 'Refresh your /vibe session',
      url: 'https://www.slashvibe.dev/api/auth/github',
      hint: 'Sign in again.',
    });
    reauthMock.mockResolvedValue(false);
    render(<ThoughtInvite onClose={() => {}} />);
    type(/real question/, 'a genuine unresolved question for one named mind');
    type('their-github-login', 'wanderingstan');
    fireEvent.click(screen.getByText('Create invitation'));
    await waitFor(() =>
      expect(screen.getByText(/still does not prove your principal/)).toBeTruthy()
    );
    expect(inviteMock).toHaveBeenCalledTimes(1); // no blind retry
  });
});
