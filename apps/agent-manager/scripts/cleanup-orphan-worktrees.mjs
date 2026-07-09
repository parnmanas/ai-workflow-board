#!/usr/bin/env node
// One-time cleanup for scattered git worktree orphans (worktree 규약 ⑤, scope 4).
//
// Background (memory awb_worktree_convention_redesign): before the `.awb/wt/`
// convention landed, coding subagents ran ad-hoc `git worktree add` for throwaway
// compile-checks (`_compilecheck_*`) and ticket work (`_wt_*`), scattering
// checkouts across the repo tree / `D:\` / `/tmp` and never removing them. The
// GameClient (txiv) repos accumulated ~51 on the Linux host (Rolf/codex) and ~20
// on Windows (Ralf/claude). The manager's own worktrees are now fixed under
// `<working_dir>/.awb/wt/` and reclaimed at Done/archive, but these pre-existing
// orphans need a one-shot sweep.
//
// This script is cross-platform (pure Node + `git`, no build step) so it runs on
// both the Linux and Windows hosts. It is SAFE BY DEFAULT: dry-run unless
// `--execute` is passed, and it NEVER removes a worktree that is dirty or that
// carries unmerged commits (e.g. a live `ticket/...` branch) — those are logged
// and skipped so no in-flight work is lost.
//
// Usage:
//   node cleanup-orphan-worktrees.mjs --repo <path> [--repo <path2> ...]
//                                     [--execute] [--all-non-awb] [--base <ref>]
//
//   --repo <path>     Repo (or any dir inside it) to sweep. Repeatable. Required.
//   --execute         Actually remove. Omit for a dry-run (default) that only logs.
//   --all-non-awb     Aggressive: treat EVERY non-main worktree that is not under
//                     `.awb/` as an orphan candidate (still gated by dirty/unmerged
//                     skips). Default matches only the known `_compilecheck_*` /
//                     `_wt_*` name patterns + the legacy `<home>/agents/*/worktrees/`
//                     manager root.
//   --base <ref>      Ref an orphan's commits must be merged into to be removable
//                     (default: auto-detect origin/HEAD, falling back to origin/main).
//
// Exit code is always 0 (best-effort maintenance). Every decision is logged.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const opts = { repos: [], execute: false, allNonAwb: false, base: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') opts.repos.push(argv[++i]);
    else if (a === '--execute') opts.execute = true;
    else if (a === '--all-non-awb') opts.allNonAwb = true;
    else if (a === '--base') opts.base = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    else console.error(`[warn] ignoring unknown arg: ${a}`);
  }
  return opts;
}

// Run git, returning { ok, out }. Never throws (a non-zero exit is expected for
// probes like merge-base --is-ancestor).
function git(repo, args) {
  try {
    const out = execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    return { ok: true, out: out.toString() };
  } catch (err) {
    return { ok: false, out: (err.stdout || '').toString(), err: (err.stderr || err.message || '').toString() };
  }
}

// Normalise for prefix comparison: forward slashes, strip trailing sep, lowercase on win32.
function norm(p) {
  let s = String(p || '').replace(/[\\/]+$/, '').replace(/\\/g, '/');
  if (process.platform === 'win32') s = s.toLowerCase();
  return s;
}

function basename(p) {
  const n = norm(p);
  const i = n.lastIndexOf('/');
  return i >= 0 ? n.slice(i + 1) : n;
}

// Parse `git worktree list --porcelain` into structured entries. The FIRST entry
// is always the main worktree.
function listWorktrees(repo) {
  const r = git(repo, ['worktree', 'list', '--porcelain']);
  if (!r.ok) return [];
  const entries = [];
  let cur = null;
  for (const rawLine of r.out.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith('worktree ')) {
      if (cur) entries.push(cur);
      cur = { path: line.slice('worktree '.length), head: null, branch: null, detached: false, locked: false, prunable: false };
    } else if (!cur) {
      continue;
    } else if (line.startsWith('HEAD ')) cur.head = line.slice('HEAD '.length);
    else if (line.startsWith('branch ')) cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.detached = true;
    else if (line.startsWith('locked')) cur.locked = true;
    else if (line.startsWith('prunable')) cur.prunable = true;
    else if (line === '') { if (cur) { entries.push(cur); cur = null; } }
  }
  if (cur) entries.push(cur);
  return entries;
}

// A worktree path is part of the NEW convention (keep) if any path segment is
// `.awb` followed by `wt` or `qa` — covers `.awb/wt/<slug>` (incl. shared) and
// `.awb/qa/<leaf>`, at any depth (repo-subdir working_dir).
function isAwbManaged(p) {
  const segs = norm(p).split('/');
  for (let i = 0; i < segs.length - 1; i++) {
    if (segs[i] === '.awb' && (segs[i + 1] === 'wt' || segs[i + 1] === 'qa')) return true;
  }
  return false;
}

// Known orphan shapes: `_compilecheck*` / `_wt_*` basenames, or the legacy
// manager worktree root `.../agents/<id>/worktrees/<x>`.
function matchesKnownOrphan(p) {
  const base = basename(p);
  if (/^_compilecheck/.test(base) || /^_wt[_-]/.test(base) || base.includes('compilecheck')) return true;
  const n = norm(p);
  if (/\/agents\/[^/]+\/worktrees\//.test(n)) return true;
  return false;
}

// Resolve the base ref (what "merged" means). Prefer an explicit --base, else the
// remote's default branch, else origin/main.
function resolveBase(repo, explicit) {
  if (explicit) return explicit;
  const head = git(repo, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (head.ok && head.out.trim()) return head.out.trim().replace(/^refs\/remotes\//, '');
  for (const cand of ['origin/main', 'origin/master']) {
    if (git(repo, ['rev-parse', '--verify', '--quiet', cand]).ok) return cand;
  }
  return 'origin/main';
}

// True when every commit reachable from `head` is already in `base` (safe to drop).
function isMergedInto(repo, head, base) {
  if (!head) return true; // no commits to lose
  return git(repo, ['merge-base', '--is-ancestor', head, base]).ok;
}

function sweepRepo(repo, opts) {
  const top = git(repo, ['rev-parse', '--show-toplevel']);
  if (!top.ok || !top.out.trim()) {
    console.log(`\n=== ${repo} — SKIP: not a git repo (${(top.err || '').trim()})`);
    return { scanned: 0, kept: 0, removed: 0, skipped: 0, pruned: 0 };
  }
  const repoRoot = top.out.trim();
  const base = resolveBase(repo, opts.base);
  const baseExists = git(repo, ['rev-parse', '--verify', '--quiet', base]).ok;
  console.log(`\n=== ${repoRoot}`);
  console.log(`    base=${base}${baseExists ? '' : ' (WARNING: base ref not found — unmerged check will skip-preserve everything)'} · mode=${opts.execute ? 'EXECUTE' : 'DRY-RUN'} · match=${opts.allNonAwb ? 'all-non-awb' : 'known-patterns'}`);

  const entries = listWorktrees(repo);
  const stats = { scanned: entries.length, kept: 0, removed: 0, skipped: 0, pruned: 0 };
  const mainPath = entries.length ? norm(entries[0].path) : '';

  for (let i = 0; i < entries.length; i++) {
    const w = entries[i];
    const p = w.path;
    const np = norm(p);
    const tag = w.branch ? `branch=${w.branch}` : (w.detached ? `detached@${(w.head || '').slice(0, 8)}` : 'unknown');

    if (i === 0 || np === mainPath) { stats.kept++; console.log(`  KEEP  (main)        ${p}`); continue; }
    if (isAwbManaged(p)) { stats.kept++; console.log(`  KEEP  (.awb managed) ${p}`); continue; }

    const isCandidate = opts.allNonAwb || matchesKnownOrphan(p);
    if (!isCandidate) { stats.kept++; console.log(`  KEEP  (unmatched)    ${p} [${tag}]`); continue; }

    // Prunable = registered but the dir vanished → let `worktree prune` handle it.
    if (w.prunable || !existsSync(p)) { console.log(`  PRUNE (dir gone)     ${p}`); continue; }
    if (w.locked) { stats.skipped++; console.log(`  SKIP  (locked)       ${p} [${tag}]`); continue; }

    // Never drop uncommitted work.
    const status = git(p, ['status', '--porcelain']);
    if (status.ok && status.out.trim() !== '') { stats.skipped++; console.log(`  SKIP  (dirty)        ${p} [${tag}]`); continue; }
    if (!status.ok) { stats.skipped++; console.log(`  SKIP  (status failed) ${p} [${tag}]`); continue; }

    // Never drop unmerged commits (live ticket/... branches etc.). When base is
    // missing we can't prove merged → preserve.
    if (!baseExists || !isMergedInto(repo, w.head, base)) {
      stats.skipped++;
      console.log(`  SKIP  (unmerged)     ${p} [${tag}] — has commits not in ${base}`);
      continue;
    }

    if (!opts.execute) { stats.removed++; console.log(`  WOULD-REMOVE         ${p} [${tag}] (clean + merged)`); continue; }
    const rm = git(repo, ['worktree', 'remove', '--force', p]);
    if (rm.ok || /is not a working tree|No such file/i.test(rm.err || '')) {
      stats.removed++;
      console.log(`  REMOVED              ${p} [${tag}]`);
    } else {
      stats.skipped++;
      console.log(`  SKIP  (remove failed) ${p} [${tag}] — ${(rm.err || '').trim().split('\n').pop()}`);
    }
  }

  // Drop registrations whose dirs vanished (the PRUNE-logged rows above).
  const before = listWorktrees(repo).length;
  if (opts.execute) {
    git(repo, ['worktree', 'prune']);
    const after = listWorktrees(repo).length;
    stats.pruned = Math.max(0, before - after);
  } else {
    stats.pruned = entries.filter((w) => w.prunable || !existsSync(w.path)).length;
  }

  console.log(
    `  --- ${repoRoot}: scanned=${stats.scanned} kept=${stats.kept} ` +
      `${opts.execute ? 'removed' : 'would-remove'}=${stats.removed} skipped=${stats.skipped} pruned=${stats.pruned}`,
  );
  return stats;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || opts.repos.length === 0) {
    console.log(
      'Usage: node cleanup-orphan-worktrees.mjs --repo <path> [--repo <path2> ...] [--execute] [--all-non-awb] [--base <ref>]\n' +
        '  Dry-run by default. Skips dirty + unmerged worktrees. See file header for details.',
    );
    process.exit(0);
  }
  console.log(`orphan-worktree cleanup · ${opts.execute ? 'EXECUTE' : 'DRY-RUN'} · ${opts.repos.length} repo(s)`);
  const total = { scanned: 0, kept: 0, removed: 0, skipped: 0, pruned: 0 };
  for (const repo of opts.repos) {
    const abs = path.resolve(repo);
    const s = sweepRepo(abs, opts);
    for (const k of Object.keys(total)) total[k] += s[k];
  }
  console.log(
    `\n==== TOTAL: scanned=${total.scanned} kept=${total.kept} ` +
      `${opts.execute ? 'removed' : 'would-remove'}=${total.removed} skipped=${total.skipped} pruned=${total.pruned}`,
  );
  if (!opts.execute && total.removed > 0) {
    console.log('Re-run with --execute to actually remove the WOULD-REMOVE entries above.');
  }
  process.exit(0);
}

main();
