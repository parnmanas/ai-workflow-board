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

export interface CircuitBreakerEntry {
  consecutiveFailures: number;
  lastFailureAt: number;
  lastExitCode: number | null;
  lastExitTail: string; // first ~200 chars of CLI output for diagnostics
  /** True once threshold is crossed — stays true until reset. */
  open: boolean;
  openedAt: number;
}

export class CircuitBreaker {
  readonly #state = new Map<string, CircuitBreakerEntry>();
  readonly #threshold: number;
  readonly #cooldownMs: number;

  constructor(opts?: { threshold?: number; cooldownMs?: number }) {
    this.#threshold = opts?.threshold ?? DEFAULT_THRESHOLD;
    this.#cooldownMs = opts?.cooldownMs ?? BREAKER_COOLDOWN_MS;
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
      entry = {
        consecutiveFailures: 0,
        lastFailureAt: 0,
        lastExitCode: null,
        lastExitTail: '',
        open: false,
        openedAt: 0,
      };
      this.#state.set(key, entry);
    }

    entry.consecutiveFailures += 1;
    entry.lastFailureAt = now;
    entry.lastExitCode = exitCode;
    entry.lastExitTail = (tailSnippet || '').slice(0, 200);

    let justOpened = false;
    const crossedThreshold = entry.consecutiveFailures >= this.#threshold;
    if (!entry.open && (crossedThreshold || opts?.forceOpen)) {
      entry.open = true;
      entry.openedAt = now;
      justOpened = true;
      log(
        `[circuit-breaker] OPEN key=${key} failures=${entry.consecutiveFailures} ` +
          `exit=${exitCode}${opts?.forceOpen ? ' (forced — non-retryable)' : ''} — ` +
          `blocking re-dispatch until operator intervenes`,
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
   */
  shouldBlock(key: string): string | null {
    const entry = this.#state.get(key);
    if (!entry || !entry.open) return null;

    // Allow a single "half-open" probe after the cooldown period
    const elapsed = Date.now() - entry.openedAt;
    if (elapsed >= this.#cooldownMs) {
      log(
        `[circuit-breaker] HALF-OPEN probe allowed key=${key} ` +
          `(${Math.round(elapsed / 60_000)}min since open)`,
      );
      // Don't auto-close — if the probe silent-exits again, record() will
      // bump consecutiveFailures and re-stamp openedAt via a fresh open.
      entry.openedAt = Date.now(); // reset cooldown for next probe
      return null;
    }

    return (
      `circuit_breaker_open (${entry.consecutiveFailures} consecutive non-transient exits, ` +
      `last exit=${entry.lastExitCode}, opened ${Math.round((Date.now() - entry.openedAt) / 1000)}s ago)`
    );
  }

  /**
   * Reset the breaker for a key — called when the agent successfully posts
   * a comment (proves it can operate) or when an operator unpends / restarts.
   */
  reset(key: string): void {
    if (this.#state.has(key)) {
      log(`[circuit-breaker] RESET key=${key}`);
      this.#state.delete(key);
    }
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
