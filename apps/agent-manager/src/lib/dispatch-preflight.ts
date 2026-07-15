// Dispatch-time preflight helpers (ticket a3047a86).
//
// Before a subagent is spawned, `EventDispatcher.handleTrigger` runs a few
// environment gates so a doomed trigger is stopped BEFORE it burns a whole CLI
// session (and, on re-trigger, a whole CLI weekly-limit quota). The concrete
// failures this guards against were observed on ticket 8436f96f:
//   - the assigned work folder was empty / not a git repo → the agent could do
//     nothing and got re-triggered repeatedly, each spawn hitting the CLI
//     weekly limit;
//   - the folder held ANOTHER ticket's dirty branch → the agent correctly
//     refused to touch it and was re-triggered;
//   - implementation finished, then Merging died TWICE at `git push` with
//     `could not read Username for 'https://github.com'` (no push credential),
//     wasting a full CLI session each time.
//
// The worktree-repo/clean side is already enforced by resolveCwd + the
// `#applyWorktreeCwd` abort. This module adds the two pieces that were missing:
//   1. a decision layer for push-credential readiness, fed by a live probe (a
//      configured-but-empty `credential.helper cache`/`store` still fails push,
//      so helper PRESENCE is not trusted — the probe is ground truth), so a
//      missing credential is caught at dispatch, at the latest before Merging;
//   2. a per-ticket blocker de-duplicator so the SAME blocker doesn't re-post a
//      ticket comment on every re-trigger (spawn is already suppressed by the
//      abort; this stops the comment spam) — while a DIFFERENT blocker, or the
//      first failure after recovery, still posts exactly once.
//
// Everything here is pure (no I/O) so it is unit-testable without driving the
// whole dispatcher. The I/O shell (`WorktreeManager.verifyPushReadiness`) calls
// git and hands the observed facts to `decidePushReadiness`.

/** git stderr fragments (lowercased) that mean "the remote rejected us for lack
 *  of usable credentials", as opposed to a transient network/DNS/timeout error.
 *  We fail CLOSED (abort dispatch) on these and fail OPEN on everything else, so
 *  a network blip never wedges a ticket. The first entry is the exact string
 *  git printed on ticket 8436f96f's Merging failure. */
const GIT_AUTH_FAILURE_SIGNATURES = [
  'could not read username',
  'could not read password',
  'authentication failed',
  'terminal prompts disabled',
  'invalid username or password',
  'incorrect username or password',
  'support for password authentication was removed',
  'access denied',
  '403 forbidden',
  'fatal: unauthorized',
  'remote: permission to',      // "remote: Permission to <repo> denied to <user>"
  'repository not found',       // GitHub masks a private repo you can't auth to as 404
] as const;

/** True when a failed git remote operation's stderr looks like an
 *  authentication/authorization rejection (a durable blocker an operator must
 *  fix) rather than a transient connectivity error (retry-able on its own). */
export function isGitAuthFailure(stderr: string | undefined | null): boolean {
  if (!stderr) return false;
  const s = stderr.toLowerCase();
  return GIT_AUTH_FAILURE_SIGNATURES.some((sig) => s.includes(sig));
}

/** Result of the live `git ls-remote` probe. `ran:false` means the probe was
 *  skipped (e.g. the remote isn't https) — the decision then never blocks. */
export interface PushReadinessProbe {
  ran: boolean;
  ok?: boolean;
  stderr?: string;
}

export interface PushReadinessInput {
  /** The origin remote is http(s) — the only scheme this failure mode covers.
   *  ssh/file/git remotes use key/local auth we don't cheaply probe. */
  isHttps: boolean;
  /** The live probe result. We deliberately do NOT trust a mere "credential
   *  helper is configured" signal: an empty `cache`/`store` helper is
   *  configured yet still fails `git push` with `could not read Username`
   *  (exactly ticket 8436f96f). The probe is the ground truth — a valid
   *  installed token makes it succeed, an empty helper makes it auth-fail. */
  probe?: PushReadinessProbe;
}

export interface PushReadinessDecision {
  ok: boolean;
  /** Set when blocked. Stable string so the blocker de-dup keys on it. */
  reason?: string;
  /** First line of the git stderr, for the ticket comment / log. */
  detail?: string;
}

/** Decide whether a dispatch may proceed w.r.t. push-credential readiness.
 *  Blocks ONLY when the remote is https AND a live probe actively failed
 *  authentication. Every other path is ready: non-https (key auth), probe not
 *  run / anonymously reachable (can't prove push fails), or a transient probe
 *  error (fail open rather than wedge a ticket on a network blip). */
export function decidePushReadiness(input: PushReadinessInput): PushReadinessDecision {
  if (!input.isHttps) return { ok: true };
  const probe = input.probe;
  if (!probe || !probe.ran) return { ok: true };
  if (probe.ok) return { ok: true };
  if (isGitAuthFailure(probe.stderr)) {
    return {
      ok: false,
      reason: 'push_credential_unavailable',
      detail: firstLine(probe.stderr) || 'push credential unavailable',
    };
  }
  return { ok: true };
}

/** A ResolveCwd-style result (only the fields the gate needs). */
export interface WorktreeOutcome {
  isWorktree?: boolean;
  reason?: string;
}

export interface DispatchGateDecision {
  blocked: boolean;
  /** Stable de-dup key for the blocker, e.g. `worktree:not_a_git_repo`. */
  kind?: string;
  reason?: string;
}

/** Map a worktree provisioning result onto a dispatch-abort decision. A real
 *  worktree is fine; a fallback with a reason OTHER than 'disabled' (isolation
 *  intentionally off, not a failure) is a blocker. This is the gate that stops
 *  an empty / non-git working_dir (`not_a_git_repo`) and a foreign/occupied
 *  checkout (`path_conflict`) before dispatch. */
export function classifyWorktreeOutcome(res: WorktreeOutcome | null | undefined): DispatchGateDecision {
  if (res?.isWorktree) return { blocked: false };
  const reason = res?.reason;
  if (!reason || reason === 'disabled') return { blocked: false };
  return { blocked: true, kind: `worktree:${reason}`, reason };
}

/** In-memory, per-ticket dispatch-blocker de-duplicator.
 *
 *  Purpose: when a dispatch keeps aborting for the same environment blocker
 *  (broken worktree, missing push credential), the abort already stops the
 *  spawn — but the ticket comment would repeat on every re-trigger. This tracks
 *  the last blocker KIND per ticket so:
 *    - the first occurrence of a kind posts a comment (returns true),
 *    - repeats of the SAME kind are suppressed (return false),
 *    - a DIFFERENT kind posts again (the situation changed), and
 *    - `clear()` on a fully-successful preflight re-arms the ticket so a future
 *      blocker after recovery posts fresh and retries proceed.
 *
 *  State is intentionally in-memory: a ticket's triggers are handled by the one
 *  manager that owns its agent, and a manager restart harmlessly re-arms (at
 *  most one extra comment). No disk/TTL machinery needed. */
export class DispatchBlockerTracker {
  #byTicket = new Map<string, string>();

  /** Record `kind` as the active blocker for `ticketId`; return true when a
   *  fresh ticket comment should be posted (first time, or the kind changed). */
  shouldComment(ticketId: string | undefined, kind: string): boolean {
    if (!ticketId) return true;
    const prev = this.#byTicket.get(ticketId);
    this.#byTicket.set(ticketId, kind);
    return prev !== kind;
  }

  /** Clear a ticket's active blocker (call once a dispatch fully clears
   *  preflight). Idempotent. */
  clear(ticketId: string | undefined): void {
    if (ticketId) this.#byTicket.delete(ticketId);
  }

  /** The active blocker kind for a ticket, or undefined. Test/observability. */
  activeKind(ticketId: string | undefined): string | undefined {
    return ticketId ? this.#byTicket.get(ticketId) : undefined;
  }
}

/** First non-empty line of a multi-line string, trimmed. */
export function firstLine(text: string | undefined | null): string {
  if (!text) return '';
  for (const raw of text.split('\n')) {
    const t = raw.trim();
    if (t) return t;
  }
  return '';
}
