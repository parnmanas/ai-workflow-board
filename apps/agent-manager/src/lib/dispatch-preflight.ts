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
  /** Stable de-dup key for the blocker, e.g. `worktree:repository_unavailable`. */
  kind?: string;
  reason?: string;
}

/** Map a worktree provisioning result onto a dispatch-abort decision. A real
 *  worktree is required; every fallback reason is a blocker. This gate stops
 *  a missing/unavailable managed repository or an occupied worktree path before
 *  dispatch. The configured working_dir itself is only a storage container. */
export function classifyWorktreeOutcome(res: WorktreeOutcome | null | undefined): DispatchGateDecision {
  if (res?.isWorktree) return { blocked: false };
  const reason = res?.reason;
  if (!reason) return { blocked: true, kind: 'worktree:unavailable', reason: 'unavailable' };
  return { blocked: true, kind: `worktree:${reason}`, reason };
}

// ── worktree checkout verification (ticket feaa7ab0) ─────────────────────────
//
// classifyWorktreeOutcome above trusts the provisioning RESULT (`isWorktree`).
// But `git worktree add` can report success while leaving a cwd that is NOT a
// usable checkout of the expected repo: an empty/clobbered dir, a half-written
// clone whose HEAD does not resolve, or a stale checkout of a DIFFERENT repo
// (when working_dir was re-pointed). Spawning there burns a whole CLI session
// and invites a supervisor re-dispatch storm — ticket 965e6229 failed
// `not_a_git_repo` four times this way. This decision layer turns an observed,
// non-mutating git probe into a spawn/abort verdict. It is PURE (no I/O):
// `WorktreeManager.verifyCheckout` runs git and feeds the facts here, so the
// classification is unit-testable without a repo.

/** Facts observed about a provisioned worktree by the I/O shell
 *  (`WorktreeManager.verifyCheckout`) via `git rev-parse` / `git remote
 *  get-url`. `originUrl` may carry embedded credentials — it is normalized /
 *  redacted here and never surfaced raw. */
export interface WorktreeCheckoutProbe {
  /** `git rev-parse --is-inside-work-tree` printed exactly "true". */
  insideWorkTree: boolean;
  /** HEAD resolves to a commit — the checkout finished, not a half-written
   *  clone/add. undefined when not probed (e.g. not a work tree at all). */
  headResolved?: boolean;
  /** `origin` remote URL, or '' when unset. */
  originUrl?: string;
}

/** What the worktree SHOULD be a checkout of — the ticket/board repository
 *  resource's clone url. When unknown, the origin match is skipped (fail open)
 *  so a legitimately-provisioned tree is never wrongly blocked. */
export interface WorktreeCheckoutExpectation {
  url?: string;
}

export type WorktreeCheckoutReason =
  | 'not_a_git_repo'
  | 'incomplete_checkout'
  | 'wrong_repository';

export interface WorktreeCheckoutDecision {
  ok: boolean;
  /** Set when blocked; becomes the dispatch blocker de-dup key suffix. */
  reason?: WorktreeCheckoutReason;
  /** Secret-free, human-readable detail for the ticket comment / log. */
  detail?: string;
}

/** Reduce a git remote URL to a comparable `host/path` identity: drop the
 *  scheme, any `user:pass@` / `user@` credentials, a trailing `.git`, and
 *  trailing slashes; lowercase. Handles scp-style `git@host:org/repo` too.
 *  Lowercasing can only cause a false MATCH (→ fail open), never a false block. */
export function normalizeRemoteUrl(raw: string | undefined | null): string {
  let u = (raw ?? '').trim();
  if (!u) return '';
  const scp = u.match(/^[^/@]+@([^:/]+):(.+)$/); // git@host:org/repo (no scheme)
  if (scp) {
    u = `${scp[1]}/${scp[2]}`;
  } else {
    u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''); // strip scheme://
    u = u.replace(/^[^/@]+@/, ''); // strip user[:pass]@
  }
  // Strip trailing slashes BEFORE `.git` so `…/repo.git/` reduces to `…/repo`
  // (order matters — a trailing slash otherwise shields the `.git` suffix and
  // yields a spurious mismatch).
  u = u.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  return u.toLowerCase();
}

/** Reduce a git remote URL to a safe-to-display form, keeping scheme+host+path
 *  so the operator can still identify the wrong remote while NEVER emitting a
 *  secret. Removes three secret carriers:
 *    - a `?query` or `#fragment` (e.g. `?access_token=…`, `#token=…`) — dropped
 *      wholesale, since a token can hide in either and neither is needed to
 *      identify a repo;
 *    - `scheme://user:pass@` userinfo (PAT-as-username / basic-auth password).
 *  The query/fragment MUST be stripped before the userinfo regex so a
 *  `…@host/path?token=…` can't slip its token through on the tail. */
export function redactRemoteUrl(raw: string | undefined | null): string {
  let u = (raw ?? '').trim();
  if (!u) return '';
  // Drop fragment first, then query — either can carry a secret, and nothing
  // downstream needs them to identify the remote. (`.` excludes newlines, but a
  // remote URL is single-line; a stray newline just ends the stripped span.)
  u = u.replace(/#.*$/, '').replace(/\?.*$/, '');
  // scheme://user[:pass]@host/… → scheme://host/…  (userinfo can be a token)
  u = u.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]+@/i, '$1');
  return u;
}

/** Decide whether a provisioned worktree is a valid checkout of the expected
 *  repository, BEFORE a subagent is spawned into it. Blocks on three concrete,
 *  observed conditions and fails OPEN on everything ambiguous:
 *    - not inside a git work tree        → `not_a_git_repo`     (empty/clobbered dir)
 *    - inside, but HEAD does not resolve  → `incomplete_checkout` (half-written clone)
 *    - both origins known and DIFFERENT   → `wrong_repository`    (stale/foreign checkout)
 *  An unknown expected url or unknown origin never blocks (can't prove a
 *  mismatch → don't wedge a legitimate tree), consistent with decidePushReadiness. */
export function classifyWorktreeCheckout(
  probe: WorktreeCheckoutProbe,
  expected?: WorktreeCheckoutExpectation,
): WorktreeCheckoutDecision {
  if (!probe.insideWorkTree) {
    return { ok: false, reason: 'not_a_git_repo', detail: 'worktree path is not a git work tree' };
  }
  if (probe.headResolved === false) {
    return { ok: false, reason: 'incomplete_checkout', detail: 'git HEAD does not resolve — checkout is incomplete' };
  }
  const want = normalizeRemoteUrl(expected?.url);
  const have = normalizeRemoteUrl(probe.originUrl);
  if (want && have && want !== have) {
    return {
      ok: false,
      reason: 'wrong_repository',
      detail: `origin ${redactRemoteUrl(probe.originUrl) || '(unset)'} does not match the expected repository`,
    };
  }
  return { ok: true };
}

/** Reduce a resolved worktree cwd to the form that is safe to write into a
 *  ticket comment / activity log: the path RELATIVE to the agent's working_dir
 *  when the worktree lives under it (the normal `.awb/wt/…` / `.awb/base/…`
 *  managed layout), else the absolute path unchanged (e.g. the resource-worktree
 *  path outside working_dir). A filesystem path carries no credential, but the
 *  working_dir-relative form also avoids echoing an absolute host layout and is
 *  what completion criterion #5 ("실패 경로") asks for. Pure string logic (no
 *  path/fs I/O) so it stays unit-testable alongside the other preflight helpers.
 *  A missing cwd yields '' so callers can omit the line entirely. */
export function managedWorktreePath(
  baseWorkingDir: string | undefined | null,
  cwd: string | undefined | null,
): string {
  const abs = (cwd ?? '').trim();
  if (!abs) return '';
  const base = (baseWorkingDir ?? '').trim().replace(/\/+$/, '');
  if (base && abs.startsWith(base + '/')) {
    return abs.slice(base.length + 1);
  }
  return abs;
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

/** Default cooldown for RoleSpawnSuppressor: how long a durable blocker
 *  suppresses supervisor re-dispatch before letting ONE probe through. Sized to
 *  comfortably span a supervisor force-respawn burst (ticket 965e6229 re-fired
 *  every ~5 min) yet expire well before an operator would expect a manual retry
 *  to be honored — and manual/comment triggers bypass it entirely regardless. */
export const DEFAULT_SPAWN_SUPPRESS_COOLDOWN_MS = 10 * 60_000;

/** Consecutive preflight aborts of ONE episode (same ticket-role + blocker
 *  kind) after which RoleSpawnSuppressor escalates from cooldown backoff to a
 *  DURABLE pend (ticket 52eedadf). The cooldown already thins the supervisor
 *  re-dispatch storm to one probe per window, but a genuinely broken
 *  environment (not_a_git_repo / broken checkout / missing push credential)
 *  never self-heals — it just keeps getting probed forever, and each probe is a
 *  fresh live-twin window. Once the episode has re-aborted this many times it is
 *  confirmed durable: the caller pends the ticket so `getAllocatedTickets` skips
 *  it and the supervisor stops re-emitting BOTH normal and forced triggers,
 *  until an operator unpends (explicit retry) or a later green preflight
 *  (reprovision success) clears the suppressor. Small so the hard stop lands
 *  minutes — not the observed ~6h (ticket c47194d9) — into a durable failure,
 *  yet > 1 so a one-off transient still self-heals via the cooldown probe first. */
export const DEFAULT_PEND_AFTER_ABORTS = 3;

export interface SpawnSuppressDecision {
  suppress: boolean;
  /** The active blocker kind (when suppressing). */
  kind?: string;
  /** Consecutive recorded aborts of this episode (observability). */
  count?: number;
  /** ms since the first abort of this episode (observability). */
  sinceMs?: number;
}

/** Per-(ticket,role) suppressor for the automated supervisor re-dispatch storm
 *  (ticket feaa7ab0).
 *
 *  When a dispatch keeps aborting at preflight for a durable environment blocker
 *  (broken/foreign worktree, missing push credential), the abort already stops
 *  THIS spawn — but the server-side supervisor keeps force-respawning the same
 *  ticket-role every few minutes (ticket 965e6229 emitted ~15 force_respawn
 *  triggers before its circuit opened). Each re-trigger re-runs the whole
 *  provision→verify→abort cycle: wasted git I/O plus a window in which an
 *  inconsistently-succeeding provision can spawn a live twin.
 *
 *  This dampens the storm on the manager side: once a ticket-role has aborted, a
 *  SUPERVISOR-sourced re-trigger for the SAME ticket-role is dropped BEFORE
 *  provisioning while inside the cooldown window. Human / state-changed triggers
 *  (comment, manual, manager_restart, column_move — `fromSupervisor:false`)
 *  ALWAYS pass, so an operator who fixes the environment recovers immediately.
 *  A cooldown escape lets one supervisor probe through per window so a
 *  self-healed transient recovers without human action. `clear()` on a green
 *  preflight re-arms the ticket-role.
 *
 *  In-memory like DispatchBlockerTracker: one manager owns a ticket-role's
 *  triggers, and a manager restart harmlessly re-arms. `now` is injected so the
 *  policy is unit-testable without a real clock. */
export class RoleSpawnSuppressor {
  #byKey = new Map<string, { kind: string; firstAt: number; lastAt: number; count: number; lastProbeAt: number }>();
  #cooldownMs: number;
  #pendAfterAborts: number;

  constructor(
    cooldownMs: number = DEFAULT_SPAWN_SUPPRESS_COOLDOWN_MS,
    pendAfterAborts: number = DEFAULT_PEND_AFTER_ABORTS,
  ) {
    this.#cooldownMs = cooldownMs > 0 ? cooldownMs : DEFAULT_SPAWN_SUPPRESS_COOLDOWN_MS;
    this.#pendAfterAborts = pendAfterAborts > 0 ? Math.floor(pendAfterAborts) : DEFAULT_PEND_AFTER_ABORTS;
  }

  #key(ticketId: string, role: string): string {
    return `${ticketId} ${role}`;
  }

  /** Record that a preflight abort just happened for (ticketId, role) with
   *  `kind`. A changed kind resets the episode (fresh firstAt/count/probe).
   *  Returns the running abort `count` and whether THIS abort is the one that
   *  crosses the durable-pend threshold (`count === pendAfterAborts`) — true on
   *  exactly ONE abort per episode, so the caller pends the ticket exactly once
   *  (no duplicate/misleading audit rows; once pended the server-side pending
   *  gate — not a manager re-pend — is what keeps the supervisor stopped). A
   *  changed kind, or a clear() on a green preflight (reprovision success),
   *  re-arms the episode so a future durable break pends afresh. `note()` is
   *  synchronous, so even concurrently-processed triggers each increment `count`
   *  atomically and only one observes the exact crossing. Missing id/role never
   *  escalates. */
  note(
    ticketId: string | undefined,
    role: string | undefined,
    kind: string,
    now: number,
  ): { count: number; shouldPend: boolean } {
    if (!ticketId || !role) return { count: 0, shouldPend: false };
    const key = this.#key(ticketId, role);
    const prev = this.#byKey.get(key);
    let count: number;
    if (!prev || prev.kind !== kind) {
      this.#byKey.set(key, { kind, firstAt: now, lastAt: now, count: 1, lastProbeAt: now });
      count = 1;
    } else {
      prev.lastAt = now;
      prev.count += 1;
      count = prev.count;
    }
    return { count, shouldPend: count === this.#pendAfterAborts };
  }

  /** Decide whether to DROP an incoming trigger before provisioning. Only a
   *  supervisor-sourced re-trigger with an active blocker, still inside the
   *  cooldown window, is suppressed; the first per-window supervisor probe and
   *  every non-supervisor trigger pass. Mutates lastProbeAt when it lets a
   *  supervisor probe through (mirrors DispatchBlockerTracker.shouldComment's
   *  record-on-query style). */
  shouldSuppress(
    ticketId: string | undefined,
    role: string | undefined,
    opts: { now: number; fromSupervisor: boolean },
  ): SpawnSuppressDecision {
    if (!ticketId || !role) return { suppress: false };
    const rec = this.#byKey.get(this.#key(ticketId, role));
    if (!rec) return { suppress: false };                 // no active blocker → run preflight
    if (!opts.fromSupervisor) return { suppress: false };  // humans / state changes always pass
    if (opts.now - rec.lastProbeAt >= this.#cooldownMs) {
      rec.lastProbeAt = opts.now;                          // let one probe through per window
      return { suppress: false };
    }
    return {
      suppress: true,
      kind: rec.kind,
      count: rec.count,
      sinceMs: Math.max(0, opts.now - rec.firstAt),
    };
  }

  /** Drop a ticket-role's active blocker (call on a fully-green preflight).
   *  Idempotent. */
  clear(ticketId: string | undefined, role: string | undefined): void {
    if (ticketId && role) this.#byKey.delete(this.#key(ticketId, role));
  }

  /** The active blocker kind for a ticket-role, or undefined. Test/observability. */
  activeKind(ticketId: string | undefined, role: string | undefined): string | undefined {
    if (!ticketId || !role) return undefined;
    return this.#byKey.get(this.#key(ticketId, role))?.kind;
  }
}

/** Operator-facing reason for a DURABLE provisioning-block pend (ticket
 *  52eedadf), rendered verbatim on the ticket detail panel's "User" tab. Names
 *  the blocker cause and both recovery paths — fix the environment then unpend
 *  (explicit retry), or let a later green preflight (reprovision success) resume
 *  it automatically. Pure string logic so it stays unit-testable alongside the
 *  other preflight helpers. */
export function provisioningPendReason(args: {
  kind: string;
  reason?: string;
  detail?: string;
  count: number;
}): string {
  const cause = (args.reason || args.kind || 'unknown').trim();
  const detail = args.detail ? ` (${args.detail})` : '';
  return (
    `티켓 디스패치 준비(preflight)가 ${args.count}회 연속 실패해 durable block 상태로 전환했습니다.\n` +
    `원인: \`${cause}\`${detail}\n\n` +
    `supervisor 의 자동 재트리거(normal·forced)를 멈춥니다. repository resource·credential 과 ` +
    `working_dir 아래 AWB 관리 폴더(\`.awb/base\`·\`.awb/wt\`)를 점검해 고친 뒤 이 티켓을 unpend 하면 ` +
    `다시 시도합니다. (환경을 고친 뒤 다음 프로비저닝이 성공하면 자동으로 재개됩니다.)`
  );
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
