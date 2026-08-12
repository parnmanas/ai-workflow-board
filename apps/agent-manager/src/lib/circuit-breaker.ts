// Circuit-Breaker for non-transient agent failures.
//
// Tracks consecutive silent exits per (agent, ticket, role) key and blocks
// re-dispatch after a configurable threshold. Distinguishes transient exit
// codes (143/SIGTERM from zombie reap) from non-transient ones (missing
// auth/config — e.g. gemini exit 41). When the breaker opens, the caller
// should pend_ticket so the ticket surfaces on the User tab for operator
// attention.
//
// State is in-memory only — a manager restart resets all breakers, which is
// acceptable: the supervisor will re-trigger, and if the config error
// persists, the breaker re-opens within N spawns. No persistence file needed
// because the failure reproduces deterministically.

import { log } from './logging.js';

/** Exit codes considered transient (agent was killed externally, not a
 *  config/auth problem). These DO NOT count toward the circuit-breaker
 *  threshold — the agent should be re-dispatched normally. */
const TRANSIENT_EXIT_CODES = new Set([
  143, // SIGTERM — zombie-subagent reap, restart_agent, idle timeout
  137, // SIGKILL — OOM-killer, manual kill, force stop
  130, // SIGINT — ctrl-c propagation
]);

/** Default: open the breaker after this many consecutive non-transient
 *  silent exits for the same (agent, ticket, role). A single successful
 *  response (the agent posts a comment / clean-exits) calls reset() and
 *  clears the counter — only 5 *consecutive* failures pend the ticket. */
const DEFAULT_THRESHOLD = 5;

/** After the breaker opens, how long to block re-dispatch before allowing
 *  one "half-open" probe attempt. Set high because non-transient errors
 *  (missing API key) cannot self-heal — the operator must intervene. */
const BREAKER_COOLDOWN_MS = 60 * 60_000; // 1 hour

/** Hard cap on the number of tracked keys. Each entry is tiny, but
 *  `#state` only shed entries via reset()/resetAgent() — a key that fails
 *  1-4 times (below threshold) then is abandoned (ticket archived / role
 *  reassigned / never retried), and an open breaker whose ticket is gone,
 *  both persist forever. Over months of uptime that is unbounded growth.
 *  When the map is full a new insert evicts the oldest entry, preferring
 *  closed/stale keys over live open breakers (see #enforceCap). */
const DEFAULT_MAX_KEYS = 2000;

export interface CircuitBreakerEntry {
  consecutiveFailures: number;
  lastFailureAt: number;
  lastExitCode: number | null;
  lastExitTail: string; // first ~200 chars of CLI output for diagnostics
  /** True once threshold is crossed — stays true until reset. */
  open: boolean;
  openedAt: number;
  /** Timestamp of the last half-open probe GRANT (ticket 970d6692 review) —
   *  distinct from `openedAt` (the real trip time, only advanced by a
   *  confirmed post-probe failure via record()). Anchors the "one probe per
   *  cooldown window" throttle in shouldBlock() without needing a separate
   *  in-flight latch: 0 until the first probe is granted after (re)opening. */
  lastProbeAt: number;
}

export class CircuitBreaker {
  readonly #state = new Map<string, CircuitBreakerEntry>();
  readonly #threshold: number;
  readonly #cooldownMs: number;
  readonly #maxKeys: number;
  /** A key with no recorded failure within this window is treated as
   *  abandoned and swept on the next insert. Defaults to the cooldown: once
   *  an open breaker has sat untouched for a full cooldown (its half-open
   *  probe never came) or a sub-threshold streak has gone quiet that long,
   *  the ticket is gone — a fresh failure simply recreates the entry. */
  readonly #staleMs: number;

  constructor(opts?: {
    threshold?: number;
    cooldownMs?: number;
    maxKeys?: number;
    staleMs?: number;
  }) {
    this.#threshold = opts?.threshold ?? DEFAULT_THRESHOLD;
    this.#cooldownMs = opts?.cooldownMs ?? BREAKER_COOLDOWN_MS;
    this.#maxKeys = opts?.maxKeys ?? DEFAULT_MAX_KEYS;
    this.#staleMs = opts?.staleMs ?? this.#cooldownMs;
  }

  static key(agentId: string, ticketId: string, role: string): string {
    return `${agentId}:${ticketId}:${role || '_'}`;
  }

  /** Classify whether an exit code is transient (should NOT trigger the
   *  breaker) or non-transient (counts toward threshold). */
  static isTransientExit(code: number | null): boolean {
    if (code === null) return true; // signal-killed without numeric code
    if (code === 0) return false; // clean exit with no comment = non-transient (silent)
    return TRANSIENT_EXIT_CODES.has(code);
  }

  /**
   * Record a silent exit. Returns `true` if the breaker just opened (crossed
   * threshold), meaning the caller should pend_ticket.
   *
   * `opts.forceOpen` opens the breaker on THIS failure regardless of the
   * threshold — used for non-retryable signatures (usage-limit / auth) that
   * cannot self-heal, so burning the full N-failure budget would just spin the
   * trigger loop N more times. The failure is still counted first so the
   * reported `consecutiveFailures` reflects reality.
   *
   * ticket 970d6692: if the entry is ALREADY open, reaching this call means a
   * half-open probe (see shouldBlock()) was allowed through, actually spawned,
   * and failed again — so `openedAt` is re-stamped to restart the cooldown from
   * this real failure. `justOpened` stays false on that repeat path (the caller
   * already pend_ticket'd on the original open; don't re-fire it every probe).
   */
  record(
    key: string,
    exitCode: number | null,
    tailSnippet?: string,
    opts?: { forceOpen?: boolean },
  ): { justOpened: boolean; entry: CircuitBreakerEntry } {
    const now = Date.now();
    let entry = this.#state.get(key);
    if (!entry) {
      // Bound the map before adding a new key: first collapse abandoned keys
      // (no failure within the stale window), then enforce the hard cap. Both
      // run only on the new-key path — existing-key updates don't grow `#state`
      // — so the cost is amortized and the map stays bounded over uptime.
      this.#sweepStale(now);
      this.#enforceCap();
      entry = {
        consecutiveFailures: 0,
        lastFailureAt: 0,
        lastExitCode: null,
        lastExitTail: '',
        open: false,
        openedAt: 0,
        lastProbeAt: 0,
      };
      this.#state.set(key, entry);
    }

    entry.consecutiveFailures += 1;
    entry.lastFailureAt = now;
    entry.lastExitCode = exitCode;
    entry.lastExitTail = (tailSnippet || '').slice(0, 200);

    let justOpened = false;
    const crossedThreshold = entry.consecutiveFailures >= this.#threshold;
    if (crossedThreshold || opts?.forceOpen) {
      justOpened = !entry.open;
      entry.open = true;
      // (Re)stamp on every real failure that keeps/puts the breaker open —
      // including a failed half-open probe — never on a mere shouldBlock()
      // check (see shouldBlock()). This is what actually restarts the cooldown.
      entry.openedAt = now;
      log(
        justOpened
          ? `[circuit-breaker] OPEN key=${key} failures=${entry.consecutiveFailures} ` +
              `exit=${exitCode}${opts?.forceOpen ? ' (forced — non-retryable)' : ''} — ` +
              `blocking re-dispatch until operator intervenes`
          : `[circuit-breaker] RE-OPEN key=${key} — half-open probe failed again ` +
              `(failures=${entry.consecutiveFailures}, exit=${exitCode}) — cooldown restarted`,
      );
    } else {
      log(
        `[circuit-breaker] recorded failure key=${key} count=${entry.consecutiveFailures}/${this.#threshold} exit=${exitCode}`,
      );
    }

    return { justOpened, entry };
  }

  /**
   * Check whether dispatch should be blocked for the given key.
   * Returns a reason string if blocked, or null if dispatch is allowed.
   *
   * Pure while the entry is closed or still cooling down. Granting a
   * half-open probe DOES mutate `entry.lastProbeAt` (ticket 970d6692 review
   * round 2) — that stamp is what limits the breaker to a single probe per
   * cooldown window when independent callers share one CircuitBreaker
   * instance (e.g. a genuinely separate, concurrent second trigger for the
   * same key). `entry.openedAt` itself is never touched here — only a
   * confirmed post-probe failure (record()) may advance it — so "opened Xs
   * ago" in the blocked message always reflects the real trip time, never a
   * mere query, and a granted probe that later succeeds (recordSuccess())
   * leaves the breaker open for another full cooldown window before the
   * NEXT probe, exactly like today's non-consecutive-failure policy
   * (ticket b2e88390 — one success is not an operator sign-off).
   *
   * Callers that chain two checks for the SAME logical spawn attempt
   * (dispatchTrigger declining for an unrelated reason → event-dispatcher
   * falling back to a one-shot spawn) MUST NOT call shouldBlock() twice —
   * the second call would see the `lastProbeAt` the first call just stamped
   * and read "probed moments ago, still cooling down", re-blocking the very
   * attempt that was just granted (the original ticket 970d6692 bug). Thread
   * the FIRST call's decision into the fallback instead — see
   * `SubagentSpawnArgs.circuitBreakerDecision` and its use in
   * event-dispatcher.ts. Two independent shouldBlock() calls are only
   * correct when they represent two independent attempts.
   */
  shouldBlock(key: string): string | null {
    const entry = this.#state.get(key);
    if (!entry || !entry.open) return null;

    // Allow a single "half-open" probe per cooldown window, anchored to
    // whichever is more recent: the real (re)open time, or the last probe
    // grant. This is what stops a second, independent concurrent attempt
    // from also being waved through while the first probe's real spawn is
    // still in flight — or was reaped without ever reporting back, since
    // there is no separate "probe in progress" latch that could get stuck;
    // it is just a rolling per-cooldown throttle that self-heals on the next
    // window regardless of how the previous probe resolved.
    const anchor = Math.max(entry.openedAt, entry.lastProbeAt);
    const elapsed = Date.now() - anchor;
    if (elapsed >= this.#cooldownMs) {
      entry.lastProbeAt = Date.now();
      log(
        `[circuit-breaker] HALF-OPEN probe allowed key=${key} ` +
          `(${Math.round((Date.now() - entry.openedAt) / 60_000)}min since open)`,
      );
      return null;
    }

    return (
      `circuit_breaker_open (${entry.consecutiveFailures} consecutive non-transient exits, ` +
      `last exit=${entry.lastExitCode}, opened ${Math.round((Date.now() - entry.openedAt) / 1000)}s ago, ` +
      `next probe in ${Math.round((this.#cooldownMs - elapsed) / 1000)}s)`
    );
  }

  /**
   * Unconditionally clear the breaker for a key. Reserved for explicit
   * human/operator-attributable paths (currently only resetAgent(), wired to
   * the admin-only restart_agent command) — never call this directly from a
   * "the agent succeeded" signal. Ticket b2e88390: a lucky retry proves the
   * ONE attempt worked, not that the underlying problem (bad credentials /
   * broken config) is fixed, so success alone must not fully close a breaker
   * that already tripped and surfaced to a human via pend_ticket. Use
   * recordSuccess() at success call sites instead — it defers to this method
   * only when the breaker was never open in the first place.
   */
  reset(key: string): void {
    if (this.#state.has(key)) {
      log(`[circuit-breaker] RESET key=${key}`);
      this.#state.delete(key);
    }
  }

  /**
   * Record that the agent successfully operated (posted a real comment / a
   * clean exit with output) for a key — the ONLY call this makes on behalf
   * of a mere retry succeeding.
   *
   * - Breaker not open (no entry, or a sub-threshold failure streak that
   *   hadn't tripped yet): this is ordinary recovery — clear it exactly like
   *   the old unconditional reset() did, so unrelated blips don't linger and
   *   falsely accumulate toward the threshold later.
   * - Breaker OPEN: the ticket already pended for a human (justOpened fired
   *   pend_ticket) — a single half-open probe succeeding is not the same as
   *   a human confirming the underlying issue is fixed (ticket b2e88390).
   *   Leave the entry open; shouldBlock() keeps gating future dispatches
   *   behind the cooldown/probe cycle until an operator explicitly clears it
   *   via resetAgent() (restart_agent), or a future probe fails again and
   *   re-stamps the open state via record().
   */
  recordSuccess(key: string): void {
    const entry = this.#state.get(key);
    if (!entry || !entry.open) {
      this.reset(key);
      return;
    }
    log(
      `[circuit-breaker] half-open probe succeeded key=${key} — staying OPEN ` +
        `(requires operator resetAgent()/restart_agent to fully close; ticket b2e88390)`,
    );
  }

  /** Reset all entries for a given agent (e.g. after restart_agent). */
  resetAgent(agentId: string): void {
    for (const key of [...this.#state.keys()]) {
      if (key.startsWith(agentId + ':')) {
        log(`[circuit-breaker] RESET (agent restart) key=${key}`);
        this.#state.delete(key);
      }
    }
  }

  /**
   * Collapse abandoned keys — entries with no recorded failure within the
   * stale window. A sub-threshold streak that went quiet, or an open breaker
   * whose ticket was archived / role reassigned and never retried, both stop
   * refreshing `lastFailureAt` and get dropped here. Runs automatically on
   * each new-key insert; also exposed so an external interval sweep can call
   * it. `now` is injectable for tests. Returns the number of entries removed.
   */
  sweep(now: number = Date.now()): number {
    return this.#sweepStale(now);
  }

  #sweepStale(now: number): number {
    let removed = 0;
    for (const [key, entry] of this.#state) {
      if (now - entry.lastFailureAt > this.#staleMs) {
        this.#state.delete(key);
        removed++;
      }
    }
    if (removed > 0) {
      log(`[circuit-breaker] swept ${removed} stale key(s) — ${this.#state.size} remaining`);
    }
    return removed;
  }

  /** Evict one entry when the map is at capacity, making room for the new key
   *  the caller is about to insert. Prefers the oldest CLOSED breaker (a
   *  live open breaker is still gating dispatch and is the more valuable
   *  signal); only when every tracked key is open does it evict the oldest
   *  open one. Keyed off `lastFailureAt` so eviction is least-recently-active
   *  first. */
  #enforceCap(): void {
    if (this.#state.size < this.#maxKeys) return;
    let oldestClosed: string | null = null;
    let oldestClosedAt = Infinity;
    let oldestAny: string | null = null;
    let oldestAnyAt = Infinity;
    for (const [key, entry] of this.#state) {
      if (entry.lastFailureAt < oldestAnyAt) {
        oldestAnyAt = entry.lastFailureAt;
        oldestAny = key;
      }
      if (!entry.open && entry.lastFailureAt < oldestClosedAt) {
        oldestClosedAt = entry.lastFailureAt;
        oldestClosed = key;
      }
    }
    const victim = oldestClosed ?? oldestAny;
    if (victim !== null) {
      this.#state.delete(victim);
      log(`[circuit-breaker] cap reached (${this.#maxKeys}) — evicted key=${victim}`);
    }
  }

  /** Get a snapshot of open breakers for diagnostics / status endpoint. */
  getOpenBreakers(): Array<{ key: string; entry: CircuitBreakerEntry }> {
    const results: Array<{ key: string; entry: CircuitBreakerEntry }> = [];
    for (const [key, entry] of this.#state) {
      if (entry.open) results.push({ key, entry });
    }
    return results;
  }

  /** Total number of tracked keys (open or not). */
  get size(): number {
    return this.#state.size;
  }
}
