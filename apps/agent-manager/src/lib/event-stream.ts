// Connect to AWB's SSE /api/events/stream and route events through
// EventDispatcher. Reconnects with exponential backoff.
//
// AWB SSE event types (from events.controller.ts):
//   - board_update:     ticket/comment CRUD
//   - agent_trigger:    trigger assigned to agent
//   - chat_request:     chat session request
//   - chat_room_message: chat room message
//   - comment_mention:  user @-mentioned this agent
//   - fs_request:       remote fs operation request
//   - agent_typing:     ignored
//
// Responsibilities are narrow by design:
//   - HTTP fetch + AbortController + reconnect backoff
//   - SSE line parsing (event: / data: / blank-line terminator)
//   - Handing each (eventType, raw) pair to the injected EventDispatcher
//
// Dispatch decisions live in EventDispatcher.

import { networkInterfaces } from 'node:os';
import { RECONNECT_INITIAL_MS, RECONNECT_MAX_MS } from './constants.js';
import { log } from './logging.js';
import {
  EventDispatcher,
  type EventDispatcherDeps,
} from './event-dispatcher.js';
import type { AwbConfig } from './rest.js';

/**
 * Best-effort local IP. Picks the first non-internal IPv4 address across
 * all NICs. Server prefers this over its own x-real-ip / x-forwarded-for
 * inference because reverse proxies obscure the true peer.
 */
function detectLocalIp(): string {
  try {
    const ifaces = networkInterfaces();
    for (const list of Object.values(ifaces)) {
      if (!list) continue;
      for (const addr of list) {
        if (addr.family === 'IPv4' && !addr.internal) return addr.address;
      }
    }
  } catch {
    /* fall through */
  }
  return 'unknown';
}

export interface EventStreamOptions {
  config: AwbConfig;
  deps?: EventDispatcherDeps;
  pluginVersion?: string;
  onConnect?: (() => void) | null;
}

/** Incremental SSE field-parser state. Carried across `feedSse` calls so a
 *  field split over two network chunks parses correctly, and so the `id` /
 *  `event` fields persist with spec semantics. Exported with `feedSse` so the
 *  pure parsing — including Last-Event-ID tracking — is unit-testable without
 *  a live socket. */
export interface SseParseState {
  buffer: string;
  eventType: string;
  /** Current `id` field — persists across events until a new `id:` line
   *  changes it (empty `id:` resets it), per the SSE spec. */
  currentId: string;
  /** Id of the last event actually dispatched (had a non-empty `data:`).
   *  This is what a reconnect replays via `Last-Event-ID`. */
  lastEventId: string;
}

export function newSseParseState(lastEventId = ''): SseParseState {
  return { buffer: '', eventType: '', currentId: lastEventId, lastEventId };
}

/**
 * Feed one decoded chunk of an SSE stream into `state` and return the
 * complete events that became dispatchable from it. Pure aside from mutating
 * `state` (the carry-over buffer + field registers). Mirrors the WHATWG SSE
 * line algorithm for the subset AWB uses: `event:`, `id:`, `data:`, and the
 * blank-line terminator. `state.lastEventId` is advanced to the dispatched
 * event's id so the caller can replay it on reconnect.
 */
export function feedSse(
  state: SseParseState,
  chunk: string,
): Array<{ eventType: string; data: string }> {
  state.buffer += chunk;
  const lines = state.buffer.split('\n');
  state.buffer = lines.pop() ?? '';
  const out: Array<{ eventType: string; data: string }> = [];
  for (const line of lines) {
    if (line.startsWith('event: ')) {
      state.eventType = line.slice(7).trim();
    } else if (line.startsWith('id:')) {
      // `id:` or `id: <value>` — one optional leading space per spec.
      state.currentId = line.slice(3).replace(/^ /, '');
    } else if (line.startsWith('data: ')) {
      const data = line.slice(6).trim();
      if (data) {
        state.lastEventId = state.currentId;
        out.push({ eventType: state.eventType, data });
      }
      state.eventType = '';
    } else if (line === '') {
      state.eventType = '';
    }
  }
  return out;
}

export class EventStream {
  #url: string;
  #retryDelay = RECONNECT_INITIAL_MS;
  #abortController: AbortController | null = null;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #stopped = false;
  #dispatcher: EventDispatcher;
  #onConnect: (() => void) | null;
  #pluginVersion: string;
  /** Id of the last SSE event we dispatched. Replayed to the server via the
   *  standard `Last-Event-ID` header on every (re)connect so a server that
   *  supports resume picks up exactly after it — avoiding the re-delivery of
   *  events the manager already processed when a flaky network bounces the
   *  stream. The current AWB server (NestJS `@Sse`, a live rxjs Subject) does
   *  not emit `id:` lines or honor the header yet, so this is forward-
   *  compatible plumbing today; it stays a no-op until the server stamps ids,
   *  and the dispatch-side trigger/inflight dedup remains the live guard
   *  against duplicate processing in the meantime. */
  #lastEventId = '';

  constructor(opts: EventStreamOptions) {
    const { config, deps = {}, pluginVersion = 'unknown', onConnect = null } = opts;
    this.#url = `${config.url.replace(/\/$/, '')}/api/events/stream?token=${encodeURIComponent(config.apiKey)}`;
    this.#dispatcher = new EventDispatcher(config, deps);
    this.#onConnect = onConnect;
    this.#pluginVersion = pluginVersion;
  }

  start(): void {
    this.#stopped = false;
    void this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#abortController?.abort();
  }

  /**
   * ticket d34075b5 — re-drive any queued shared-pool `pool_exhausted` retries in
   * the dispatcher. main.ts calls this from the periodic/boot pool-lease reconcile
   * the moment a leaked lease is reclaimed (a slot just freed), so a starved
   * dispatch recovers immediately instead of waiting out its backoff. Thin
   * passthrough — the dispatcher owns the retry queue.
   */
  wakePoolRetries(reason: string): void {
    this.#dispatcher.wakePoolRetries(reason);
  }

  /**
   * ticket 467f714a — record a recognized harness session-limit exit (opens the
   * per-agent defer window in the dispatcher). main.ts wires the ticket-session /
   * one-shot exit handlers to this, so a `You've hit your session limit · resets …`
   * death defers the agent's dispatch until the reset instant. Thin passthrough —
   * the dispatcher owns the durable defer store.
   */
  recordHarnessSessionLimit(info: {
    agentId: string;
    // ticket 467f714a blocker #1: the dead task's (ticket, role) so the dispatcher
    // can seed it as a durable pending intent (replays even with no later trigger).
    ticketId?: string;
    role?: string;
    deferUntilMs: number;
    reason?: string;
    resetLabel?: string;
  }): void {
    this.#dispatcher.recordHarnessSessionLimit(info);
  }

  /**
   * Force-drop the current SSE connection and reconnect immediately. Used by
   * `agent_manager_command spawn_agent` so the server-side `managedAgentIds`
   * snapshot (cached once at SSE connect — see events.controller.ts) is
   * recomputed and includes the freshly-registered managed agent. Without
   * this, the next `chat_request` / `agent_trigger` / `comment_mention` for
   * that agent is silently filtered out on the server, and no subagent ever
   * spawns.
   *
   * Returns a Promise that resolves once the fresh SSE connection is
   * established (HTTP 200 received). spawn_agent awaits this so the ack
   * POST only fires after the server's managedAgentIds cache includes the
   * new agent — closing the race window where a chat message arriving
   * between ack and reconnect would be silently dropped.
   *
   * Handles three concurrent states cleanly:
   *   - active connect → abort the fetch/reader, the catch swallows AbortError.
   *   - waiting in backoff → clear the pending timer.
   *   - already stopped → resolves immediately (no-op).
   * A fresh #connect() is then scheduled on the next tick.
   */
  reconnect(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    log('SSE forced reconnect (managedAgentIds refresh)');
    this.#retryDelay = RECONNECT_INITIAL_MS;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    const prev = this.#abortController;
    this.#abortController = null;
    prev?.abort();

    return new Promise<void>((resolve) => {
      const origOnConnect = this.#onConnect;
      this.#onConnect = () => {
        this.#onConnect = origOnConnect;
        try { origOnConnect?.(); } catch { /* hook errors must not block */ }
        resolve();
      };
      setImmediate(() => void this.#connect());
      // Safety net: resolve after 10s even if the connection fails to
      // establish, so spawn_agent ack is never blocked indefinitely.
      setTimeout(() => resolve(), 10_000).unref?.();
    });
  }

  async #connect(): Promise<void> {
    if (this.#stopped) return;

    try {
      this.#abortController = new AbortController();
      const headers: Record<string, string> = {
        Accept: 'text/event-stream',
        'X-Plugin-Ip': detectLocalIp(),
        'X-Plugin-Version': this.#pluginVersion,
      };
      // Resume hint — only sent once we've actually seen an id, so a cold
      // start doesn't send an empty header.
      if (this.#lastEventId) headers['Last-Event-ID'] = this.#lastEventId;
      const resp = await fetch(this.#url, {
        headers,
        signal: this.#abortController.signal,
      });

      if (!resp.ok) {
        log(`SSE error: ${resp.status} ${resp.statusText}`);
        this.#scheduleReconnect();
        return;
      }
      if (!resp.body) {
        log('SSE error: response body is null');
        this.#scheduleReconnect();
        return;
      }

      log('SSE connected');
      this.#retryDelay = RECONNECT_INITIAL_MS;
      try {
        this.#onConnect?.();
      } catch {
        /* hook errors must not block stream read */
      }
      await this.#readStream(resp.body);

      log('SSE stream ended, reconnecting...');
      this.#scheduleReconnect();
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      log(`SSE error: ${err?.message ?? err}`);
      this.#scheduleReconnect();
    }
  }

  async #readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    // Seed the parser with the id we carried in so a mid-stream reset is the
    // only thing that clears it; `state.lastEventId` keeps advancing as events
    // dispatch and we mirror it back onto `#lastEventId` for the next connect.
    const state = newSseParseState(this.#lastEventId);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const events = feedSse(state, decoder.decode(value, { stream: true }));
      for (const { eventType, data } of events) {
        const result = this.#dispatcher.dispatch(eventType, data);
        if (result instanceof Promise) {
          result.catch((err) =>
            log(`dispatch(${eventType}) rejected: ${err?.message ?? err}`),
          );
        }
      }
      // Mirror the parser's running id back so the next (re)connect replays
      // after the last event we dispatched.
      this.#lastEventId = state.lastEventId;
    }
  }

  #scheduleReconnect(): void {
    if (this.#stopped) return;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#connect();
    }, this.#retryDelay);
    this.#retryDelay = Math.min(this.#retryDelay * 1.5, RECONNECT_MAX_MS);
  }
}
