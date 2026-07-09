// Worktree isolation tests (ticket 9f26f091 + worktree 규약 ②).
//
// Exercises the real `git worktree` machinery against throwaway repos so the
// acceptance scenarios are covered without spawning agents. 규약 ② moves the
// worktree root INSIDE the agent's working_dir at `<working_dir>/.awb/wt/` and
// makes placement board-configurable (per_ticket | shared), so these tests also
// pin: the fixed `.awb/wt` root, the per_ticket/shared slug, the repo-subdir
// working_dir case (repo-root checkout + workSubpath), idempotent `.awb/`
// .gitignore registration, and that removeTicketWorktrees/sweep never touch the
// reusable 'shared' checkout.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import {
  WorktreeManager,
  worktreeSlug,
  worktreesRootFor,
  runWorkspaceRootFor,
  DEFAULT_WORKTREE_MODE,
  sharedSlotName,
  isSharedSlotSeg,
} from '../dist/lib/worktree-manager.js';

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

async function makeRepo() {
  const root = await fsp.mkdtemp(join(tmpdir(), 'awb-wt-'));
  const repo = join(root, 'repo');
  await fsp.mkdir(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@awb.local']);
  git(repo, ['config', 'user.name', 'AWB Test']);
  await fsp.writeFile(join(repo, 'README.md'), '# base\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'base']);
  return { root, repo, cleanup: () => fsp.rm(root, { recursive: true, force: true }) };
}

// A repo whose base branch has a real `origin` remote, so the warm-pool
// reset-on-acquire can target `origin/<base>`. The primary tree is deliberately
// advanced ONE commit past what was pushed, so a reset to origin/main is
// distinguishable from a reset to the primary HEAD.
async function makeRepoWithRemote() {
  const root = await fsp.mkdtemp(join(tmpdir(), 'awb-wt-remote-'));
  const remote = join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const repo = join(root, 'repo');
  await fsp.mkdir(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@awb.local']);
  git(repo, ['config', 'user.name', 'AWB Test']);
  await fsp.writeFile(join(repo, 'README.md'), '# base\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'base']);
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-q', '-u', 'origin', 'main']);
  git(repo, ['remote', 'set-head', 'origin', 'main']); // sets refs/remotes/origin/HEAD
  // Advance the primary tree past origin/main WITHOUT pushing.
  await fsp.writeFile(join(repo, 'README.md'), '# base v2 (unpushed)\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'v2 local only']);
  return { root, repo, remote, cleanup: () => fsp.rm(root, { recursive: true, force: true }) };
}

const TICKET_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const TICKET_B = 'bbbbbbbb-1111-2222-3333-444444444444';
const TICKET_C = 'cccccccc-1111-2222-3333-444444444444';

// ── slug + root helpers ─────────────────────────────────────────────────────

test('worktreeSlug: per_ticket → <ticket8>, shared → shared, default per_ticket', () => {
  assert.equal(worktreeSlug(TICKET_A, 'per_ticket'), 'aaaaaaaa');
  assert.equal(worktreeSlug(TICKET_A, 'shared'), 'shared');
  assert.equal(worktreeSlug(TICKET_A), 'aaaaaaaa', 'default is per_ticket');
  assert.equal(DEFAULT_WORKTREE_MODE, 'per_ticket');
  // filesystem-hostile chars in the ticket id are stripped
  assert.equal(worktreeSlug('id/with*bad', 'per_ticket'), 'id_with_');
  // shared is a fixed literal regardless of the ticket id
  assert.equal(worktreeSlug('id/with*bad', 'shared'), 'shared');
});

test('sharedSlotName / isSharedSlotSeg: pool slot naming + protection set', () => {
  assert.equal(sharedSlotName(0), 'shared-0');
  assert.equal(sharedSlotName(3), 'shared-3');
  // Every pool slot AND the legacy literal are protected from sweep/removal.
  assert.ok(isSharedSlotSeg('shared-0'));
  assert.ok(isSharedSlotSeg('shared-7'));
  assert.ok(isSharedSlotSeg('shared'), 'legacy single-shared dir still protected');
  // Per-ticket slugs are NOT pool slots (they get swept / terminal-removed).
  assert.ok(!isSharedSlotSeg('aaaaaaaa'));
  assert.ok(!isSharedSlotSeg('sharedx'));
});

test('worktreesRootFor is always <working_dir>/.awb/wt', () => {
  assert.equal(worktreesRootFor('/x/y/z'), join('/x/y/z', '.awb', 'wt'));
});

// ── placement: everything lands under <working_dir>/.awb/wt/ ─────────────────

test('per_ticket: worktrees land under .awb/wt/<ticket8>, distinct per ticket', async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const wm = new WorktreeManager();
    const wtRoot = worktreesRootFor(repo);
    const a = await wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_A, role: 'assignee' });
    const b = await wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_B, role: 'reviewer', mode: 'per_ticket' });

    assert.ok(a.isWorktree && b.isWorktree, 'both are worktrees');
    assert.equal(a.mode, 'per_ticket');
    // Placement is fixed under .awb/wt — the OLD external root is never used.
    assert.equal(a.worktreePath, join(wtRoot, 'aaaaaaaa'));
    assert.equal(b.worktreePath, join(wtRoot, 'bbbbbbbb'));
    // working_dir IS the repo root → no subpath, cwd == checkout root.
    assert.equal(a.workSubpath, '');
    assert.equal(a.cwd, a.worktreePath);
    assert.notEqual(a.cwd, b.cwd, 'distinct cwd per ticket');

    // Independent branches: A's commit must never appear on B's branch.
    git(a.cwd, ['checkout', '-q', '-b', 'ticket/aaaaaaaa']);
    git(b.cwd, ['checkout', '-q', '-b', 'ticket/bbbbbbbb']);
    await fsp.writeFile(join(a.cwd, 'a.txt'), 'A\n');
    git(a.cwd, ['add', '.']);
    git(a.cwd, ['commit', '-q', '-m', 'A commit']);
    assert.ok(git(a.cwd, ['log', '--oneline']).includes('A commit'));
    assert.ok(!git(b.cwd, ['log', '--oneline']).includes('A commit'), 'B branch has no A commit');
  } finally {
    await cleanup();
  }
});

// ── shared = warm worktree pool (규약 ⑥) ─────────────────────────────────────

test('shared pool: concurrent tickets lease DISTINCT slots up to N (poolSize)', async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const wm = new WorktreeManager();
    const wtRoot = worktreesRootFor(repo);
    // Pool size N = board concurrency = 2.
    const a = await wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_A, role: 'assignee', mode: 'shared', poolSize: 2 });
    const b = await wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_B, role: 'assignee', mode: 'shared', poolSize: 2 });

    assert.ok(a.isWorktree && b.isWorktree, 'both leased a slot');
    assert.equal(a.mode, 'shared');
    assert.equal(a.worktreePath, join(wtRoot, 'shared-0'));
    assert.equal(b.worktreePath, join(wtRoot, 'shared-1'), 'second concurrent ticket gets a DIFFERENT slot');
    assert.notEqual(a.cwd, b.cwd, 'distinct cwd per concurrent ticket — no branch contention');

    // Independent branches across the two pool slots (the whole point of the pool).
    git(a.cwd, ['checkout', '-q', '-b', 'ticket/aaaaaaaa']);
    git(b.cwd, ['checkout', '-q', '-b', 'ticket/bbbbbbbb']);
    await fsp.writeFile(join(a.cwd, 'a.txt'), 'A\n');
    git(a.cwd, ['add', '.']);
    git(a.cwd, ['commit', '-q', '-m', 'A commit']);
    assert.ok(!git(b.cwd, ['log', '--oneline']).includes('A commit'), 'B slot has no A commit');

    // The lease registry is persisted under the gitignored .awb/.
    assert.ok(existsSync(join(wtRoot, '.pool-leases.json')), 'lease registry persisted');
  } finally {
    await cleanup();
  }
});

test('shared pool: same ticket reattaches to its slot across roles/turns (no reset)', async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const wm = new WorktreeManager();
    const wtRoot = worktreesRootFor(repo);
    const first = await wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_A, role: 'assignee', mode: 'shared', poolSize: 2 });
    git(first.cwd, ['checkout', '-q', '-b', 'ticket/aaaaaaaa']);
    await fsp.writeFile(join(first.cwd, 'wip.txt'), 'in progress\n'); // uncommitted

    // A different role / resume for the SAME ticket lands back on the same slot
    // with its branch + dirty tree intact — NOT reset.
    const second = await wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_A, role: 'reviewer', mode: 'shared', poolSize: 2 });
    assert.equal(second.worktreePath, join(wtRoot, 'shared-0'), 'same slot regardless of role');
    assert.equal(second.reused, true);
    assert.equal(git(second.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']), 'ticket/aaaaaaaa', 'branch intact');
    assert.equal(await fsp.readFile(join(second.cwd, 'wip.txt'), 'utf8'), 'in progress\n', 'dirty tree intact');
  } finally {
    await cleanup();
  }
});

test('shared pool: release → reacquire RESETS tracked source but PRESERVES untracked warm build', async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const wm = new WorktreeManager();
    const wtRoot = worktreesRootFor(repo);
    // N=1: a single reused slot. Ticket A leases it and does work.
    const a = await wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_A, role: 'assignee', mode: 'shared', poolSize: 1 });
    assert.equal(a.worktreePath, join(wtRoot, 'shared-0'));
    git(a.cwd, ['checkout', '-q', '-b', 'ticket/aaaaaaaa']);
    await fsp.writeFile(join(a.cwd, 'README.md'), '# MODIFIED by A\n'); // tracked change
    git(a.cwd, ['add', '.']);
    git(a.cwd, ['commit', '-q', '-m', 'A modifies tracked source']);
    await fsp.writeFile(join(a.cwd, 'build-artifact.bin'), 'WARM\n'); // untracked build output

    // A reaches a terminal column → its slot is RELEASED (lazy), not removed.
    const removed = await wm.removeTicketWorktrees({ baseWorkingDir: repo, ticketId: TICKET_A });
    assert.equal(removed, 0, 'a pool slot is released, never removed');
    assert.ok(existsSync(join(wtRoot, 'shared-0')), 'slot dir + warm artifacts survive release');

    // Ticket B leases the freed slot → reset-on-acquire.
    const b = await wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_B, role: 'assignee', mode: 'shared', poolSize: 1 });
    assert.equal(b.worktreePath, join(wtRoot, 'shared-0'), 'B reuses the freed warm slot');
    assert.equal(b.reused, true, 'the warm checkout dir was reused, not recreated');
    // Tracked source is back at the base tip …
    assert.equal(await fsp.readFile(join(b.cwd, 'README.md'), 'utf8'), '# base\n', 'tracked source reset to base');
    // … but the untracked warm-build artifact survived (the pool's whole value).
    assert.ok(existsSync(join(b.cwd, 'build-artifact.bin')), 'untracked warm build artifact PRESERVED');
    // A's stale work branch was dropped, and B is detached (no leftover branch).
    assert.ok(!git(repo, ['branch', '--list', 'ticket/aaaaaaaa']).includes('ticket/aaaaaaaa'), 'prior work branch -D');
  } finally {
    await cleanup();
  }
});

test('shared pool: reset-on-acquire targets origin/<base> when a remote exists', async () => {
  const { repo, cleanup } = await makeRepoWithRemote();
  try {
    const wm = new WorktreeManager();
    const wtRoot = worktreesRootFor(repo);
    // A leases a fresh slot (created at the primary HEAD = the unpushed v2 commit).
    const a = await wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_A, role: 'assignee', mode: 'shared', poolSize: 1 });
    assert.equal(await fsp.readFile(join(a.cwd, 'README.md'), 'utf8'), '# base v2 (unpushed)\n', 'fresh slot starts at primary HEAD');
    // Release, then B reacquires → reset-on-acquire must go to origin/main (the
    // pushed base tip), NOT the primary's unpushed HEAD.
    await wm.removeTicketWorktrees({ baseWorkingDir: repo, ticketId: TICKET_A });
    const b = await wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_B, role: 'assignee', mode: 'shared', poolSize: 1 });
    assert.equal(b.worktreePath, join(wtRoot, 'shared-0'));
    assert.equal(await fsp.readFile(join(b.cwd, 'README.md'), 'utf8'), '# base\n', 'reset went to origin/main, not the unpushed primary HEAD');
  } finally {
    await cleanup();
  }
});

test('shared pool: exhausted (all N slots active) → safe fallback to base cwd', async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const wm = new WorktreeManager();
    // N=1, and A holds the only slot (still active — not released).
    await wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_A, role: 'assignee', mode: 'shared', poolSize: 1 });
    const b = await wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_B, role: 'assignee', mode: 'shared', poolSize: 1 });
    assert.equal(b.isWorktree, false, 'no free slot → not a worktree');
    assert.equal(b.reason, 'pool_exhausted');
    assert.equal(b.cwd, repo, 'falls back to the base cwd');
  } finally {
    await cleanup();
  }
});

test('shared pool: lease registry persists across a manager restart (resume reattaches)', async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const wm1 = new WorktreeManager();
    const wtRoot = worktreesRootFor(repo);
    const a = await wm1.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_A, role: 'assignee', mode: 'shared', poolSize: 2 });
    assert.equal(a.worktreePath, join(wtRoot, 'shared-0'));

    // Fresh manager instance (simulating a restart) reads the on-disk registry.
    const wm2 = new WorktreeManager();
    const a2 = await wm2.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_A, role: 'reviewer', mode: 'shared', poolSize: 2 });
    assert.equal(a2.worktreePath, join(wtRoot, 'shared-0'), 'restart reattaches ticket to its persisted slot');
    assert.equal(a2.reused, true);
    // A concurrent NEW ticket after restart must get slot-1, not clobber slot-0.
    const c = await wm2.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_C, role: 'assignee', mode: 'shared', poolSize: 2 });
    assert.equal(c.worktreePath, join(wtRoot, 'shared-1'), 'new ticket takes the still-free slot');
  } finally {
    await cleanup();
  }
});

// ── repo-subdir working_dir: checkout at .awb/wt, cwd = checkout + subpath ────

test('repo-subdir working_dir: worktree under working_dir/.awb/wt, cwd carries the subpath', async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    // working_dir is a tracked SUBFOLDER of the repo (e.g. <repo>/game/client).
    await fsp.mkdir(join(repo, 'game', 'client'), { recursive: true });
    await fsp.writeFile(join(repo, 'game', 'client', 'app.txt'), 'client\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'add subdir']);
    const sub = join(repo, 'game', 'client');

    const wm = new WorktreeManager();
    const r = await wm.resolveCwd({ baseWorkingDir: sub, ticketId: TICKET_A, role: 'assignee' });

    assert.ok(r.isWorktree, 'subdir working_dir still gets a worktree');
    // The checkout root lives under the working_dir's own .awb/wt — NOT the repo root's.
    assert.equal(r.worktreePath, join(sub, '.awb', 'wt', 'aaaaaaaa'));
    // The checkout is a FULL repo-root checkout (has the repo-root README).
    assert.ok(existsSync(join(r.worktreePath, 'README.md')), 'checkout is repo-root');
    // workSubpath is the repo-root→working_dir relative path (forward-slash).
    assert.equal(r.workSubpath, 'game/client');
    // cwd = checkout root + subpath → the real working directory the agent runs in.
    assert.equal(r.cwd, join(r.worktreePath, 'game', 'client'));
    assert.ok(existsSync(join(r.cwd, 'app.txt')), 'cwd points at the checked-out subfolder');
  } finally {
    await cleanup();
  }
});

// ── .awb/ is auto-registered in .gitignore, idempotently ─────────────────────

test('.awb/ is registered in the repo .gitignore exactly once (idempotent)', async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const wm = new WorktreeManager();
    const giPath = join(repo, '.gitignore');
    assert.ok(!existsSync(giPath), 'repo starts without a .gitignore');

    await wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_A, role: 'assignee' });
    assert.ok(existsSync(giPath), '.gitignore created');
    const lines1 = (await fsp.readFile(giPath, 'utf8')).split(/\r?\n/).map((l) => l.trim());
    assert.ok(lines1.includes('.awb/'), '.awb/ registered');

    // A second ticket must not append a duplicate line.
    await wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_B, role: 'assignee' });
    const count = (await fsp.readFile(giPath, 'utf8'))
      .split(/\r?\n/)
      .filter((l) => l.trim() === '.awb/').length;
    assert.equal(count, 1, 'no duplicate .awb/ entry');

    // The nested worktrees stay out of `git status` (that is the whole point).
    assert.equal(git(repo, ['status', '--porcelain', '--untracked-files=all', '.awb']), '', '.awb not surfaced by git status');
  } finally {
    await cleanup();
  }
});

// ── resume / reattach preserves branch + dirty tree ──────────────────────────

test('resume reattaches to the same per-ticket worktree (branch + dirty tree intact)', async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const wm = new WorktreeManager();
    const first = await wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_A, role: 'assignee' });
    git(first.cwd, ['checkout', '-q', '-b', 'mybranch']);
    await fsp.writeFile(join(first.cwd, 'wip.txt'), 'in progress\n');
    assert.equal(first.reused, false);

    // Idle-reap + unpend: a fresh spawn for the SAME ticket (any role) lands back.
    const second = await wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_A, role: 'reviewer' });
    assert.equal(second.cwd, first.cwd, 'same worktree regardless of role');
    assert.equal(second.reused, true);
    assert.equal(git(second.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']), 'mybranch');
    assert.equal(await fsp.readFile(join(second.cwd, 'wip.txt'), 'utf8'), 'in progress\n');
  } finally {
    await cleanup();
  }
});

// ── fallbacks ────────────────────────────────────────────────────────────────

test('fallback to base cwd when not a git repo', async () => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'awb-wt-nogit-'));
  try {
    const base = join(root, 'plain');
    await fsp.mkdir(base, { recursive: true });
    const wm = new WorktreeManager();
    const r = await wm.resolveCwd({ baseWorkingDir: base, ticketId: TICKET_A, role: 'assignee' });
    assert.equal(r.isWorktree, false);
    assert.equal(r.cwd, base);
    assert.equal(r.reason, 'not_a_git_repo');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('disabled manager always falls back to base cwd', async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const wm = new WorktreeManager({ enabled: false });
    const r = await wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_A, role: 'assignee' });
    assert.equal(r.isWorktree, false);
    assert.equal(r.cwd, repo);
  } finally {
    await cleanup();
  }
});

// ── terminal reclamation: removeTicketWorktrees ──────────────────────────────

test('removeTicketWorktrees drops the per_ticket worktree (even dirty) but keeps others', async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const wm = new WorktreeManager();
    const wtRoot = worktreesRootFor(repo);
    // Terminal ticket A: dirty checkout — the case a dirty-preserving sweep can
    // never reclaim, so removeTicketWorktrees must force it.
    const a = await wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_A, role: 'assignee' });
    git(a.cwd, ['checkout', '-q', '-b', 'ticket/aaaaaaaa']);
    await fsp.writeFile(join(a.cwd, 'wip.txt'), 'uncommitted\n');
    // Unrelated ticket B stays live and must be left alone.
    const b = await wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_B, role: 'assignee' });

    const removed = await wm.removeTicketWorktrees({ baseWorkingDir: repo, ticketId: TICKET_A });
    assert.equal(removed, 1, 'A worktree removed');

    const remaining = (await wm.listWorktrees(repo)).map((w) => w.path);
    assert.ok(!remaining.some((p) => p === join(wtRoot, 'aaaaaaaa')), 'A gone');
    assert.ok(remaining.some((p) => p === join(wtRoot, 'bbbbbbbb')), 'B untouched');
    void b;
    // The branch ref survives removal — terminal work is not lost.
    assert.ok(git(repo, ['branch', '--list', 'ticket/aaaaaaaa']).includes('ticket/aaaaaaaa'), 'branch ref survives');
  } finally {
    await cleanup();
  }
});

test('removeTicketWorktrees releases (never removes) a warm-pool slot', async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const wm = new WorktreeManager();
    const wtRoot = worktreesRootFor(repo);
    // Ticket A ran in shared mode → holds pool slot shared-0.
    await wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_A, role: 'assignee', mode: 'shared', poolSize: 2 });
    // A reaches a terminal column → cleanup fires for ticket A.
    const removed = await wm.removeTicketWorktrees({ baseWorkingDir: repo, ticketId: TICKET_A });
    assert.equal(removed, 0, 'a pool slot is not a per-ticket worktree — nothing removed');
    assert.ok(
      (await wm.listWorktrees(repo)).some((w) => w.path === join(wtRoot, 'shared-0')),
      'pool slot survives a terminal ticket (warm build preserved)',
    );
    // The slot is now released (idle): a NEW ticket reuses shared-0, not shared-1.
    const b = await wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_B, role: 'assignee', mode: 'shared', poolSize: 2 });
    assert.equal(b.worktreePath, join(wtRoot, 'shared-0'), 'released slot is reused before opening a new one');
  } finally {
    await cleanup();
  }
});

// ── archive reclamation: removeTicketRunWorkspace (규약 ⑤) ────────────────────

test('runWorkspaceRootFor is always <working_dir>/.awb/qa', () => {
  assert.equal(runWorkspaceRootFor('/x/y/z'), join('/x/y/z', '.awb', 'qa'));
});

test('removeTicketRunWorkspace removes .awb/qa/<ticket8> but keeps the root + siblings', async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const wm = new WorktreeManager();
    const qaRoot = runWorkspaceRootFor(repo);
    const target = join(qaRoot, 'aaaaaaaa'); // <ticket8> of TICKET_A
    const sibling = join(qaRoot, 'scenario99'); // a QA scenario run dir, unrelated
    await fsp.mkdir(join(target, 'nested'), { recursive: true });
    await fsp.writeFile(join(target, 'nested', 'artifact.txt'), 'run output\n');
    await fsp.mkdir(sibling, { recursive: true });

    const removed = await wm.removeTicketRunWorkspace({ baseWorkingDir: repo, ticketId: TICKET_A });
    assert.equal(removed, true, 'the ticket run workspace was removed');
    assert.ok(!existsSync(target), '.awb/qa/<ticket8> gone (recursively)');
    // The qa ROOT itself and unrelated sibling run dirs must survive.
    assert.ok(existsSync(qaRoot), 'qa root preserved');
    assert.ok(existsSync(sibling), 'unrelated sibling run dir preserved');
  } finally {
    await cleanup();
  }
});

test('removeTicketRunWorkspace is a no-op (returns false) when no run dir exists', async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const wm = new WorktreeManager();
    // Ordinary dev ticket: run workspaces are keyed by scenario/profile id, not
    // ticket id, so there is nothing to remove — must not throw, returns false.
    const removed = await wm.removeTicketRunWorkspace({ baseWorkingDir: repo, ticketId: TICKET_B });
    assert.equal(removed, false);
  } finally {
    await cleanup();
  }
});

test('removeTicketRunWorkspace strips filesystem-hostile ticket-id chars', async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const wm = new WorktreeManager();
    const qaRoot = runWorkspaceRootFor(repo);
    // slice(0,8) of 'id/with*bad' = 'id/with*' → sanitized to 'id_with_'.
    const target = join(qaRoot, 'id_with_');
    await fsp.mkdir(target, { recursive: true });
    const removed = await wm.removeTicketRunWorkspace({ baseWorkingDir: repo, ticketId: 'id/with*bad' });
    assert.equal(removed, true);
    assert.ok(!existsSync(target), 'sanitized run dir removed');
  } finally {
    await cleanup();
  }
});

test('removeTicketRunWorkspace on a disabled manager returns false', async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const wm = new WorktreeManager({ enabled: false });
    const qaRoot = runWorkspaceRootFor(repo);
    const target = join(qaRoot, 'aaaaaaaa');
    await fsp.mkdir(target, { recursive: true });
    const removed = await wm.removeTicketRunWorkspace({ baseWorkingDir: repo, ticketId: TICKET_A });
    assert.equal(removed, false, 'disabled manager does nothing');
    assert.ok(existsSync(target), 'target left intact when disabled');
  } finally {
    await cleanup();
  }
});

// ── idle reclamation: sweep ──────────────────────────────────────────────────

test('sweep removes idle clean worktrees, keeps active, dirty, and shared', async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const wm = new WorktreeManager();
    const wtRoot = worktreesRootFor(repo);
    // clean + inactive → removed
    await wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_A, role: 'assignee' });
    // dirty + inactive → kept (pended work)
    const dirty = await wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_B, role: 'assignee' });
    await fsp.writeFile(join(dirty.cwd, 'unsaved.txt'), 'do not lose me\n');
    // active → kept even though clean
    await wm.resolveCwd({ baseWorkingDir: repo, ticketId: 'cccccccc-x', role: 'assignee' });
    // shared pool slot → kept unconditionally (warm build must survive)
    await wm.resolveCwd({ baseWorkingDir: repo, ticketId: 'dddddddd-x', role: 'assignee', mode: 'shared', poolSize: 1 });

    const activeKeys = new Set([worktreeSlug('cccccccc-x')]); // == 'cccccccc'
    const removed = await wm.sweep({ baseWorkingDir: repo, activeKeys });
    assert.equal(removed, 1, 'only the clean idle per_ticket worktree is swept');

    const remaining = (await wm.listWorktrees(repo)).map((w) => w.path);
    assert.ok(!remaining.includes(join(wtRoot, 'aaaaaaaa')), 'clean idle removed');
    assert.ok(remaining.includes(join(wtRoot, 'bbbbbbbb')), 'dirty kept');
    assert.ok(remaining.includes(join(wtRoot, 'cccccccc')), 'active kept');
    assert.ok(remaining.includes(join(wtRoot, 'shared-0')), 'pool slot kept');
  } finally {
    await cleanup();
  }
});
