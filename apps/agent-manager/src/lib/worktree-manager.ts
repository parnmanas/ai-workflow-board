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
//   - worktree_mode = 'shared'               → slug = 'shared'   (one reused for all)
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

/** Fixed worktree root for an agent working_dir: `<working_dir>/.awb/wt`.
 *  Every worktree this manager creates lives directly under it. Exported so the
 *  event-dispatcher (and ticket ④'s prompt injection) can reference the same
 *  root without re-deriving it. */
export function worktreesRootFor(baseWorkingDir: string): string {
  return join(baseWorkingDir, '.awb', 'wt');
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

export interface ResolveCwdArgs {
  /** The agent's base repo working_dir (the shared cwd). */
  baseWorkingDir: string;
  ticketId: string;
  /** Kept for logging/observability; no longer part of the worktree path (a
   *  ticket gets ONE worktree that every role of it reuses). */
  role: string;
  /** Board worktree_mode (worktree 규약 ①/②). Defaults to 'per_ticket'. */
  mode?: WorktreeMode;
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
    if (mode === 'per_ticket' && !ticketId) return fallback('no_ticket');

    if (!(await this.#isGitWorkTree(baseWorkingDir))) {
      return fallback('not_a_git_repo');
    }

    const repoCtx = await this.#resolveRepoContext(baseWorkingDir);
    if (!repoCtx) return fallback('no_repo_root');
    const { repoRoot, workSubpath } = repoCtx;
    const withSub = (p: string) => (workSubpath ? join(p, workSubpath) : p);

    const worktreesRoot = worktreesRootFor(baseWorkingDir);
    const slug = worktreeSlug(ticketId, mode);
    const wtPath = join(worktreesRoot, slug);

    // Keep the nested worktrees out of `git status` (and out of Unity scans).
    await this.#ensureAwbIgnored(repoRoot, workSubpath);

    // Drop stale registrations first so a worktree whose dir was manually
    // removed doesn't block recreating it here.
    await this.prune(baseWorkingDir);

    // Reuse an existing registered worktree at this exact path — that is the
    // resume path (idle-reap → respawn lands back in the same branch/dirty
    // tree the prior session left behind). In shared mode this is also how the
    // one reused checkout is picked up across tickets.
    const existing = (await this.listWorktrees(baseWorkingDir)).find((w) =>
      samePath(w.path, wtPath),
    );
    if (existing) {
      try {
        const st = await fsp.stat(wtPath);
        if (st.isDirectory()) {
          return {
            cwd: withSub(wtPath),
            isWorktree: true,
            reused: true,
            worktreePath: wtPath,
            workSubpath,
            mode,
          };
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
    // `ticket/<id>` branch inside this worktree anyway.
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
        `[worktree] add failed for ticket=${String(ticketId).slice(0, 8)} role=${role} mode=${mode}: ${add.stderr.trim()} — falling back to base cwd`,
      );
      return fallback('add_failed');
    }
    log(
      `[worktree] created ${wtPath} for ticket=${String(ticketId).slice(0, 8)} role=${role} mode=${mode}${workSubpath ? ` subpath=${workSubpath}` : ''} (detached at base HEAD)`,
    );
    return {
      cwd: withSub(wtPath),
      isWorktree: true,
      reused: false,
      worktreePath: wtPath,
      workSubpath,
      mode,
    };
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
   * (tolerating a legacy `<ticket8>-<role>` suffix). The 'shared' worktree never
   * matches — it is reused across tickets and must survive a terminal ticket.
   * Confined to `<working_dir>/.awb/wt` so the agent's main worktree is never
   * touched. Returns the number removed. Best-effort; never throws.
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
      // per_ticket dir == <ticket8>; skip 'shared' and unrelated tickets.
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
    return removed;
  }

  /**
   * Reclaim worktrees that are no longer in use. Conservative on purpose:
   * a worktree is removed only when ALL hold:
   *   - its dir lives under `<working_dir>/.awb/wt` (never the main worktree),
   *   - it is NOT the reusable 'shared' worktree,
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
      if (slug === 'shared') continue; // the reusable checkout — never sweep
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
