/**
 * Server-sent events over an AUTHENTICATED request.
 *
 * The live stream used to be a native EventSource on
 * `/api/v2/messages/stream?token=<JWT>`: EventSource cannot send headers, so
 * the session token rode in the URL, where hosting and proxy access logs keep
 * it. The platform's stream route already accepts `Authorization: Bearer`
 * (api/v2/messages/stream.js reads the header first, the query second), and
 * the Tauri HTTP plugin (2.5.x) streams a response body chunk by chunk — so
 * the same events arrive with the token in a header and the URL carries none.
 *
 * The parser is the subset of the SSE format the platform sends: `event:`,
 * `data:` (multi-line joined with \n), `id:`, comments, CRLF or LF, an event
 * dispatched at a blank line. Unknown fields are ignored, as the spec says.
 */
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

export interface SseEvent { event: string; data: string; id?: string }

/** Pure, incremental SSE parser: feed text as it arrives. */
export function createSseParser(onEvent: (e: SseEvent) => void): (chunk: string) => void {
  let buffer = '';
  let event = '';
  let data: string[] = [];
  let id: string | undefined;
  const dispatch = () => {
    if (data.length) onEvent({ event: event || 'message', data: data.join('\n'), ...(id !== undefined ? { id } : {}) });
    event = ''; data = [];
  };
  return (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.search(/\r\n|\n|\r/)) !== -1) {
      const line = buffer.slice(0, nl);
      const sepLen = buffer.startsWith('\r\n', nl) ? 2 : 1;
      // A lone trailing \r may be the first half of \r\n: wait for more.
      if (buffer[nl] === '\r' && sepLen === 1 && nl === buffer.length - 1) break;
      buffer = buffer.slice(nl + sepLen);
      if (line === '') { dispatch(); continue; }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
      else if (field === 'id') id = value;
    }
  };
}

export interface SseHandlers {
  onOpen: () => void;
  onEvent: (e: SseEvent) => void;
  /** The stream failed or ended. Called at most once per connection. */
  onError: () => void;
}

/**
 * Open the stream. The token goes ONLY in the Authorization header.
 * Returns a closer; closing never calls onError.
 */
export function openAuthedEventStream(
  url: string,
  token: string,
  handlers: SseHandlers,
  fetchImpl: typeof tauriFetch = tauriFetch,
): () => void {
  const controller = new AbortController();
  let closed = false;
  let failed = false;
  const fail = () => {
    if (closed || failed) return;
    failed = true;
    handlers.onError();
  };
  void (async () => {
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream', 'Cache-Control': 'no-cache' },
        signal: controller.signal,
      });
      const type = res.headers?.get?.('content-type') || '';
      if (!res.ok || !res.body || !type.includes('text/event-stream')) { fail(); return; }
      if (closed) return;
      handlers.onOpen();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const feed = createSseParser((e) => { if (!closed) handlers.onEvent(e); });
      for (;;) {
        const { value, done } = await reader.read();
        if (closed) return;
        if (done) break;
        feed(decoder.decode(value, { stream: true }));
      }
      fail(); // the server ended the stream: reconnect like EventSource would
    } catch {
      fail();
    }
  })();
  return () => {
    closed = true;
    controller.abort();
  };
}
