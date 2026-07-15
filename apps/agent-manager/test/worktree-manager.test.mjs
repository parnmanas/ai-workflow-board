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
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';

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

test('empty non-git working_dir keeps its container root and clones under .awb', async () => {
  const source = await makeRepoWithRemote();
  const workingDir = join(source.root, 'empty-agent-dir');
  try {
    await fsp.mkdir(workingDir, { recursive: true });
    const wm = new WorktreeManager();
    const result = await wm.resolveCwd({
      baseWorkingDir: workingDir,
      ticketId: TICKET_A,
      role: 'assignee',
      bootstrapRepo: { url: source.remote, branch: 'main' },
    });
    assert.ok(result.isWorktree, 'container clone continues into ticket worktree creation');
    assert.equal(result.worktreePath, join(workingDir, '.awb', 'wt', 'aaaaaaaa'));
    assert.equal(git(join(workingDir, '.awb', 'base'), ['remote', 'get-url', 'origin']), source.remote);
    assert.equal(existsSync(join(workingDir, '.git')), false);
    assert.throws(() => git(workingDir, ['status', '--short']), /not a git repository/);
    assert.equal(await fsp.readFile(join(result.cwd, 'README.md'), 'utf8'), '# base\n');
  } finally {
    await source.cleanup();
  }
});

test('non-empty non-git working_dir provisions below .awb without touching container files', async () => {
  const source = await makeRepoWithRemote();
  const workingDir = join(source.root, 'occupied-agent-dir');
  try {
    await fsp.mkdir(workingDir, { recursive: true });
    await fsp.writeFile(join(workingDir, 'keep.txt'), 'user data\n');
    const wm = new WorktreeManager();
    const result = await wm.resolveCwd({
      baseWorkingDir: workingDir,
      ticketId: TICKET_A,
      role: 'assignee',
      bootstrapRepo: { url: source.remote, branch: 'main' },
    });
    assert.equal(result.isWorktree, true);
    assert.equal(result.worktreePath, join(workingDir, '.awb', 'wt', 'aaaaaaaa'));
    assert.equal(existsSync(join(workingDir, '.git')), false, 'container root never becomes a repository');
    assert.equal(await fsp.readFile(join(workingDir, 'keep.txt'), 'utf8'), 'user data\n');
    assert.equal(git(join(workingDir, '.awb', 'base'), ['remote', 'get-url', 'origin']), source.remote);

    git(result.cwd, ['config', 'user.email', 'test@awb.local']);
    git(result.cwd, ['config', 'user.name', 'AWB Test']);
    git(result.cwd, ['switch', '-q', '-c', 'ticket/container-bootstrap']);
    await fsp.writeFile(join(result.cwd, 'ticket.txt'), 'container worktree\n');
    git(result.cwd, ['add', 'ticket.txt']);
    git(result.cwd, ['commit', '-q', '-m', 'ticket change']);
    git(result.cwd, ['push', '-q', '-u', 'origin', 'ticket/container-bootstrap']);
    assert.equal(
      git(source.remote, ['rev-parse', 'refs/heads/ticket/container-bootstrap']),
      git(result.cwd, ['rev-parse', 'HEAD']),
      'commit created in the ticket worktree reaches origin',
    );
  } finally {
    await source.cleanup();
  }
});

test('repository credential helper uses one absolute store across ticket worktrees', async () => {
  const source = await makeRepoWithRemote();
  try {
    const wm = new WorktreeManager();
    const result = await wm.resolveCwd({
      baseWorkingDir: source.repo,
      ticketId: TICKET_A,
      role: 'assignee',
      bootstrapRepo: {
        url: 'https://github.com/acme/private.git',
        branch: 'main',
        credential: { username: 'x-access-token', token: 'github-secret' },
      },
    });
    assert.ok(result.isWorktree);

    const helperFromBase = git(source.repo, ['config', '--get', 'credential.helper']);
    const helperFromWorktree = git(result.cwd, ['config', '--get', 'credential.helper']);
    assert.equal(helperFromWorktree, helperFromBase);
    assert.match(helperFromBase, /^store --file="[/\\].+awb-credentials"$/);

    const match = helperFromBase.match(/^store --file="(.+)"$/);
    assert.ok(match);
    const stored = await fsp.readFile(match[1], 'utf8');
    assert.match(stored, /^https:\/\/x-access-token:github-secret@github\.com\/acme\/private\.git\/?$/m);
  } finally {
    await source.cleanup();
  }
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

test('repository resource keeps a ticket worktree stable across agent working dirs and managers', async () => {
  const { root, repo, cleanup } = await makeRepo();
  try {
    const otherAgentRepo = join(root, 'other-agent');
    git(root, ['clone', '-q', repo, otherAgentRepo]);
    const canonicalRoot = join(root, 'manager-worktrees');
    const bootstrapRepo = { resourceId: 'repo-resource-1', url: repo };
    const firstManager = new WorktreeManager({ resourceWorktreesRoot: canonicalRoot });
    const first = await firstManager.resolveCwd({
      baseWorkingDir: repo, ticketId: TICKET_A, role: 'assignee',
      mode: 'per_ticket', bootstrapRepo,
    });
    git(first.cwd, ['checkout', '-q', '-b', 'ticket/reassigned']);
    await fsp.writeFile(join(first.cwd, 'wip.txt'), 'preserved across reassignment\n');

    const secondManager = new WorktreeManager({ resourceWorktreesRoot: canonicalRoot });
    const second = await secondManager.resolveCwd({
      baseWorkingDir: otherAgentRepo, ticketId: TICKET_A, role: 'reviewer',
      mode: 'per_ticket', bootstrapRepo,
    });
    assert.equal(second.cwd, first.cwd, 'agent and manager instance do not affect canonical cwd');
    assert.equal(second.reused, true);
    assert.equal(git(second.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']), 'ticket/reassigned');
    assert.equal(await fsp.readFile(join(second.cwd, 'wip.txt'), 'utf8'), 'preserved across reassignment\n');
  } finally {
    await cleanup();
  }
});

test('repository resource serializes concurrent first resolve across manager instances', async () => {
  const { root, repo, cleanup } = await makeRepo();
  try {
    const otherAgentRepo = join(root, 'other-agent');
    git(root, ['clone', '-q', repo, otherAgentRepo]);
    const canonicalRoot = join(root, 'manager-worktrees');
    const bootstrapRepo = { resourceId: 'repo-resource-race', url: repo };
    const [first, second] = await Promise.all([
      new WorktreeManager({ resourceWorktreesRoot: canonicalRoot }).resolveCwd({
        baseWorkingDir: repo, ticketId: TICKET_A, role: 'assignee', mode: 'per_ticket', bootstrapRepo,
      }),
      new WorktreeManager({ resourceWorktreesRoot: canonicalRoot }).resolveCwd({
        baseWorkingDir: otherAgentRepo, ticketId: TICKET_A, role: 'reviewer', mode: 'per_ticket', bootstrapRepo,
      }),
    ]);
    assert.equal(first.isWorktree, true);
    assert.equal(second.isWorktree, true, 'loser never falls back to its shared agent cwd');
    assert.equal(second.cwd, first.cwd, 'both managers resolve the single canonical ticket cwd');
    const owner = (await fsp.readFile(join(canonicalRoot, 'repo-resource-race', '.repo-owner'), 'utf8')).trim();
    assert.ok(owner === repo || owner === otherAgentRepo, 'one durable repository owner wins');
    assert.equal(git(owner, ['worktree', 'list', '--porcelain']).match(/worktree /g)?.length, 2);
  } finally {
    await cleanup();
  }
});

test('provision lease never steals a stale-looking lock from a live owner', async () => {
  const { root, repo, cleanup } = await makeRepo();
  try {
    const canonicalRoot = join(root, 'manager-worktrees');
    const resourceRoot = join(canonicalRoot, 'repo-resource-live-lock');
    const lockDir = join(resourceRoot, '.provision.lock');
    await fsp.mkdir(lockDir, { recursive: true });
    await fsp.writeFile(join(lockDir, 'owner.json'), JSON.stringify({ token: 'live-owner', pid: process.pid }));
    const old = new Date(Date.now() - 5_000);
    await fsp.utimes(lockDir, old, old);

    const wm = new WorktreeManager({
      resourceWorktreesRoot: canonicalRoot,
      provisionLockTimeoutMs: 100,
      provisionLockStaleMs: 10,
      provisionLockHeartbeatMs: 5,
    });
    await assert.rejects(wm.resolveCwd({
      baseWorkingDir: repo,
      ticketId: TICKET_A,
      role: 'assignee',
      mode: 'per_ticket',
      bootstrapRepo: { resourceId: 'repo-resource-live-lock', url: repo },
    }), /provision lock timeout/);
    assert.equal(JSON.parse(await fsp.readFile(join(lockDir, 'owner.json'), 'utf8')).token, 'live-owner');
  } finally {
    await cleanup();
  }
});

test('provision lease atomically reclaims a stale lock whose owner is dead', async () => {
  const { root, repo, cleanup } = await makeRepo();
  try {
    const canonicalRoot = join(root, 'manager-worktrees');
    const resourceRoot = join(canonicalRoot, 'repo-resource-dead-lock');
    const lockDir = join(resourceRoot, '.provision.lock');
    await fsp.mkdir(lockDir, { recursive: true });
    await fsp.writeFile(join(lockDir, 'owner.json'), JSON.stringify({ token: 'dead-owner', pid: 2147483647 }));
    const old = new Date(Date.now() - 5_000);
    await fsp.utimes(lockDir, old, old);

    const wm = new WorktreeManager({
      resourceWorktreesRoot: canonicalRoot,
      provisionLockTimeoutMs: 500,
      provisionLockStaleMs: 10,
      provisionLockHeartbeatMs: 5,
    });
    const result = await wm.resolveCwd({
      baseWorkingDir: repo,
      ticketId: TICKET_A,
      role: 'assignee',
      mode: 'per_ticket',
      bootstrapRepo: { resourceId: 'repo-resource-dead-lock', url: repo },
    });
    assert.equal(result.isWorktree, true);
    assert.equal(existsSync(lockDir), false, 'the current owner releases only its own lease');
  } finally {
    await cleanup();
  }
});

for (const ownerState of ['missing', 'malformed']) {
  test(`provision lease recovers from stale lock with ${ownerState} owner metadata`, async () => {
    const { root, repo, cleanup } = await makeRepo();
    try {
      const canonicalRoot = join(root, 'manager-worktrees');
      const resourceId = `repo-resource-${ownerState}-owner`;
      const lockDir = join(canonicalRoot, resourceId, '.provision.lock');
      await fsp.mkdir(lockDir, { recursive: true });
      if (ownerState === 'malformed') {
        await fsp.writeFile(join(lockDir, 'owner.json'), '{not-json');
      }
      const old = new Date(Date.now() - 5_000);
      await fsp.utimes(lockDir, old, old);

      const wm = new WorktreeManager({
        resourceWorktreesRoot: canonicalRoot,
        provisionLockTimeoutMs: 500,
        provisionLockStaleMs: 10,
        provisionLockHeartbeatMs: 5,
      });
      const result = await wm.resolveCwd({
        baseWorkingDir: repo,
        ticketId: TICKET_A,
        role: 'assignee',
        mode: 'per_ticket',
        bootstrapRepo: { resourceId, url: repo },
      });
      assert.equal(result.isWorktree, true);
      assert.equal(existsSync(lockDir), false, 'recovered lease is released after provisioning');
    } finally {
      await cleanup();
    }
  });
}

test('repository resource ticket worktree is reclaimed through its canonical owner', async () => {
  const { root, repo, cleanup } = await makeRepo();
  try {
    const otherAgentRepo = join(root, 'other-agent');
    git(root, ['clone', '-q', repo, otherAgentRepo]);
    const canonicalRoot = join(root, 'manager-worktrees');
    const bootstrapRepo = { resourceId: 'repo-resource-cleanup', url: repo };
    const wm = new WorktreeManager({ resourceWorktreesRoot: canonicalRoot });
    const resolved = await wm.resolveCwd({
      baseWorkingDir: repo, ticketId: TICKET_A, role: 'assignee', mode: 'per_ticket', bootstrapRepo,
    });
    await fsp.writeFile(join(resolved.cwd, 'dirty.txt'), 'terminal dirty state\n');
    const removed = await wm.removeTicketWorktrees({
      baseWorkingDir: otherAgentRepo,
      ticketId: TICKET_A,
      repositoryResourceId: bootstrapRepo.resourceId,
    });
    assert.equal(removed, 1);
    assert.equal(existsSync(resolved.worktreePath), false, 'resource-scoped checkout directory is removed');
    assert.equal(git(repo, ['worktree', 'list', '--porcelain']).includes(resolved.worktreePath), false);
  } finally {
    await cleanup();
  }
});

test('concurrent per-ticket provisioning is atomic and isolates branch/index/untracked files', async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const wm = new WorktreeManager();
    const [a, b] = await Promise.all([
      wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_A, role: 'assignee' }),
      wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_B, role: 'assignee' }),
    ]);

    assert.equal(a.isWorktree, true);
    assert.equal(b.isWorktree, true);
    assert.notEqual(a.cwd, b.cwd, 'different tickets never share a cwd');
    git(a.cwd, ['checkout', '-q', '-b', 'ticket/concurrent-a']);
    await fsp.writeFile(join(a.cwd, 'only-a.txt'), 'private to A\n');
    assert.equal(git(b.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD', 'B remains detached');
    await assert.rejects(fsp.access(join(b.cwd, 'only-a.txt')), 'A untracked file is invisible in B');

    const [a1, a2] = await Promise.all([
      wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_A, role: 'assignee' }),
      wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_A, role: 'reviewer' }),
    ]);
    assert.equal(a1.cwd, a.cwd, 'same ticket reuses its stable path');
    assert.equal(a2.cwd, a.cwd, 'simultaneous respawn resolves to the same registered worktree');
    assert.equal(a1.isWorktree, true);
    assert.equal(a2.isWorktree, true, 'no racing caller falls back to the shared base cwd');
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

// ── crash-tolerant lease reclaim: reconcilePoolLeases (ticket 4ed77ad5) ───────

async function readRegistry(wtRoot) {
  return JSON.parse(await fsp.readFile(join(wtRoot, '.pool-leases.json'), 'utf8'));
}

// Rewrite a slot's leasedAt to `agoMs` in the past so crash-reclaim's freshness
// grace treats it as a genuinely orphaned (old) lease rather than a worker still
// mid-dispatch. 60 min comfortably clears the 20-min grace.
async function backdateLease(wtRoot, slot, agoMs) {
  const path = join(wtRoot, '.pool-leases.json');
  const reg = JSON.parse(await fsp.readFile(path, 'utf8'));
  reg.slots[slot].leasedAt = new Date(Date.now() - agoMs).toISOString();
  await fsp.writeFile(path, JSON.stringify(reg, null, 2));
}

test('reconcilePoolLeases reclaims a dead worker\'s orphaned active lease → idle (state flip only)', async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const wm = new WorktreeManager();
    const wtRoot = worktreesRootFor(repo);
    // Ticket A leases shared-0 and does work, then its worker DIES (exit-143)
    // WITHOUT ever releasing — the slot stays active in the registry.
    const a = await wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_A, role: 'assignee', mode: 'shared', poolSize: 2 });
    git(a.cwd, ['checkout', '-q', '-b', 'ticket/aaaaaaaa']);
    await fsp.writeFile(join(a.cwd, 'build-artifact.bin'), 'WARM\n'); // untracked warm build
    assert.equal((await readRegistry(wtRoot)).slots['shared-0'].active, true, 'lease active before reclaim');
    // The worker died a while ago (mid-build), so its lease is well past the
    // freshness grace — it's a genuine orphan, not a mid-dispatch worker.
    await backdateLease(wtRoot, 'shared-0', 60 * 60 * 1000);

    // Reconcile against a live set that does NOT contain A (its worker is dead).
    const reclaimed = await wm.reconcilePoolLeases({ baseWorkingDir: repo, liveTicketIds: new Set() });
    assert.equal(reclaimed, 1, 'the orphaned lease was reclaimed');

    const reg = await readRegistry(wtRoot);
    assert.equal(reg.slots['shared-0'].active, false, 'lease flipped to idle');
    assert.equal(reg.slots['shared-0'].branch, 'ticket/aaaaaaaa', 'slot branch recorded for the next acquire to drop');
    // Pure state flip: the slot dir and its untracked warm build are UNTOUCHED.
    assert.ok(existsSync(join(wtRoot, 'shared-0')), 'slot dir preserved (never rm)');
    assert.ok(existsSync(join(a.cwd, 'build-artifact.bin')), 'untracked warm build preserved by reclaim');
    assert.ok(git(repo, ['branch', '--list', 'ticket/aaaaaaaa']).includes('ticket/aaaaaaaa'), 'branch not dropped by reclaim (deferred to acquire)');

    // The reclaimed slot behaves exactly like a released one: the next ticket
    // reuses it (warm) and reset-on-acquire cleans tracked source + drops the branch.
    const b = await wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_B, role: 'assignee', mode: 'shared', poolSize: 2 });
    assert.equal(b.worktreePath, join(wtRoot, 'shared-0'), 'reclaimed slot is reused before opening a new one');
    assert.ok(existsSync(join(b.cwd, 'build-artifact.bin')), 'warm build still preserved through the reset-on-acquire');
    assert.ok(!git(repo, ['branch', '--list', 'ticket/aaaaaaaa']).includes('ticket/aaaaaaaa'), 'stale branch dropped at acquire');
  } finally {
    await cleanup();
  }
});

test('reconcilePoolLeases KEEPS a lease whose ticket is still live (no false reclaim)', async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const wm = new WorktreeManager();
    const wtRoot = worktreesRootFor(repo);
    await wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_A, role: 'assignee', mode: 'shared', poolSize: 2 });
    // A is still alive → present in the live set.
    const reclaimed = await wm.reconcilePoolLeases({
      baseWorkingDir: repo,
      liveTicketIds: new Set([TICKET_A]),
    });
    assert.equal(reclaimed, 0, 'a live worker\'s slot is never reclaimed');
    assert.equal((await readRegistry(wtRoot)).slots['shared-0'].active, true, 'lease stays active');
  } finally {
    await cleanup();
  }
});

test('reconcilePoolLeases is a no-op (0) on a per_ticket board — no registry', async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const wm = new WorktreeManager();
    // per_ticket worktree, no pool registry ever written.
    await wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_A, role: 'assignee' });
    const reclaimed = await wm.reconcilePoolLeases({ baseWorkingDir: repo, liveTicketIds: new Set() });
    assert.equal(reclaimed, 0, 'nothing to reconcile when there is no pool');
    assert.ok(!existsSync(join(worktreesRootFor(repo), '.pool-leases.json')), 'no spurious registry created');
  } finally {
    await cleanup();
  }
});

test('reconcilePoolLeases spares a slot a live process is still cwd\'d inside (OS-liveness guard)', {
  skip: process.platform !== 'linux' ? 'Linux /proc only' : false,
}, async () => {
  const { repo, cleanup } = await makeRepo();
  let child;
  try {
    const wm = new WorktreeManager();
    const wtRoot = worktreesRootFor(repo);
    const a = await wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_A, role: 'assignee', mode: 'shared', poolSize: 1 });
    // A detached worker that outlived a manager restart: absent from the live
    // session snapshot (empty liveTicketIds) but still RUNNING with its cwd
    // inside the slot. reclaim must NOT flip it (it would reset the tree under a
    // live build). Real /proc/<pid>/cwd, not a mock.
    child = spawn('sleep', ['30'], { cwd: a.cwd, stdio: 'ignore' });
    await once(child, 'spawn');
    // Backdate past the freshness grace so it can't short-circuit — the /proc
    // belt must be the thing that spares this slot, not the leasedAt grace.
    await backdateLease(wtRoot, 'shared-0', 60 * 60 * 1000);

    const reclaimed = await wm.reconcilePoolLeases({ baseWorkingDir: repo, liveTicketIds: new Set() });
    assert.equal(reclaimed, 0, 'a slot with a live process cwd\'d inside is spared');
    assert.equal((await readRegistry(wtRoot)).slots['shared-0'].active, true, 'lease stays active');
  } finally {
    if (child) {
      child.kill('SIGKILL');
      await once(child, 'exit').catch(() => {});
    }
    await cleanup();
  }
});

test('reset-on-acquire never `branch -D` the base branch literal (main/master) even when base detection returns null', async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const wm = new WorktreeManager();
    const wtRoot = worktreesRootFor(repo);
    // No remote → #detectBaseBranch returns null, so the old `b !== base` guard
    // (b !== null → always true) would delete a slot's `master` branch. The
    // literal-protection must save it.
    const a = await wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_A, role: 'assignee', mode: 'shared', poolSize: 1 });
    // Put the slot on a branch literally named `master` and record it via release.
    git(a.cwd, ['checkout', '-q', '-b', 'master']);
    await fsp.writeFile(join(a.cwd, 'x.txt'), 'x\n');
    git(a.cwd, ['add', '.']);
    git(a.cwd, ['commit', '-q', '-m', 'on master']);
    await wm.removeTicketWorktrees({ baseWorkingDir: repo, ticketId: TICKET_A }); // release (records branch=master)

    // B reacquires shared-0 → reset-on-acquire runs its branch-drop loop.
    const b = await wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_B, role: 'assignee', mode: 'shared', poolSize: 1 });
    assert.equal(b.worktreePath, join(wtRoot, 'shared-0'));
    assert.ok(git(repo, ['branch', '--list', 'master']).includes('master'), 'base-branch literal survives reset-on-acquire');
  } finally {
    await cleanup();
  }
});

test('reconcilePoolLeases spares a just-leased slot (freshness grace) but reclaims it once past the grace', async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const wm = new WorktreeManager();
    const wtRoot = worktreesRootFor(repo);
    // A slot leased THIS instant: the worker may still be provisioning/spawning
    // (env clone → fetch context → spawn) and not yet in the live snapshot. An
    // empty live set must NOT reclaim it — that is the mid-dispatch false-reclaim
    // the ticket forbids (force_respawn death-loop lesson).
    await wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_A, role: 'assignee', mode: 'shared', poolSize: 1 });
    let reclaimed = await wm.reconcilePoolLeases({ baseWorkingDir: repo, liveTicketIds: new Set() });
    assert.equal(reclaimed, 0, 'fresh lease within the grace is spared even with an empty live set');
    assert.equal((await readRegistry(wtRoot)).slots['shared-0'].active, true, 'fresh lease stays active');

    // Advance past the grace → now a genuine orphan → reclaimed.
    await backdateLease(wtRoot, 'shared-0', 60 * 60 * 1000);
    reclaimed = await wm.reconcilePoolLeases({ baseWorkingDir: repo, liveTicketIds: new Set() });
    assert.equal(reclaimed, 1, 'once past the grace the orphaned lease is reclaimed');
    assert.equal((await readRegistry(wtRoot)).slots['shared-0'].active, false, 'old orphan flipped to idle');
  } finally {
    await cleanup();
  }
});

test('reattach refreshes leasedAt so a re-dispatched worker is re-protected by the grace', async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const wm = new WorktreeManager();
    const wtRoot = worktreesRootFor(repo);
    await wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_A, role: 'assignee', mode: 'shared', poolSize: 1 });
    // A was leased long ago and its worker was idle-reaped (lease still active).
    await backdateLease(wtRoot, 'shared-0', 60 * 60 * 1000);
    // A re-triggers → reattaches the SAME slot; leasedAt must bump to now so the
    // re-spawn window is inside the grace again (else a reconcile tick during
    // re-dispatch would false-reclaim the reattaching worker).
    await wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_A, role: 'assignee', mode: 'shared', poolSize: 1 });
    const reclaimed = await wm.reconcilePoolLeases({ baseWorkingDir: repo, liveTicketIds: new Set() });
    assert.equal(reclaimed, 0, 'a just-reattached slot is within the refreshed grace → not reclaimed');
    assert.equal((await readRegistry(wtRoot)).slots['shared-0'].active, true, 'reattached lease stays active');
  } finally {
    await cleanup();
  }
});

// ── snapshotWorktrees (ticket 72fc244f — worktree visibility) ────────────────

test('snapshotWorktrees: shared slot → allocated/idle/orphaned + per_ticket, joined to lease registry', async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const wm = new WorktreeManager({ enabled: true });
    const wtRoot = worktreesRootFor(repo);

    // Lease a shared pool slot for A (poolSize 2) and create a per_ticket dir for C.
    await wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_A, role: 'assignee', mode: 'shared', poolSize: 2 });
    await wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_C, role: 'assignee', mode: 'per_ticket' });

    const findShared = (snap) => snap.find((w) => w.mode === 'shared' && w.slot === 'shared-0');
    const findPer = (snap) => snap.find((w) => w.mode === 'per_ticket' && w.slot === 'cccccccc');

    // 1) A + C both live → allocated + live; the shared entry carries the full uuid.
    let snap = await wm.snapshotWorktrees({ baseWorkingDir: repo, liveTicketIds: new Set([TICKET_A, TICKET_C]) });
    let sA = findShared(snap);
    assert.ok(sA, 'shared-0 present');
    assert.equal(sA.state, 'allocated');
    assert.equal(sA.live, true);
    assert.equal(sA.ticketId, TICKET_A, 'shared active lease carries the full ticket uuid');
    let pC = findPer(snap);
    assert.ok(pC, 'per_ticket dir present');
    assert.equal(pC.state, 'allocated');
    assert.equal(pC.live, true);
    assert.equal(pC.ticketId, TICKET_C, 'live per_ticket dir resolves to the full uuid');
    // Ordering: shared pool slots sort before per_ticket dirs.
    assert.equal(snap[0].mode, 'shared', 'shared entries sort first');

    // 2) Nothing live but the lease is still fresh → allocated (assumed mid-dispatch),
    //    and the idle per_ticket dir reports ticketId=null (only the 8-char slug is local).
    snap = await wm.snapshotWorktrees({ baseWorkingDir: repo, liveTicketIds: new Set() });
    sA = findShared(snap);
    assert.equal(sA.state, 'allocated', 'a fresh lease within the grace is NOT a leak');
    assert.equal(sA.live, false);
    pC = findPer(snap);
    assert.equal(pC.state, 'idle');
    assert.equal(pC.ticketId, null, 'an idle per_ticket dir exposes no full uuid');

    // 3) Age the lease past the reclaim grace with no live owner → orphaned (the exact
    //    leak reconcilePoolLeases would reclaim, surfaced so an operator can eyeball it).
    await backdateLease(wtRoot, 'shared-0', 60 * 60 * 1000);
    snap = await wm.snapshotWorktrees({ baseWorkingDir: repo, liveTicketIds: new Set() });
    sA = findShared(snap);
    assert.equal(sA.state, 'orphaned', 'aged, ownerless active lease → orphaned');
    assert.equal(sA.live, false);

    // 4) A released (inactive) lease → idle, no ticket.
    const reg = await readRegistry(wtRoot);
    reg.slots['shared-0'].active = false;
    await fsp.writeFile(join(wtRoot, '.pool-leases.json'), JSON.stringify(reg, null, 2));
    snap = await wm.snapshotWorktrees({ baseWorkingDir: repo, liveTicketIds: new Set() });
    sA = findShared(snap);
    assert.equal(sA.state, 'idle', 'a released lease → idle');
    assert.equal(sA.ticketId, null);
  } finally {
    await cleanup();
  }
});

test('snapshotWorktrees: disabled manager and an empty .awb/wt root → [] (never throws)', async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const disabled = new WorktreeManager({ enabled: false });
    assert.deepEqual(
      await disabled.snapshotWorktrees({ baseWorkingDir: repo, liveTicketIds: new Set() }),
      [],
      'a disabled manager reports nothing',
    );
    const wm = new WorktreeManager({ enabled: true });
    // No .awb/wt created yet → empty list, no throw.
    assert.deepEqual(
      await wm.snapshotWorktrees({ baseWorkingDir: repo, liveTicketIds: new Set() }),
      [],
      'an untouched repo has no live worktrees',
    );
  } finally {
    await cleanup();
  }
});

// ── dispatch preflight: worktree occupancy + push-credential readiness ───────
// (ticket a3047a86)

test('resolveCwd: a foreign directory occupying the ticket worktree path → path_conflict (never clobbers)', async () => {
  // The per-ticket model's analog of "another ticket's dirty working folder":
  // a non-worktree directory already sits at <working_dir>/.awb/wt/<ticket8>.
  // The manager must refuse to clobber it and surface `path_conflict` so the
  // dispatcher aborts instead of running the agent on a foreign checkout.
  const { repo, cleanup } = await makeRepo();
  try {
    const wtPath = join(worktreesRootFor(repo), worktreeSlug(TICKET_A, 'per_ticket'));
    await fsp.mkdir(wtPath, { recursive: true });
    await fsp.writeFile(join(wtPath, 'stray.txt'), 'left behind by another ticket\n');
    const wm = new WorktreeManager();
    const r = await wm.resolveCwd({ baseWorkingDir: repo, ticketId: TICKET_A, role: 'assignee' });
    assert.equal(r.isWorktree, false);
    assert.equal(r.reason, 'path_conflict');
  } finally {
    await cleanup();
  }
});

test('verifyPushReadiness: no origin / non-https remote → ready (key/local auth, not this failure mode)', async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const wm = new WorktreeManager();
    assert.deepEqual(await wm.verifyPushReadiness(repo), { ok: true }, 'no origin remote → ready');
    assert.deepEqual(
      await wm.verifyPushReadiness(repo, 'git@github.com:example/repo.git'),
      { ok: true },
      'ssh remote → ready',
    );
    assert.deepEqual(
      await wm.verifyPushReadiness(repo, '/srv/git/example.git'),
      { ok: true },
      'local path remote → ready',
    );
  } finally {
    await cleanup();
  }
});

test('verifyPushReadiness: disabled manager never blocks', async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const wm = new WorktreeManager({ enabled: false });
    assert.deepEqual(
      await wm.verifyPushReadiness(repo, 'https://github.com/example/repo.git'),
      { ok: true },
    );
  } finally {
    await cleanup();
  }
});

test('verifyPushReadiness: https, no resolvable credential, unreachable host → fails open (transient, never wedges)', async () => {
  // With no repo-local credential.helper the check falls through to a live
  // ls-remote probe. A reserved `.invalid` TLD makes git fail fast with a DNS
  // error (NOT an auth error), which must be treated as transient → ready, so a
  // network blip never wedges a ticket. (On a host that happens to carry an
  // ambient credential.helper / token env the check short-circuits to ready
  // before probing — same outcome, so this assertion holds either way.)
  const { repo, cleanup } = await makeRepo();
  try {
    const wm = new WorktreeManager();
    const r = await wm.verifyPushReadiness(repo, 'https://awb-nonexistent.invalid/example/repo.git');
    assert.equal(r.ok, true);
  } finally {
    await cleanup();
  }
});
