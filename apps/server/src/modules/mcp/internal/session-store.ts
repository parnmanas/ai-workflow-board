/**
 * Unified MCP session store.
 *
 * Merges the transport-session map (previously duplicated between
 * mcp-server.ts and mcp.controller.ts) with the agent-auth context map
 * (previously a standalone `sessionAuthMap` inside mcp-tools.ts) into a
 * single source of truth with a shared 10-minute idle TTL.
 *
 * Bug fix (Phase 2 C3): the old `sessionAuthMap` had no TTL — entries were
 * only removed when an explicit sessionClose notification ran. If a client
 * disconnected abnormally and the transport.onclose handler was missed, the
 * auth entry leaked forever. With the unified store every entry (transport,
 * server, auth) is tied to the same `lastActivity` timestamp and is purged
 * by the same cleanup pass.
 *
 * The singleton `sessionStore` is safe to import from multiple entry points
 * (standalone mcp-server.ts HTTP mode + NestJS McpController). Its cleanup
 * timer is started lazily via `ensureCleanupStarted()` and is idempotent —
 * the first caller wins and subsequent calls short-circuit, so the interval
 * can never be double-registered even if both entry points run in the same
 * process (e.g. during tests). The interval is `.unref()`'d so it never
 * keeps the Node.js event loop alive on its own.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

export interface McpAgentContext {
  agentId?: string;
  agentName?: string;
  scope?: string;
  source: 'db' | 'env' | 'dev-mode';
}

interface SessionEntry {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
  auth?: McpAgentContext;
  lastActivity: number;
}

/**
 * Invoked for each session evicted by the idle-cleanup pass, after the
 * entry has already been removed from the store and transport.close() has
 * been fired. Use for downstream side effects (agent offline marking,
 * additional logging).
 */
export type SessionEvictionHook = (sessionId: string, entry: SessionEntry) => void;

export const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes idle timeout
const CLEANUP_INTERVAL_MS = 2 * 60 * 1000;    // sweep every 2 minutes

class SessionStore {
  private sessions = new Map<string, SessionEntry>();
  private evictionHooks: SessionEvictionHook[] = [];
  private cleanupTimer: NodeJS.Timeout | null = null;
  private cleanupReporter: ((removed: number, remaining: number) => void) | null = null;

  /** Register a new session's transport + server. Auth may be attached now or later. */
  register(
    sessionId: string,
    transport: WebStandardStreamableHTTPServerTransport,
    server: McpServer,
    auth?: McpAgentContext,
  ): void {
    this.sessions.set(sessionId, {
      transport,
      server,
      auth,
      lastActivity: Date.now(),
    });
  }

  /** Attach or replace auth context for an existing session. */
  setAuth(sessionId: string, auth: McpAgentContext): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.auth = auth;
    }
  }

  /** Retrieve auth context — used by MCP tool handlers to identify the caller. */
  getAuth(sessionId: string): McpAgentContext | undefined {
    return this.sessions.get(sessionId)?.auth;
  }

  /** Remove only the auth context, leaving transport/server in place. */
  removeAuth(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.auth = undefined;
    }
  }

  /** Mark the session as recently active (resets TTL). */
  touch(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) entry.lastActivity = Date.now();
  }

  get(sessionId: string): SessionEntry | undefined {
    return this.sessions.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Remove a session entirely (transport + server + auth). Does NOT close transport. */
  remove(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /**
   * True iff any currently-registered session carries the given agentId in its
   * auth context. Used by the eviction hook to avoid marking an agent offline
   * when a stale session idles out but other live sessions for the same agent
   * (e.g. from a reconnect) are still active.
   */
  hasAgentSession(agentId: string): boolean {
    for (const entry of this.sessions.values()) {
      if (entry.auth?.agentId === agentId) return true;
    }
    return false;
  }

  /** Register a hook to run after each idle-cleanup eviction. */
  onEviction(hook: SessionEvictionHook): void {
    this.evictionHooks.push(hook);
  }

  /**
   * Lazily start the idle-cleanup timer. Idempotent — first call wins.
   * Subsequent calls update the reporter but never double-register the interval.
   */
  ensureCleanupStarted(reporter?: (removed: number, remaining: number) => void): void {
    if (reporter) this.cleanupReporter = reporter;
    if (this.cleanupTimer) return;

    const timer = setInterval(() => this.runCleanup(), CLEANUP_INTERVAL_MS);
    // Don't let the cleanup timer keep the event loop alive on its own.
    if (typeof timer.unref === 'function') timer.unref();
    this.cleanupTimer = timer;
  }

  private runCleanup(): void {
    const now = Date.now();
    const evicted: Array<[string, SessionEntry]> = [];
    for (const [sid, entry] of this.sessions) {
      if (now - entry.lastActivity > SESSION_TTL_MS) {
        evicted.push([sid, entry]);
      }
    }
    for (const [sid, entry] of evicted) {
      this.sessions.delete(sid);
      entry.transport.close().catch(() => {});
      for (const hook of this.evictionHooks) {
        try { hook(sid, entry); } catch { /* hook errors are swallowed to protect other sessions */ }
      }
    }
    if (evicted.length > 0 && this.cleanupReporter) {
      this.cleanupReporter(evicted.length, this.sessions.size);
    }
  }
}

export const sessionStore = new SessionStore();
