/**
 * Intelligence Module — Ambient Social Awareness for Vibe Buddy
 *
 * Ported from vibe-mcp/intelligence/ and adapted for client-side use.
 *
 * Three layers:
 * 1. Infer — Smart state detection from context signals
 * 2. Serendipity — Surface meaningful coincidences between users
 * 3. Proactive — Background social moments (ships in the night, etc.)
 */

import type { VibeUser } from './vibeClient';
import { isFreshLastSeen } from './freshness';

type Metadata = VibeUser['clientMetadata'] | Record<string, unknown> | null | undefined;

function metadataString(meta: Metadata, key: string): string {
  const value = meta?.[key];
  return typeof value === 'string' ? value : '';
}

function metadataNumber(meta: Metadata, key: string): number {
  const value = meta?.[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function metadataStrings(meta: Metadata, key: string): string[] {
  const value = meta?.[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

// ============ INFERRED STATES ============

export interface InferredState {
  state: string;
  emoji: string;
  label: string;
  confidence: number;
  reason: string;
  /**
   * How this state was arrived at. 'self-report' — the person set it
   * themselves (attributable). 'inferred' — a heuristic guessed it from
   * signals (a branch name, a session counter). The surface renders the two
   * differently: a guess is always SAID to be a guess (audit #4, ruled
   * 2026-08-13: keep the surface, label every result).
   */
  kind: 'self-report' | 'inferred';
}

/**
 * The one phrase every surface renders for an inferred state. A heuristic
 * result never appears as bare fact — "looks like debugging", never
 * "debugging" — and a self-report is attributed, never absorbed.
 */
export function inferredPhrase(s: InferredState): string {
  return s.kind === 'self-report' ? `says they're ${s.label}` : `looks like ${s.label}`;
}

/** The signal behind the state, for tooltips/accessible names. */
export function inferredEvidence(s: InferredState): string {
  return s.kind === 'self-report' ? s.reason : `a guess from: ${s.reason}`;
}

const STATES: Record<string, { emoji: string; label: string; description: string }> = {
  'shipping': {
    emoji: '\u{1F525}',
    label: 'shipping',
    description: 'Active commits, deploying code'
  },
  'deep-focus': {
    emoji: '\u{1F9E0}',
    label: 'deep focus',
    description: 'Long session, minimal messaging'
  },
  'debugging': {
    emoji: '\u{1F41B}',
    label: 'debugging',
    description: 'Working through errors or on fix branch'
  },
  'exploring': {
    emoji: '\u{1F50D}',
    label: 'exploring',
    description: 'Browsing codebase, many file switches'
  },
  'stuck': {
    emoji: '\u{1F914}',
    label: 'might be stuck',
    description: 'Same area for a while, no commits'
  },
  'pairing': {
    emoji: '\u{1F465}',
    label: 'pairing',
    description: 'Active messaging with someone'
  },
  'late-night': {
    emoji: '\u{1F319}',
    label: 'late night',
    description: 'Coding after midnight'
  },
  'vibing': {
    emoji: '\u{1F3B5}',
    label: 'vibing',
    description: 'Active and building'
  }
};

/**
 * Infer what a user is doing from their presence signals
 */
export function inferState(user: VibeUser): InferredState | null {
  // Inference describes what is happening now. Once the presence source has
  // gone away, its branch/session metadata is stale and cannot support a
  // current-tense state label. Freshness gates it too: a retained snapshot
  // row can still say status 'active' while its heartbeat evidence has
  // expired, and a guess over expired evidence is a guess about the past
  // rendered in the present tense (audit #4: every inference expires).
  if (user.status !== 'active') return null;
  if (!isFreshLastSeen(user.lastSeen, Date.now())) return null;

  // If user has explicit mood that isn't from inference, respect it
  if (typeof user.mood === 'string' && user.mood && !user.moodInferred) {
    const matchedState = Object.entries(STATES).find(([, v]) => v.label === user.mood);
    if (matchedState) {
      return {
        state: matchedState[0],
        emoji: matchedState[1].emoji,
        label: matchedState[1].label,
        confidence: 1.0,
        reason: `they set this themselves`,
        kind: 'self-report'
      };
    }
  }

  const candidates: Array<{ state: string; confidence: number; reason: string }> = [];
  const meta = user.clientMetadata || {};
  const branch = metadataString(meta, 'branch').toLowerCase();
  const phase = metadataString(meta, 'phase').toLowerCase();
  const sessionMinutes = metadataNumber(meta, 'session_minutes');

  // Shipping needs an activity signal. A branch named main proves only where
  // the checkout sits; it does not prove that a commit or deploy happened.
  if (phase === 'shipping' || phase === 'deploying') {
    candidates.push({ state: 'shipping', confidence: 0.9, reason: 'deploying to production' });
  }

  // Rule: Debugging — on fix/bug branch or phase is "debugging"
  if (/^(fix|debug|bug|hotfix)[-_\/]/.test(branch)) {
    candidates.push({ state: 'debugging', confidence: 0.85, reason: `on ${branch}` });
  } else if (phase === 'debugging') {
    candidates.push({ state: 'debugging', confidence: 0.8, reason: 'working through errors' });
  }

  // Rule: Deep Focus — long session, minimal social signals
  if (sessionMinutes >= 120) {
    candidates.push({
      state: 'deep-focus',
      confidence: Math.min(0.9, 0.5 + (sessionMinutes - 120) / 600),
      reason: `${Math.floor(sessionMinutes / 60)}h session`
    });
  }

  // Rule: Exploring — phase is "exploring" or "reading"
  if (phase === 'exploring' || phase === 'reading' || phase === 'reviewing') {
    candidates.push({ state: 'exploring', confidence: 0.7, reason: 'browsing codebase' });
  }

  // The viewer's clock says nothing about another person's timezone. Only a
  // source-provided phase can support this label.
  if (phase === 'late-night') {
    candidates.push({ state: 'late-night', confidence: 0.8, reason: 'reported a late-night session' });
  }

  // Rule: General vibing — active with coding phase
  if (phase === 'coding' && candidates.length === 0) {
    candidates.push({ state: 'vibing', confidence: 0.6, reason: 'actively building' });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.confidence - a.confidence);
  const best = candidates[0];
  if (best.confidence < 0.5) return null;

  const stateInfo = STATES[best.state];
  if (!stateInfo) return null;

  return {
    state: best.state,
    emoji: stateInfo.emoji,
    label: stateInfo.label,
    confidence: best.confidence,
    reason: best.reason,
    kind: 'inferred'
  };
}

// ============ SERENDIPITY ============

export interface SerendipityMoment {
  type: string;
  emoji: string;
  withHandle: string;
  text: string;
  relevance: number;
  action: 'pair' | 'connect' | 'help' | 'inform' | 'welcome';
}

/**
 * Find serendipity between current user and all others
 */
export function findSerendipity(myHandle: string, allUsers: VibeUser[]): SerendipityMoment[] {
  const me = allUsers.find(u => u.handle === myHandle);
  if (!me) return [];

  // Same expiry as inferState: a retained row can still say status 'active'
  // while its heartbeat evidence has aged out, and project/stack/branch
  // metadata from an expired row cannot support a present-tense "both"
  // (codex P2 on the audit-#4 fix). The viewer's own row is held to the same
  // bar — half of every "you and @x" claim is about the viewer.
  const now = Date.now();
  if (!isFreshLastSeen(me.lastSeen, now)) return [];
  const others = allUsers.filter(
    u => u.handle !== myHandle && u.status === 'active' && isFreshLastSeen(u.lastSeen, now)
  );
  const moments: SerendipityMoment[] = [];

  for (const other of others) {
    const myMeta = me.clientMetadata || {};
    const theirMeta = other.clientMetadata || {};

    // 1. Same project
    if (me.project && other.project && me.project === other.project) {
      moments.push({
        type: 'same_project',
        emoji: '\u2728',
        withHandle: other.handle,
        text: `You and @${other.handle} both report working on ${me.project}`,
        relevance: 0.9,
        action: 'pair'
      });
    }

    // 2. Same tech stack overlap
    const myStack = metadataStrings(myMeta, 'tech_stack');
    const theirStack = metadataStrings(theirMeta, 'tech_stack');
    if (myStack.length > 0 && theirStack.length > 0) {
      const overlap = myStack.filter((t: string) => theirStack.includes(t));
      if (overlap.length >= 2) {
        moments.push({
          type: 'tech_overlap',
          emoji: '\u{1F517}',
          withHandle: other.handle,
          text: `You and @${other.handle} both report using ${overlap.join(', ')}`,
          relevance: 0.6 + overlap.length * 0.1,
          action: 'connect'
        });
      }
    }

    // 3. Same branch topic
    const myBranch = metadataString(myMeta, 'branch').toLowerCase();
    const theirBranch = metadataString(theirMeta, 'branch').toLowerCase();
    if (myBranch && theirBranch) {
      const myTopic = extractBranchTopic(myBranch);
      const theirTopic = extractBranchTopic(theirBranch);
      if (myTopic && theirTopic && myTopic === theirTopic) {
        moments.push({
          type: 'same_topic',
          emoji: '\u{1F3AF}',
          withHandle: other.handle,
          text: `Looks like you and @${other.handle} are both on ${myTopic} — by your branch names`,
          relevance: 0.8,
          action: 'connect'
        });
      }
    }

    // 4. Complementary states — one stuck, one shipping same area
    const myState = inferState(me);
    const theirState = inferState(other);
    if (myState?.state === 'stuck' && theirState?.state === 'shipping') {
      moments.push({
        type: 'complementary',
        emoji: '\u{1F4A1}',
        withHandle: other.handle,
        text: `Looks like @${other.handle} is shipping — they might be able to help`,
        relevance: 0.7,
        action: 'help'
      });
    }

    // 5. Both in same deep state
    if (myState && theirState && myState.state === theirState.state &&
        ['deep-focus', 'debugging', 'late-night'].includes(myState.state)) {
      moments.push({
        type: 'same_state',
        emoji: '\u{1F4AB}',
        withHandle: other.handle,
        text: `Looks like you and @${other.handle} are both in ${myState.label} mode`,
        relevance: 0.55,
        action: 'connect'
      });
    }
  }

  return moments.sort((a, b) => b.relevance - a.relevance);
}

function extractBranchTopic(branch: string): string | null {
  const cleaned = branch
    .replace(/^(fix|feat|feature|bug|hotfix|chore|refactor|docs)[-_\/]?/i, '')
    .replace(/[-_\/]/g, '-')
    .toLowerCase();

  const parts = cleaned.split('-').filter(p => p.length > 2);
  const topics = ['auth', 'user', 'api', 'db', 'database', 'ui', 'test', 'config',
    'payment', 'email', 'notification', 'search', 'cache', 'session', 'login',
    'signup', 'presence', 'message', 'chat'];

  for (const part of parts) {
    if (topics.includes(part)) return part;
  }
  return parts[0] || null;
}

// ============ PROACTIVE ============

export interface ProactiveMoment {
  type: string;
  emoji: string;
  text: string;
  priority: number;
  handles?: string[];
}

// Track state across polling intervals
let previousUsers: Map<string, VibeUser> = new Map();
let welcomedHandles = new Set<string>();
let lastProactiveCheck = 0;

/**
 * Detect proactive moments by comparing current state to previous
 */
export function detectProactiveMoments(
  myHandle: string,
  currentUsers: VibeUser[]
): ProactiveMoment[] {
  const moments: ProactiveMoment[] = [];
  const now = Date.now();

  // Throttle to once per 30 seconds
  if (now - lastProactiveCheck < 30000) return [];
  lastProactiveCheck = now;

  const currentMap = new Map(currentUsers.map(u => [u.handle, u]));

  // 1. New arrivals (someone just came online)
  for (const user of currentUsers) {
    if (user.handle === myHandle) continue;
    if (user.status !== 'active') continue;
    // A retained-stale row cannot arrive: "just joined" and "is back" are
    // now-claims and need fresh heartbeat evidence (codex P2, audit #4).
    if (!isFreshLastSeen(user.lastSeen, now)) continue;

    const wasHere = previousUsers.get(user.handle);
    if (!wasHere || wasHere.status !== 'active') {
      // They just came online or came back from away
      const firstSeenAt = typeof user.firstSeen === 'string'
        ? new Date(user.firstSeen).getTime()
        : NaN;
      const age = now - firstSeenAt;
      const isNew = Number.isFinite(firstSeenAt) && age >= 0 && age < 24 * 60 * 60 * 1000;

      if (isNew && !welcomedHandles.has(user.handle)) {
        welcomedHandles.add(user.handle);
        moments.push({
          type: 'new_user',
          emoji: '\u{1F44B}',
          text: `@${user.handle} just joined /vibe`,
          priority: 2,
          handles: [user.handle]
        });
      } else if (wasHere) {
        moments.push({
          type: 'came_back',
          emoji: '\u2615',
          text: `@${user.handle} is back`,
          priority: 4,
          handles: [user.handle]
        });
      }
    }
  }

  // 2. Someone started shipping (state changed to shipping)
  for (const user of currentUsers) {
    if (user.handle === myHandle) continue;
    const prev = previousUsers.get(user.handle);
    const currentState = inferState(user);
    if (currentState?.state === 'shipping') {
      // Check if they weren't shipping before
      const prevUser = prev;
      const prevState = prevUser ? inferState(prevUser) : null;
      if (prevState?.state !== 'shipping') {
        moments.push({
          type: 'started_shipping',
          emoji: '\u{1F680}',
          text: `Looks like @${user.handle} started shipping`,
          priority: 3,
          handles: [user.handle]
        });
      }
    }
  }

  // 3. Deep focus milestone (someone hit 3h+)
  for (const user of currentUsers) {
    if (user.handle === myHandle) continue;
    // The session counter is metadata off the same heartbeat: expired
    // evidence cannot report a session in the present tense.
    if (!isFreshLastSeen(user.lastSeen, now)) continue;
    const mins = metadataNumber(user.clientMetadata, 'session_minutes');
    const prevMins = metadataNumber(
      previousUsers.get(user.handle)?.clientMetadata,
      'session_minutes'
    );
    if (mins >= 180 && prevMins < 180) {
      moments.push({
        type: 'deep_session',
        emoji: '\u{1F9E0}',
        text: `@${user.handle} reports a 3+ hour session`,
        priority: 5,
        handles: [user.handle]
      });
    }
  }

  // Update previous state
  previousUsers = currentMap;

  return moments.sort((a, b) => a.priority - b.priority);
}

/**
 * Reset proactive state (e.g., on login)
 */
export function resetProactiveState(): void {
  previousUsers = new Map();
  welcomedHandles = new Set();
  lastProactiveCheck = 0;
}

// ============ COLLABORATION SCORE ============

/**
 * Score how likely two users would benefit from connecting
 * Returns 0-1 score with reason
 */
export function collaborationScore(
  userA: VibeUser,
  userB: VibeUser
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  // Same project
  if (userA.project && userB.project && userA.project === userB.project) {
    score += 0.3;
    reasons.push(`both on ${userA.project}`);
  }

  // Tech stack overlap
  const stackA = metadataStrings(userA.clientMetadata, 'tech_stack');
  const stackB = metadataStrings(userB.clientMetadata, 'tech_stack');
  const overlap = stackA.filter((t: string) => stackB.includes(t));
  if (overlap.length > 0) {
    score += 0.1 * overlap.length;
    reasons.push(`shared: ${overlap.join(', ')}`);
  }

  // Same source (both on terminal, both on MCP, etc.)
  const sourcesA = Array.isArray(userA.sources)
    ? userA.sources.filter((source): source is string => typeof source === 'string')
    : [];
  const sourcesB = Array.isArray(userB.sources)
    ? userB.sources.filter((source): source is string => typeof source === 'string')
    : [];
  const sharedSources = sourcesA.filter(
    (source) => sourcesB.includes(source)
  );
  if (sharedSources.length > 0) {
    score += 0.1;
    reasons.push(`both via ${sharedSources[0]}`);
  }

  // Complementary states
  const stateA = inferState(userA);
  const stateB = inferState(userB);
  if (stateA && stateB) {
    if (stateA.state === 'stuck' && stateB.state === 'shipping') {
      score += 0.2;
      reasons.push('could help unblock');
    }
    if (stateA.state === stateB.state) {
      score += 0.1;
      reasons.push(`both ${stateA.label}`);
    }
  }

  return { score: Math.min(1, score), reasons };
}

// ============ CONVERSATION STARTERS ============

export interface ConversationStarter {
  text: string;
  reason: string;
  type: 'context' | 'help' | 'social' | 'curiosity';
}

/**
 * Generate smart conversation starters when opening a DM
 * This is the most magical feature — the app suggests what to say
 */
export function getConversationStarters(
  me: VibeUser | null,
  them: VibeUser | null,
  allUsers: VibeUser[]
): ConversationStarter[] {
  if (!them) return [];
  const starters: ConversationStarter[] = [];
  const theirState = inferState(them);
  const myState = me ? inferState(me) : null;
  const theirMeta = them.clientMetadata || {};
  const myMeta = me?.clientMetadata || {};

  // 1. React to their current state. inferState already gates on freshness;
  // the reasons carry the same register as every other surface — a guess is
  // said to be a guess (audit #4, codex P2: DMPanel renders these).
  if (theirState) {
    if (theirState.state === 'shipping') {
      starters.push({
        text: 'What are you shipping?',
        reason: 'Looks like they\'re deploying',
        type: 'curiosity'
      });
    }
    if (theirState.state === 'debugging') {
      starters.push({
        text: 'What are you debugging? Maybe I can help',
        reason: 'Looks like they\'re working through an issue',
        type: 'help'
      });
    }
    if (theirState.state === 'deep-focus') {
      starters.push({
        text: `${Math.floor(metadataNumber(theirMeta, 'session_minutes') / 60)}h deep session - what are you building?`,
        reason: 'They report a long session',
        type: 'curiosity'
      });
    }
    if (theirState.state === 'late-night') {
      starters.push({
        text: 'Late night session - what\'s keeping you up?',
        reason: 'They report a late-night session',
        type: 'social'
      });
    }
  }

  // 2. Shared tech stack
  const myStack = metadataStrings(myMeta, 'tech_stack');
  const theirStack = metadataStrings(theirMeta, 'tech_stack');
  const overlap = myStack.filter((t: string) => theirStack.includes(t));
  if (overlap.length >= 2) {
    starters.push({
      text: `How's your ${overlap[0]} setup? I'm using it too`,
      reason: `You both use ${overlap.join(' + ')}`,
      type: 'context'
    });
  }

  // 3. Same project
  if (me?.project && them.project && me.project === them.project) {
    starters.push({
      text: `What part of ${me.project} are you working on?`,
      reason: 'You\'re both on the same project',
      type: 'context'
    });
  }

  // 4. Branch topic overlap
  const myBranch = metadataString(myMeta, 'branch').toLowerCase();
  const theirBranch = metadataString(theirMeta, 'branch').toLowerCase();
  if (myBranch && theirBranch) {
    const myTopic = extractBranchTopic(myBranch);
    const theirTopic = extractBranchTopic(theirBranch);
    if (myTopic && theirTopic && myTopic === theirTopic) {
      starters.push({
        text: `Are you working on ${myTopic} too?`,
        reason: 'Similar branch names',
        type: 'context'
      });
    }
  }

  // 5. I'm stuck, they're shipping
  if (myState?.state === 'stuck' && theirState?.state === 'shipping') {
    starters.push({
      text: 'I\'m stuck on something - got a sec?',
      reason: 'Looks like you might be stuck and they\'re in the flow',
      type: 'help'
    });
  }

  // 6. They just joined (new user)
  if (them.firstSeen) {
    const hoursAgo = (Date.now() - new Date(them.firstSeen).getTime()) / (1000 * 60 * 60);
    if (Number.isFinite(hoursAgo) && hoursAgo >= 0 && hoursAgo < 48) {
      starters.push({
        text: 'Welcome to /vibe! What are you building?',
        reason: 'They\'re new here',
        type: 'social'
      });
    }
  }

  // 7. Their workingOn is interesting
  if (typeof them.oneLiner === 'string' && them.oneLiner && them.oneLiner !== 'Vibing' && them.oneLiner !== 'Online via Buddy') {
    starters.push({
      text: `Tell me about "${them.oneLiner.slice(0, 40)}${them.oneLiner.length > 40 ? '...' : ''}"`,
      reason: 'Based on what they\'re working on',
      type: 'curiosity'
    });
  }

  // Return top 3, deduplicated by type
  const seen = new Set<string>();
  return starters.filter(s => {
    if (seen.has(s.type)) return false;
    seen.add(s.type);
    return true;
  }).slice(0, 3);
}

// ============ SHARED CONTEXT ============

export interface SharedContext {
  sharedTopics: string[];
  sharedTech: string[];
  sharedProject: string | null;
  summary: string | null;
}

/**
 * Find shared context between two users for the DM header
 * "You're both working on: presence, auth"
 */
export function getSharedContext(me: VibeUser | null, them: VibeUser | null): SharedContext {
  if (!me || !them) return { sharedTopics: [], sharedTech: [], sharedProject: null, summary: null };
  // "Both" is a now-claim about two people; either side's expired heartbeat
  // evidence retires it (codex P2, audit #4).
  const now = Date.now();
  if (!isFreshLastSeen(me.lastSeen, now) || !isFreshLastSeen(them.lastSeen, now)) {
    return { sharedTopics: [], sharedTech: [], sharedProject: null, summary: null };
  }

  const myMeta = me.clientMetadata || {};
  const theirMeta = them.clientMetadata || {};

  // Shared project
  const sharedProject = (me.project && them.project && me.project === them.project)
    ? me.project
    : null;

  // Shared tech stack
  const myStack = metadataStrings(myMeta, 'tech_stack');
  const theirStack = metadataStrings(theirMeta, 'tech_stack');
  const sharedTech = myStack.filter((t: string) => theirStack.includes(t));

  // Shared topics (from recent_topics)
  const myTopics = metadataStrings(myMeta, 'recent_topics');
  const theirTopics = metadataStrings(theirMeta, 'recent_topics');
  const sharedTopics = myTopics.filter((t: string) => theirTopics.includes(t));

  // Build summary
  const parts: string[] = [];
  if (sharedProject) parts.push(sharedProject);
  if (sharedTech.length > 0) parts.push(...sharedTech.slice(0, 2));
  if (sharedTopics.length > 0) parts.push(...sharedTopics.slice(0, 2));

  // Deduplicate
  const unique = [...new Set(parts)];
  const summary = unique.length > 0
    ? `Both report: ${unique.join(', ')}`
    : null;

  return { sharedTopics, sharedTech, sharedProject, summary };
}

// ============ SMART DM CONTEXT ============

export interface DMContext {
  theirStatus: string | null;
  stateEmoji: string | null;
  sessionDuration: string | null;
  techStack: string[] | null;
}

/**
 * Get contextual info about who you're DMing
 * Shown subtly in the DM header so you know what they're up to
 */
export function getDMContext(them: VibeUser | null): DMContext {
  if (!them) return { theirStatus: null, stateEmoji: null, sessionDuration: null, techStack: null };

  const inference = inferState(them);
  const meta = them.clientMetadata || {};
  const mins = metadataNumber(meta, 'session_minutes');
  const techStack = metadataStrings(meta, 'tech_stack');

  let duration: string | null = null;
  if (mins >= 60) {
    duration = `${Math.floor(mins / 60)}h session`;
  } else if (mins > 0) {
    duration = `${mins}m session`;
  }

  // Build a natural status line. A guess is said to be a guess (audit #4).
  const parts: string[] = [];
  if (inference) parts.push(inferredPhrase(inference));
  if (techStack.length > 0) {
    parts.push(techStack.slice(0, 2).join(' + '));
  }
  if (duration) parts.push(duration);

  return {
    theirStatus: parts.length > 0
      ? parts.join(' \u00b7 ')
      : (typeof them.oneLiner === 'string' ? them.oneLiner || null : null),
    stateEmoji: inference?.emoji || null,
    sessionDuration: duration,
    techStack: techStack.length > 0 ? techStack : null,
  };
}
