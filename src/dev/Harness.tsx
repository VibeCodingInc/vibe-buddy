// Dev-only screenshot harness. Renders the REAL list + notice components with
// synthetic fixture data, inside a frame the size of the actual Buddy window,
// so UI states can be reviewed and captured in a browser without a Tauri
// backend, network truth, or real people's names on screen.
//
// Reached only via src/main.tsx's dev branch: http://localhost:1421/?fixture=current
//   ?fixture=<name>   which state to render (see fixtures.ts; ?fixture=index lists all)
//   &w=<px>&h=<px>    window size override (default 320×500, the expanded app size)
//
// This file must never ship: the import in main.tsx is guarded by
// import.meta.env.DEV and loaded dynamically, so production builds tree-shake
// the whole directory away. tests/regressions.test.ts guards that.

import { useState } from 'react';
import UnifiedBuddyList from '../components/UnifiedBuddyList';

// The notification offer is real App logic keyed on OS permission state, which
// a browser harness cannot represent honestly — silence it so captures show
// the states under study. Its own capture lives in the audit's before-set.
try { localStorage.setItem('buddy_notify_dismissed', '1'); } catch { /* fine */ }
import { Notice } from '../App';
import { color, font } from '../lib/tokens';
import { FIXTURES, ME, type ListFixture } from './fixtures';
import type { PresencePrefs } from '../lib/presencePrefs';

function Frame({ fixture, width, height }: { fixture: ListFixture; width: number; height: number }) {
  // Presence prefs are live so the My Presence card's controls actually work
  // in the harness; everything else is fixed fixture data.
  const [prefs, setPrefs] = useState<PresencePrefs>(fixture.prefs);
  return (
    <div
      id="frame"
      style={{
        width,
        height,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        borderRadius: 10,
        border: `1px solid ${color.line}`,
        background: color.bg,
      }}
    >
      <div style={{ flex: 1, minHeight: 0 }}>
        <UnifiedBuddyList
          handle={ME}
          greeter="guide_demo"
          users={fixture.users}
          sessions={fixture.sessions}
          mySessions={fixture.mySessions}
          mySessionsProbe={fixture.mySessionsProbe}
          mySessionsObservedAt={fixture.mySessionsObservedAt}
          sessionSignals={fixture.signals}
          threads={fixture.threads}
          presenceError={fixture.presenceError}
          recentlyHere={fixture.recentlyHere}
          pairedWith={fixture.pairedWith}
          myPresence={{
            prefs,
            broadcast: prefs.sharing ? fixture.broadcast : null,
            lastLandedAt: fixture.lastLandedAt,
          }}
          onPresenceChange={(patch) => setPrefs((p) => ({ ...p, ...patch }))}
          onUserClick={() => {}}
          onSignOut={() => {}}
          onSession={() => {}}
        />
      </div>
      <Notice notice={fixture.notice ?? null} />
    </div>
  );
}

export default function Harness() {
  const params = new URLSearchParams(window.location.search);
  const name = params.get('fixture') || 'index';
  const width = Number(params.get('w')) || 320;
  const height = Number(params.get('h')) || 500;
  const fixture = FIXTURES[name];
  // `bare=1`: the frame alone, flush at the origin, no padding and no
  // caption — so a headless capture at exactly w x h contains the window and
  // nothing else. Centring inside a padded page pushed the frame off the
  // shot and clipped the row actions off the right edge
  // (scripts/capture-ui.mjs).
  const bare = params.get('bare') === '1';

  if (bare && fixture) {
    // The marker is the capture's proof of life: an ErrorBoundary or a
    // browser error page screenshots just as happily as a board, and can
    // easily clear a size threshold, so the release script would publish it
    // and stamp it as the current build (codex P2). scripts/capture-ui.mjs
    // dumps the DOM and refuses to swap the image unless this is present.
    return (
      <div data-harness-rendered="1">
        <Frame fixture={fixture} width={width} height={height} />
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#1a1c20',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        fontFamily: font.mono,
        padding: 24,
      }}
    >
      {fixture ? (
        <>
          <Frame fixture={fixture} width={width} height={height} />
          <div style={{ color: color.faint, fontSize: 11 }}>
            fixture: {name} · {width}×{height} · synthetic data only
          </div>
        </>
      ) : (
        <div style={{ color: color.dim, fontSize: 13, lineHeight: 2 }}>
          <div style={{ color: color.ink, marginBottom: 8 }}>buddy dev harness — pick a fixture:</div>
          {Object.keys(FIXTURES).map((k) => (
            <div key={k}>
              <a href={`?fixture=${k}`} style={{ color: color.blue }}>
                ?fixture={k}
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
