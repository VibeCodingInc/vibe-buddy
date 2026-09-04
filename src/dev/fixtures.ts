// Synthetic fixture data for the dev screenshot harness (?fixture=<name>).
//
// Personas follow the buyer demo narrative (Alice asks, Bob answers while
// offline, the reply waits). Every handle is invented; none may collide with
// a real GitHub account we know of, and none may match the synthetic-QA
// prefixes (synth-, test_, …) that the list deliberately filters out.
// The demo evidence checklist is the law here: no real user names, presence,
// or message content ever appears in captured material.

import type {
  VibeUser,
  VibeThread,
  SessionEntity,
  MySession,
  RecentTrace,
} from '../lib/vibeClient';
import type { PresencePrefs, PresenceBroadcast } from '../lib/presencePrefs';
import type { MySessionsProbe } from '../lib/mySessionsState';
import type { SessionSignal } from '../lib/transcript';

export const ME = 'alice_demo';
export const COLLABORATOR = 'bob_demo';

const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

export interface ListFixture {
  name: string;
  users: VibeUser[];
  sessions: SessionEntity[];
  mySessions: MySession[];
  /** Fixtures are settled states, so the default is an authoritative read. */
  mySessionsProbe: MySessionsProbe;
  /** When the sessions snapshot was "received" — rows age from this. */
  mySessionsObservedAt?: number;
  threads: VibeThread[];
  /**
   * Transcript signals per cwd. App detects these at runtime, so without
   * them a captured board renders with the attention router switched off —
   * no "your turn", no promoted rows, no Open Session. That is the newest
   * and most legible half of the product, and a screenshot missing it
   * misrepresents the build it was cut from.
   */
  signals?: Map<string, SessionSignal>;
  recentlyHere: RecentTrace[];
  presenceError: boolean;
  pairedWith?: string;
  prefs: PresencePrefs;
  broadcast: PresenceBroadcast | null;
  lastLandedAt: number | null;
  /** Notice fixture rendered under the list, mirroring App's single slot. */
  notice?: { kind: 'info' | 'warn'; text: string; actions?: Array<{ label: string; primary?: boolean; onClick: () => void }> };
}

const myBroadcast: PresenceBroadcast = {
  workingOn: 'debugging the rollback fixture',
  project: 'checkout-api',
  branch: 'drop-legacy-status',
  model: 'claude-fable-5',
  sentAt: Date.now() - 90_000,
};

const sharingPrefs: PresencePrefs = { sharing: true, detail: 'full', statusText: null };

const humans: VibeUser[] = [
  {
    handle: 'mira_demo',
    oneLiner: 'wiring the payments retry queue',
    status: 'active',
    clientMetadata: { branch: 'retry-queue', tech_stack: ['typescript', 'postgres'], session_minutes: 84 },
  },
  {
    handle: 'theo_demo',
    oneLiner: 'reviewing the ingest PR',
    status: 'active',
    clientMetadata: { session_minutes: 22 },
  },
  {
    handle: 'jun_demo',
    oneLiner: '',
    status: 'away',
    ago: '38m',
  },
];

const agents: VibeUser[] = [
  {
    handle: 'deploy_scout',
    oneLiner: 'watching CI for the release branch',
    status: 'active',
    isAgent: true,
    reachability: 'listening',
  },
  {
    handle: 'docs_drone',
    oneLiner: 'Heartbeat',
    status: 'active',
    isAgent: true,
    reachability: 'broadcast-only',
    unreadCount: 12,
    lastReadAt: null,
  },
];

const bobReply: VibeThread = {
  with: COLLABORATOR,
  unread: 1,
  lastMessage: {
    from: COLLABORATOR,
    body: 'Yes — the rollback test still reads the old column. Update that fixture first, then legacy_status is safe to drop.',
    created_at: minsAgo(7),
  },
};

const readThreads: VibeThread[] = [
  {
    with: 'priya_demo',
    unread: 0,
    lastMessage: { from: ME, body: 'merged, thanks for the schema check', created_at: minsAgo(190) },
  },
  {
    with: 'sam_demo',
    unread: 0,
    lastMessage: { from: 'sam_demo', body: 'tomorrow works, ping me after standup', created_at: minsAgo(60 * 26) },
  },
];

const mySessions: MySession[] = [
  {
    sessionId: 'sess-1',
    cwd: '/Users/alice/work/checkout-api',
    project: 'checkout-api',
    model: 'claude-fable-5',
    workingOn: 'drop legacy_status migration',
    status: 'active',
    agoSeconds: 40,
    // Without a host the session verbs gate off, so a captured board shows
    // a waiting row with no way to act on it — the opposite of the point.
    clientName: 'claude-code',
  },
  {
    sessionId: 'sess-2',
    cwd: '/Users/alice/work/site',
    project: 'site',
    status: 'idle',
    agoSeconds: 60 * 47,
    clientName: 'claude-code',
  },
];

// checkout-api finished its turn; site is quiet. One waiting row, two
// folded — the shape the router exists to produce.
const demoSignals = new Map<string, SessionSignal>([
  ['/Users/alice/work/checkout-api', { kind: 'awaiting-you', idle_seconds: 260 }],
  ['/Users/alice/work/site', { kind: 'quiet', idle_seconds: 2820 }],
]);

const miraSession: SessionEntity = {
  handle: 'mira_demo/claude',
  parent: 'mira_demo',
  type: 'session',
  status: 'active',
  project: 'payments',
  model: 'claude-fable-5',
  summary: 'retry queue backoff',
  turnCount: 31,
  updatedAt: minsAgo(2),
  guestEnabled: false,
  badge: 'CC',
  displayName: 'mira_demo · claude',
};


// DAY ONE, ALONE — what a first-time user actually sees, and therefore what
// the landing page must show. The `current` fixture is a populated social
// board: six people, agents, unread replies. Depicting that to someone who
// downloads and finds an empty room sells a state they do not have and makes
// the app look broken on arrival. Here the machine is busy and the room is
// not: eight local sessions, two of them waiting on you, nobody else yet.
const dayOneSessions: MySession[] = [
  { sessionId: 'd1', cwd: '/Users/you/code/checkout', project: 'checkout',
    model: 'claude-fable-5', workingOn: 'drop legacy_status migration',
    status: 'active', agoSeconds: 22, clientName: 'claude-code' },
  { sessionId: 'd2', cwd: '/Users/you/code/ingest', project: 'ingest',
    model: 'claude-fable-5', status: 'active', agoSeconds: 95, clientName: 'claude-code' },
  { sessionId: 'd3', cwd: '/Users/you/code/dashboard', project: 'dashboard',
    model: 'claude-fable-5', status: 'active', agoSeconds: 140, clientName: 'claude-code' },
  { sessionId: 'd4', cwd: '/Users/you/code/infra', project: 'infra',
    status: 'idle', agoSeconds: 60 * 12, clientName: 'claude-code' },
  { sessionId: 'd5', cwd: '/Users/you/code/site', project: 'site',
    status: 'idle', agoSeconds: 60 * 34, clientName: 'claude-code' },
  { sessionId: 'd6', cwd: '/Users/you/code/schema', project: 'schema',
    status: 'idle', agoSeconds: 60 * 51, clientName: 'claude-code' },
  { sessionId: 'd7', cwd: '/Users/you/code/cli', project: 'cli',
    status: 'idle', agoSeconds: 60 * 78, clientName: 'claude-code' },
  { sessionId: 'd8', cwd: '/Users/you/code/docs', project: 'docs',
    status: 'idle', agoSeconds: 60 * 96, clientName: 'claude-code' },
];

const dayOneSignals = new Map<string, SessionSignal>([
  ['/Users/you/code/checkout', { kind: 'awaiting-you', idle_seconds: 190 }],
  ['/Users/you/code/ingest', { kind: 'awaiting-you', idle_seconds: 640 }],
  ['/Users/you/code/dashboard', { kind: 'working', idle_seconds: 3 }],
]);

const base: Omit<ListFixture, 'name'> = {
  users: [],
  sessions: [],
  mySessions: [],
  mySessionsProbe: 'known',
  mySessionsObservedAt: Date.now(),
  threads: [],
  recentlyHere: [],
  presenceError: false,
  prefs: sharingPrefs,
  broadcast: myBroadcast,
  lastLandedAt: Date.now() - 90_000,
};

// NEW lane (2026-09-04): people who joined in the last two days. Timestamps
// are relative so the fixture stays "new" whenever it is rendered.
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();
const newcomerHumans: VibeUser[] = [
  { handle: 'nova_demo', oneLiner: 'first day, wiring a viewer', status: 'active', firstSeen: hoursAgo(2) },
  { handle: 'oldtimer_demo', oneLiner: 'here since spring', status: 'active', firstSeen: hoursAgo(24 * 30) },
  { handle: 'freshbot_demo', oneLiner: 'an agent that just enrolled', status: 'active', isAgent: true, firstSeen: hoursAgo(1) },
];

export const FIXTURES: Record<string, ListFixture> = {
  // A newcomer present (live row), a newcomer who stepped out (history row),
  // an old-timer (ONLINE, not NEW), a brand-new agent (AGENTS, never NEW).
  newcomers: {
    ...base,
    name: 'newcomers',
    users: newcomerHumans,
    recentlyHere: [
      { handle: 'quill_demo', ago: '3h', workingOn: 'training user models', firstSeen: hoursAgo(5) },
      { handle: 'veteran_demo', ago: '1h', workingOn: 'old hand', firstSeen: hoursAgo(24 * 90) },
    ],
  },

  // The landing-page shot. See dayOneSessions above.
  dayone: {
    ...base,
    name: 'dayone',
    users: [],
    mySessions: dayOneSessions,
    signals: dayOneSignals,
  },

  // The demo money shot (05-DEMO-NARRATIVE 5:30–6:15): Bob answered while
  // offline; the reply is waiting; the interval between turns is honest.
  current: {
    ...base,
    name: 'current',
    users: [...humans, ...agents],
    sessions: [miraSession],
    mySessions,
    signals: demoSignals,
    threads: [bobReply, ...readThreads],
  },

  // Same world, Alice and Bob explicitly paired.
  paired: {
    ...base,
    name: 'paired',
    users: [
      { handle: COLLABORATOR, oneLiner: 'reading your migration question', status: 'active' },
      ...humans,
      ...agents,
    ],
    sessions: [miraSession],
    mySessions,
    threads: [bobReply, ...readThreads],
    pairedWith: COLLABORATOR,
  },

  // First arrival: nobody known, nothing missed, traces of recent life.
  arrival: {
    ...base,
    name: 'arrival',
    recentlyHere: [
      { handle: 'mira_demo', ago: '2h', workingOn: 'payments retry queue' },
      { handle: 'theo_demo', ago: '5h', workingOn: 'ingest PR review' },
    ],
  },

  // You have read everything; the room is quiet but inhabited.
  'read-everything': {
    ...base,
    name: 'read-everything',
    users: [humans[1], agents[0]],
    threads: readThreads,
  },

  // Stale/offline with content on screen: the roster holds, nothing zeroes.
  stale: {
    ...base,
    name: 'stale',
    users: [...humans, ...agents],
    mySessions,
    threads: [bobReply, ...readThreads],
    broadcast: null,
    lastLandedAt: Date.now() - 4 * 60_000,
    notice: { kind: 'warn', text: 'reconnecting · last synced 4m' },
  },

  // Cannot reach /vibe and nothing was ever loaded.
  unreachable: {
    ...base,
    name: 'unreachable',
    presenceError: true,
    mySessionsProbe: 'unchecked',
  },

  // The noticing moment: alone in the room, but YOUR session is live. The
  // session block must render above "Quiet in here", with the recognition
  // line — this exact state used to draw a void.
  'solo-with-session': {
    ...base,
    name: 'solo-with-session',
    mySessions: [mySessions[0]],
    recentlyHere: [
      { handle: 'mira_demo', ago: '2h', workingOn: 'payments retry queue' },
    ],
  },

  // The my-sessions read has never succeeded: say we can't see, never "none".
  'sessions-unchecked': {
    ...base,
    name: 'sessions-unchecked',
    mySessionsProbe: 'unchecked',
    mySessionsObservedAt: undefined,
  },

  // Roster fetch failing, my-sessions read verified: the independent truth
  // still renders above the outage message.
  'unreachable-with-session': {
    ...base,
    name: 'unreachable-with-session',
    presenceError: true,
    mySessions: [mySessions[0]],
  },

  // Retained snapshot under a failing read: the row aged past the green gate
  // (dim dot, honest heartbeat age) and the stale line says how old the
  // snapshot is. Certainty is gone; the rows are not.
  'sessions-stale': {
    ...base,
    name: 'sessions-stale',
    mySessions: [mySessions[0]],
    mySessionsProbe: 'unchecked',
    mySessionsObservedAt: Date.now() - 12 * 60_000,
    recentlyHere: [
      { handle: 'mira_demo', ago: '2h', workingOn: 'payments retry queue' },
    ],
  },

  // Update ready — App's single notice slot, info kind.
  update: {
    ...base,
    name: 'update',
    users: [...humans, ...agents],
    mySessions,
    threads: readThreads,
    notice: {
      kind: 'info',
      text: 'v0.5.43 is ready',
      actions: [{ label: 'install', primary: true, onClick: () => {} }],
    },
  },

  // An agent's answer waiting: moved out of the AGENTS lane by priority, the
  // row itself must still say what kind of company answered (🤖 agent chip).
  'agent-waiting': {
    ...base,
    name: 'agent-waiting',
    users: [...humans, ...agents],
    mySessions,
    threads: [
      {
        with: 'deploy_scout',
        unread: 1,
        lastMessage: {
          from: 'deploy_scout',
          body: 'CI is green on release-0.6 — two flaky retries, both passed on rerun.',
          created_at: minsAgo(3),
        },
      },
      bobReply,
      ...readThreads,
    ],
  },

  // buddy#10's two distinguishable failure states, for the record.
  'presence-never-landed': {
    ...base,
    name: 'presence-never-landed',
    users: [humans[1]],
    broadcast: null,
    lastLandedAt: null,
  },
  'presence-stopped': {
    ...base,
    name: 'presence-stopped',
    users: [humans[1]],
    broadcast: null,
    lastLandedAt: Date.now() - 4 * 60_000,
  },
};
