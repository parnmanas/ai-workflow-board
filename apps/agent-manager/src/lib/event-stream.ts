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

export class EventStream {
  #url: string;
  #retryDelay = RECONNECT_INITIAL_MS;
  #abortController: AbortController | null = null;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #stopped = false;
  #dispatcher: EventDispatcher;
  #onConnect: (() => void) | null;
  #pluginVersion: string;

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
      const resp = await fetch(this.#url, {
        headers: {
          Accept: 'text/event-stream',
          'X-Plugin-Ip': detectLocalIp(),
          'X-Plugin-Version': this.#pluginVersion,
        },
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
    let buffer = '';
    let eventType = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data) {
            const result = this.#dispatcher.dispatch(eventType, data);
            if (result instanceof Promise) {
              result.catch((err) =>
                log(`dispatch(${eventType}) rejected: ${err?.message ?? err}`),
              );
            }
          }
          eventType = '';
        } else if (line === '') {
          eventType = '';
        }
      }
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
