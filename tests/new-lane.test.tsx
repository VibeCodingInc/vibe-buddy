// @vitest-environment jsdom
// NEW lane (Seth, 2026-09-04): a stranger who just installed should be one tap
// from a first message. Served firstSeen is the only evidence; present
// newcomers keep the live row, absent ones render as history (no dot).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => {
    switch (cmd) {
      case 'vibeconf_available':
        return null; // app not detected
      case 'vibeconf_seat_state':
        return { kind: 'closed' };
      case 'read_botfile':
        return null;
      default:
        return null;
    }
  }),
}));

// DMPanel opens SSE streams on mount; the network layer is not under test.
vi.mock('../src/lib/realtime', () => ({
  realtime: {
    init: vi.fn(),
    openDM: vi.fn(),
    goBackground: vi.fn(),
    setTypingCallback: vi.fn(),
  },
}));

import UnifiedBuddyList from '../src/components/UnifiedBuddyList';
import { FIXTURES, ME } from '../src/dev/fixtures';

function mountFixture(name: keyof typeof FIXTURES) {
  const fixture = FIXTURES[name];
  return render(
    <UnifiedBuddyList
      handle={ME}
      greeter="guide_demo"
      users={fixture.users}
      sessions={fixture.sessions}
      mySessions={fixture.mySessions}
      mySessionsProbe={fixture.mySessionsProbe}
      mySessionsObservedAt={fixture.mySessionsObservedAt}
      threads={fixture.threads}
      presenceError={fixture.presenceError}
      recentlyHere={fixture.recentlyHere}
      pairedWith={fixture.pairedWith}
      myPresence={{
        prefs: fixture.prefs,
        broadcast: fixture.prefs.sharing ? fixture.broadcast : null,
        lastLandedAt: fixture.lastLandedAt,
      }}
      onPresenceChange={() => {}}
      onUserClick={() => {}}
      onSignOut={() => {}}
      onSession={() => {}}
    />,
  );
}

beforeEach(() => cleanup());

describe('NEW lane', () => {
  it('lists people who joined in the last two days, present or stepped out, once each', () => {
    mountFixture('newcomers');
    expect(screen.getByText(/New · 2/)).toBeTruthy();
    expect(screen.getByText('nova_demo')).toBeTruthy();          // present newcomer, live row
    expect(screen.getByText('quill_demo')).toBeTruthy();         // stepped out, history row
    expect(screen.getAllByText(/joined \dh ago/).length).toBe(2);
    expect(screen.getByLabelText(/@quill_demo, joined 5h ago, here 3h ago/)).toBeTruthy();
  });

  it('keeps old-timers in ONLINE and agents out of NEW', () => {
    mountFixture('newcomers');
    expect(screen.getByText(/Online · 1/)).toBeTruthy();        // only the old-timer
    expect(screen.getByText('oldtimer_demo')).toBeTruthy();
    expect(screen.getAllByText('nova_demo').length).toBe(1);     // not also in ONLINE
    expect(screen.queryByText(/joined 1h ago/)).toBeNull();      // the brand-new agent is not "new"
    expect(screen.queryByText('veteran_demo')).toBeNull();       // an old trace is not a newcomer
  });
});

describe('NEW lane, integration (codex on #20)', () => {
  it('a present newcomer keeps their session row beneath the card', () => {
    mountFixture('newcomers');
    expect(screen.getByText('nova_demo/claude')).toBeTruthy(); // the SessionRow renders parent/claude
  });

  it('a newcomer who already has a conversation is presented by that conversation, not twice', () => {
    mountFixture('newcomers');
    expect(screen.getAllByText('talked_demo').length).toBe(1);
    expect(screen.queryByLabelText(/@talked_demo, joined/)).toBeNull(); // no NEW history row
    expect(screen.getByText(/New · 2/)).toBeTruthy();                 // nova + quill only
  });
});
