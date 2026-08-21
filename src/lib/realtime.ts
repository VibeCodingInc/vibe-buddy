// Realtime message layer — SSE primary, polling fallback
//
// Connects to /api/v2/messages/stream for live events.
// Falls back to adaptive polling if SSE fails.

import { buddyClient, type VibeMessage, type VibeThread } from './vibeClient';

const API_URL = 'https://www.slashvibe.dev/api';

type MessageCallback = (messages: VibeMessage[]) => void;
type ThreadCallback = (threads: VibeThread[]) => void;
type TypingCallback = (from: string) => void;
type LiveCallback = (handle: string, isLive: boolean, roomId?: string) => void;

export interface RealtimeEvent {
  type: 'message' | 'typing' | 'read' | 'live' | 'live_ended' | 'fork' | 'follow' | 'ping';
  data: any;
}

class RealtimeMessages {
  private handle: string | null = null;
  private dmTarget: string | null = null;
  private onMessages: MessageCallback | null = null;
  // Incremented whenever the open thread changes, so an in-flight fetch can
  // tell that it belongs to a conversation the user has already left.
  private dmGeneration = 0;
  private onThreads: ThreadCallback | null = null;
  private onTyping: TypingCallback | null = null;
  private onLive: LiveCallback | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private mode: 'dm' | 'inbox' | 'background' = 'background';
  private eventSource: EventSource | null = null;
  private sseConnected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;

  // Polling intervals (used as fallback)
  private readonly POLL_DM = 3000;
  private readonly POLL_INBOX = 8000;
  private readonly POLL_BG = 30000;

  init(handle: string) {
    this.handle = handle;
  }

  /**
   * Whether the live (SSE) stream is currently up. When false, Buddy is on the
   * polling fallback — not offline, but not live either. Read for diagnostics
   * (G6); it is a fact about the transport, not about presence.
   */
  isLiveConnected(): boolean {
    return this.sseConnected;
  }

  /**
   * Connect to SSE stream for live events
   */
  connectSSE() {
    if (!this.handle) return;

    const token = buddyClient.getAuthToken();
    if (!token) {
      // No token yet — fall back to polling
      this.startPolling();
      return;
    }

    this.disconnectSSE();

    const url = `${API_URL}/v2/messages/stream?token=${encodeURIComponent(token)}`;
    this.eventSource = new EventSource(url);

    this.eventSource.onopen = () => {
      this.sseConnected = true;
      this.reconnectDelay = 1000;
      // SSE is live — stop polling
      this.stopPolling();
    };

    this.eventSource.addEventListener('message', (e) => {
      try {
        const data = JSON.parse(e.data);
        this.handleSSEEvent({ type: 'message', data });
      } catch {}
    });

    this.eventSource.addEventListener('typing', (e) => {
      try {
        const data = JSON.parse(e.data);
        this.handleSSEEvent({ type: 'typing', data });
      } catch {}
    });

    this.eventSource.addEventListener('read', (e) => {
      try {
        const data = JSON.parse(e.data);
        this.handleSSEEvent({ type: 'read', data });
      } catch {}
    });

    this.eventSource.addEventListener('live', (e) => {
      try {
        const data = JSON.parse(e.data);
        this.handleSSEEvent({ type: 'live', data });
      } catch {}
    });

    this.eventSource.addEventListener('live_ended', (e) => {
      try {
        const data = JSON.parse(e.data);
        this.handleSSEEvent({ type: 'live_ended', data });
      } catch {}
    });

    this.eventSource.onerror = () => {
      this.sseConnected = false;
      this.disconnectSSE();
      // Fall back to polling immediately
      this.startPolling();
      // Try to reconnect SSE with backoff
      this.scheduleReconnect();
    };
  }

  private handleSSEEvent(event: RealtimeEvent) {
    switch (event.type) {
      case 'message': {
        // A new message arrived — refresh the current view
        if (this.mode === 'dm' && this.dmTarget) {
          this.pollDM();
        } else if (this.mode === 'inbox') {
          this.pollInbox();
        }
        break;
      }
      case 'typing': {
        const from = event.data?.from || event.data?.handle;
        if (from && this.onTyping) {
          this.onTyping(from);
        }
        break;
      }
      case 'live': {
        if (this.onLive) {
          this.onLive(event.data.handle, true, event.data.roomId);
        }
        break;
      }
      case 'live_ended': {
        if (this.onLive) {
          this.onLive(event.data.handle, false);
        }
        break;
      }
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.connectSSE();
    }, this.reconnectDelay);
    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  disconnectSSE() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.sseConnected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Open a DM channel — fast polling for this thread (or SSE handles it)
   */
  openDM(target: string, cb: MessageCallback) {
    // Bump the generation: any DM fetch already in flight belongs to the
    // PREVIOUS thread and must not be delivered to this one's callback.
    this.dmGeneration += 1;
    this.dmTarget = target;
    this.onMessages = cb;
    this.mode = 'dm';
    if (!this.sseConnected) {
      this.restartPolling();
    }
    // Always do an immediate fetch
    this.pollDM();
  }

  /**
   * Open inbox — medium polling for thread list
   */
  openInbox(cb: ThreadCallback) {
    this.dmTarget = null;
    this.onMessages = null;
    this.onThreads = cb;
    this.mode = 'inbox';
    if (!this.sseConnected) {
      this.restartPolling();
    }
    this.pollInbox();
  }

  /**
   * Set typing callback — fires when remote user is typing
   */
  setTypingCallback(cb: TypingCallback | null) {
    this.onTyping = cb;
  }

  /**
   * Set live status callback
   */
  setLiveCallback(cb: LiveCallback | null) {
    this.onLive = cb;
  }

  /**
   * Go to background — slow polling
   */
  goBackground() {
    this.dmTarget = null;
    this.onMessages = null;
    this.onThreads = null;
    this.mode = 'background';
    if (!this.sseConnected) {
      this.restartPolling();
    }
  }

  /**
   * Re-establish the transport after a sleep/network gap, WITHOUT tearing down
   * what the UI is subscribed to.
   *
   * Wake handling used to call stop() then connectSSE(). stop() is written for
   * logout — it drops dmTarget, both callbacks, and resets mode to background.
   * But on wake the DM panel is still mounted, so its subscribe effect does not
   * rerun: the stream came back in background mode with no target and no
   * callback, message events had nothing to deliver to, and background polling
   * fetches nothing. The open conversation went permanently silent until the
   * user navigated away and back — after any laptop sleep, which is every day.
   *
   * The generation bump stays: anything still in flight from before the gap is
   * stale and must not land. The subscription itself is what has to survive.
   */
  reconnect() {
    this.dmGeneration += 1;
    this.stopPolling();
    this.disconnectSSE();
    this.connectSSE();
    this.restartPolling();
  }

  /**
   * Stop everything
   */
  stop() {
    // Invalidate in-flight fetches and drop the listeners: stop() runs on
    // logout, so anything still resolving belongs to the account that left.
    this.dmGeneration += 1;
    this.dmTarget = null;
    this.onMessages = null;
    this.onThreads = null;
    this.mode = 'background';
    this.stopPolling();
    this.disconnectSSE();
  }

  isConnected(): boolean {
    return this.sseConnected;
  }

  // Polling (fallback when SSE is down)
  private startPolling() {
    if (this.timer) return; // already polling
    this.restartPolling();
  }

  private stopPolling() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private restartPolling() {
    this.stopPolling();

    const interval = this.mode === 'dm' ? this.POLL_DM
      : this.mode === 'inbox' ? this.POLL_INBOX
      : this.POLL_BG;

    this.timer = setInterval(() => {
      if (this.mode === 'dm') this.pollDM();
      else if (this.mode === 'inbox') this.pollInbox();
    }, interval);
  }

  /**
   * Fetch the open thread.
   *
   * `dmTarget` and `onMessages` are singleton fields that openDM() overwrites,
   * so a fetch that started for Alice used to resolve and hand Alice's
   * messages to whatever callback was current — Bob's, or the next account's
   * after a sign-out. DMPanel then cached the wrong person's conversation
   * under Bob's key. Capture the identity of THIS request and drop the result
   * unless every part of it still matches.
   */
  private async pollDM() {
    if (!this.handle || !this.dmTarget || !this.onMessages) return;
    const generation = this.dmGeneration;
    const handle = this.handle;
    const target = this.dmTarget;
    const cb = this.onMessages;

    const result = await buddyClient.getThreadResult(target);

    if (
      generation !== this.dmGeneration ||
      handle !== this.handle ||
      target !== this.dmTarget ||
      cb !== this.onMessages
    ) {
      return; // stale: the thread, the account, or the listener moved on
    }
    // Failure is not an empty conversation. Calling back with [] here makes
    // DMPanel erase the visible thread and overwrite its last-good cache.
    if (!result.error) cb(result.messages);
  }

  private async pollInbox() {
    if (!this.handle || !this.onThreads) return;
    const threads = await buddyClient.getThreadList();
    this.onThreads(threads);
  }
}

export const realtime = new RealtimeMessages();
