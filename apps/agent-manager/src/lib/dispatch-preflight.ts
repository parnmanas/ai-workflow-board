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
 *  kind) after which RoleSpawnSuppressor escalates a TRANSIENT/ambiguous blocker
 *  from cooldown backoff to a durable pend (ticket 52eedadf). DURABLE blockers
 *  (see {@link isDurableProvisioningBlocker}) do NOT wait for this count — they
 *  pend on the FIRST abort so a genuinely broken environment (not_a_git_repo /
 *  broken checkout / missing push credential) stops the supervisor IMMEDIATELY
 *  (`provisioning failure → 반복 trigger 없음`) instead of being re-probed once
 *  per window forever, each probe a fresh live-twin window (the ~6h loop of
 *  ticket c47194d9). This threshold only governs blockers that MIGHT self-heal —
 *  a `path_conflict` frees when the occupying ticket finishes, a
 *  `repository_unavailable` resource may come back: the cooldown lets one probe
 *  per window through, and only after the episode has re-aborted this many times
 *  is even a transient blocker declared durable and pended. > 1 so a one-off
 *  transient still self-heals via the cooldown probe first; small so a persistent
 *  transient still hard-stops in minutes. Once pended, `getAllocatedTickets`
 *  skips the ticket and the supervisor stops re-emitting BOTH normal and forced
 *  triggers until an operator unpends (explicit retry) or a post-unpend green
 *  preflight (reprovision success) clears the suppressor. */
export const DEFAULT_PEND_AFTER_ABORTS = 3;

/** Dispatch blocker `kind`s that an operator MUST fix by hand — a broken/empty/
 *  foreign checkout or a missing push credential never self-heals, so re-probing
 *  it only burns another CLI session and re-opens the live-twin window. Compared
 *  after stripping an optional `worktree:` prefix so both the `worktree:<reason>`
 *  checkout kinds and the bare `push_credential_unavailable` kind map. */
const DURABLE_BLOCKER_REASONS = new Set<string>([
  'not_a_git_repo',              // empty / clobbered work folder
  'incomplete_checkout',         // half-written clone — HEAD unresolved
  'wrong_repository',            // stale/foreign checkout — working_dir mis-pointed
  'push_credential_unavailable', // remote auth rejected — operator must add a token
]);

/** True when a dispatch blocker `kind` is a DURABLE provisioning failure (needs
 *  operator action, never self-heals) versus a TRANSIENT/ambiguous one that may
 *  clear on its own (a `path_conflict` frees when the occupying ticket finishes;
 *  an `unavailable` / `repository_unavailable` resource may come back). Durable
 *  blockers pend on the FIRST abort so the supervisor stops at once; transient
 *  ones keep the cooldown-probe self-heal and pend only after the episode
 *  re-aborts `pendAfterAborts` times. Unknown kinds are treated as transient —
 *  fail-safe: back off rather than instantly park a ticket on a blocker we don't
 *  recognise. */
export function isDurableProvisioningBlocker(kind: string | undefined | null): boolean {
  if (!kind) return false;
  const reason = kind.startsWith('worktree:') ? kind.slice('worktree:'.length) : kind;
  return DURABLE_BLOCKER_REASONS.has(reason);
}

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
   *  crosses the pend threshold for the blocker's durability class — a DURABLE
   *  blocker ({@link isDurableProvisioningBlocker}) crosses on the FIRST abort
   *  (`count === 1`) so a broken environment pends immediately, a TRANSIENT one
   *  only after `pendAfterAborts` cooldown-probed re-aborts. `shouldPend` is true
   *  on exactly ONE abort per episode either way, so the caller pends the ticket
   *  exactly once (no duplicate/misleading audit rows; once pended the
   *  server-side pending gate — not a manager re-pend — is what keeps the
   *  supervisor stopped). A changed kind, or a clear() on a green preflight
   *  (reprovision success), re-arms the episode so a future break pends afresh.
   *  `note()` is synchronous, so even concurrently-processed triggers each
   *  increment `count` atomically and only one observes the exact crossing.
   *  Missing id/role never escalates. */
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
    // Durable blockers (operator must fix, never self-heal) pend on the FIRST
    // abort so the supervisor stops immediately (`provisioning failure → 반복
    // trigger 없음`); transient/ambiguous blockers keep the cooldown-probe
    // self-heal and pend only once the episode has re-aborted `pendAfterAborts`
    // times. Either way the crossing is a single count value, so shouldPend is
    // true on exactly one abort per episode.
    const pendThreshold = isDurableProvisioningBlocker(kind) ? 1 : this.#pendAfterAborts;
    return { count, shouldPend: count === pendThreshold };
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
 *  the blocker cause and the recovery path: because a pended ticket receives NO
 *  supervisor triggers (normal or forced), an explicit operator `unpend` is the
 *  ONLY way to resume — there is no unattended auto-retry while pended. Once
 *  unpended and re-dispatched, a green preflight (reprovision success) then
 *  clears the durable block automatically. Pure string logic so it stays
 *  unit-testable alongside the other preflight helpers. */
export function provisioningPendReason(args: {
  kind: string;
  reason?: string;
  detail?: string;
  count: number;
}): string {
  const cause = (args.reason || args.kind || 'unknown').trim();
  const detail = args.detail ? ` (${args.detail})` : '';
  return (
    `프로비저닝 preflight 가 durable blocker 로 실패해 이 티켓을 durable block 상태로 전환했습니다 (누적 실패 ${args.count}회).\n` +
    `원인: \`${cause}\`${detail}\n\n` +
    `supervisor 의 자동 재트리거(normal·forced)를 멈춥니다. repository resource·credential 과 ` +
    `working_dir 아래 AWB 관리 폴더(\`.awb/base\`·\`.awb/wt\`)를 점검해 고친 뒤 이 티켓을 unpend 하세요. ` +
    `pend 상태에서는 supervisor 가 트리거를 보내지 않으므로 unpend 가 유일한 재개 방법이며, ` +
    `unpend 후 재디스패치의 프로비저닝이 성공하면 durable block 이 자동 해제되어 정상 흐름으로 복귀합니다.`
  );
}

/** Identity a ticket dispatch holds while it provisions + spawns. Mirrors the
 *  (ticketId, role, agentId) triple the downstream spawn methods key on. */
export interface InflightDispatchMeta {
  ticketId: string;
  role: string;
  agentId: string;
}

/** Why a dispatch was suppressed by the provision-spanning single-flight guard.
 *  Kept a stable string so the metric / log / activity can key on it (and so a
 *  future second suppression cause slots in without churn). */
export type DispatchSuppressReason = 'inflight_dispatch';

/** Provision-spanning single-flight coordinator for ticket triggers (ticket 3d180f85).
 *
 *  The twin bug it closes: `EventDispatcher.handleTrigger` awaits worktree
 *  provisioning (`#applyWorktreeCwd`) + ticket fetch BEFORE it reaches either
 *  spawn method, and SSE events dispatch fire-and-forget (event-stream.ts — the
 *  dispatch promise is only `.catch()`'d, never awaited). So same-(ticket, role,
 *  agent) triggers run `handleTrigger` CONCURRENTLY. During a provisioning-
 *  failure storm the server's supervisor re-sends the trigger; once provisioning
 *  recovers, the accumulated concurrent triggers ALL pass provisioning and each
 *  spawns → up to `live_count=3` live twins. The existing spawn-window guards
 *  (SubagentManager.findDuplicateSpawn + `#map`; TicketSessionManager `_inflight`
 *  + `_getLiveSession`) only engage INSIDE the spawn methods, AFTER the
 *  previously-unguarded provisioning window, so they miss this race.
 *
 *  ── authoritative single-flight (ticket blocker #2) ──
 *  The RESERVATION itself is NOT held here. When persistent ticket sessions are
 *  on (the default, and the config the twin incident was observed under),
 *  handleTrigger reserves the (ticket, role, agent) key directly in the
 *  TicketSessionManager's AUTHORITATIVE `_inflight` map (see
 *  `TicketSessionManager.tryReserveDispatch`), the same pid-checked registry the
 *  spawn consults via `_getLiveSession`/`_inflight` — so the provisioning window
 *  and the spawn window share ONE authoritative reservation with no parallel
 *  map and an atomic hand-off. This coordinator only OWNS the process-local
 *  fallback slot used when persistent sessions are OFF (one-shot-only config,
 *  where the equivalent authority is SubagentManager.findDuplicateSpawn), plus
 *  the two purely-in-process bookkeeping concerns that belong to no registry:
 *  the suppression-reason metric and the suppressed-force-respawn intent.
 *
 *  Cross-manager / duplicate-manager is deliberately out of scope: one manager
 *  owns an agent (the agent lockfile guarantees it), and the server's
 *  `claim_ticket` lock is AGENT-keyed (`locked_by_agent_id`) so it cannot even
 *  distinguish two twins of the SAME (ticket, role, agent) — the exact case
 *  here. The authoritative source for a same-agent twin is therefore the owning
 *  manager's own live-session registry, which is what we reserve in. */
export class InflightDispatchTracker {
  /** Process-local fallback reservation table — used ONLY when the authoritative
   *  TicketSessionManager._inflight registry is unavailable (persistent sessions
   *  disabled). Keyed identically to the authoritative registry. */
  #fallback = new Map<string, InflightDispatchMeta>();
  /** Per-reason suppression counter — the production-observable metric
   *  (surfaced on the instance heartbeat, mirroring `open_breaker_count`). */
  #suppressCounts = new Map<DispatchSuppressReason, number>();
  /** Keys that already surfaced a suppression activity DURING the current hold,
   *  so a supervisor re-send flood posts one activity per storm-burst rather
   *  than one per dropped trigger. Cleared on the holder's release. */
  #surfaced = new Set<string>();
  /** Keys for which a `force_respawn` trigger was SUPPRESSED while the slot was
   *  held. The fresh-session intent must not be silently dropped (blocker #1):
   *  the holder replays it exactly once on release. */
  #pendingForce = new Set<string>();

  /** Single-flight key. Mirrors TicketSessionManager.#makeKey / the
   *  SubagentManager (ticketId, role, agentId) dedup so the guard keys on the
   *  SAME identity the spawn does; empty role/agent collapse to `_` (so an
   *  unknown-agent trigger still single-flights instead of twinning), and a
   *  distinct non-empty agentId (다중담당자 co-holder) gets a distinct key. */
  static key(ticketId: string, role: string, agentId: string): string {
    return `${ticketId}:${role || '_'}:${agentId || '_'}`;
  }

  /** Atomically claim the process-local FALLBACK slot for `key` (persistent
   *  sessions off). Free → records the holder, returns acquired. Held → returns
   *  not-acquired; the caller suppresses. Pure/synchronous: no `await` between
   *  the `has` and the `set`, so under Node's single thread the check-and-set
   *  cannot interleave with another dispatch. */
  tryAcquireFallback(key: string, meta: InflightDispatchMeta): { acquired: boolean } {
    if (this.#fallback.has(key)) return { acquired: false };
    this.#fallback.set(key, meta);
    return { acquired: true };
  }

  /** Release the process-local fallback slot. Idempotent. */
  releaseFallback(key: string): void {
    this.#fallback.delete(key);
  }

  /** True while the fallback slot holds `key`. Test / observability. */
  isFallbackInflight(key: string): boolean {
    return this.#fallback.has(key);
  }

  /** Record a suppressed twin trigger: bump the reason metric, capture a
   *  force-respawn intent to replay, and decide whether to surface an activity
   *  (throttled to one per hold-burst). Called for BOTH the authoritative and
   *  the fallback reservation paths — the metric/intent are backend-agnostic. */
  recordSuppression(
    reason: DispatchSuppressReason,
    key: string,
    opts: { force: boolean },
  ): { surface: boolean } {
    this.#suppressCounts.set(reason, (this.#suppressCounts.get(reason) ?? 0) + 1);
    if (opts.force) this.#pendingForce.add(key);
    const surface = !this.#surfaced.has(key);
    this.#surfaced.add(key);
    return { surface };
  }

  /** Settle the holder's release: re-arm activity surfacing for the next storm
   *  on this key, and hand back (clearing) any suppressed force-respawn intent
   *  so the caller replays a single fresh respawn. Idempotent per key. */
  onRelease(key: string): { pendingForceRespawn: boolean } {
    this.#surfaced.delete(key);
    const pendingForceRespawn = this.#pendingForce.delete(key);
    return { pendingForceRespawn };
  }

  /** Suppression-reason metric. With no arg, the total across reasons. */
  suppressedCount(reason?: DispatchSuppressReason): number {
    if (reason) return this.#suppressCounts.get(reason) ?? 0;
    let total = 0;
    for (const v of this.#suppressCounts.values()) total += v;
    return total;
  }

  /** Per-reason snapshot for the instance-heartbeat metric field. Empty object
   *  when nothing has been suppressed (so the heartbeat omits a noise field). */
  suppressionCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [reason, n] of this.#suppressCounts) if (n > 0) out[reason] = n;
    return out;
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
