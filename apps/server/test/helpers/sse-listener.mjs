// Generic event-type-agnostic SSE listener for QA tests.
//
// The existing chat-roundtrip test has a chat_message-only listener. This
// listener is the generalized version: buffers every non-ping/non-meta frame
// with its event name and supports predicate waiters scoped by event type.
//
// Auth: the /api/events/stream endpoint accepts EITHER a user session token
// OR an agent API key via ?token= query param (events.controller.ts:108-140),
// so the same helper serves both user and virtual-agent subscribers.

async function* parseSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const current = { event: 'message', data: '' };
      for (const rawLine of frame.split('\n')) {
        const line = rawLine.replace(/\r$/, '');
        if (!line || line.startsWith(':')) continue;
        const colonIdx = line.indexOf(':');
        const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
        let val = colonIdx === -1 ? '' : line.slice(colonIdx + 1);
        if (val.startsWith(' ')) val = val.slice(1);
        if (field === 'event') current.event = val;
        else if (field === 'data') {
          current.data = current.data ? current.data + '\n' + val : val;
        }
      }
      yield current;
    }
  }
}

/**
 * Open an authenticated SSE stream and return a handle with:
 *   - waitFor(event?, predicate?, timeoutMs?) → Promise<{event,data}>
 *   - drainOfType(event, windowMs)            → Promise<frames[]>
 *   - snapshot()                              → frames[] (copy)
 *   - close(), isClosed()
 *
 * All buffered frames stay in a FIFO. waitFor scans the buffer first, then
 * waits for future frames if nothing matches yet. Keepalive `ping` and
 * `server_meta` frames are silently dropped (they're not meaningful to tests).
 */
export async function openSseStream(port, token, { boardId, onFrame } = {}) {
  const abort = new AbortController();
  const qs = new URLSearchParams({ token });
  if (boardId) qs.set('boardId', boardId);
  const res = await fetch(`http://localhost:${port}/api/events/stream?${qs}`, {
    headers: { Accept: 'text/event-stream' },
    signal: abort.signal,
  });
  if (!res.ok) throw new Error(`SSE fetch failed: HTTP ${res.status}`);

  const buffered = []; // { event, data }
  const waiters = []; // { event, predicate, resolve, reject }
  let closed = false;
  let streamError = null;

  (async () => {
    try {
      for await (const frame of parseSse(res)) {
        if (frame.event === 'ping' || frame.event === 'server_meta') continue;
        let parsed;
        try {
          parsed = JSON.parse(frame.data);
        } catch {
          parsed = frame.data;
        }
        const item = { event: frame.event, data: parsed };
        if (onFrame) {
          try {
            onFrame(item);
          } catch {
            // swallow — tests assert on state, not on callback exceptions
          }
        }
        // Try matching a waiter in FIFO order. First match wins.
        let consumed = false;
        for (let i = 0; i < waiters.length; i++) {
          const w = waiters[i];
          if (w.event && w.event !== frame.event) continue;
          if (!w.predicate || w.predicate(parsed, frame.event)) {
            waiters.splice(i, 1);
            w.resolve(item);
            consumed = true;
            break;
          }
        }
        if (!consumed) buffered.push(item);
      }
    } catch (e) {
      streamError = e;
    } finally {
      closed = true;
      while (waiters.length) {
        const w = waiters.shift();
        w.reject(streamError || new Error('SSE stream closed'));
      }
    }
  })();

  function waitFor(event, predicate = () => true, timeoutMs = 5000) {
    for (let i = 0; i < buffered.length; i++) {
      const it = buffered[i];
      if (event && it.event !== event) continue;
      if (predicate(it.data, it.event)) {
        buffered.splice(i, 1);
        return Promise.resolve(it);
      }
    }
    if (closed) return Promise.reject(streamError || new Error('SSE stream already closed'));
    return new Promise((resolve, reject) => {
      const w = { event, predicate, resolve, reject };
      waiters.push(w);
      const t = setTimeout(() => {
        const idx = waiters.indexOf(w);
        if (idx !== -1) waiters.splice(idx, 1);
        const seen = buffered.map((b) => b.event).join(',') || 'none';
        reject(
          new Error(
            `Timeout waiting for SSE event${event ? ` '${event}'` : ''} (${timeoutMs}ms). Buffered so far: ${seen}`,
          ),
        );
      }, timeoutMs);
      t.unref();
    });
  }

  function drainOfType(event, windowMs = 500) {
    return new Promise((resolve) => {
      const startLen = buffered.length;
      const t = setTimeout(() => {
        const slice = buffered.slice(startLen).filter((b) => b.event === event);
        resolve(slice);
      }, windowMs);
      t.unref();
    });
  }

  return {
    waitFor,
    drainOfType,
    snapshot: () => buffered.slice(),
    close: () => {
      try {
        abort.abort();
      } catch {
        /* ignore */
      }
    },
    isClosed: () => closed,
  };
}
