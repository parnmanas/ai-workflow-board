// Shared classifier for CLI fatal-error output (ticket 27806095).
//
// Background: a non-MCP one-shot CLI (codex / antigravity) can die in 1–2s on
// a usage-limit or auth error. `collectOneshotResult` then aggregates the
// CLI's error text — e.g. codex's `[codex error] You've hit your usage
// limit` — and the manager USED to post it back to the ticket as an
// *agent-identity* comment. That comment.created event passes the server's
// system-actor trigger-loop guard and re-fires the trigger → the CLI is
// re-spawned → dies again → infinite loop (the 2026-06-07 production meltdown).
//
// This module recognizes those fatal-error signatures so the one-shot exit
// handler can:
//   (1) refuse to post the error as a valid agent answer (route it to the
//       system-attributed silent-exit fallback, which the server guard drops),
//   (2) force the circuit-breaker open immediately for non-retryable errors
//       (usage-limit / auth) instead of waiting for N consecutive failures.

export interface CliErrorClassification {
  /** True when the text looks like CLI failure output rather than a real
   *  agent answer. Such text must NOT be posted under the agent identity. */
  isFatal: boolean;
  /** True when the failure cannot self-heal on a retry (usage-limit / quota /
   *  auth). The circuit-breaker should open immediately on these rather than
   *  burning the full N-failure threshold. */
  nonRetryable: boolean;
  /** Short machine label for logs / pend reasons (e.g. 'usage_limit'). */
  reason: string;
}

const OK: CliErrorClassification = { isFatal: false, nonRetryable: false, reason: '' };

// Usage / rate / quota exhaustion — operator must upgrade plan or wait for the
// window to reset; a retry within the cooldown just fails again.
const USAGE_LIMIT_RE =
  /usage limit|rate limit(?:ed)?|quota|too many requests|\b429\b|(?:hit|exceeded|reached) your (?:usage|rate|monthly|daily) limit|monthly limit|insufficient_quota|upgrade to pro/i;

// Authentication / authorization failures — missing or invalid credential;
// only an operator credential fix unblocks it.
const AUTH_RE =
  /\b401\b|\b403\b|unauthorized|forbidden|invalid api key|authentication failed|not logged in|login required|please (?:run )?[a-z-]*\s*login|missing (?:the )?api key|no api key|api key not (?:set|found)/i;

// Model-selection failures — the configured `--model` id is unknown to the
// CLI / provider, or the account can't access it. Unlike usage/auth these DO
// self-heal on a *different* model, so they are the primary fallback trigger
// (ticket 61f4dd18): retry the next model in the chain rather than pending.
const MODEL_UNAVAILABLE_RE =
  /model[_\s-]?not[_\s-]?found|unknown model|no such model|model .{0,40}?(?:does not exist|not found|is not available|unavailable|not supported|isn'?t available)|(?:invalid|unsupported|unrecognized) model|does not have access to (?:the )?model|not_?found_?error.{0,40}?model/i;

// codex's own structured-error wrapper. `collectOneshotResult` emits this
// prefix only when codex reported a `turn.failed` / `error` event instead of a
// real `agent_message` — i.e. the "answer" is actually an error report.
const CODEX_ERROR_RE = /\[codex error\]/i;

export interface ClassifyOptions {
  /**
   * Process exit code, when known. A non-zero exit is itself an error context.
   * Pass the subagent's exit code so usage/auth signatures are only treated as
   * fatal when the turn actually failed — not when they merely appear as words
   * inside a successful (exit-0) agent answer. `null`/`undefined` = unknown.
   */
  exitCode?: number | null;
}

/**
 * Classify a one-shot CLI result string. Pure + side-effect-free so it can be
 * unit-tested directly. Empty / whitespace input is treated as non-fatal (the
 * exit-code path handles "no output at all").
 *
 * Usage-limit / auth signatures (`403`, `429`, `quota`, `unauthorized`, …) are
 * also common substrings of *legitimate* SWE answers — a clean exit-0 codex
 * reply about "403 Forbidden handling" or "429/quota rate limiting" must NOT be
 * suppressed or trip the breaker. So those signatures only count as
 * fatal/non-retryable when there is an actual **error context**:
 *   - a non-zero exit code (`opts.exitCode`), OR
 *   - codex's own `[codex error]` wrapper in the text
 * (codex emits usage-limit text only inside `[codex error]`, with zero
 * `agent_message` parts, and exits non-zero — so this fully preserves the
 * meltdown fix while eliminating the exit-0 false positive).
 */
export function classifyCliError(
  text: string | null | undefined,
  opts?: ClassifyOptions,
): CliErrorClassification {
  const s = String(text ?? '');
  if (!s.trim()) return OK;

  const isCodexErrorWrapped = CODEX_ERROR_RE.test(s);
  const nonZeroExit = typeof opts?.exitCode === 'number' && opts.exitCode !== 0;
  const hasErrorContext = nonZeroExit || isCodexErrorWrapped;

  // Anchor usage/auth classification to a real failure — never to raw answer
  // text alone — so legit exit-0 answers that mention these terms pass through.
  if (hasErrorContext) {
    if (USAGE_LIMIT_RE.test(s)) return { isFatal: true, nonRetryable: true, reason: 'usage_limit' };
    if (AUTH_RE.test(s)) return { isFatal: true, nonRetryable: true, reason: 'auth_failure' };
    // A bad --model id won't self-heal on THIS config (nonRetryable → the
    // breaker force-opens if the fallback chain is exhausted) but IS the prime
    // fallback trigger — isFallbackEligible() routes it to the next model.
    if (MODEL_UNAVAILABLE_RE.test(s))
      return { isFatal: true, nonRetryable: true, reason: 'model_unavailable' };
  }

  // A bare codex error wrapper (transient model/turn failure with no
  // usage/auth signature) is fatal-as-an-answer but MAY recover on retry, so
  // it counts toward the breaker threshold normally rather than opening now.
  if (isCodexErrorWrapped) return { isFatal: true, nonRetryable: false, reason: 'codex_error' };

  return OK;
}

// Failure reasons that switching to a DIFFERENT model can plausibly clear
// (ticket 61f4dd18). `model_unavailable`: the id is bad — another id may work.
// `usage_limit`: an external cap on the current model/tier — a cheaper or
// separate-quota fallback may still have headroom (the ticket's canonical
// case). Deliberately NOT eligible: `auth_failure` (same credential — a
// different model won't fix a bad/missing key) and `codex_error` (transient;
// a plain retry on the same model is the breaker's job, not a model switch).
const FALLBACK_ELIGIBLE_REASONS = new Set(['model_unavailable', 'usage_limit']);

/**
 * Should agent-manager try the next model in the fallback chain for this
 * failure? True only for classifications whose failure a different model can
 * clear. The spawn site additionally gates on "no deliverable was produced
 * this attempt" so a mid-work code-bug crash never triggers an endless model
 * walk (ticket 61f4dd18 scope ④); the chain length also bounds total attempts.
 */
export function isFallbackEligible(c: CliErrorClassification): boolean {
  return c.isFatal && FALLBACK_ELIGIBLE_REASONS.has(c.reason);
}
