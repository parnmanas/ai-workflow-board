// Worktree isolation tests (ticket 9f26f091). Exercises the real `git
// worktree` machinery against a throwaway repo so the acceptance scenarios
// (independent branches per ticket, resume preserves branch+dirty tree,
// fallback when not a git repo, idle-clean sweep) are covered without
// spawning agents.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { WorktreeManager, worktreeSlug } from '../dist/lib/worktree-manager.js';

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
  const worktreesRoot = join(root, 'worktrees');
  return { root, repo, worktreesRoot, cleanup: () => fsp.rm(root, { recursive: true, force: true }) };
}

const TICKET_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const TICKET_B = 'bbbbbbbb-1111-2222-3333-444444444444';

test('worktreeSlug is filesystem-safe and stable', () => {
  assert.equal(worktreeSlug(TICKET_A, 'assignee'), 'aaaaaaaa-assignee');
  assert.equal(worktreeSlug('id/with*bad', 'role:x'), 'id_with_-role_x');
});

test('(c) two tickets get independent worktrees + branches', async () => {
  const { repo, worktreesRoot, cleanup } = await makeRepo();
  try {
    const wm = new WorktreeManager();
    const a = await wm.resolveCwd({ baseWorkingDir: repo, worktreesRoot, ticketId: TICKET_A, role: 'assignee' });
    const b = await wm.resolveCwd({ baseWorkingDir: repo, worktreesRoot, ticketId: TICKET_B, role: 'assignee' });
    assert.ok(a.isWorktree, 'A is a worktree');
    assert.ok(b.isWorktree, 'B is a worktree');
    assert.notEqual(a.cwd, b.cwd, 'distinct cwd per ticket');

    // Each checks out its own branch — must not collide.
    git(a.cwd, ['checkout', '-q', '-b', 'ticket/aaaaaaaa-feat']);
    git(b.cwd, ['checkout', '-q', '-b', 'ticket/bbbbbbbb-feat']);

    await fsp.writeFile(join(a.cwd, 'a.txt'), 'A work\n');
    git(a.cwd, ['add', '.']);
    git(a.cwd, ['commit', '-q', '-m', 'A commit']);

    await fsp.writeFile(join(b.cwd, 'b.txt'), 'B work\n');
    git(b.cwd, ['add', '.']);
    git(b.cwd, ['commit', '-q', '-m', 'B commit']);

    // A's commit lives on A's branch only; B's branch never saw a.txt.
    assert.equal(git(a.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']), 'ticket/aaaaaaaa-feat');
    assert.equal(git(b.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']), 'ticket/bbbbbbbb-feat');
    assert.ok(git(a.cwd, ['log', '--oneline']).includes('A commit'));
    assert.ok(!git(a.cwd, ['log', '--oneline']).includes('B commit'), 'A branch has no B commit');
    assert.ok(!git(b.cwd, ['log', '--oneline']).includes('A commit'), 'B branch has no A commit');
  } finally {
    await cleanup();
  }
});

test('(a) A pend → B branch switch → A unpend: A commit stays on A branch', async () => {
  const { repo, worktreesRoot, cleanup } = await makeRepo();
  try {
    const wm = new WorktreeManager();
    // A gains focus, starts branchA.
    const a1 = await wm.resolveCwd({ baseWorkingDir: repo, worktreesRoot, ticketId: TICKET_A, role: 'assignee' });
    git(a1.cwd, ['checkout', '-q', '-b', 'branchA']);
    await fsp.writeFile(join(a1.cwd, 'a.txt'), 'partial\n'); // uncommitted — A is "pended"

    // B gains focus on the same agent, switches branch in ITS worktree.
    const b = await wm.resolveCwd({ baseWorkingDir: repo, worktreesRoot, ticketId: TICKET_B, role: 'assignee' });
    git(b.cwd, ['checkout', '-q', '-b', 'branchB']);
    await fsp.writeFile(join(b.cwd, 'b.txt'), 'b\n');
    git(b.cwd, ['add', '.']);
    git(b.cwd, ['commit', '-q', '-m', 'B commit']);

    // A unpends → resolveCwd reattaches to A's worktree (same dir, branchA, dirt intact).
    const a2 = await wm.resolveCwd({ baseWorkingDir: repo, worktreesRoot, ticketId: TICKET_A, role: 'assignee' });
    assert.equal(a2.cwd, a1.cwd, 'A reattaches to same worktree');
    assert.equal(a2.reused, true);
    assert.equal(git(a2.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']), 'branchA', 'still on branchA');
    assert.ok((await fsp.readFile(join(a2.cwd, 'a.txt'), 'utf8')) === 'partial\n', 'uncommitted work preserved');

    // A commits — lands on branchA, never branchB.
    git(a2.cwd, ['add', '.']);
    git(a2.cwd, ['commit', '-q', '-m', 'A commit']);
    assert.ok(git(a2.cwd, ['log', '--oneline', 'branchA']).includes('A commit'));
    assert.ok(!git(repo, ['log', '--oneline', 'branchB']).includes('A commit'), 'A commit did not leak to branchB');
  } finally {
    await cleanup();
  }
});

test('(b) resume reattaches to same worktree (branch + dirty tree intact)', async () => {
  const { repo, worktreesRoot, cleanup } = await makeRepo();
  try {
    const wm = new WorktreeManager();
    const first = await wm.resolveCwd({ baseWorkingDir: repo, worktreesRoot, ticketId: TICKET_A, role: 'reviewer' });
    git(first.cwd, ['checkout', '-q', '-b', 'mybranch']);
    await fsp.writeFile(join(first.cwd, 'wip.txt'), 'in progress\n');
    assert.equal(first.reused, false);

    // Simulate idle-reap + unpend: new spawn for same (ticket,role).
    const second = await wm.resolveCwd({ baseWorkingDir: repo, worktreesRoot, ticketId: TICKET_A, role: 'reviewer' });
    assert.equal(second.cwd, first.cwd);
    assert.equal(second.reused, true);
    assert.equal(git(second.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']), 'mybranch');
    assert.equal(await fsp.readFile(join(second.cwd, 'wip.txt'), 'utf8'), 'in progress\n');
  } finally {
    await cleanup();
  }
});

test('fallback to base cwd when not a git repo', async () => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'awb-wt-nogit-'));
  try {
    const base = join(root, 'plain');
    await fsp.mkdir(base, { recursive: true });
    const wm = new WorktreeManager();
    const r = await wm.resolveCwd({
      baseWorkingDir: base,
      worktreesRoot: join(root, 'wt'),
      ticketId: TICKET_A,
      role: 'assignee',
    });
    assert.equal(r.isWorktree, false);
    assert.equal(r.cwd, base);
    assert.equal(r.reason, 'not_a_git_repo');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('disabled manager always falls back', async () => {
  const { repo, worktreesRoot, cleanup } = await makeRepo();
  try {
    const wm = new WorktreeManager({ enabled: false });
    const r = await wm.resolveCwd({ baseWorkingDir: repo, worktreesRoot, ticketId: TICKET_A, role: 'assignee' });
    assert.equal(r.isWorktree, false);
    assert.equal(r.cwd, repo);
  } finally {
    await cleanup();
  }
});

test('(d) sweep removes idle clean worktrees, keeps active and dirty ones', async () => {
  const { repo, worktreesRoot, cleanup } = await makeRepo();
  try {
    const wm = new WorktreeManager();
    // clean + inactive → removed
    const clean = await wm.resolveCwd({ baseWorkingDir: repo, worktreesRoot, ticketId: TICKET_A, role: 'assignee' });
    // dirty + inactive → kept (pended work)
    const dirty = await wm.resolveCwd({ baseWorkingDir: repo, worktreesRoot, ticketId: TICKET_B, role: 'assignee' });
    await fsp.writeFile(join(dirty.cwd, 'unsaved.txt'), 'do not lose me\n');
    // active → kept even though clean
    const active = await wm.resolveCwd({ baseWorkingDir: repo, worktreesRoot, ticketId: 'cccccccc-x', role: 'assignee' });

    const activeKeys = new Set([worktreeSlug('cccccccc-x', 'assignee')]);
    const removed = await wm.sweep({ baseWorkingDir: repo, worktreesRoot, activeKeys });
    assert.equal(removed, 1, 'only the clean idle worktree is swept');

    const remaining = (await wm.listWorktrees(repo)).map((w) => w.path);
    assert.ok(!remaining.some((p) => p.endsWith(worktreeSlug(TICKET_A, 'assignee'))), 'clean idle removed');
    assert.ok(remaining.some((p) => p.endsWith(worktreeSlug(TICKET_B, 'assignee'))), 'dirty kept');
    assert.ok(remaining.some((p) => p.endsWith(worktreeSlug('cccccccc-x', 'assignee'))), 'active kept');
    void clean; void active;
  } finally {
    await cleanup();
  }
});
