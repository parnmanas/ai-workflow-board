// Per-ticket git worktree isolation, rooted inside the agent's working_dir.
//
// Problem this solves (ticket 9f26f091): a managed agent has ONE working_dir,
// and every (ticket,role) session it runs shares that cwd. The current branch
// is global state of that cwd, so a `git checkout` in one ticket's session
// bleeds into another ticket's session sharing the same agent — commits land
// on the wrong branch when focus flips between tickets (pend/unpend,
// preemption, idle-reap → respawn).
//
// Fix: give each ticket its own dedicated git worktree, checked out from the
// agent's base repo. A branch switch inside one worktree cannot touch another
// worktree's HEAD or working tree, so:
//   - two tickets commit/checkout independent branches concurrently,
//   - a pended ticket's branch + uncommitted changes survive in its own
//     worktree dir while another ticket runs, and resume lands back in it.
//
// The worktree dir is deterministic per ticket, so a fresh spawn after an
// idle-reap reattaches to the SAME worktree (branch + dirty tree intact) — that
// is what makes the focus gain/loss handling fall out for free.
//
// ── worktree 규약 ② (this ticket) ──────────────────────────────────────────
// Where the worktrees live is now FIXED, always inside the agent's working_dir:
//
//     <working_dir>/.awb/wt/<slug>
//
//   - worktree_mode = 'per_ticket' (default) → slug = <ticket8>  (one per ticket)
//   - worktree_mode = 'shared'   → a WARM POOL of slots `shared-0 … shared-<N-1>`
//         (규약 ⑥). N = the board concurrency (max_concurrent_tickets_per_agent,
//         flattened onto the trigger event). A ticket LEASES an idle slot for its
//         whole lifecycle (reattaches across roles / resumes) and RELEASES it
//         (idle-mark only, lazy) at terminal/archive. The NEXT lease RESETS the
//         slot to the base tip before handing it over — `git reset --hard` returns
//         only TRACKED source to the base while UNTRACKED build artifacts (Unity
//         Library/, node_modules, out-of-tree outputs) survive, so the next ticket
//         builds incrementally (warm). Never `git clean -fdx` — that would defeat
//         the whole point. Reset-on-acquire (not on-release) is deliberate: workers
//         die uncleanly (exit-143) all the time, so cleanup can't depend on a tidy
//         handback. Pool size == concurrency and the manager caps concurrent ticket
//         sessions at N (ticket-session-manager), so a lease that clears the gate
//         always finds a free slot — the pool never starves. QA/Security runs use a
//         SEPARATE `.awb/qa/<id8>` clone (run-provisioner), NOT this pool; the
//         "shared" ticket+QA budget is enforced by the server concurrency gate.
//         See #acquireSharedSlot + the on-disk lease registry (.pool-leases.json).
//
// This replaces the old `<MANAGER_HOME>/agents/<id>/worktrees/<ticket>-<role>`
// root that scattered checkouts outside the repo tree. `.awb/` is a dot-prefix
// dir (ignored by Unity-style asset scans) and is auto-registered in the repo's
// `.gitignore` so the nested worktrees never pollute `git status`.
//
// repo-subdir working_dir: when working_dir is a SUBFOLDER of the repo (e.g.
// `<repo>/gameclient/txiv`), a git worktree is always a full repo-root checkout,
// so the worktree is added at `<working_dir>/.awb/wt/<slug>` but the agent's
// actual work directory is that checkout PLUS the repo-root→working_dir subpath
// (`.awb/wt/<slug>/gameclient/txiv`). resolveCwd returns that real work dir as
// `cwd` and exposes the subpath separately (ticket ④ injects it into prompts).
//
// Fallback: when the base working_dir is not a git repo, or `git worktree`
// fails (unsupported/old git, disk error), resolveCwd returns the shared base
// cwd with isWorktree=false. Callers keep the legacy single-cwd behavior in
// that case (and rely on the dispatch-level serialization for safety).

import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { log } from './logging.js';

const GIT_TIMEOUT_MS = 20_000;

/** Board worktree placement mode (mirrors the server's worktree-config enum —
 *  kept as a local literal so agent-manager doesn't depend on the server pkg). */
export type WorktreeMode = 'per_ticket' | 'shared';
export const DEFAULT_WORKTREE_MODE: WorktreeMode = 'per_ticket';

/** Prefix for warm-pool slot dirs in shared mode: `shared-0 … shared-<N-1>`.
 *  The legacy single reused checkout was the literal `shared` — both are treated
 *  as pool members (protected from sweep/terminal removal) by isSharedSlotSeg. */
export const SHARED_SLOT_PREFIX = 'shared-';

/** Warm-pool slot dir name for index i (`shared-0`, `shared-1`, …). */
export function sharedSlotName(i: number): string {
  return `${SHARED_SLOT_PREFIX}${i}`;
}

/** Is this last-path-segment a shared-pool slot (new `shared-<i>` OR the legacy
 *  literal `shared`)? Used so sweep()/removeTicketWorktrees never delete a pool
 *  slot — that would wipe the warm build the pool exists to preserve. */
export function isSharedSlotSeg(seg: string): boolean {
  return seg === 'shared' || seg.startsWith(SHARED_SLOT_PREFIX);
}

/** On-disk warm-pool lease registry (`<working_dir>/.awb/wt/.pool-leases.json`).
 *  Persisted so a manager restart re-reads which ticket owns which slot (resume
 *  reattaches; released slots stay released). Keyed by slot name. */
export interface PoolSlotLease {
  slot: string;
  /** The ticket that currently (active) or last (released) held this slot. */
  ticketId: string;
  /** Role of the last acquire — observability only. */
  role?: string;
  /** true = leased to a ticket that has not reached terminal/archive; false =
   *  released (idle) and awaiting a reset-on-acquire by the next lease. */
  active: boolean;
  leasedAt: string;
  releasedAt?: string;
  /** The slot's checked-out branch captured AT RELEASE — the next acquire deletes
   *  it (`git branch -D`) so stale `ticket/<id>` refs don't accumulate. */
  branch?: string | null;
}

export interface PoolRegistry {
  version: number;
  slots: Record<string, PoolSlotLease>;
}

/**
 * Freshness grace for crash-reclaim: a lease whose `leasedAt` is within this
 * window is NEVER reclaimed, even if no live session/`/proc` owner is visible
 * yet. A slot's lease is written durably (`active=true`) at acquire time, but
 * the worker only becomes visible to the live-session snapshot much later —
 * dispatch first runs environment provisioning (a cold clone of a large repo
 * can take many minutes — see run-provisioner's 20-min git timeout), then
 * fetches ticket context, then spawns the child, which registers in `_sessions`
 * only at the END of spawn. During that whole [lease → child registered] gap the
 * ticket is in neither snapshot and has no `/proc` cwd in the slot yet, so a
 * reconcile tick would otherwise false-reclaim a live-but-still-dispatching
 * worker (the exact failure the ticket forbids — cf. the force_respawn
 * death-loop lesson). The grace covers that provision+spawn upper bound.
 *
 * This does NOT delay the common leak this feature targets: a worker that dies
 * mid-work (exit-143 hours into a build) leased its slot long ago, so its
 * `leasedAt` is already well past the grace and it is reclaimed on the next
 * tick regardless. Only a worker that dies *inside* the dispatch window has its
 * reclaim deferred — by at most one extra tick, which is harmless.
 */
const POOL_LEASE_RECLAIM_GRACE_MS = 20 * 60 * 1000;

function nowIso(): string {
  return new Date().toISOString();
}

/** Fixed worktree root for an agent working_dir: `<working_dir>/.awb/wt`.
 *  Every worktree this manager creates lives directly under it. Exported so the
 *  event-dispatcher (and ticket ④'s prompt injection) can reference the same
 *  root without re-deriving it. */
export function worktreesRootFor(baseWorkingDir: string): string {
  return join(baseWorkingDir, '.awb', 'wt');
}

/** Fixed QA/Security run-workspace root for an agent working_dir:
 *  `<working_dir>/.awb/qa` — mirrors the server's `RUN_WORKSPACE_ROOT` ('.awb/qa',
 *  worktree 규약 ③). Exported so the archive-reclamation path (규약 ⑤) can target
 *  `<root>/<ticket8>` without re-deriving the segment layout. */
export function runWorkspaceRootFor(baseWorkingDir: string): string {
  return join(baseWorkingDir, '.awb', 'qa');
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Thin promisified `git -C <cwd> <args...>`. Never throws — failures come
 *  back as { ok:false }. We avoid util.promisify(execFile) so a non-zero git
 *  exit (expected for "is this a repo?" probes) doesn't reject. */
function git(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: (stdout ?? '').toString(),
          stderr: (stderr ?? (err as any)?.message ?? '').toString(),
        });
      },
    );
  });
}

export interface WorktreeInfo {
  path: string;
  head: string | null;
  branch: string | null; // refs/heads/<x> stripped to <x>; null when detached
  detached: boolean;
}

/** Lease state of a worktree for the observability snapshot.
 *  - allocated: a live worker owns it (or a shared slot leased inside its
 *    dispatch grace window — assumed in-flight, not a leak).
 *  - idle: released / never-leased (shared warm slot) or a per_ticket dir with
 *    no live session.
 *  - orphaned: a shared slot with an ACTIVE lease but no live owner AND past the
 *    reclaim grace — the exact leak reconcilePoolLeases will reclaim. Surfaced so
 *    an operator can spot a stuck lease by eye. */
export type WorktreeState = 'allocated' | 'idle' | 'orphaned';

/** Read-only observability view of one worktree under `<working_dir>/.awb/wt/`,
 *  joined to the pool lease registry. Produced by snapshotWorktrees() for the
 *  instance heartbeat so the admin UI can render "slot → current task". This is
 *  a pure projection — no mutation path consumes it. */
export interface WorktreeSnapshotEntry {
  /** Absolute worktree path (`<working_dir>/.awb/wt/<slot>`). */
  path: string;
  /** Last path segment: `shared-<i>` (shared pool slot) or `<ticket8>` (per_ticket). */
  slot: string;
  mode: WorktreeMode;
  /** Full ticket uuid when known (shared active lease from the registry, or a
   *  live per_ticket dir matched by prefix); null for an idle shared slot and an
   *  idle per_ticket dir (only the 8-char slug is locally known). */
  ticketId: string | null;
  /** Current branch (from `git worktree list --porcelain`); null when detached /
   *  sitting at the base HEAD. */
  branch: string | null;
  state: WorktreeState;
  /** True when a live worker session / subagent currently holds this worktree's ticket. */
  live: boolean;
}

export interface ResolveCwdArgs {
  /** The agent's base repo working_dir (the shared cwd). */
  baseWorkingDir: string;
  ticketId: string;
  /** Kept for logging/observability; no longer part of the worktree path (a
   *  ticket gets ONE worktree that every role of it reuses). */
  role: string;
  /** Board worktree_mode (worktree 규약 ①/②). Defaults to 'per_ticket'. */
  mode?: WorktreeMode;
  /** Warm-pool size for shared mode (규약 ⑥) = the board concurrency
   *  (max_concurrent_tickets_per_agent), flattened onto the trigger event.
   *  Ignored in per_ticket mode. Absent / ≤0 → 1 (a single reused slot, i.e. the
   *  pre-pool behavior). */
  poolSize?: number;
}

export interface ResolveCwdResult {
  /** cwd the child should spawn under — the worktree checkout PLUS the
   *  repo-root→working_dir subpath when working_dir is a repo subfolder. */
  cwd: string;
  /** true when cwd is a dedicated worktree, false when it fell back to base. */
  isWorktree: boolean;
  /** true when an existing worktree was reattached (vs freshly created). */
  reused?: boolean;
  /** populated on fallback so callers can log why isolation was skipped. */
  reason?: string;
  /** the worktree checkout ROOT (`<working_dir>/.awb/wt/<slug>`); undefined on
   *  fallback. Distinct from `cwd` in the repo-subdir case. */
  worktreePath?: string;
  /** repo-root→working_dir relative subpath ('' when working_dir IS the repo
   *  root); undefined on fallback. Ticket ④ injects this into the prompt. */
  workSubpath?: string;
  /** the effective mode used to pick the slug. */
  mode?: WorktreeMode;
}

/** Map a ticket + mode to the worktree dir's last path segment.
 *  per_ticket → the ticket uuid's first 8 chars (unique enough per agent);
 *  shared     → the literal 'shared' (one reused checkout for every ticket). */
export function worktreeSlug(ticketId: string, mode: WorktreeMode = DEFAULT_WORKTREE_MODE): string {
  if (mode === 'shared') return 'shared';
  const t = String(ticketId || '').slice(0, 8).replace(/[^A-Za-z0-9._-]/g, '_');
  return t || 'ticket';
}

export class WorktreeManager {
  #enabled: boolean;
  /** Per-worktree-root serialization for warm-pool acquire/release so two
   *  concurrent triggers can't lease the same idle slot (규약 ⑥). Keyed by the
   *  normalized worktrees root; one chained promise per key. */
  #poolLocks = new Map<string, Promise<unknown>>();

  constructor(opts: { enabled?: boolean } = {}) {
    this.#enabled = opts.enabled !== false;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /**
   * Detach the base repo's primary worktree HEAD when it is sitting on a
   * branch, so ticket worktrees can `git checkout <base-branch>` (a branch is
   * checkable-out in only one worktree at a time). Idempotent — a no-op when
   * HEAD is already detached. Detaching points HEAD at the same commit, so it
   * never touches the working tree or loses the branch ref. Best-effort.
   */
  async #freeBaseBranch(baseWorkingDir: string): Promise<void> {
    // `symbolic-ref -q HEAD` succeeds (and prints refs/heads/<b>) only when on
    // a branch; it exits non-zero on a detached HEAD.
    const onBranch = await git(baseWorkingDir, ['symbolic-ref', '-q', 'HEAD']);
    if (!onBranch.ok) return; // already detached
    const branch = onBranch.stdout.trim().replace(/^refs\/heads\//, '');
    const det = await git(baseWorkingDir, ['checkout', '--detach']);
    if (det.ok) {
      log(
        `[worktree] detached base working_dir HEAD (was ${branch}) so ticket worktrees can check out the base branch: ${baseWorkingDir}`,
      );
    } else {
      log(
        `[worktree] could not detach base HEAD (${det.stderr.trim()}); ticket worktrees should branch off origin/<base> directly`,
      );
    }
  }

  /** Is `dir` the top of (or inside) a git work tree we can add worktrees to? */
  async #isGitWorkTree(dir: string): Promise<boolean> {
    const r = await git(dir, ['rev-parse', '--is-inside-work-tree']);
    return r.ok && r.stdout.trim() === 'true';
  }

  /**
   * Resolve the repo root + the working_dir's position within it, so a
   * working_dir that is a repo SUBFOLDER still gets a repo-root checkout with
   * the real work path computed on top. Returns null when not resolvable.
   * `workSubpath` is forward-slash, no trailing slash, '' at the repo root.
   */
  async #resolveRepoContext(
    baseWorkingDir: string,
  ): Promise<{ repoRoot: string; workSubpath: string } | null> {
    const top = await git(baseWorkingDir, ['rev-parse', '--show-toplevel']);
    if (!top.ok || !top.stdout.trim()) return null;
    const repoRoot = top.stdout.trim();
    const pfx = await git(baseWorkingDir, ['rev-parse', '--show-prefix']);
    const workSubpath = pfx.ok ? pfx.stdout.trim().replace(/[/\\]+$/, '') : '';
    return { repoRoot, workSubpath };
  }

  /**
   * Ensure `.awb/` is git-ignored in the repo so the nested worktrees under
   * `<working_dir>/.awb/wt/` don't show up as untracked in `git status`.
   * Idempotent: skips entirely when `.awb` is already ignored (committed
   * `.gitignore`, global excludes, or a prior run's append). Appends `.awb/`
   * (unanchored — matches at any depth, so it covers a repo-subdir working_dir)
   * to the repo-root `.gitignore` otherwise. Best-effort; never throws.
   */
  async #ensureAwbIgnored(repoRoot: string, workSubpath: string): Promise<void> {
    try {
      // The actual `.awb` dir relative to the repo root — repo-subdir aware.
      const rel = workSubpath ? `${workSubpath.replace(/\\/g, '/')}/.awb` : '.awb';
      const check = await git(repoRoot, ['check-ignore', '-q', rel]);
      if (check.ok) return; // already ignored — nothing to do
      const giPath = join(repoRoot, '.gitignore');
      let content = '';
      try {
        content = await fsp.readFile(giPath, 'utf8');
      } catch {
        // no .gitignore yet — we'll create it
      }
      const already = content.split(/\r?\n/).some((l) => {
        const t = l.trim();
        return t === '.awb' || t === '.awb/' || t === '/.awb' || t === '/.awb/';
      });
      if (already) return;
      const sep = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
      await fsp.writeFile(giPath, `${content}${sep}.awb/\n`, 'utf8');
      log(`[worktree] registered .awb/ in ${giPath} (worktree isolation dir)`);
    } catch (err: any) {
      log(`[worktree] could not ensure .awb/ ignored under ${repoRoot}: ${err?.message ?? err}`);
    }
  }

  /** Parse `git worktree list --porcelain`. Returns [] on any failure. */
  async listWorktrees(baseWorkingDir: string): Promise<WorktreeInfo[]> {
    const r = await git(baseWorkingDir, ['worktree', 'list', '--porcelain']);
    if (!r.ok) return [];
    const out: WorktreeInfo[] = [];
    let cur: WorktreeInfo | null = null;
    for (const rawLine of r.stdout.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      if (line.startsWith('worktree ')) {
        if (cur) out.push(cur);
        cur = { path: line.slice('worktree '.length), head: null, branch: null, detached: false };
      } else if (!cur) {
        continue;
      } else if (line.startsWith('HEAD ')) {
        cur.head = line.slice('HEAD '.length);
      } else if (line.startsWith('branch ')) {
        cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
      } else if (line === 'detached') {
        cur.detached = true;
      } else if (line === '') {
        if (cur) {
          out.push(cur);
          cur = null;
        }
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  /** Best-effort `git worktree prune` — drops registrations whose dir vanished.
   *  Safe to call often; never throws. */
  async prune(baseWorkingDir: string): Promise<void> {
    if (!this.#enabled) return;
    await git(baseWorkingDir, ['worktree', 'prune']).catch(() => {});
  }

  /**
   * Resolve the cwd a ticket's child should spawn under. Reattaches to an
   * existing worktree when present (preserving its branch + dirty tree),
   * creates one otherwise, and falls back to the shared base cwd when worktree
   * isolation is unavailable. The worktree always lands under
   * `<working_dir>/.awb/wt/`; a repo-subdir working_dir gets the real work path
   * (checkout + subpath) back as `cwd`.
   */
  async resolveCwd(args: ResolveCwdArgs): Promise<ResolveCwdResult> {
    const { baseWorkingDir, ticketId, role } = args;
    const mode: WorktreeMode = args.mode === 'shared' ? 'shared' : 'per_ticket';
    const fallback = (reason: string): ResolveCwdResult => ({
      cwd: baseWorkingDir,
      isWorktree: false,
      reason,
    });

    if (!this.#enabled) return fallback('disabled');
    if (!baseWorkingDir) return fallback('no_base_dir');
    // Both modes key a lease/slug on the ticket id, so it is required for either.
    if (!ticketId) return fallback('no_ticket');

    if (!(await this.#isGitWorkTree(baseWorkingDir))) {
      return fallback('not_a_git_repo');
    }

    const repoCtx = await this.#resolveRepoContext(baseWorkingDir);
    if (!repoCtx) return fallback('no_repo_root');
    const { repoRoot, workSubpath } = repoCtx;
    const withSub = (p: string) => (workSubpath ? join(p, workSubpath) : p);

    const worktreesRoot = worktreesRootFor(baseWorkingDir);

    // Keep the nested worktrees out of `git status` (and out of Unity scans).
    await this.#ensureAwbIgnored(repoRoot, workSubpath);

    // Drop stale registrations first so a worktree whose dir was manually
    // removed doesn't block recreating it here.
    await this.prune(baseWorkingDir);

    // ── shared: lease a warm-pool slot (규약 ⑥) ─────────────────────────────
    if (mode === 'shared') {
      return this.#acquireSharedSlot({
        baseWorkingDir,
        worktreesRoot,
        ticketId,
        role,
        poolSize: args.poolSize,
        workSubpath,
        withSub,
        fallback,
      });
    }

    // ── per_ticket: one dedicated worktree named `<ticket8>` ────────────────
    const wtPath = join(worktreesRoot, worktreeSlug(ticketId, mode));
    const ens = await this.#ensureWorktree(baseWorkingDir, worktreesRoot, wtPath);
    if (!ens.ok) {
      if (ens.reason === 'add_failed') {
        log(
          `[worktree] add failed for ticket=${String(ticketId).slice(0, 8)} role=${role} mode=${mode}: ${ens.detail ?? ''} — falling back to base cwd`,
        );
      }
      return fallback(ens.reason ?? 'worktree_unavailable');
    }
    if (ens.created) {
      log(
        `[worktree] created ${wtPath} for ticket=${String(ticketId).slice(0, 8)} role=${role} mode=${mode}${workSubpath ? ` subpath=${workSubpath}` : ''} (detached at base HEAD)`,
      );
    }
    return {
      cwd: withSub(wtPath),
      isWorktree: true,
      reused: !ens.created,
      worktreePath: wtPath,
      workSubpath,
      mode,
    };
  }

  /**
   * Materialize the worktree at `wtPath`: reattach to an existing registered
   * worktree (the resume path — branch + dirty tree the prior session left
   * behind), or create a fresh detached checkout at the base repo's HEAD. We
   * deliberately do NOT check out a named branch (a branch can live in only one
   * worktree; the column workflow creates its own `ticket/<id>` branch here).
   * Never throws — failures come back as { ok:false, reason }. Assumes the
   * caller has already run `prune`. Shared by the per_ticket path and each
   * warm-pool slot in #acquireSharedSlot.
   */
  async #ensureWorktree(
    baseWorkingDir: string,
    worktreesRoot: string,
    wtPath: string,
  ): Promise<{ ok: boolean; created: boolean; reason?: string; detail?: string }> {
    const existing = (await this.listWorktrees(baseWorkingDir)).find((w) =>
      samePath(w.path, wtPath),
    );
    if (existing) {
      try {
        const st = await fsp.stat(wtPath);
        if (st.isDirectory()) return { ok: true, created: false };
      } catch {
        // Registered but dir is gone — prune already ran; fall through to add.
      }
    }

    // If the dir exists but isn't a registered worktree, we don't know what's
    // in it — refuse to clobber.
    if (!existing && (await pathExists(wtPath))) {
      log(
        `[worktree] path exists but is not a registered worktree, falling back to base cwd: ${wtPath}`,
      );
      return { ok: false, created: false, reason: 'path_conflict' };
    }

    try {
      await fsp.mkdir(worktreesRoot, { recursive: true });
    } catch (err: any) {
      return { ok: false, created: false, reason: `mkdir_failed:${err?.message ?? err}` };
    }

    // Free the base branch: the column workflow guide tells the agent to
    // `git checkout <base-branch> && git pull` first, but a branch can be
    // checked out in only ONE worktree. Detaching the base HEAD (no file
    // changes — same commit) frees the branch. Best-effort.
    await this.#freeBaseBranch(baseWorkingDir);

    const add = await git(baseWorkingDir, ['worktree', 'add', '--detach', wtPath]);
    if (!add.ok) {
      return { ok: false, created: false, reason: 'add_failed', detail: add.stderr.trim() };
    }
    return { ok: true, created: true };
  }

  // ── warm-pool (shared mode, 규약 ⑥) ──────────────────────────────────────

  /**
   * Lease a warm-pool slot for a shared-mode ticket. Serialized per worktrees
   * root so two triggers never grab the same idle slot. Three outcomes:
   *   - Reattach: this ticket already owns a slot → return it, no reset (its
   *     branch + tree survive — resume / next role / follow-up turn).
   *   - Fresh lease: pick an idle slot (a released one first — it's warm — else
   *     an unused index), reset-on-acquire it (tracked source → base tip;
   *     untracked build artifacts preserved), and record the lease.
   *   - Pool exhausted: no idle slot in [0, N). The invariant (N == concurrency,
   *     the ticket cap holds concurrent ticket sessions ≤ N) makes this
   *     unreachable in normal operation; a leaked dead-worker lease can still
   *     exhaust it (crash reclaim is a follow-up ticket). Safe fallback: base cwd.
   */
  async #acquireSharedSlot(a: {
    baseWorkingDir: string;
    worktreesRoot: string;
    ticketId: string;
    role: string;
    poolSize?: number;
    workSubpath: string;
    withSub: (p: string) => string;
    fallback: (reason: string) => ResolveCwdResult;
  }): Promise<ResolveCwdResult> {
    const N = Math.max(1, Math.floor(a.poolSize && a.poolSize > 0 ? a.poolSize : 1));
    const t8 = String(a.ticketId).slice(0, 8);
    const result = (wtPath: string, reused: boolean): ResolveCwdResult => ({
      cwd: a.withSub(wtPath),
      isWorktree: true,
      reused,
      worktreePath: wtPath,
      workSubpath: a.workSubpath,
      mode: 'shared',
    });

    return this.#withPoolLock(a.worktreesRoot, async () => {
      const reg = await this.#readRegistry(a.worktreesRoot);

      // 1. Reattach — this ticket already holds a slot (active OR released; a
      //    released ticket re-triggering keeps its own tree, no reset).
      const mine = Object.keys(reg.slots).find((s) => reg.slots[s].ticketId === a.ticketId);
      if (mine) {
        const wtPath = join(a.worktreesRoot, mine);
        const ens = await this.#ensureWorktree(a.baseWorkingDir, a.worktreesRoot, wtPath);
        if (ens.ok) {
          reg.slots[mine].active = true;
          reg.slots[mine].role = a.role;
          // Refresh leasedAt on reattach too: a re-dispatch (idle-reap respawn,
          // pend/unpend) reopens the same [lease → child registered] gap, and the
          // reclaim freshness grace keys off leasedAt. Without this, a slot whose
          // leasedAt is stale (worker was reaped long ago) would be reclaimable
          // during its re-spawn window before the new child registers a session.
          reg.slots[mine].leasedAt = nowIso();
          delete reg.slots[mine].releasedAt;
          await this.#writeRegistry(a.worktreesRoot, reg);
          return result(wtPath, !ens.created);
        }
        // Owned slot can't be materialized (dir clobbered by a non-worktree,
        // add failed) — drop the stale lease and fall through to a fresh pick.
        delete reg.slots[mine];
      }

      // 2. Fresh lease — classify slots [0, N): prefer a released (warm) slot,
      //    else an unused index.
      let resetIdx = -1;
      let freshIdx = -1;
      for (let i = 0; i < N; i++) {
        const lease = reg.slots[sharedSlotName(i)];
        if (lease && lease.active) continue; // held by a live ticket — never touch
        if (lease) {
          if (resetIdx < 0) resetIdx = i; // released → warm, reuse first
        } else if (freshIdx < 0) {
          freshIdx = i; // never used
        }
      }
      const pick = resetIdx >= 0 ? resetIdx : freshIdx;
      if (pick < 0) {
        log(
          `[worktree] shared pool exhausted (N=${N}) for ticket=${t8} — every slot is an active lease; falling back to base cwd`,
        );
        return a.fallback('pool_exhausted');
      }

      const slotName = sharedSlotName(pick);
      const wtPath = join(a.worktreesRoot, slotName);
      const prevLease = reg.slots[slotName];
      const ens = await this.#ensureWorktree(a.baseWorkingDir, a.worktreesRoot, wtPath);
      if (!ens.ok) return a.fallback(ens.reason ?? 'worktree_unavailable');

      // Reset-on-acquire: hand a clean TRACKED tree at the base tip while keeping
      // UNTRACKED warm-build artifacts. A brand-new dir is already clean at base
      // HEAD, so it only needs the stale recorded branch dropped.
      await this.#resetSlotOnAcquire(a.baseWorkingDir, wtPath, {
        fullReset: !ens.created,
        recordedBranch: prevLease?.branch ?? null,
      });

      reg.slots[slotName] = {
        slot: slotName,
        ticketId: a.ticketId,
        role: a.role,
        active: true,
        leasedAt: nowIso(),
      };
      await this.#writeRegistry(a.worktreesRoot, reg);
      log(
        `[worktree] leased shared pool slot ${slotName} (${resetIdx >= 0 ? 'reset warm' : 'fresh'}) to ticket=${t8} role=${a.role} of N=${N}`,
      );
      return result(wtPath, !ens.created);
    });
  }

  /**
   * Reset a pool slot back to the base tip before handing it to a new lease.
   * `git reset --hard` restores TRACKED source only — UNTRACKED build artifacts
   * (Unity Library/, node_modules, out-of-tree outputs) survive, so the next
   * ticket builds warm. NEVER `git clean` — that would wipe exactly what makes
   * the pool valuable. Detaches HEAD first so a hard-reset can't be blocked by
   * (and the prior work branch can be deleted despite) a checked-out branch. All
   * steps best-effort; a git failure degrades to "slightly less clean", never a
   * throw.
   */
  async #resetSlotOnAcquire(
    baseWorkingDir: string,
    slotPath: string,
    opts: { fullReset: boolean; recordedBranch: string | null },
  ): Promise<void> {
    const base = await this.#detectBaseBranch(baseWorkingDir);
    // The branch the dead/prior occupant left checked out — delete it too.
    const liveHead = await git(slotPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const liveBranch = liveHead.ok ? liveHead.stdout.trim() : '';

    if (opts.fullReset) {
      // Detach at the current commit (no file changes → safe on a dirty tree),
      // freeing the branch so `reset --hard` and `branch -D` below can proceed.
      await git(slotPath, ['checkout', '--detach']);
      let resetOk = false;
      if (base) {
        const r = await git(slotPath, ['reset', '--hard', `origin/${base}`]);
        resetOk = r.ok;
      }
      if (!resetOk) {
        // origin/<base> unresolvable (no remote / stale) → fall back to the base
        // repo's current HEAD commit, which is where fresh slots start anyway.
        const head = await git(baseWorkingDir, ['rev-parse', 'HEAD']);
        if (head.ok && head.stdout.trim()) {
          await git(slotPath, ['reset', '--hard', head.stdout.trim()]);
        }
      }
    }

    // Drop the prior occupant's work branch(es) so `ticket/<id>` refs don't pile
    // up. Safe: release only happens at terminal (work merged) / archive (work
    // abandoned). `-D` is best-effort — a no-op when already deleted by Merging.
    // Base-branch guard: also skip the `main`/`master` literals unconditionally,
    // not just the detected `base`. When #detectBaseBranch returns null (no
    // remote), `b !== base` is `b !== null` — always true — so a slot that ever
    // sat on `main` could get `branch -D main`. Protecting the literals closes
    // that (crash-reclaim hardening requested in the ticket 83b2d43b review).
    const protectedBranches = new Set(
      ['HEAD', base, 'main', 'master'].filter((x): x is string => !!x),
    );
    for (const b of new Set([liveBranch, opts.recordedBranch ?? ''])) {
      if (b && !protectedBranches.has(b)) {
        await git(slotPath, ['branch', '-D', b]);
      }
    }
  }

  /**
   * Determine the repo's base branch name (typically `main` / `master`) for the
   * reset-on-acquire target. Prefers the remote's default (`origin/HEAD`), then
   * probes `origin/main` / `origin/master`. Returns null when none resolves (the
   * caller then falls back to the base repo HEAD). Never throws.
   */
  async #detectBaseBranch(baseWorkingDir: string): Promise<string | null> {
    const sym = await git(baseWorkingDir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    if (sym.ok) {
      const b = sym.stdout.trim().replace(/^origin\//, '');
      if (b) return b;
    }
    for (const cand of ['main', 'master']) {
      const ref = await git(baseWorkingDir, [
        'show-ref',
        '--verify',
        '--quiet',
        `refs/remotes/origin/${cand}`,
      ]);
      if (ref.ok) return cand;
    }
    return null;
  }

  /**
   * Release the pool slot a shared-mode ticket holds — LAZY: mark it idle and
   * record its current branch (for the next acquire's `branch -D`), but do NOT
   * reset or remove it. The reset is deferred to the next acquire so cleanup
   * never depends on a tidy handback (workers die on exit-143 mid-work). No-op
   * (returns 0) when the ticket holds no active slot. Never throws.
   */
  async #releaseSharedSlot(baseWorkingDir: string, ticketId: string): Promise<number> {
    const worktreesRoot = worktreesRootFor(baseWorkingDir);
    return this.#withPoolLock(worktreesRoot, async () => {
      const reg = await this.#readRegistry(worktreesRoot);
      const key = Object.keys(reg.slots).find(
        (s) => reg.slots[s].ticketId === ticketId && reg.slots[s].active,
      );
      if (!key) return 0;
      const wtPath = join(worktreesRoot, key);
      let branch: string | null = null;
      const hb = await git(wtPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
      if (hb.ok) {
        const b = hb.stdout.trim();
        if (b && b !== 'HEAD') branch = b;
      }
      reg.slots[key] = { ...reg.slots[key], active: false, releasedAt: nowIso(), branch };
      await this.#writeRegistry(worktreesRoot, reg);
      log(
        `[worktree] released shared pool slot ${key} for ticket=${String(ticketId).slice(0, 8)} (idle; reset deferred to next acquire)`,
      );
      return 1;
    });
  }

  /**
   * Crash-tolerant lease reclaim (this ticket): reconcile the persisted lease
   * registry against the set of live ticket workers, flipping any ACTIVE lease
   * whose owner is no longer alive back to IDLE. This closes the leak that
   * reset-on-acquire alone can't: a worker that dies uncleanly (exit-143 /
   * crash) BEFORE its ticket reaches terminal/archive never runs the release
   * path (#releaseSharedSlot), so its slot stays `active` forever and the pool
   * eventually starves (`pool_exhausted`).
   *
   * The persisted registry is the source of truth; `liveTicketIds` is the
   * caller's live-worker view — the union of the manager's live ticket sessions
   * and one-shot subagents (the same snapshots the worktree sweep reuses, kept
   * honest against the OS by _getLiveSession / #reconcileOnStart). A lease is an
   * orphan candidate when its ticket is `active` in the registry but ABSENT from
   * that live set. We trust this OS/output-liveness view, NOT a ticket's
   * my_last_update_at — the force_respawn death-loop lesson (fdc69c13): a live
   * but quiet worker still holds a live session, so it stays in the snapshot and
   * is never mistaken for dead.
   *
   * Safety belt (규약: never false-reclaim a live worker): before reclaiming, a
   * best-effort `/proc/<pid>/cwd` scan (#liveProcessCwds) spares any slot a live
   * process is still working INSIDE. This covers a detached persistent ticket
   * child that outlived a manager restart but isn't yet re-registered in
   * `_sessions` at boot — its cwd still points at the slot, so it survives.
   *
   * Reclaim is a pure STATE FLIP: mark idle + record the slot's branch for the
   * next acquire's `branch -D`. The slot dir (and its untracked warm build) is
   * NEVER touched — the reset-on-acquire the next lease runs does the cleanup.
   * Serialized under the same per-root pool lock as acquire/release. Returns the
   * number of leases reclaimed. Never throws.
   */
  async reconcilePoolLeases(opts: {
    baseWorkingDir: string;
    liveTicketIds: Set<string>;
  }): Promise<number> {
    if (!this.#enabled) return 0;
    const { baseWorkingDir, liveTicketIds } = opts;
    if (!baseWorkingDir) return 0;
    const worktreesRoot = worktreesRootFor(baseWorkingDir);
    return this.#withPoolLock(worktreesRoot, async () => {
      const reg = await this.#readRegistry(worktreesRoot);
      const now = Date.now();
      // Orphan candidates: active leases with no live owner. A per_ticket board
      // has an empty registry → no candidates → cheap no-op (no /proc scan).
      // Freshness grace (POOL_LEASE_RECLAIM_GRACE_MS): skip a lease still within
      // its dispatch window — the worker may be provisioning/spawning and just
      // not yet in the live-session snapshot (never false-reclaim a live worker).
      // An unparseable leasedAt falls through to a candidate; the /proc belt is
      // the final safety net there.
      const candidates = Object.keys(reg.slots).filter((s) => {
        const lease = reg.slots[s];
        if (!lease.active || liveTicketIds.has(lease.ticketId)) return false;
        const leasedMs = Date.parse(lease.leasedAt);
        if (Number.isFinite(leasedMs) && now - leasedMs < POOL_LEASE_RECLAIM_GRACE_MS) {
          return false;
        }
        return true;
      });
      if (candidates.length === 0) return 0;

      // Secondary guard — spare any slot a live process is still cwd'd inside
      // (a detached child that outlived a restart before the session map was
      // rebuilt). Best-effort; empty on non-Linux / failure → snapshot-only.
      const liveCwds = (await this.#liveProcessCwds()).map(normPath);
      const inUse = (slotPath: string): boolean => {
        const p = normPath(slotPath);
        // === covers working_dir==repo-root; startsWith covers a repo-subdir
        // working_dir (child cwd is `<slot>/<subpath>`, strictly under the slot).
        return liveCwds.some((c) => c === p || c.startsWith(p + '/'));
      };

      let reclaimed = 0;
      for (const slot of candidates) {
        const lease = reg.slots[slot];
        const t8 = String(lease.ticketId).slice(0, 8);
        const wtPath = join(worktreesRoot, slot);
        // `/proc/<pid>/cwd` is kernel-canonicalized, so compare against the slot's
        // realpath (working_dir / .awb may sit under a symlink). Dir gone → the
        // raw path, and inUse is false anyway (no live cwd in a vanished dir).
        let realWt = wtPath;
        try {
          realWt = await fsp.realpath(wtPath);
        } catch {
          /* slot dir pruned/removed — nothing can be cwd'd inside it */
        }
        if (inUse(realWt)) {
          log(
            `[worktree] pool reclaim SKIP slot ${slot} ticket=${t8} — a live process is still working in it (not in session snapshot but OS-alive)`,
          );
          continue;
        }
        // Record the branch the dead occupant left so the next acquire drops it
        // (falls back to the already-recorded branch when the dir is gone).
        let branch: string | null = lease.branch ?? null;
        const hb = await git(wtPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
        if (hb.ok) {
          const b = hb.stdout.trim();
          branch = b && b !== 'HEAD' ? b : null;
        }
        reg.slots[slot] = { ...lease, active: false, releasedAt: nowIso(), branch };
        reclaimed++;
        log(
          `[worktree] pool reclaim slot ${slot} — orphaned lease from dead ticket=${t8} flipped to idle (reset deferred to next acquire)`,
        );
      }
      if (reclaimed > 0) await this.#writeRegistry(worktreesRoot, reg);
      return reclaimed;
    });
  }

  /**
   * Read-only observability snapshot of every worktree under this working_dir's
   * `<working_dir>/.awb/wt/` root, joined to the pool lease registry so the admin
   * UI can render "which slot / folder holds which task" (ticket 72fc244f). Pure
   * projection — never mutates state and never throws (a failure yields []).
   * Best-effort; called on the instance-heartbeat clock (30s), so it stays cheap:
   * one `git worktree list` + one registry read per working_dir.
   *
   * SHARED mode — the lease registry (`.pool-leases.json`) is the source of truth
   * for slot→ticket. An active lease with a live owner → 'allocated'; an active
   * lease with no live owner but still inside the reclaim grace → 'allocated'
   * (assumed mid-dispatch, not a leak); an active lease past the grace with no
   * owner → 'orphaned' (the exact lease reconcilePoolLeases reclaims). A
   * released/absent lease → 'idle' (warm slot awaiting the next acquire's reset).
   *
   * PER_TICKET mode — no lease record exists; the dir `<ticket8>` IS the task.
   * 'allocated' when a live worker session owns it (matched by id prefix), else
   * 'idle'. Only a live per_ticket dir yields a full ticket uuid; an idle one is
   * reported with ticketId=null (only the 8-char slug is locally knowable).
   *
   * QA/Security run workspaces are a SEPARATE `.awb/qa/<id8>` clone (not a git
   * worktree of this repo), so they never appear in `git worktree list` and are
   * intentionally out of scope here.
   */
  async snapshotWorktrees(opts: {
    baseWorkingDir: string;
    liveTicketIds: Set<string>;
  }): Promise<WorktreeSnapshotEntry[]> {
    if (!this.#enabled) return [];
    const { baseWorkingDir, liveTicketIds } = opts;
    if (!baseWorkingDir) return [];
    const worktreesRoot = worktreesRootFor(baseWorkingDir);
    try {
      // Read the lease registry under the pool lock so we never observe a
      // half-written file mid-acquire. listWorktrees is a read-only git call and
      // needs no lock.
      const reg = await this.#withPoolLock(worktreesRoot, () =>
        this.#readRegistry(worktreesRoot),
      );
      const wts = await this.listWorktrees(baseWorkingDir);
      // Keep only worktrees strictly under `.awb/wt` (drops the main checkout).
      const bySlot = new Map<string, WorktreeInfo>();
      for (const w of wts) {
        if (!isUnder(w.path, worktreesRoot)) continue;
        bySlot.set(lastSegment(w.path), w);
      }
      // Union of on-disk slots and registry slots — a lease pointing at a
      // vanished dir is itself a leak worth surfacing.
      const slots = new Set<string>([...bySlot.keys(), ...Object.keys(reg.slots)]);
      const now = Date.now();
      const out: WorktreeSnapshotEntry[] = [];
      for (const slot of slots) {
        const wt = bySlot.get(slot) ?? null;
        const path = wt?.path ?? join(worktreesRoot, slot);
        if (isSharedSlotSeg(slot)) {
          const lease = reg.slots[slot] ?? null;
          const active = lease?.active === true;
          const ticketId = active ? lease!.ticketId : null;
          const live = active && !!ticketId && liveTicketIds.has(ticketId);
          let state: WorktreeState = 'idle';
          if (active) {
            const leasedMs = lease ? Date.parse(lease.leasedAt) : NaN;
            const withinGrace =
              Number.isFinite(leasedMs) && now - leasedMs < POOL_LEASE_RECLAIM_GRACE_MS;
            state = live || withinGrace ? 'allocated' : 'orphaned';
          }
          out.push({
            path,
            slot,
            mode: 'shared',
            ticketId,
            branch: wt?.branch ?? lease?.branch ?? null,
            state,
            live,
          });
        } else {
          // per_ticket: slug is the ticket's first 8 chars. The full id is only
          // knowable when a live session holds it.
          const fullLive = [...liveTicketIds].find((id) => id.slice(0, 8) === slot) ?? null;
          const live = !!fullLive;
          out.push({
            path,
            slot,
            mode: 'per_ticket',
            ticketId: fullLive,
            branch: wt?.branch ?? null,
            state: live ? 'allocated' : 'idle',
            live,
          });
        }
      }
      // Stable order: shared pool slots first (numeric by index), then per_ticket
      // dirs by slug — deterministic so the UI list doesn't jitter between ticks.
      out.sort((a, b) => {
        if (a.mode !== b.mode) return a.mode === 'shared' ? -1 : 1;
        return a.slot.localeCompare(b.slot, undefined, { numeric: true });
      });
      return out;
    } catch (err: any) {
      log(`[worktree] snapshotWorktrees failed under ${worktreesRoot}: ${err?.message ?? err}`);
      return [];
    }
  }

  /**
   * Best-effort snapshot of the cwd of every live process (Linux
   * `/proc/<pid>/cwd`). Used by reconcilePoolLeases as an OS-liveness cross-check
   * so a slot a live process is still working in is never reclaimed. Returns []
   * on non-Linux or any read failure (the caller then relies on the live-session
   * snapshot alone). Mirrors subagent-manager's `/proc` scan — same host
   * assumption. Never throws.
   */
  async #liveProcessCwds(): Promise<string[]> {
    if (process.platform !== 'linux') return [];
    let entries: string[];
    try {
      entries = await fsp.readdir('/proc');
    } catch {
      return [];
    }
    const cwds: string[] = [];
    await Promise.all(
      entries.map(async (e) => {
        if (!/^\d+$/.test(e)) return; // only numeric pid dirs
        try {
          cwds.push(await fsp.readlink(`/proc/${e}/cwd`));
        } catch {
          /* process gone between readdir and readlink, or EPERM — skip */
        }
      }),
    );
    return cwds;
  }

  #registryPath(worktreesRoot: string): string {
    return join(worktreesRoot, '.pool-leases.json');
  }

  /** Read the on-disk lease registry; a missing / malformed file yields an empty
   *  registry (so a per_ticket board never spuriously creates one). Never throws. */
  async #readRegistry(worktreesRoot: string): Promise<PoolRegistry> {
    try {
      const raw = await fsp.readFile(this.#registryPath(worktreesRoot), 'utf8');
      const parsed = JSON.parse(raw);
      const slots: Record<string, PoolSlotLease> = {};
      if (parsed && typeof parsed === 'object' && parsed.slots && typeof parsed.slots === 'object') {
        for (const [k, v] of Object.entries(parsed.slots as Record<string, any>)) {
          if (v && typeof v.ticketId === 'string' && v.ticketId) {
            slots[k] = {
              slot: k,
              ticketId: v.ticketId,
              role: typeof v.role === 'string' ? v.role : undefined,
              active: v.active === true,
              leasedAt: typeof v.leasedAt === 'string' ? v.leasedAt : '',
              releasedAt: typeof v.releasedAt === 'string' ? v.releasedAt : undefined,
              branch:
                typeof v.branch === 'string' ? v.branch : v.branch === null ? null : undefined,
            };
          }
        }
      }
      return { version: 1, slots };
    } catch {
      return { version: 1, slots: {} };
    }
  }

  /** Persist the lease registry under `<worktreesRoot>/.pool-leases.json`
   *  (inside the gitignored `.awb/`). Best-effort; never throws. */
  async #writeRegistry(worktreesRoot: string, reg: PoolRegistry): Promise<void> {
    try {
      await fsp.mkdir(worktreesRoot, { recursive: true });
      await fsp.writeFile(
        this.#registryPath(worktreesRoot),
        JSON.stringify({ version: 1, slots: reg.slots }, null, 2) + '\n',
        'utf8',
      );
    } catch (err: any) {
      log(`[worktree] pool lease registry write failed under ${worktreesRoot}: ${err?.message ?? err}`);
    }
  }

  /** Serialize an async op per worktrees root (one chained promise per key). */
  async #withPoolLock<T>(worktreesRoot: string, fn: () => Promise<T>): Promise<T> {
    const key = normPath(worktreesRoot);
    const prev = this.#poolLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    this.#poolLocks.set(key, prev.then(() => gate));
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Force-remove a ticket's worktree, regardless of dirty state. This is the
   * terminal-ticket reclamation path (ticket 9f26f091 acceptance (d)): once a
   * ticket reaches a terminal column (done/merged) its work is committed to its
   * branch (or already merged), so the checkout is disposable — the branch ref
   * survives in the repo even after the worktree is gone. Unlike `sweep()`,
   * this deliberately ignores a dirty tree: in this repo a worktree goes
   * permanently dirty after any build (untracked tsbuildinfo / database dir),
   * so a dirty-preserving sweep would never reclaim a terminal ticket's tree.
   *
   * Matches the worktree dir whose last path segment is the ticket's `<ticket8>`
   * (tolerating a legacy `<ticket8>-<role>` suffix). A shared-pool slot
   * (`shared-<i>` / legacy `shared`) never matches — it is reused across tickets
   * and must survive a terminal ticket (규약 ⑥); instead this RELEASES the
   * shared-mode ticket's pool slot (idle-mark, lazy — the reset happens at the
   * next acquire). Confined to `<working_dir>/.awb/wt` so the agent's main
   * worktree is never touched. Returns the number of per_ticket worktrees
   * physically removed (a released pool slot is not a removal). Never throws.
   */
  async removeTicketWorktrees(opts: {
    baseWorkingDir: string;
    ticketId: string;
  }): Promise<number> {
    if (!this.#enabled) return 0;
    const { baseWorkingDir, ticketId } = opts;
    if (!baseWorkingDir || !ticketId) return 0;
    if (!(await this.#isGitWorkTree(baseWorkingDir))) return 0;
    const worktreesRoot = worktreesRootFor(baseWorkingDir);
    const ticket8 = String(ticketId).slice(0, 8);
    const legacyPrefix = `${ticket8}-`;
    await this.prune(baseWorkingDir);
    const worktrees = await this.listWorktrees(baseWorkingDir);
    let removed = 0;
    for (const w of worktrees) {
      if (!isUnder(w.path, worktreesRoot)) continue; // never the main worktree
      const seg = lastSegment(w.path);
      if (isSharedSlotSeg(seg)) continue; // pool slot — released below, not removed
      // per_ticket dir == <ticket8>; skip unrelated tickets.
      if (seg !== ticket8 && !seg.startsWith(legacyPrefix)) continue;
      const r = await git(baseWorkingDir, ['worktree', 'remove', '--force', w.path]);
      if (r.ok || /is not a working tree|No such file/i.test(r.stderr)) {
        removed++;
        log(`[worktree] removed terminal-ticket worktree ${w.path}`);
      } else {
        log(`[worktree] terminal remove failed ${w.path}: ${r.stderr.trim()}`);
      }
    }
    if (removed > 0) await this.prune(baseWorkingDir);
    // Shared mode: this ticket held a warm-pool slot (not a per_ticket dir) —
    // release it (idle-mark) so the next lease can reset + reuse it. No-op for a
    // per_ticket ticket (no matching lease → empty registry read, nothing written).
    await this.#releaseSharedSlot(baseWorkingDir, ticketId).catch(() => {});
    return removed;
  }

  /**
   * worktree 규약 ⑤: best-effort removal of a ticket's per-ticket QA/Security
   * run workspace (`<working_dir>/.awb/qa/<ticket8>`), invoked when the ticket is
   * ARCHIVED. Unlike a worktree this is a plain directory rm — a run workspace is
   * not a registered git worktree, it's a checkout the run provisioner clones
   * into, so `git worktree remove` doesn't apply. Strongly guarded: the target
   * is always `<runRoot>/<ticket8>` and must sit strictly UNDER
   * `<working_dir>/.awb/qa` (never the qa root itself, never anything outside
   * `.awb/`). Returns true when a dir was removed. Never throws.
   *
   * Note: run workspaces are keyed by QA scenario / security profile id (id8),
   * not by ticket id, so for an ordinary dev ticket this is a no-op (no such
   * dir). It's kept so archive reclaims everything a ticket could have used and
   * stays symmetric with removeTicketWorktrees.
   */
  async removeTicketRunWorkspace(opts: {
    baseWorkingDir: string;
    ticketId: string;
  }): Promise<boolean> {
    if (!this.#enabled) return false;
    const { baseWorkingDir, ticketId } = opts;
    if (!baseWorkingDir || !ticketId) return false;
    const runRoot = runWorkspaceRootFor(baseWorkingDir);
    const ticket8 = String(ticketId).slice(0, 8).replace(/[^A-Za-z0-9._-]/g, '_');
    if (!ticket8) return false;
    const target = join(runRoot, ticket8);
    // Guard: only ever remove a dir strictly under `<working_dir>/.awb/qa`.
    if (!isUnder(target, runRoot)) return false;
    try {
      const st = await fsp.stat(target).catch(() => null);
      if (!st || !st.isDirectory()) return false;
      await fsp.rm(target, { recursive: true, force: true });
      log(`[worktree] removed archived-ticket run workspace ${target}`);
      return true;
    } catch (err: any) {
      log(`[worktree] run workspace remove failed ${target}: ${err?.message ?? err}`);
      return false;
    }
  }

  /**
   * Reclaim worktrees that are no longer in use. Conservative on purpose:
   * a worktree is removed only when ALL hold:
   *   - its dir lives under `<working_dir>/.awb/wt` (never the main worktree),
   *   - it is NOT a warm-pool slot (`shared-<i>` / legacy `shared`) — those are
   *     reused across tickets and their untracked warm build must survive (규약 ⑥),
   *   - its slug is NOT in `activeKeys` (no live session), and
   *   - its working tree is clean (no uncommitted / untracked changes) — a
   *     dirty tree means a pended ticket still has unsaved work; keep it.
   * Removing a clean, inactive worktree loses nothing recoverable: the branch
   * ref stays in the repo, and resume recreates the worktree on demand.
   * Returns the number of worktrees removed.
   */
  async sweep(opts: {
    baseWorkingDir: string;
    activeKeys: Set<string>;
  }): Promise<number> {
    if (!this.#enabled) return 0;
    const { baseWorkingDir, activeKeys } = opts;
    if (!baseWorkingDir || !(await this.#isGitWorkTree(baseWorkingDir))) return 0;
    const worktreesRoot = worktreesRootFor(baseWorkingDir);
    await this.prune(baseWorkingDir);
    const worktrees = await this.listWorktrees(baseWorkingDir);
    let removed = 0;
    for (const w of worktrees) {
      if (!isUnder(w.path, worktreesRoot)) continue; // never the main worktree
      const slug = lastSegment(w.path);
      if (isSharedSlotSeg(slug)) continue; // warm-pool slot — never sweep (규약 ⑥)
      if (activeKeys.has(slug)) continue; // a live session owns this worktree
      const status = await git(w.path, ['status', '--porcelain']);
      if (!status.ok) continue;
      if (status.stdout.trim() !== '') continue; // dirty → preserve pended work
      const r = await git(baseWorkingDir, ['worktree', 'remove', '--force', w.path]);
      if (r.ok) {
        removed++;
        log(`[worktree] swept idle clean worktree ${w.path}`);
      }
    }
    if (removed > 0) await this.prune(baseWorkingDir);
    return removed;
  }
}

// ── path helpers (no realpath: worktree dirs may be transient) ──────────────

function normPath(p: string): string {
  // Strip trailing slashes; on win32 compare case-insensitively + unify seps.
  let s = String(p || '').replace(/[/\\]+$/, '');
  if (process.platform === 'win32') s = s.replace(/\\/g, '/').toLowerCase();
  return s;
}

function samePath(a: string, b: string): boolean {
  return normPath(a) === normPath(b);
}

function isUnder(child: string, parent: string): boolean {
  const c = normPath(child);
  const p = normPath(parent);
  return c === p ? false : c.startsWith(p + '/');
}

function lastSegment(p: string): string {
  const n = normPath(p);
  const idx = n.lastIndexOf('/');
  return idx >= 0 ? n.slice(idx + 1) : n;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}
