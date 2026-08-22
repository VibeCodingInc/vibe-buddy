import { useState, useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { buddyClient, type VibeUser, type VibeThread, type SessionEntity, type MySession, type RecentTrace } from '../lib/vibeClient';
import { ensureNotificationPermissionResult, hasNotificationPermission, checkAndNotify, notifyArrivals, initNotificationClicks } from '../lib/notifications';
import { vibeconfAvailability, vibeconfSeatState, startCall, joinLine, sessionContext } from '../lib/vibeconf';
import { rememberCall } from '../lib/callMemory';
import { readBotfile, sessionLabel, type Botfile } from '../lib/botfile';
import { copyText } from '../lib/clipboard';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { color, space, radius, size } from '../lib/tokens';
import { presenceStatusLine, selfDotConfirmed, type PresencePrefs, type PresenceBroadcast, type OfflineRetraction } from '../lib/presencePrefs';
import { waitingThreads, sessionsSummary } from '../lib/interval';
import { mySessionsBlock, mySessionsStaleLine, effectiveAgoMs, freshSessionCount, FIRST_RECOGNITION, type MySessionsProbe } from '../lib/mySessionsState';
import { wantsYou, type SessionSignal } from '../lib/transcript';
import { sessionLadder, type Rung, type SeatProbe } from '../lib/sessionLadder';
import { isFreshAge, isFreshLastSeen } from '../lib/freshness';
import { getSummonable, summonAgent } from '../lib/doorbell';
import { MySessionsSection, MySessionRow } from './list/MySessions';
import { UserRow, SessionRow } from './list/rows';
import { MyPresenceCard } from './list/MyPresenceCard';
import { OfflineThreadRow } from './list/OfflineThreadRow';
import { avatarFailed, menuItemStyle, TEST_HANDLE_PREFIXES, isTestAccount, LEGACY_AGENT_HANDLES, isBroadcastOnly, isUnproven, presenceDotColor, isAgent, MACHINE_ONELINERS, formatDuration, formatTime, Avatar, hasDNA } from './list/shared';
import { formatAgo, formatModel, pressOnKey } from './list/format';

interface UnifiedBuddyListProps {
  handle: string;
  users: VibeUser[];
  sessions: SessionEntity[];
  mySessions?: MySession[];
  /** Certainty of the LATEST my-sessions read — see lib/mySessionsState. */
  mySessionsProbe?: MySessionsProbe;
  /** When the last good my-sessions read was received; retained rows age from it. */
  mySessionsObservedAt?: number;
  /** Transcript signals per cwd, detected by App so they survive view changes. */
  sessionSignals?: Map<string, SessionSignal>;
  threads: VibeThread[];
  presenceError?: boolean;
  /** Who was here recently but is not here now. Traces, never presence. */
  recentlyHere?: RecentTrace[];
  pairedWith?: string;
  /**
   * Who greets a newcomer in the empty room. Defaults to the founder — a real
   * person saying hi is the product being social on purpose. Overridable so
   * synthetic captures (src/dev) never put a real handle in demo material.
   */
  greeter?: string;
  myPresence?: { prefs: PresencePrefs; broadcast: PresenceBroadcast | null; lastLandedAt: number | null; retraction?: OfflineRetraction };
  onPresenceChange?: (patch: Partial<PresencePrefs>) => void;
  onUserClick: (handle: string) => void;
  onSignOut: () => void;
  onCompact?: () => void;
  onSession?: (targetHandle: string) => void;
  onCheckUpdates?: () => void;
}

// Inject row-entrance keyframes once so new builders fade in instead of popping.
const ANIM_STYLE_ID = 'vibe-buddy-anim';
if (typeof document !== 'undefined' && !document.getElementById(ANIM_STYLE_ID)) {
  const el = document.createElement('style');
  el.id = ANIM_STYLE_ID;
  el.textContent =
    '@keyframes vibeRowIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}' +
    '.vibe-row{animation:vibeRowIn .22s ease both}' +
    '@media (prefers-reduced-motion: reduce){.vibe-row{animation:none}}' +
    // Keyboard focus is visible, in our one action colour. Rows are div-based
    // buttons, so without this rule tabbing through the room shows nothing.
    `.vibe-press:focus-visible{outline:2px solid ${color.blue};outline-offset:-2px}`;
  document.head.appendChild(el);
}




export default function UnifiedBuddyList({
  handle,
  users: allUsers,
  sessions,
  mySessions = [],
  mySessionsProbe = 'unasked',
  mySessionsObservedAt,
  sessionSignals,
  threads: allThreads,
  presenceError,
  recentlyHere = [],
  pairedWith,
  greeter = 'brightseth',
  myPresence,
  onPresenceChange,
  onUserClick,
  onSignOut,
  onCompact,
  onSession,
  onCheckUpdates,
}: UnifiedBuddyListProps) {
  const [showMenu, setShowMenu] = useState(false);
  // Same handoff as a session row, minus the session scoping. Probed on open,
  // never cached — the app can quit and the affordance must not outlive it.
  const [menuCanCall, setMenuCanCall] = useState(false);
  const [menuCallAvailabilityError, setMenuCallAvailabilityError] = useState(false);
  const [menuCallState, setMenuCallState] = useState<string | null>(null);
  useEffect(() => {
    if (!showMenu) return;
    let cancelled = false;
    setMenuCanCall(false);
    setMenuCallAvailabilityError(false);
    vibeconfAvailability().then((result) => {
      if (!cancelled) {
        setMenuCanCall(result.available);
        setMenuCallAvailabilityError(result.error);
      }
    });
    return () => { cancelled = true; };
  }, [showMenu]);

  const startMenuCall = async () => {
    if (menuCallState) return;
    setMenuCallState('starting…');
    try {
      const info = await startCall();
      const copied = await copyText(joinLine(info.code));
      setMenuCallState(copied ? 'call opened · join line copied' : `call opened · ${info.code}`);
      setTimeout(() => setMenuCallState(null), 8000);
    } catch (err) {
      setMenuCallState(String(err).slice(0, 60));
      setTimeout(() => setMenuCallState(null), 6000);
    }
  };
  const [inviteCopyState, setInviteCopyState] = useState<'copied' | 'failed' | null>(null);
  // Resolved lazily so the empty state can show a real tracked /join link
  // instead of the bare referral page. Starts as the fallback page.
  const [inviteLink, setInviteLink] = useState(`https://www.slashvibe.dev/invite/${handle}`);
  const [query, setQuery] = useState('');
  const [recentExpanded, setRecentExpanded] = useState(false);
  // MY SESSIONS folding (several sessions → one glance) lives in
  // MySessionsSection, so the populated list and the quiet room share it.
  // Doorbell (dark-launched): agents this user can summon. Empty until the
  // platform endpoint deploys + flips, so no UI renders in production today.
  const [summonable, setSummonable] = useState<Set<string>>(new Set());
  const [summonTarget, setSummonTarget] = useState<string | null>(null);
  const [summonMeetUrl, setSummonMeetUrl] = useState('');
  const [summonPurpose, setSummonPurpose] = useState('');
  const [summonBusy, setSummonBusy] = useState(false);
  const [summonNote, setSummonNote] = useState<string | null>(null);
  // Notifications: offered in-app, with a reason, before the OS dialog — and
  // only once the user has a real thread, so the ask is obviously about
  // something they care about. Dismissal is remembered.
  const [notifyOffer, setNotifyOffer] = useState(false);
  const [notifyOfferError, setNotifyOfferError] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const users = useMemo(
    () => allUsers.filter(u => u.handle !== handle && !isTestAccount(u.handle)),
    [allUsers, handle]
  );

  // Drop synthetic QA threads before anything consumes them, so test bots never
  // inflate the unread badge or clutter the Recent list.
  const threads = useMemo(() => allThreads.filter(t => !isTestAccount(t.with)), [allThreads]);

  // Thread lookup: handle -> thread
  const threadMap = useMemo(() => {
    const map = new Map<string, VibeThread>();
    for (const t of threads) {
      map.set(t.with, t);
    }
    return map;
  }, [threads]);

  // ROWS, not messages (buddy#49 decision 2): the board's aggregate counts
  // conversations waiting, so it can never disagree with the FOR YOU zone it
  // summarizes. Three unread messages from one person is ONE thing to do.
  // (The macOS dock badge keeps message-count convention — notifications.ts.)
  const unreadThreadCount = useMemo(() => threads.filter((t) => t.unread > 0).length, [threads]);

  // The exchange leads. Unread conversations form the WAITING block directly
  // under the pair card, whatever the counterpart's presence state — in the
  // interval between turns, an answer that is already here outranks a roster
  // of people who are merely around. Principals in this block are presented
  // once: the lanes below exclude them.
  // No pairedWith exclusion: the hero card owned that person and is gone, so
  // excluding them here would make an unread message from your closest
  // collaborator render NOWHERE.
  const waiting = useMemo(() => waitingThreads(threads), [threads]);
  const waitingHandles = useMemo(() => new Set(waiting.map((t) => t.with)), [waiting]);

  // Resolve the real tracked invite link once. Best-effort — if it fails,
  // inviteLink stays the bare referral fallback set in initial state.
  useEffect(() => {
    let cancelled = false;
    buddyClient.getInviteLink().then((link) => {
      if (!cancelled && link) setInviteLink(link);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [handle]);

  // Show detail features (DNA, tokens) only when 5+ users
  const totalPeople = users.length;
  const showDetails = totalPeople >= 5;

  // Paired partner data
  const pairedUser = useMemo(
    () => pairedWith ? allUsers.find(u => u.handle === pairedWith) || null : null,
    [pairedWith, allUsers]
  );


  // Offer notifications only when they'd obviously be useful: the user has at
  // least one conversation, we don't already have permission, and they haven't
  // dismissed the offer before. Never prompts the OS on its own.
  useEffect(() => {
    let cancelled = false;
    if (threads.length === 0) return;
    try {
      if (localStorage.getItem('buddy_notify_dismissed') === '1') return;
    } catch { /* storage unavailable — just skip the offer */ }
    hasNotificationPermission().then((granted) => {
      if (!cancelled && !granted) setNotifyOffer(true);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [threads.length]);

  const dismissNotifyOffer = () => {
    setNotifyOffer(false);
    try { localStorage.setItem('buddy_notify_dismissed', '1'); } catch { /* fine */ }
  };

  // Doorbell probe — re-checks every 5 min (service-side cache), so a
  // platform-side flip lights the Summon affordance without a Buddy release.
  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      const list = await getSummonable();
      if (!cancelled) setSummonable(new Set(list.map((a) => a.agent.toLowerCase())));
    };
    probe();
    const timer = setInterval(probe, 5 * 60 * 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [handle]);

  const ringDoorbell = async () => {
    if (!summonTarget || summonBusy) return;
    setSummonBusy(true);
    const result = await summonAgent({
      agent: summonTarget,
      meetUrl: summonMeetUrl,
      purpose: summonPurpose,
    });
    setSummonBusy(false);
    if (result.rung) {
      // Blind by design (contract §4): a 202 means "rung", nothing more —
      // the body appearing in the room is the only real answer.
      setSummonNote(`🔔 Doorbell rung for @${summonTarget} — if permitted, they'll appear in the room.`);
      setSummonTarget(null);
      setSummonMeetUrl('');
      setSummonPurpose('');
      setTimeout(() => setSummonNote(null), 8000);
    } else {
      setSummonNote(result.error || 'Doorbell unavailable');
      setTimeout(() => setSummonNote(null), 5000);
    }
  };

  // Clicking a DM notification focuses Buddy and opens that thread.
  // Ref keeps the handler pointing at the latest onUserClick without re-registering.
  const onUserClickRef = useRef(onUserClick);
  onUserClickRef.current = onUserClick;
  useEffect(() => {
    initNotificationClicks(
      (h) => onUserClickRef.current(h),
      // Reply straight from the banner. buddyClient.sendMessage returns false
      // on failure, and initNotificationClicks falls back to opening the thread
      // in that case — so a reply that did not send never looks like one that did.
      (h, text) => buddyClient.sendMessage(h, text),
      // A session alert's click goes where the work is: the terminal tab,
      // fronted. Buddy is not the destination — the one-click return IS the
      // retention loop.
      (cwd) => {
        void (async () => {
          const { terminalSessions, matchSessionRow, frontSession } = await import('../lib/terminal');
          const { sessions } = await terminalSessions();
          const match = matchSessionRow(cwd, sessions);
          // The host travels WITH the tty — Rust defaults an absent app to
          // iTerm2, so omitting it fronted the wrong application (or launched
          // iTerm) for every Terminal.app session reached from a banner
          // (codex P1; the same bug the row verbs fixed in 0.5.58).
          // frontSession reports failure as { ok: false } rather than
          // throwing — the tab can close between enumeration and focus, and
          // macOS Automation can refuse. The banner is already gone by now,
          // so a swallowed failure means the click visibly did NOTHING
          // (codex P2). Any way this fails, land the user in Buddy, where
          // the row explains itself.
          const fronted =
            match.kind === 'one'
              ? await frontSession(match.session.tty, match.session.app)
              : { ok: false as const };
          if (!fronted.ok) {
            const { getCurrentWindow } = await import('@tauri-apps/api/window');
            const w = getCurrentWindow();
            await w.show().then(() => w.unminimize()).then(() => w.setFocus()).catch(() => {});
          }
        })();
      },
    );
    // Read the OS grant on EVERY launch, unconditionally.
    //
    // `permissionGranted` in lib/notifications.ts is module state that starts
    // false each process. It was only ever set from the offer effect below,
    // which returns early once `buddy_notify_dismissed` is set — and accepting
    // the offer sets that flag. So the first restart after enabling
    // notifications left the module believing it had no permission, and
    // checkAndNotify silently dropped every notification from then on, forever.
    //
    // The dismissal flag governs whether to OFFER. It must never govern whether
    // we know what the OS already granted. This call never prompts.
    hasNotificationPermission().catch(() => {});
  }, []);

  // A slow tick so derived state re-runs even when no poll succeeds — an
  // outage leaves the roster frozen, and a dep array of data alone would let
  // stale input look current (codex P2, audit #4). Now it drives only the
  // BOT.md re-read; the inference it was built for is gone.
  const [intelClock, setIntelClock] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setIntelClock((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  // NOTIFICATIONS — the half of Buddy that reaches out.
  //
  // These lived inside the intelligence effect, so removing that effect
  // removed the ONLY runtime calls to them: unread counts could rise and
  // contacts could come online and the app would say nothing, with permission
  // granted, forever (codex P1). They have nothing to do with inference and
  // belong in their own effect, where deleting something else cannot take
  // them along.
  useEffect(() => {
    checkAndNotify(threads);
    // The buddy list's oldest trick, and the one Buddy never did: tell you
    // when someone you know shows up. Presence was only ever visible to a
    // user already looking at a window that lives hidden in the menu bar.
    void notifyArrivals(allUsers, threads);
  }, [handle, allUsers, threads]);

  // CUT 2026-08-15 (ruthless pass): serendipity, proactive moments and the
  // ambient line.
  //
  // These inferred things ABOUT PEOPLE from presence metadata — "you and @x
  // are both working on vibeconf" — which is local inference, the thing the
  // platform law forbids clients from doing, and the seed of a feed. The
  // ambient line restated a count the list already shows. None of the three
  // helps you reach anyone, and together they were the only part of Buddy
  // that guessed.

  // Serendipity lookup

  // Sorted active users (excluding those already in WAITING —
  // and anyone already presented in the WAITING block)
  const sortedActive = useMemo(() => {
    const active = users.filter(
      u => u.status === 'active' && !waitingHandles.has(u.handle),
    );
    const me: VibeUser = {
      handle,
      oneLiner: '',
      status: 'active',
      clientMetadata: allUsers.find(u => u.handle === handle)?.clientMetadata,
      sources: [],
    };

    return active.sort((a, b) => {
      // Users with unread messages first
      const aUnread = threadMap.get(a.handle)?.unread || 0;
      const bUnread = threadMap.get(b.handle)?.unread || 0;
      if (aUnread > 0 && bUnread === 0) return -1;
      if (bUnread > 0 && aUnread === 0) return 1;
      if (aUnread > 0 && bUnread > 0) {
        const aTime = threadMap.get(a.handle)?.lastMessage?.created_at || '';
        const bTime = threadMap.get(b.handle)?.lastMessage?.created_at || '';
        if (aTime !== bTime) return bTime.localeCompare(aTime);
      }
      // CUT 2026-08-15: collaboration score. Ranking PEOPLE by an inferred
      // affinity is the same client-side inference as the rest of this pass,
      // and it decided who you saw first. Order is now evidence only —
      // unread, then recency — and alphabetical after that.
      return a.handle.localeCompare(b.handle);
    });
  }, [users, handle, pairedWith, threadMap, allUsers, waitingHandles]);

  const awayUsers = users.filter(
    u => u.status === 'away' && !waitingHandles.has(u.handle),
  );

  // Offline threads: users with messages who aren't in the online/away lists.
  // Unread threads live in the WAITING block above, so Recent is history only.
  const onlineHandles = useMemo(() => new Set(users.map(u => u.handle)), [users]);
  const offlineThreads = useMemo(() => {
    return threads
      .filter(t => !onlineHandles.has(t.with) && !waitingHandles.has(t.with))
      .sort((a, b) => {
        const aTime = a.lastMessage?.created_at || '';
        const bTime = b.lastMessage?.created_at || '';
        return bTime.localeCompare(aTime);
      });
  }, [threads, onlineHandles, pairedWith, waitingHandles]);

  // Session entity lookup
  const sessionMap = useMemo(() => {
    const map = new Map<string, SessionEntity>();
    for (const s of sessions) {
      map.set(s.parent, s);
    }
    return map;
  }, [sessions]);

  // Search filter — appears once the list is genuinely too big to scan.
  //
  // This was 8, which is a list you can still read. A permanent search box
  // for eight rows is a control dressed for a scale the room does not have,
  // and it was taking the slot directly under the header — above your own
  // waiting work. `/` opens search at any size, so nothing is lost below the
  // threshold; the box just stops occupying the best row on the screen.
  // Orphan sessions: a session whose parent is not in the roster. It renders
  // its own lane, so it is a visible row — and a visible row that search
  // cannot reach is worse than one search omits, because the lane was gated
  // on `!q` and simply VANISHED the moment you typed its name, under
  // "Nobody here matches" (codex P2).
  // The paired partner's session is included even though they ARE in the
  // roster: the hero card used to render it, and nothing else does — none of
  // WAITING, AGENTS or AWAY renders a SessionRow. Without this, deleting the
  // hero made a partner's live session unreachable from the UI entirely
  // (codex P2).
  // A session lands here when nobody else will show it. The paired partner
  // qualifies ONLY when they are not in the rendered roster — if they are, the
  // humanActive lane already draws their SessionRow beneath their UserRow, and
  // adopting it here put two clickable rows for one session on the board
  // (codex P2).
  const renderedHandles = new Set(users.map((u) => u.handle));
  const orphanSessions = sessions.filter(
    (s) =>
      !allUsers.some((u) => u.handle === s.parent) ||
      (s.parent === pairedWith && !renderedHandles.has(s.parent)),
  );
  const SEARCH_WORTH_IT = 20;
  // Counted over every SEARCHABLE principal, not just the roster. Waiting and
  // offline threads render rows whose senders need not appear in `users` at
  // all, so `users.length` could sit at 8 while twenty-plus rows were on
  // screen — hiding the box from a list bigger than its own threshold
  // (codex P2). Deduped, because one principal can hold a roster entry and a
  // thread and is still one row to find.
  const searchablePrincipals = new Set<string>([
    ...users.map((u) => u.handle.toLowerCase()),
    ...waiting.map((t) => t.with.toLowerCase()),
    ...offlineThreads.map((t) => t.with.toLowerCase()),
    ...orphanSessions.map((s) => s.parent.toLowerCase()),
  ]);
  if (pairedWith) searchablePrincipals.add(pairedWith.toLowerCase());
  const showSearch = searchablePrincipals.size >= SEARCH_WORTH_IT;
  // Summoned by `/` in a room below the threshold. The capability is always
  // there; only the standing box is rationed.
  const [searchRevealed, setSearchRevealed] = useState(false);
  // Keyboard-focus ring for the header Search control — the dark UI has no
  // default-visible focus, so this makes keyboard focus explicit.
  const [searchFocused, setSearchFocused] = useState(false);
  const q = query.trim().toLowerCase();
  // SEARCH MATCHES WHAT IS SHOWN. tech_stack was in this predicate; with the
  // pills gone it surfaced rows containing none of the query text, and kept
  // exposing profile metadata this pass moved behind a different consent
  // boundary (codex P2).
  const matchUser = (u: VibeUser) =>
    !q ||
    u.handle.toLowerCase().includes(q) ||
    (u.displayName || '').toLowerCase().includes(q);

  const filteredActive = q ? sortedActive.filter(matchUser) : sortedActive;
  const filteredAway = q ? awayUsers.filter(matchUser) : awayUsers;
  const filteredOffline = q
    ? offlineThreads.filter((t) => t.with.toLowerCase().includes(q))
    : offlineThreads;
  // Matches the DISPLAY NAME too, not just the handle. WAITING rows render
  // `displayName`, and the paired partner now lands here like anyone else —
  // so handle-only matching hid a row whose visible text contained the query
  // and reported "nobody here matches" (codex P2). The hero used to run the
  // full matchUser for that person; nothing should have lost it.
  const filteredWaiting = q
    ? waiting.filter((t) => {
        const sender = allUsers.find((u) => u.handle === t.with);
        return t.with.toLowerCase().includes(q) || (sender ? matchUser(sender) : false);
      })
    : waiting;
  const filteredOrphanSessions = q
    ? orphanSessions.filter((s) =>
        s.parent.toLowerCase().includes(q) || s.handle.toLowerCase().includes(q))
    : orphanSessions;
  // The hero renders unconditionally and sits outside all four filtered
  // collections, so searching for your own partner showed them on screen
  // directly above "Nobody here matches", with Enter unable to open them
  // (codex P2). It is a row like any other: it filters, and it counts.
  const noMatches =
    !!q && filteredOrphanSessions.length === 0 &&
    filteredActive.length === 0 && filteredAway.length === 0 &&
    filteredOffline.length === 0 && filteredWaiting.length === 0;

  // Split live presence into humans vs. Seth's agent fleet. Humans stay in the
  // Online/Away lanes; every agent (active or away) collapses into one labeled
  // "Agents" lane so the fleet stops dominating the human board.
  const humanActive = filteredActive.filter((u) => !isAgent(u));
  const humanAway = filteredAway.filter((u) => !isAgent(u));
  const agentUsers = [...filteredActive, ...filteredAway].filter((u) => isAgent(u));
  // (The Enter-target walk moved BELOW the botfile join: it must include the
  // agents promoted into the FOR YOU zone, which are derived from it.)

  // ── One card per being (buddy#33 ①): join AGENTS ∩ MY SESSIONS on BOT.md ──
  // A session whose botfile slug names a handle on the board is (by its own
  // declaration) that agent's local body — so it renders UNDER the agent's
  // card instead of as a second, unrelated row. The join is a SELF-REPORT
  // from a local file and is labeled as such; it grants nothing and moves no
  // authority (identity binding proper is the platform's runtime-lease work).
  const [sessionBotfiles, setSessionBotfiles] = useState<Map<string, Botfile | null>>(new Map());
  const sessionCwdKey = mySessions.map((s) => s.cwd).join('|');
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        mySessions.map(async (s) => [s.cwd, await readBotfile(s.cwd)] as const),
      );
      if (!cancelled) setSessionBotfiles(new Map(entries));
    })();
    return () => { cancelled = true; };
    // intelClock: re-derive each minute so an added/removed/renamed BOT.md
    // (or one transiently failed read) heals without a restart (codex r1) —
    // readBotfile's own 60s TTL keeps the re-read nearly free.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionCwdKey, intelClock]);

  // The join derives from the UNFILTERED roster (codex r1): an agent with
  // unread mail renders in WAITING, a paired one in the hero — the being is
  // still on screen, so its body still attaches. Search is the exception:
  // while a query filters the lanes, binding suspends entirely so a hidden
  // agent's session cannot vanish from MY SESSIONS.
  const agentHandleSet = new Set(users.filter((u) => isAgent(u)).map((u) => u.handle.toLowerCase()));
  const bindingActive = !q;
  // A handle claimed by MORE than one session binds to none: the claim is
  // ambiguous and a coin flip under an agent's name is worse than two rows.
  const claimCounts = new Map<string, number>();
  for (const s of mySessions) {
    const slug = sessionBotfiles.get(s.cwd)?.bot?.toLowerCase();
    if (slug && agentHandleSet.has(slug)) claimCounts.set(slug, (claimCounts.get(slug) || 0) + 1);
  }
  const boundByHandle = new Map<string, MySession>();
  if (bindingActive) {
    for (const s of mySessions) {
      const slug = sessionBotfiles.get(s.cwd)?.bot?.toLowerCase();
      if (slug && agentHandleSet.has(slug) && claimCounts.get(slug) === 1) boundByHandle.set(slug, s);
    }
  }
  const boundSessionIds = new Set([...boundByHandle.values()].map((s) => s.sessionId));
  const unboundSessions = mySessions.filter((s) => !boundSessionIds.has(s.sessionId));
  // The shared-cwd stand-down must see EVERY session on the machine, bound
  // rows included — a bound twin must not un-share its sibling's directory.
  const allSessionCwds = mySessions.map((s) => s.cwd);

  // Signals are detected by App (always mounted, so alerts keep firing in DM,
  // session and compact views — codex r1 P1) and handed down here. The list
  // renders from the same map the alerts fire from, so a banner can never
  // claim something a row contradicts.
  const signals = sessionSignals ?? new Map<string, SessionSignal>();

  // The bound body, renderable after ANY agent-row variant (AGENTS lane,
  // WAITING, the paired hero) — one definition so the label and epistemics
  // cannot drift between lanes.
  const boundSessionBlock = (agentHandle: string) => {
    const bound = boundByHandle.get(agentHandle.toLowerCase());
    if (!bound) return null;
    return (
      // KEYED BY RUNTIME. Without this, when an agent's bound session is
      // replaced (A ends, B starts and claims the same handle), the subtree
      // holds its position and MySessionRow keeps A's state — expanded, verb
      // note, and the DRAFT. Staging a line written for A into B's terminal
      // is the exact cross-session mistake the verbs' matching rules exist
      // to prevent, arriving through React instead (codex r8 P1).
      <div key={bound.sessionId} style={{ margin: '0 0 3px 14px', borderLeft: `1px solid ${color.line}`, paddingLeft: '6px' }}>
        <div style={{ fontSize: '9px', color: color.faint, padding: '2px 4px 1px' }}>
          this session says it's @{agentHandle}
        </div>
        <MySessionRow
          session={bound}
          ageMs={effectiveAgoMs(bound, mySessionsObservedAt, Date.now())}
          stale={sessionsBlock.kind === 'rows-stale'}
          snapshotAgeMs={mySessionsObservedAt === undefined ? undefined : Math.max(0, Date.now() - mySessionsObservedAt)}
          cwdShared={allSessionCwds.filter((c) => c === bound.cwd).length > 1}
          knownSignal={signals.get(bound.cwd)}
          // Opening freezes the card's placement (zone vs AGENTS lane) so a
          // signal flip cannot move — and therefore remount — the row while
          // its draft is open (codex r3 P1 on #50). Closing releases it.
          onOpenChange={(open) => {
            const key = agentHandle.toLowerCase();
            setFrozenPlacement((m) => {
              if (open === m.has(key)) return m;
              const next = new Map(m);
              // Waiting IS the zone: a card opened under a waiting row must
              // stay in the zone when its unread clears — the zone renders
              // waiting and promoted cards from one keyed array, so the
              // waiting→promoted move preserves the subtree (codex r7 P1).
              if (open) next.set(key, promotedHandles.has(agentHandle) || waitingHandles.has(agentHandle) ? 'zone' : 'lane');
              else next.delete(key);
              return next;
            });
          }}
        />
      </div>
    );
  };


  // A being whose local body wants you belongs in the FOR YOU zone even with
  // a quiet inbox: the zone count is machine-wide (decision 2), so the ROW
  // must be in the zone too — a count pointing at a row two lanes down reads
  // as a count pointing at nothing (codex r2 P2 on #50). An agent with
  // unread mail already promotes via the waiting rows; this covers the
  // bound body alone. Under search the binding stands down (bindingActive),
  // so this set is empty and the lanes hold.
  // PLACEMENT FREEZES WHILE THE BOUND ROW IS OPEN. Promotion and demotion
  // move the card between two parents (the zone and the AGENTS lane), and
  // React cannot match keys across parents — the move is a REMOUNT, which
  // discards the bound row's expanded state, staged draft and caret exactly
  // when a routine signal refresh flips wantsYou (codex r3 P1 on #50). So
  // evidence decides placement only while the row is closed; an open row
  // stays where it was opened until its owner closes it — the same
  // only-you-close-it rule the MY SESSIONS pins follow.
  const [frozenPlacement, setFrozenPlacement] = useState<Map<string, 'zone' | 'lane'>>(new Map());
  const promotedAgents = agentUsers.filter((u) => {
    const key = u.handle.toLowerCase();
    const bound = boundByHandle.get(key);
    if (!bound) return false;
    const frozen = frozenPlacement.get(key);
    if (frozen) return frozen === 'zone';
    return wantsYou(signals.get(bound.cwd));
  });
  const promotedHandles = new Set(promotedAgents.map((u) => u.handle));
  const laneAgents = agentUsers.filter((u) => !promotedHandles.has(u.handle));

  // THE FIRST-MESSAGE FALLBACK, defined once for every branch (codex r3 P2:
  // it lived only in the populated branch, so a fresh account in the quiet
  // room — the user who most needs a first conversation — typed an exact
  // handle into search and got nothing). Renders when the query is
  // handle-shaped; opens the normal composer with nothing sent; existence is
  // decided at send (recipient_not_found), never claimed here.
  // The PLATFORM's handle grammar (validateHandle: 3–20 chars, lowercase
  // letters/digits/underscore, no leading underscore, not numeric-only),
  // applied BEFORE the door renders (codex r10 P2): a one-letter prefix
  // search toward a visible @bob must never mint an @b composer and steal
  // Enter from the real match. Hyphens accepted as input (GitHub habit) and
  // canonicalized to underscores, mirroring getHandleRecord.
  const composeCandidate = (() => {
    if (!q || !/^@?[a-z0-9][a-z0-9_-]{0,38}$/i.test(query.trim())) return null;
    const raw = query.trim().replace(/^@/, '').toLowerCase();
    // SERVED FORM FIRST (codex r13 P1): hyphenated principals exist on the
    // platform (resident vibe-bot) even though NEW registrations refuse
    // hyphens — so aliasing raw→underscore is only correct when no served
    // identity carries the raw form. The roster and thread list are the
    // served identities this client can see.
    // Every server-served sighting this client holds: roster, thread list,
    // recent traces. The residual ambiguity (a served hyphenated identity
    // with NO current sighting) is only resolvable by a platform identity
    // read — requested on the platform#272 review; until then an unsighted
    // raw form aliases to the registrable grammar (codex r14 P2, recorded).
    const servedRaw =
      users.some((u) => u.handle.toLowerCase() === raw) ||
      threads.some((t) => t.with.toLowerCase() === raw) ||
      recentlyHere.some((t) => t.handle.toLowerCase() === raw);
    const c = servedRaw ? raw : raw.replace(/-/g, '_');
    if (c.length < 3 || c.length > 20) return null;
    if (!/^[a-z0-9_-]+$/.test(c) || c.startsWith('_') || /^[0-9]+$/.test(c)) return null;
    return c;
  })();
  // Synthetic-QA principals are deliberately filtered off this board
  // (isTestAccount); the compose door must not reopen them — a successful
  // send would land in a conversation the list then hides (codex r9 P2).
  const composeRaw = q ? query.trim().replace(/^@/, '').toLowerCase() : null;
  const composeQuery = composeCandidate && !isTestAccount(composeCandidate) && !(composeRaw && isTestAccount(composeRaw))
    ? composeCandidate : null;
  // EXACT beats fuzzy, and RENDERED beats known (codex r4 P2, r5 P2):
  // typing 'bob' toward a new @bob while @bobby exists hid the only compose
  // action; and searching a KNOWN principal by alias form ('@alice',
  // 'alice-smith' for alice_smith) filtered out every row while the
  // known-set check suppressed the door — a total dead end. So the door
  // hides only when the canonical target's own row is ACTUALLY ON SCREEN
  // (that row is the affordance); in every other handle-shaped case it
  // shows, and clicking it opens the same thread the row would have.
  const presentedHandles = new Set([
    ...filteredWaiting.map((t) => t.with.toLowerCase()),
    ...humanActive.map((u) => u.handle.toLowerCase()),
    ...humanAway.map((u) => u.handle.toLowerCase()),
    ...promotedAgents.map((u) => u.handle.toLowerCase()),
    ...laneAgents.map((u) => u.handle.toLowerCase()),
    ...filteredOffline.map((t) => t.with.toLowerCase()),
    // NOT orphan sessions (codex r6 P2): a session-only row routes to the
    // SESSION view, not the composer — it cannot stand in for the DM door.
  ]);
  // Both forms suppress (codex r13 P1): a rendered hyphenated row must not
  // coexist with a canonicalized door that steals Enter toward a different
  // underscore principal.
  const composeTargetPresented = composeQuery !== null &&
    (presentedHandles.has(composeQuery) || presentedHandles.has(composeQuery.replace(/_/g, '-')));
  const firstMessageFallback = composeQuery && !composeTargetPresented ? (
    <div style={{ textAlign: 'center', paddingBottom: '16px' }}>
      <button
        type="button"
        onClick={() => onUserClick(composeQuery)}
        style={{
          background: 'transparent',
          border: `1px solid ${color.line}`,
          borderRadius: '6px',
          padding: '6px 14px',
          color: color.blue,
          fontSize: '12px',
          fontFamily: 'inherit',
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        Message @{composeQuery} ›
      </button>
    </div>
  ) : null;

  // Enter opens the TOPMOST VISIBLE result — so this list is the render
  // order, lane for lane. It used to read only the hero, Online and Agents,
  // which meant a query whose only match sat in Waiting, Away or Recent
  // either opened some unrelated row further down or did nothing at all
  // (codex P2, twice: first the hero, then every other lane).
  //
  // Handles, not users: Waiting and Recent are threads, whose principals
  // need not appear in the roster at all.
  // Render order, lane for lane: hero, the FOR YOU zone (waiting threads,
  // then promoted bound-wanting agents), Online, Sessions, Away, Agents,
  // Recent. An orphan session opens with onSession, not onUserClick — it
  // has no DM thread — so the target carries HOW to open it, not just who
  // (codex P2). Getting the order wrong opens a lower row than the one the
  // reader is looking at, which has now been the same bug three times.
  const enterTarget: { handle: string; session?: boolean } | undefined =
    // The DOOR wins Enter while it is showing (codex r6 P1): a fuzzy row
    // (@bobby) must not swallow a keystroke aimed at a new exact @bob, and
    // with no fuzzy rows Enter must not die on a renderable action.
    (composeQuery && !composeTargetPresented ? { handle: composeQuery } : undefined) ??
    (filteredWaiting[0] ? { handle: filteredWaiting[0].with } : undefined) ??
    (promotedAgents[0] ? { handle: promotedAgents[0].handle } : undefined) ??
    (humanActive[0] ? { handle: humanActive[0].handle } : undefined) ??
    (filteredOrphanSessions[0] ? { handle: filteredOrphanSessions[0].parent, session: true } : undefined) ??
    (humanAway[0] ? { handle: humanAway[0].handle } : undefined) ??
    (laneAgents[0] ? { handle: laneAgents[0].handle } : undefined) ??
    (filteredOffline[0] ? { handle: filteredOffline[0].with } : undefined);

  // Keep live presence above the fold: a long Recent (past DMs) list is collapsed
  // to the most-recent few by default. Searching always shows every match.
  const RECENT_COLLAPSED_LIMIT = 5;
  const recentCapped = !q && !recentExpanded && filteredOffline.length > RECENT_COLLAPSED_LIMIT;
  const visibleOffline = recentCapped
    ? filteredOffline.slice(0, RECENT_COLLAPSED_LIMIT)
    : filteredOffline;

  // `/` SUMMONS search at any room size; Esc clears and dismisses it.
  //
  // This used to bail when the box was not rendered, so raising the
  // threshold would have removed search entirely for a room of 8-19 rather
  // than merely hiding it — the box is the only thing the threshold should
  // govern, never the capability. Below the threshold `/` reveals it for as
  // long as it is wanted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
      if (e.key === '/' && !typing) {
        e.preventDefault();
        setSearchRevealed(true);
        // Already mounted → focus now. Not yet → the effect below focuses it
        // once it exists (ref is null here on the first reveal).
        searchRef.current?.focus();
      } else if (e.key === 'Escape') {
        if (query) setQuery('');
        searchRef.current?.blur();
        // Always clear the latch. Pressing `/` in a big room set it even
        // though the box was already standing, and a guarded clear left it
        // stuck true — so if presence later fell below the threshold, a
        // dismissed box came back and stayed (codex P3). `showSearch` alone
        // keeps the box mounted while the room still warrants it.
        setSearchRevealed(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showSearch, query]);

  useEffect(() => {
    if (searchRevealed) searchRef.current?.focus();
  }, [searchRevealed]);

  // Count sections for smart header display
  const sectionCount = [
    filteredWaiting.length > 0 ? 1 : 0,
    humanActive.length > 0 ? 1 : 0,
    humanAway.length > 0 ? 1 : 0,
    agentUsers.length > 0 ? 1 : 0,
    filteredOffline.length > 0 ? 1 : 0,
  ].reduce((a, b) => a + b, 0);

  // `threads`, not `offlineThreads`: an unread thread from an offline sender
  // lives in the WAITING block, and a window holding a waiting answer is not
  // an empty room.
  const hasContent = users.length > 0 || sessions.length > 0 || threads.length > 0 || pairedWith;

  // The sessions block, decided once (lib/mySessionsState) and rendered from
  // ONE element in every branch that shows it — the quiet room, the
  // can't-reach room, and (rows only) the populated list. Zero rows still
  // says which zero it is; retained rows under a failing read say how old.
  const sessionsBlock = mySessionsBlock(mySessionsProbe, mySessions.length);

  // The FOR YOU zone's count: THE ROWS THE ZONE PRESENTS, exactly (buddy#49
  // decision 2; codex r5 P2 on #50). Presentation can lawfully diverge from
  // raw evidence while a row is held open (frozenPlacement above, and pins
  // inside MySessions keep an open row where its owner put it), so a count
  // derived from evidence alone would point at rows that are not there —
  // or miss ones that are. Three addends, each the size of a rendered set:
  //   · promotedAgents — bound-wanting beings presented in the zone
  //     (placement-frozen members included: presented is presented)
  //   · wanting UNBOUND sessions — exactly MySessions' above-the-line rows
  //   · the waiting conversations (added at each call site, since search
  //     scopes them)
  // A wanting session bound to an agent the user is holding in the AGENTS
  // lane is deliberately NOT counted here: its row — where its state shows —
  // is in the lane until its owner closes it.
  const wantingUnbound = unboundSessions.filter((s) => wantsYou(signals.get(s.cwd))).length;
  // A waiting agent card renders TWO actionable rows when its bound session
  // also wants you — the conversation and the session (codex r6 P2 on #50).
  // The session half is counted here; the conversation is in the waiting
  // count. Under search the binding stands down, so this is 0 and matches
  // the unrendered bound blocks.
  const boundWantingInWaiting = [...boundByHandle.entries()].filter(([slug, s]) =>
    [...waitingHandles].some((h) => h.toLowerCase() === slug) && wantsYou(signals.get(s.cwd))).length;
  const zoneSessionCount = wantingUnbound + promotedAgents.length + boundWantingInWaiting;
  const mySessionsEl = mySessions.length > 0 ? (
    <MySessionsSection
      mySessions={unboundSessions}
      allCwds={allSessionCwds}
      attentionSessions={mySessions}
      signals={signals}
      observedAt={mySessionsObservedAt}
      stale={sessionsBlock.kind === 'rows-stale'}
    />
  ) : null;

  // ONE definition of "can this conversation be archived": only when the
  // thread carries a server id — the chip must never offer a write that
  // cannot land. Every row variant (UserRow and OfflineThreadRow) gets its
  // affordance from here, so archivability never depends on row shape.
  const archiveFor = (t?: VibeThread) =>
    t?.id ? () => buddyClient.setThreadArchived(t.id!, true) : undefined;
  const sessionsBlockEl = (
    <div style={{ textAlign: 'left', marginBottom: '16px' }}>
      {sessionsBlock.kind === 'line' ? (
        <>
          <div style={{
            fontSize: '9px',
            fontWeight: 600,
            color: color.faint,
            textTransform: 'uppercase',
            letterSpacing: '1px',
            padding: '4px 4px 4px',
          }}>
            My Sessions
          </div>
          <div style={{ color: color.faint, fontSize: size[11], padding: '0 4px' }}>
            {sessionsBlock.line}
          </div>
        </>
      ) : (
        <>
          {/* The zone keeps its name in EVERY branch that renders wanting
              rows (buddy#49 decision 1): a quiet or unreachable room still
              says "For you" above the sessions that want you, in the same
              vocabulary as the populated board. The count here is exactly
              the wanting rows — there are no waiting conversations in the
              branches that draw this block. The claim is local transcript
              truth, so it holds even while the roster read fails. */}
          {zoneSessionCount > 0 && (
            <div style={{
              fontSize: '9px',
              fontWeight: 600,
              color: color.faint,
              textTransform: 'uppercase',
              letterSpacing: '1px',
              padding: '4px 4px 4px',
            }}>
              For you · {zoneSessionCount}
            </div>
          )}
          {mySessions.length > 0 && (
          <MySessionsSection
            mySessions={unboundSessions}
            allCwds={allSessionCwds}
            attentionSessions={mySessions}
            signals={signals}
            observedAt={mySessionsObservedAt}
            stale={sessionsBlock.kind === 'rows-stale'}
          />
          )}
          {/* Recognition is a NOW-claim, so it never renders over a stale
              snapshot — only under rows the latest read verified. */}
          {sessionsBlock.kind === 'rows' && (
            <div style={{ color: color.faint, fontSize: size[11], padding: '2px 4px 0' }}>
              {FIRST_RECOGNITION}
            </div>
          )}
        </>
      )}
    </div>
  );

  const copyInviteLink = async () => {
    // A tracked /join code (credits the referral chain / K-factor), not the
    // bare /invite/{handle} page. getInviteLink() falls back to that page if
    // the invites API is unreachable, so this never copies nothing.
    const link = await buddyClient.getInviteLink();
    const copied = await copyText(link);
    setInviteCopyState(copied ? 'copied' : 'failed');
    setTimeout(() => setInviteCopyState(null), copied ? 2000 : 4000);
  };


  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: color.bg,
      color: color.ink,
    }}>
      {/* Header */}
      <div
        style={{
          padding: '10px 14px',
          borderBottom: `1px solid ${color.panel}`,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
        data-tauri-drag-region
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', position: 'relative' }}>
          {/* This opens the account menu, and for a long time it was a bare
              word with no chevron, no border and no hover state. Seth searched
              four separate places for "Check for Updates" before finding it
              here — and he commissioned the feature. An affordance discovered
              by accident is an affordance most people never discover.

              A caret and a hover background cost nothing and make it a button. */}
          <button
            type="button"
            aria-label="Account menu"
            onClick={() => setShowMenu(!showMenu)}
            onMouseEnter={(e) => (e.currentTarget.style.background = color.panel)}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: space[1],
              fontWeight: 600,
              fontSize: size[14],
              color: color.ink,
              fontFamily: 'inherit',
              background: 'transparent',
              border: 'none',
              borderRadius: radius.sm,
              padding: `2px ${space[1]}px`,
              margin: `0 -${space[1]}px`,
              cursor: 'pointer',
            }}
          >
            /vibe
            <span
              style={{
                fontSize: size[11],
                color: color.faint,
                transform: showMenu ? 'rotate(180deg)' : 'none',
                transition: 'transform 120ms',
                lineHeight: 1,
              }}
            >
              ▾
            </span>
          </button>
          {sortedActive.length > 0 && (
            <span style={{
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              background: color.ink,
              display: 'inline-block',
            }} />
          )}
          {showMenu && (
            <div style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              marginTop: '4px',
              background: color.panel,
              border: `1px solid ${color.line}`,
              borderRadius: '6px',
              padding: '4px 0',
              minWidth: '130px',
              zIndex: 100,
            }}>
              <div style={{
                padding: '6px 12px',
                fontSize: '11px',
                color: color.faint,
                borderBottom: `1px solid ${color.line}`,
              }}>
                @{handle}
              </div>
              {/* "Go Live" used to sit here in pink. It called startBroadcast()
                  — the broadcast half of Watch, which was cut from the default
                  surface in 0.5.17 after being silently broken for months. So
                  it started a broadcast nobody could ever watch, and spent the
                  reserved attention colour doing it.
                  A real call replaces it: vibeconf does calls, Buddy hands off. */}
              {menuCanCall && (
                <button
                  type="button"
                  disabled={menuCallState !== null}
                  style={{ ...menuItemStyle, color: color.blue }}
                  onClick={() => { void startMenuCall(); }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = color.line)}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  {menuCallState || 'Start a call'}
                </button>
              )}
              {menuCallAvailabilityError && (
                <div style={{ ...menuItemStyle, color: color.faint }}>
                  Couldn't check call availability
                </div>
              )}
              {/* Seth went looking for this here twice. It lives in the tray
                  menu too, but the account menu is where people expect it. */}
              <button
                type="button"
                style={{ ...menuItemStyle, color: color.dim }}
                onClick={() => { setShowMenu(false); onCheckUpdates?.(); }}
                onMouseEnter={(e) => (e.currentTarget.style.background = color.line)}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                Check for updates
              </button>
              <button
                type="button"
                style={{ ...menuItemStyle, color: color.dim }}
                onClick={() => { setShowMenu(false); copyInviteLink(); }}
                onMouseEnter={(e) => (e.currentTarget.style.background = color.line)}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                Copy invite link
              </button>
              <button
                type="button"
                style={{ ...menuItemStyle, color: color.dim }}
                onClick={() => { setShowMenu(false); onSignOut(); }}
                onMouseEnter={(e) => (e.currentTarget.style.background = color.line)}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                Sign out
              </button>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {/* Suppressed while a query is active: the badge is a standing
              board-wide claim, the zone header below is scoped to the search
              — two aggregates disagreeing on one screen is the exact defect
              decision 2 exists to kill (codex r1 P2 on #50). The board-wide
              number returns the moment the search clears. */}
          {!query.trim() && unreadThreadCount + zoneSessionCount > 0 && (
            <span style={{
              background: color.blue,
              color: color.ink,
              fontSize: '10px',
              padding: '2px 6px',
              borderRadius: '8px',
              fontWeight: 600,
            }}>
              {unreadThreadCount + zoneSessionCount}
            </span>
          )}
          {/* Always-visible, quiet Search affordance (the / shortcut is real
              but invisible). Reveals and focuses the SAME search field; no
              modal, no new search system. Subdued by default, blue only when
              active (revealed or a live query) — the one place blue earns its
              meaning here. Keyboard-activates as a button; its focus ring is
              explicit so the dark UI still shows keyboard focus. */}
          <button
            type="button"
            aria-label="Search people and sessions"
            // Reflects the field's ACTUAL visibility: it also stands open on
            // its own in a crowded room (showSearch), not only when revealed
            // or queried — so the ARIA state can't disagree with the screen.
            aria-expanded={showSearch || searchRevealed || !!query.trim()}
            onClick={() => { setSearchRevealed(true); searchRef.current?.focus(); }}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            style={{
              background: 'transparent',
              border: 'none',
              color: (searchRevealed || query.trim()) ? color.blue : color.faint,
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: '11px',
              lineHeight: 1,
              padding: '2px 4px',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '3px',
              borderRadius: '4px',
              outline: searchFocused ? `1px solid ${color.blue}` : 'none',
              outlineOffset: '1px',
            }}
          >
            <span style={{ fontSize: '13px' }} aria-hidden>⌕</span>
            <span>Search</span>
          </button>
          {onCompact && (
            <span
              onClick={onCompact}
              style={{ fontSize: '11px', color: color.faint, cursor: 'pointer', padding: '2px 4px' }}
              title="Compact mode"
            >
              &laquo;
            </span>
          )}
        </div>
      </div>

      {/* Notification offer — explains the value, then asks the OS. */}
      {notifyOffer && (
        <div style={{
          padding: '8px 14px',
          borderBottom: `1px solid ${color.panel}`,
          background: color.panel,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}>
          <div style={{ flex: 1, minWidth: 0, fontSize: '11px', color: color.dim, lineHeight: 1.5 }}>
            {notifyOfferError
              ? "Couldn't ask macOS for notification access."
              : "Get notified when a DM lands, so you don't have to keep Buddy open?"}
          </div>
          <button
            type="button"
            onClick={async () => {
              setNotifyOfferError(false);
              const result = await ensureNotificationPermissionResult();
              if (result.error) {
                setNotifyOfferError(true);
              } else {
                // Granted or deliberately denied are both answers. Only an
                // OS/plugin failure keeps the offer retryable.
                dismissNotifyOffer();
              }
            }}
            style={{
              background: color.blue,
              border: 'none',
              borderRadius: '5px',
              padding: '5px 12px',
              color: color.ink,
              fontSize: '11px',
              fontWeight: 600,
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            {notifyOfferError ? 'Try again' : 'Turn on'}
          </button>
          <button
            type="button"
            onClick={dismissNotifyOffer}
            style={{
              background: 'transparent',
              border: `1px solid ${color.line}`,
              borderRadius: '5px',
              padding: '5px 10px',
              color: color.faint,
              fontSize: '11px',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            Not now
          </button>
        </div>
      )}

      {/* Doorbell ring sheet — only reachable when the probe found a live
          endpoint AND this user holds a grant for the target agent. */}
      {summonTarget && (
        <div style={{
          padding: '10px 14px',
          borderBottom: `1px solid ${color.line}`,
          background: color.panel,
          flexShrink: 0,
        }}>
          <div style={{ fontSize: '12px', fontWeight: 600, color: color.blue, marginBottom: '6px' }}>
            🔔 Summon @{summonTarget} into a call
          </div>
          <input
            value={summonMeetUrl}
            onChange={(e) => setSummonMeetUrl(e.target.value)}
            placeholder="https://meet.google.com/xxx-xxxx-xxx"
            spellCheck={false}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              background: color.panel,
              border: `1px solid ${color.panel}`,
              borderRadius: '5px',
              padding: '6px 8px',
              color: color.ink,
              fontSize: '11px',
              outline: 'none',
              marginBottom: '5px',
              fontFamily: 'monospace',
            }}
          />
          <input
            value={summonPurpose}
            onChange={(e) => setSummonPurpose(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void ringDoorbell(); }}
            placeholder="Why? (lands in the receipt — required)"
            maxLength={160}
            spellCheck={false}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              background: color.panel,
              border: `1px solid ${color.panel}`,
              borderRadius: '5px',
              padding: '6px 8px',
              color: color.ink,
              fontSize: '11px',
              outline: 'none',
              marginBottom: '7px',
            }}
          />
          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              onClick={() => void ringDoorbell()}
              disabled={summonBusy || !summonMeetUrl.trim() || !summonPurpose.trim()}
              style={{
                flex: 1,
                background: color.blue,
                border: 'none',
                borderRadius: '5px',
                padding: '6px 0',
                color: color.panel,
                fontSize: '11px',
                fontWeight: 700,
                cursor: summonBusy ? 'default' : 'pointer',
                opacity: summonBusy || !summonMeetUrl.trim() || !summonPurpose.trim() ? 0.5 : 1,
              }}
            >
              {summonBusy ? 'Ringing…' : 'Ring the doorbell'}
            </button>
            <button
              onClick={() => { setSummonTarget(null); setSummonMeetUrl(''); setSummonPurpose(''); }}
              style={{
                background: color.panel,
                border: `1px solid ${color.line}`,
                borderRadius: '5px',
                padding: '6px 12px',
                color: color.dim,
                fontSize: '11px',
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Doorbell result note — deliberately outcome-blind (contract §4) */}
      {summonNote && (
        <div style={{
          padding: '6px 14px',
          fontSize: '11px',
          color: color.blue,
          borderBottom: `1px solid ${color.line}`,
          background: color.panel,
          flexShrink: 0,
        }}>
          {summonNote}
        </div>
      )}

      {/* Ambient whisper */}

      {/* Search — a standing box once the list is genuinely unscannable, and
          on demand via `/` at any size. A live query always keeps it up, or
          filtering would hide the control doing the filtering. */}
      {(showSearch || searchRevealed || query) && (
        <div style={{ padding: '6px 10px', borderBottom: `1px solid ${color.panel}`, flexShrink: 0 }}>
          <div style={{ position: 'relative' }}>
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && enterTarget) {
                  if (enterTarget.session) onSession?.(enterTarget.handle);
                  else onUserClick(enterTarget.handle);
                } else if (e.key === 'Escape') {
                  setQuery('');
                  e.currentTarget.blur();
                }
              }}
              // NO COUNT, and not "builders".
              //
              // `totalPeople` counts humans AND agents, but the ambient line
              // two rows up says "3 builders online right now · 4 agents" —
              // builders there EXCLUDE agents. One word, two meanings, two
              // lines apart, and no way to reconcile 8 with 3 + 4 without
              // reading the source. Dropping the number removes the
              // contradiction permanently rather than restating it in a
              // second place that can drift again — and stops the first
              // sentence on a newcomer's screen from announcing how small
              // the room is.
              placeholder="Search the room…  ( / )"
              spellCheck={false}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                background: color.panel,
                border: `1px solid ${color.panel}`,
                borderRadius: '6px',
                padding: '6px 26px 6px 10px',
                color: color.ink,
                fontSize: '12px',
                outline: 'none',
              }}
            />
            {query && (
              <span
                onClick={() => { setQuery(''); searchRef.current?.focus(); }}
                style={{
                  position: 'absolute',
                  right: '8px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  fontSize: '12px',
                  color: color.faint,
                  cursor: 'pointer',
                }}
                title="Clear"
              >
                {'×'}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Unified list */}
      <div style={{
        flex: 1,
        overflow: 'auto',
        padding: '6px 8px',
        minHeight: 0,
      }}>
        {/* My Presence — your own broadcast, visible and controllable. Sits at
            the top the way your own name did on the AIM buddy list. */}
        {myPresence && onPresenceChange && (
          <MyPresenceCard
            handle={handle}
            prefs={myPresence.prefs}
            broadcast={myPresence.broadcast}
            lastLandedAt={myPresence.lastLandedAt}
            retraction={myPresence.retraction ?? null}
            liveSessionCount={
              // Only sessions whose liveness evidence is still fresh count as
              // broadcasters — the platform retains rows past their last
              // heartbeat, and a retained row must not keep the invisible
              // card claiming "sessions broadcast you" (codex P2 r3).
              mySessionsProbe === 'known'
                ? freshSessionCount(mySessions, mySessionsObservedAt, Date.now())
                : null
            }
            onChange={onPresenceChange}
          />
        )}

        {/* CUT 2026-08-15 (ruthless pass): the paired-partner hero card.
            One bespoke treatment for one person is a second row type to
            maintain, a second place for copy to drift, and a second set of
            honesty rules to keep in sync — it already needed its own
            searchability fix, its own Enter-target fix and its own bound-
            session keying. With the list sorted by attention, your partner
            rises to the top on merit. */}

        {!hasContent && presenceError ? (
          // Couldn't reach /vibe — don't claim it's empty. Polling auto-retries.
          <div style={{
            textAlign: 'center',
            color: color.faint,
            padding: '40px 20px',
            fontSize: '12px',
            lineHeight: '1.8',
          }}>
            {/* My Sessions is an INDEPENDENT read: when the roster fetch
                fails but /api/my-sessions verified an answer, that truth
                still renders — a presence outage must not hide it. RETAINED
                rows render too (with their stale line saying how old): the
                zone count keeps counting a retained wanting row under a
                failing read, and a badge whose row is hidden is a count
                pointing at nothing (codex r2 P2 on #50). Only the
                never-loaded case stays hidden — the error text below
                already covers "we can't see". */}
            {(mySessionsProbe === 'known' || mySessions.length > 0) && sessionsBlockEl}
            {/* The door renders under an outage too (codex r13 P2):
                presence and messaging are independent endpoints, and Enter
                already reached this target — a keyboard-only action with no
                visible counterpart is the defect, not the composing. */}
            {firstMessageFallback}
            <div style={{ fontSize: '14px', fontWeight: 600, color: color.dim, marginBottom: '4px' }}>
              Can't reach /vibe
            </div>
            <div style={{ color: color.faint }}>
              Check your connection — reconnecting automatically.
            </div>
          </div>
        ) : !hasContent ? (
          // Empty state — never a dead end. Seed with a first conversation
          // (@brightseth sends the welcome DM) and a real tracked invite link.
          <div style={{
            textAlign: 'center',
            color: color.faint,
            padding: '32px 20px',
            fontSize: '12px',
            lineHeight: '1.8',
          }}>
            {/* Your own session renders BEFORE the room is declared quiet.
                "Quiet in here" is a claim about other people; a live coding
                session is still content, and hiding it here was the moment
                Buddy could have said "your session is here" and drew a void
                instead. */}
            {sessionsBlockEl}
            {/* The first-message door works from the quiet room too (codex
                r3 P2): the fresh account with nobody on the board is exactly
                who needs to start a conversation from a handle they were
                given elsewhere. */}
            {firstMessageFallback}
            <div style={{ fontSize: '14px', fontWeight: 600, color: color.dim, marginBottom: '4px' }}>
              Quiet in here
            </div>
            {/* Room tone: the ambient sound of an empty room, so that silence
                feels alive rather than dead. The server has always known who
                was here in the last hours and what they were doing; Buddy
                dropped it and rendered a void. A room with a history invites.
                A room with none looks like a broken app.

                Rendered as history, never as presence: no dots, dim, and the
                time is stated first so nobody reads it as "here now". */}
            {recentlyHere.length > 0 ? (
              <div style={{ marginBottom: '16px', textAlign: 'left' }}>
                <div style={{ color: color.faint, marginBottom: '8px', textAlign: 'center' }}>
                  but people have been building
                </div>
                {recentlyHere.slice(0, 4).map((t) => (
                  <div
                    key={t.handle}
                    className="vibe-press"
                    role="button"
                    tabIndex={0}
                    aria-label={`@${t.handle}, here ${t.ago} ago`}
                    onKeyDown={pressOnKey(() => onUserClick(t.handle))}
                    onClick={() => onUserClick(t.handle)}
                    style={{
                      display: 'flex',
                      gap: space[2],
                      alignItems: 'baseline',
                      padding: `${space[1]}px ${space[2]}px`,
                      cursor: 'pointer',
                      borderRadius: radius.sm,
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = color.panel)}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <span style={{ color: color.faint, fontSize: size[11], minWidth: '28px' }}>
                      {t.ago}
                    </span>
                    <span style={{ color: color.dim, fontSize: size[12], fontWeight: 500 }}>
                      {t.handle}
                    </span>
                    <span style={{
                      color: color.faint,
                      fontSize: size[11],
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      flex: 1,
                    }}>
                      {t.workingOn || ''}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ marginBottom: '16px', color: color.faint }}>
                Say hi, or invite someone to build with
              </div>
            )}
            <button
              onClick={() => onUserClick(greeter)}
              style={{
                background: color.panel,
                color: color.ink,
                border: `1px solid ${color.line}`,
                borderRadius: '6px',
                padding: '8px 20px',
                fontSize: '12px',
                fontWeight: 600,
                cursor: 'pointer',
                marginBottom: '10px',
                display: 'block',
                width: '100%',
                maxWidth: '220px',
                marginLeft: 'auto',
                marginRight: 'auto',
              }}
            >
              👋 Say hi to @{greeter}
            </button>
            <button
              onClick={copyInviteLink}
              style={{
                background: color.blue,
                color: color.ink,
                border: 'none',
                borderRadius: '6px',
                padding: '8px 20px',
                fontSize: '12px',
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'background 0.2s ease',
                display: 'block',
                width: '100%',
                maxWidth: '220px',
                marginLeft: 'auto',
                marginRight: 'auto',
              }}
            >
              {inviteCopyState === 'copied'
                ? 'Copied!'
                : inviteCopyState === 'failed'
                  ? 'Copy failed — select the link below'
                  : 'Copy invite link'}
            </button>
            <div style={{ marginTop: '12px', fontSize: '10px', color: color.faint, wordBreak: 'break-all' }}>
              {inviteLink.replace(/^https?:\/\//, '')}
            </div>
          </div>
        ) : (
          <>
            {/* THE FOR YOU ZONE — one position, always (buddy#49 decision 1).
                Everything actionable lives here: waiting conversations first
                (the exchange outranks presence — the interval's whole job),
                then the sessions that want you (MySessions renders directly
                below, attention rows above its own fold line). The zone
                never moves; rank lives INSIDE it, so the eye can build a
                spatial habit instead of re-reading headers.
                This replaces the keyed-siblings swap that traded WAITING and
                MY SESSIONS by evidence. That mechanism existed to survive
                its own reordering (remount ate drafts: codex r5 P1; CSS
                `order` broke a11y: codex r6 P2) — a fixed order needs none
                of it, and DOM order is the visual order by construction.
                The header is the board's ONE aggregate and counts ACTIONABLE
                ROWS exactly (decision 2): filtered unread conversations plus
                machine-wide wanting sessions. */}
            {filteredWaiting.length + zoneSessionCount > 0 && (
              <div style={{
                fontSize: '9px',
                fontWeight: 600,
                color: color.faint,
                textTransform: 'uppercase',
                letterSpacing: '1px',
                padding: '4px 4px 4px',
              }}>
                For you · {filteredWaiting.length + zoneSessionCount}
              </div>
            )}
            {/* ONE KEYED ARRAY for the zone's being-rows — waiting cards and
                promoted bound-wanting cards. An agent transitions between
                the two on ordinary unread events (a DM arrives, a thread is
                read); as sibling maps those are different React parents, so
                the transition REMOUNTED the card and discarded its bound
                row's open draft (codex r7 P1 on #50). In one array the key
                (the handle) matches across the transition and the subtree
                MOVES. */}
            {[
                ...filteredWaiting.map((thread) => {
                  const sender = users.find((u) => u.handle === thread.with);
                  return sender ? (
                    <div key={thread.with}>
                    <UserRow
                      user={sender}
                      onClick={() => onUserClick(thread.with)}
                      thread={thread}
                      onArchive={archiveFor(thread)}
                      isPaired={sender.handle === pairedWith}
                      onSessionView={sender.handle === pairedWith && onSession ? () => onSession(sender.handle) : undefined}
                      myHandle={handle}
                      showDetails={showDetails}
                      showKind
                      unreadImplied
                    />
                    {isAgent(sender) && boundSessionBlock(sender.handle)}
                    </div>
                  ) : (
                    <OfflineThreadRow
                      key={thread.with}
                      thread={thread}
                      onClick={() => onUserClick(thread.with)}
                      myHandle={handle}
                      onArchive={archiveFor(thread)}
                      unreadImplied
                    />
                  );
                }),
            // Bound-wanting beings: the agent card and its body, promoted
            // out of the AGENTS lane so every row the zone counts is a row
            // the zone shows. showKind — outside the labeled lane, the row
            // says what kind of company it is.
            ...promotedAgents.map((user) => (
              <div key={user.handle}>
                <UserRow
                  user={user}
                  onClick={() => onUserClick(user.handle)}
                  onSummon={summonable.has(user.handle.toLowerCase()) ? () => setSummonTarget(user.handle) : undefined}
                  thread={threadMap.get(user.handle)}
                  onArchive={archiveFor(threadMap.get(user.handle))}
                  isPaired={user.handle === pairedWith}
                  onSessionView={user.handle === pairedWith && onSession ? () => onSession(user.handle) : undefined}
                  myHandle={handle}
                  showDetails={showDetails}
                  showKind
                />
                {boundSessionBlock(user.handle)}
              </div>
            )),
            ]}
            {mySessionsEl}

            {/* Online users (humans) */}
            {humanActive.length > 0 && (
              <>
                {sectionCount > 1 && (
                  <div style={{
                    fontSize: '9px',
                    fontWeight: 600,
                    color: color.faint,
                    textTransform: 'uppercase',
                    letterSpacing: '1px',
                    padding: pairedWith ? '8px 4px 4px' : '4px 4px 4px',
                  }}>
                    Online · {humanActive.length}
                  </div>
                )}
                {/* The ONLY lane that renders a SessionRow beneath the row —
                    which is why it is the only one that suppresses the paired
                    Watch action. Suppressing it everywhere stranded a paired
                    partner who was unread, away or an agent exactly when a
                    live session existed (codex P2). */}
                {humanActive.map((user) => (
                  <div key={user.handle}>
                    <UserRow
                      user={user}
                      onClick={() => onUserClick(user.handle)}
                      onSummon={summonable.has(user.handle.toLowerCase()) ? () => setSummonTarget(user.handle) : undefined}
                      thread={threadMap.get(user.handle)}
                      onArchive={archiveFor(threadMap.get(user.handle))}
                      isPaired={user.handle === pairedWith}
                      onSessionView={user.handle === pairedWith && onSession && !sessionMap.has(user.handle) ? () => onSession(user.handle) : undefined}
                      myHandle={handle}
                      showDetails={showDetails}
                    />
                    {sessionMap.has(user.handle) && (
                      <SessionRow
                        session={sessionMap.get(user.handle)!}
                        onSession={onSession}
                      />
                    )}
                  </div>
                ))}
              </>
            )}

            {/* Orphan sessions */}
            {filteredOrphanSessions.length > 0 && (
              <>
                <div style={{
                  fontSize: '9px',
                  fontWeight: 600,
                  color: color.faint,
                  textTransform: 'uppercase',
                  letterSpacing: '1px',
                  padding: '8px 4px 4px',
                }}>
                  Sessions
                </div>
                {filteredOrphanSessions.map((s) => (
                  <SessionRow
                    key={s.handle}
                    session={s}
                    onSession={onSession}
                  />
                ))}
              </>
            )}

            {/* Away users (humans) */}
            {humanAway.length > 0 && (
              <>
                {sectionCount > 1 && (
                  <div style={{
                    fontSize: '9px',
                    fontWeight: 600,
                    color: color.faint,
                    textTransform: 'uppercase',
                    letterSpacing: '1px',
                    padding: '8px 4px 4px',
                  }}>
                    Away · {humanAway.length}
                  </div>
                )}
                {humanAway.map((user) => (
                  <UserRow
                    key={user.handle}
                    user={user}
                    onClick={() => onUserClick(user.handle)}
                    thread={threadMap.get(user.handle)}
                    onArchive={archiveFor(threadMap.get(user.handle))}
                    isPaired={user.handle === pairedWith}
                      onSessionView={user.handle === pairedWith && onSession ? () => onSession(user.handle) : undefined}
                    myHandle={handle}
                    showDetails={showDetails}
                  />
                ))}
              </>
            )}

            {/* Agents — Seth's fleet, corralled into their own labeled lane so
                they stop dominating the human presence board. Always labeled. */}
            {laneAgents.length > 0 && (
              <>
                <div style={{
                  fontSize: '9px',
                  fontWeight: 600,
                  color: color.faint,
                  textTransform: 'uppercase',
                  letterSpacing: '1px',
                  padding: '8px 4px 4px',
                }}>
                  Agents · {laneAgents.length}
                </div>
                {laneAgents.map((user) => {
                  return (
                    <div key={user.handle}>
                      <UserRow
                        user={user}
                        onClick={() => onUserClick(user.handle)}
                        onSummon={summonable.has(user.handle.toLowerCase()) ? () => setSummonTarget(user.handle) : undefined}
                        thread={threadMap.get(user.handle)}
                        onArchive={archiveFor(threadMap.get(user.handle))}
                        isPaired={user.handle === pairedWith}
                      onSessionView={user.handle === pairedWith && onSession ? () => onSession(user.handle) : undefined}
                        myHandle={handle}
                        showDetails={showDetails}
                      />
                      {boundSessionBlock(user.handle)}
                    </div>
                  );
                })}
              </>
            )}

            {/* Offline threads */}
            {filteredOffline.length > 0 && (
              <>
                {sectionCount > 1 && (
                  <div style={{
                    fontSize: '9px',
                    fontWeight: 600,
                    color: color.faint,
                    textTransform: 'uppercase',
                    letterSpacing: '1px',
                    padding: '8px 4px 4px',
                  }}>
                    Recent · {filteredOffline.length}
                  </div>
                )}
                {visibleOffline.map((thread) => (
                  <OfflineThreadRow
                    key={thread.with}
                    thread={thread}
                    onClick={() => onUserClick(thread.with)}
                    myHandle={handle}
                    onArchive={archiveFor(thread)}
                  />
                ))}
                {!q && filteredOffline.length > RECENT_COLLAPSED_LIMIT && (
                  <div
                    className="vibe-press"
                    role="button"
                    tabIndex={0}
                    aria-expanded={recentExpanded}
                    onKeyDown={pressOnKey(() => setRecentExpanded((v) => !v))}
                    onClick={() => setRecentExpanded((v) => !v)}
                    style={{
                      fontSize: '10px',
                      color: color.faint,
                      cursor: 'pointer',
                      padding: '6px 4px 4px',
                      textAlign: 'center',
                      transition: 'color 0.15s ease',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = color.blue)}
                    onMouseLeave={(e) => (e.currentTarget.style.color = color.faint)}
                  >
                    {recentExpanded
                      ? 'Show less'
                      : `Show all ${filteredOffline.length}`}
                  </div>
                )}
              </>
            )}

            {/* No search matches. When the query LOOKS like a handle, the
                dead end becomes the first-message door (buddy#53): one
                action that opens the normal composer with nothing sent.
                This claims nothing about the handle — existence is decided
                at send, where the server refuses recipient_not_found (and
                its lookup fails open, so nothing is ever "verified"). A
                thread reaches RECENT only after a stored-message receipt,
                because the thread list is server-served. */}
            {noMatches && (
              <div style={{
                textAlign: 'center',
                color: color.faint,
                padding: '24px 16px 8px',
                fontSize: '12px',
              }}>
                Nobody here matches “{query.trim()}”
              </div>
            )}
            {firstMessageFallback}


            {/* Invite link — always at bottom when list is small */}
            {!showDetails && (
              <div style={{
                textAlign: 'center',
                padding: '16px 12px 8px',
              }}>
                <span
                  onClick={copyInviteLink}
                  style={{
                    fontSize: '11px',
                    color: inviteCopyState ? color.dim : color.faint,
                    cursor: 'pointer',
                    transition: 'color 0.2s ease',
                  }}
                >
                  {inviteCopyState === 'copied'
                    ? 'Copied!'
                    : inviteCopyState === 'failed'
                      ? 'Copy failed'
                      : 'Invite someone to /vibe'}
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
