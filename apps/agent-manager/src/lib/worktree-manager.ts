// Per-(ticket,role) git worktree isolation.
//
// Problem this solves (ticket 9f26f091): a managed agent has ONE working_dir,
// and every (ticket,role) session it runs shares that cwd. The current branch
// is global state of that cwd, so a `git checkout` in one ticket's session
// bleeds into another ticket's session sharing the same agent — commits land
// on the wrong branch when focus flips between tickets (pend/unpend,
// preemption, idle-reap → respawn).
//
// Fix: give each (ticket,role) session its own dedicated git worktree, checked
// out from the agent's base repo. A branch switch inside one worktree cannot
// touch another worktree's HEAD or working tree, so:
//   - two tickets commit/checkout independent branches concurrently,
//   - a pended ticket's branch + uncommitted changes survive in its own
//     worktree dir while another ticket runs, and resume lands back in it.
//
// The worktree dir is deterministic per (ticket,role), so a fresh spawn after
// an idle-reap reattaches to the SAME worktree (branch + dirty tree intact) —
// that is what makes the focus gain/loss handling fall out for free on the
// worktree path.
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

export interface ResolveCwdArgs {
  /** The agent's base repo working_dir (the shared cwd). */
  baseWorkingDir: string;
  /** Directory under which this agent's per-ticket worktrees live, e.g.
   *  <MANAGER_HOME>/agents/<id>/worktrees. */
  worktreesRoot: string;
  ticketId: string;
  role: string;
}

export interface ResolveCwdResult {
  /** cwd the child should spawn under. */
  cwd: string;
  /** true when cwd is a dedicated worktree, false when it fell back to base. */
  isWorktree: boolean;
  /** true when an existing worktree was reattached (vs freshly created). */
  reused?: boolean;
  /** populated on fallback so callers can log why isolation was skipped. */
  reason?: string;
}

/** Map a (ticket,role) pair to a filesystem-safe, collision-resistant slug.
 *  ticketId is a uuid; first 8 chars are unique enough per agent. */
export function worktreeSlug(ticketId: string, role: string): string {
  const t = String(ticketId || '').slice(0, 8);
  const r = String(role || 'role');
  return `${t}-${r}`.replace(/[^A-Za-z0-9._-]/g, '_');
}

export class WorktreeManager {
  #enabled: boolean;

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
   * Resolve the cwd a (ticket,role) child should spawn under. Reattaches to an
   * existing per-ticket worktree when present (preserving its branch + dirty
   * tree), creates one otherwise, and falls back to the shared base cwd when
   * worktree isolation is unavailable.
   */
  async resolveCwd(args: ResolveCwdArgs): Promise<ResolveCwdResult> {
    const { baseWorkingDir, worktreesRoot, ticketId, role } = args;
    const fallback = (reason: string): ResolveCwdResult => ({
      cwd: baseWorkingDir,
      isWorktree: false,
      reason,
    });

    if (!this.#enabled) return fallback('disabled');
    if (!baseWorkingDir) return fallback('no_base_dir');
    if (!ticketId || !role) return fallback('no_ticket_role');

    if (!(await this.#isGitWorkTree(baseWorkingDir))) {
      return fallback('not_a_git_repo');
    }

    const slug = worktreeSlug(ticketId, role);
    const wtPath = join(worktreesRoot, slug);

    // Drop stale registrations first so a worktree whose dir was manually
    // removed doesn't block recreating it here.
    await this.prune(baseWorkingDir);

    // Reuse an existing registered worktree at this exact path — that is the
    // resume path (idle-reap → respawn lands back in the same branch/dirty
    // tree the prior session left behind).
    const existing = (await this.listWorktrees(baseWorkingDir)).find(
      (w) => samePath(w.path, wtPath),
    );
    if (existing) {
      try {
        const st = await fsp.stat(wtPath);
        if (st.isDirectory()) {
          return { cwd: wtPath, isWorktree: true, reused: true };
        }
      } catch {
        // Registered but dir is gone — prune already ran; fall through to add.
      }
    }

    // If the dir exists but isn't a registered worktree, we don't know what's
    // in it — refuse to clobber and fall back to the shared cwd.
    if (!existing && (await pathExists(wtPath))) {
      log(
        `[worktree] path exists but is not a registered worktree, falling back to base cwd: ${wtPath}`,
      );
      return fallback('path_conflict');
    }

    // Fresh worktree, detached at the base repo's current HEAD. We deliberately
    // do NOT check out a named branch: a branch can only be checked out in one
    // worktree, and the agent's column workflow creates/attaches its own
    // `ticket/<id>-<slug>` branch inside this worktree anyway.
    try {
      await fsp.mkdir(worktreesRoot, { recursive: true });
    } catch (err: any) {
      return fallback(`mkdir_failed:${err?.message ?? err}`);
    }

    // Free the base branch: the column workflow guide tells the agent to
    // `git checkout <base-branch> && git pull` first, but a branch can be
    // checked out in only ONE worktree. If the base repo's primary tree is
    // sitting on the base branch, that checkout fails ("already used by
    // worktree"). Detaching the base HEAD (no file changes — same commit)
    // frees the branch so every ticket worktree can check it out per the
    // documented flow. Best-effort; on failure the agent can still branch
    // off origin/<base> directly.
    await this.#freeBaseBranch(baseWorkingDir);

    const add = await git(baseWorkingDir, ['worktree', 'add', '--detach', wtPath]);
    if (!add.ok) {
      log(
        `[worktree] add failed for ticket=${ticketId.slice(0, 8)} role=${role}: ${add.stderr.trim()} — falling back to base cwd`,
      );
      return fallback('add_failed');
    }
    log(
      `[worktree] created ${wtPath} for ticket=${ticketId.slice(0, 8)} role=${role} (detached at base HEAD)`,
    );
    return { cwd: wtPath, isWorktree: true, reused: false };
  }

  /** Remove a specific (ticket,role) worktree. Force-removes even a dirty tree
   *  — callers should only invoke this for terminal tickets. Returns true when
   *  the worktree was removed (or already absent). */
  async remove(args: ResolveCwdArgs): Promise<boolean> {
    if (!this.#enabled) return false;
    const { baseWorkingDir, worktreesRoot, ticketId, role } = args;
    if (!baseWorkingDir || !(await this.#isGitWorkTree(baseWorkingDir))) return false;
    const wtPath = join(worktreesRoot, worktreeSlug(ticketId, role));
    const r = await git(baseWorkingDir, ['worktree', 'remove', '--force', wtPath]);
    await this.prune(baseWorkingDir);
    if (!r.ok && !/is not a working tree|No such file/i.test(r.stderr)) {
      log(`[worktree] remove failed ${wtPath}: ${r.stderr.trim()}`);
      return false;
    }
    return true;
  }

  /**
   * Reclaim worktrees that are no longer in use. Conservative on purpose:
   * a worktree is removed only when ALL hold:
   *   - its dir lives under `worktreesRoot` (never touch the main worktree),
   *   - its (ticket,role) key is NOT in `activeKeys` (no live session), and
   *   - its working tree is clean (no uncommitted / untracked changes) — a
   *     dirty tree means a pended ticket still has unsaved work; keep it.
   * Removing a clean, inactive worktree loses nothing recoverable: the branch
   * ref stays in the repo, and resume recreates the worktree on demand.
   * Returns the number of worktrees removed.
   */
  async sweep(opts: {
    baseWorkingDir: string;
    worktreesRoot: string;
    activeKeys: Set<string>;
  }): Promise<number> {
    if (!this.#enabled) return 0;
    const { baseWorkingDir, worktreesRoot, activeKeys } = opts;
    if (!baseWorkingDir || !(await this.#isGitWorkTree(baseWorkingDir))) return 0;
    await this.prune(baseWorkingDir);
    const worktrees = await this.listWorktrees(baseWorkingDir);
    let removed = 0;
    for (const w of worktrees) {
      if (!isUnder(w.path, worktreesRoot)) continue; // never the main worktree
      const slug = lastSegment(w.path);
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
