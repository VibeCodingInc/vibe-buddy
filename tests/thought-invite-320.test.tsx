// @vitest-environment jsdom
// #320 consumption: the structured principal_required refusal renders as its
// ACTION (a button opening the reauth URL), never the raw error string; a
// created invitation reports whether it carries the thought; /t/{thread_id}
// links extract for in-app thread opening.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const openMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/plugin-shell', () => ({ open: openMock }));
const inviteMock = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/vibeClient', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    buddyClient: Object.assign(Object.create(Object.getPrototypeOf((real as any).buddyClient)), (real as any).buddyClient, {
      createThoughtInvite: inviteMock,
    }),
  };
});

import { ThoughtInvite } from '../src/components/list/ThoughtInvite';
import { threadLinksIn } from '../src/components/DMPanel';

beforeEach(() => {
  cleanup();
  openMock.mockReset();
  inviteMock.mockReset();
});

describe('principal_required renders as its action, never as an error string', () => {
  it('shows the served label as a button and opens the served url', async () => {
    inviteMock.mockResolvedValue({
      kind: 'principal_required',
      label: 'Refresh your /vibe session',
      url: 'https://www.slashvibe.dev/api/auth/github',
      hint: 'Sign in again so this session proves your principal, not only your handle.',
    });
    render(<ThoughtInvite onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/real question/), {
      target: { value: 'the thought that needs stan specifically, in my own words' },
    });
    fireEvent.click(screen.getByText('Create invitation'));
    const btn = await screen.findByText('Refresh your /vibe session');
    fireEvent.click(btn);
    expect(openMock).toHaveBeenCalledWith('https://www.slashvibe.dev/api/auth/github');
    // the raw error string is NOT the rendering
    expect(screen.queryByText(/Sign in again to send an invitation/)).toBeNull();
  });
});

describe('a created invitation is honest about what it carries', () => {
  it('reports carries-thought and shows the link', async () => {
    inviteMock.mockResolvedValue({
      kind: 'created',
      shareUrl: 'https://www.slashvibe.dev/join/VIBE-TEST-CODE',
      carriesThought: true,
    });
    render(<ThoughtInvite onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/real question/), {
      target: { value: 'a genuine unresolved question for one named mind' },
    });
    fireEvent.change(screen.getByPlaceholderText('their-github-login'), {
      target: { value: 'wanderingstan' },
    });
    fireEvent.click(screen.getByText('Create invitation'));
    await waitFor(() =>
      expect(screen.getByText(/carries your thought/)).toBeTruthy()
    );
    expect(inviteMock).toHaveBeenCalledWith(
      'a genuine unresolved question for one named mind',
      'wanderingstan'
    );
    expect(screen.getByText(/join\/VIBE-TEST-CODE/)).toBeTruthy();
  });

  it('an unreachable service creates NOTHING and says so', async () => {
    inviteMock.mockResolvedValue({ kind: 'unreachable' });
    render(<ThoughtInvite onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/real question/), {
      target: { value: 'words that must not silently vanish into a fake success' },
    });
    fireEvent.click(screen.getByText('Create invitation'));
    await waitFor(() => expect(screen.getByText(/Nothing was created/)).toBeTruthy());
  });
});

describe('/t/{thread_id} links extract for in-app opening', () => {
  it('finds served thread links and nothing else', () => {
    const body =
      'you landed here: https://www.slashvibe.dev/t/th_abc123 — and https://example.com/t/nope is not ours';
    const links = threadLinksIn(body);
    expect(links).toHaveLength(1);
    expect(links[0].threadId).toBe('th_abc123');
  });

  it('refuses malformed ids rather than guessing', () => {
    expect(threadLinksIn('https://www.slashvibe.dev/t/!!bad!!')).toHaveLength(0);
  });
});
