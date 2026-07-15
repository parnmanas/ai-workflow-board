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
      bootstrapRepo: { resourceId: 'repo-empty', url: source.remote, branch: 'main' },
    });
    assert.ok(result.isWorktree, 'container clone continues into ticket worktree creation');
    assert.equal(result.worktreePath, join(workingDir, '.awb', 'wt', 'repo-empty', 'aaaaaaaa'));
    assert.equal(git(join(workingDir, '.awb', 'base', 'repo-empty'), ['remote', 'get-url', 'origin']), source.remote);
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
      bootstrapRepo: { resourceId: 'repo-occupied', url: source.remote, branch: 'main' },
    });
    assert.equal(result.isWorktree, true);
    assert.equal(result.worktreePath, join(workingDir, '.awb', 'wt', 'repo-occupied', 'aaaaaaaa'));
    assert.equal(existsSync(join(workingDir, '.git')), false, 'container root never becomes a repository');
    assert.equal(await fsp.readFile(join(workingDir, 'keep.txt'), 'utf8'), 'user data\n');
    assert.equal(git(join(workingDir, '.awb', 'base', 'repo-occupied'), ['remote', 'get-url', 'origin']), source.remote);

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

test('one non-git container isolates base clones for different repository resources', async () => {
  const first = await makeRepoWithRemote();
  const second = await makeRepoWithRemote();
  const workingDir = join(first.root, 'multi-repo-agent-dir');
  try {
    await fsp.writeFile(join(second.repo, 'SECOND.md'), 'second repository\n');
    git(second.repo, ['add', 'SECOND.md']);
    git(second.repo, ['commit', '-q', '-m', 'identify second repo']);
    git(second.repo, ['push', '-q', 'origin', 'main']);
    await fsp.mkdir(workingDir, { recursive: true });
    const wm = new WorktreeManager();
    const a = await wm.resolveCwd({
      baseWorkingDir: workingDir,
      ticketId: TICKET_A,
      role: 'assignee',
      bootstrapRepo: { resourceId: 'repo/A', url: first.remote, branch: 'main' },
    });
    const b = await wm.resolveCwd({
      baseWorkingDir: workingDir,
      ticketId: TICKET_B,
      role: 'assignee',
      bootstrapRepo: { resourceId: 'repo/B', url: second.remote, branch: 'main' },
    });
    assert.ok(a.isWorktree && b.isWorktree);
    assert.equal(git(join(workingDir, '.awb', 'base', 'repo_A'), ['remote', 'get-url', 'origin']), first.remote);
    assert.equal(git(join(workingDir, '.awb', 'base', 'repo_B'), ['remote', 'get-url', 'origin']), second.remote);
    assert.equal(existsSync(join(a.cwd, 'SECOND.md')), false);
    assert.equal(await fsp.readFile(join(b.cwd, 'SECOND.md'), 'utf8'), 'second repository\n');
  } finally {
    await first.cleanup();
    await second.cleanup();
  }
});

test('container base clone credential store is inherited by its ticket worktree', async () => {
  const source = await makeRepoWithRemote();
  const workingDir = join(source.root, 'credential-container');
  const remoteUrl = 'https://git.example.test/acme/private.git';
  const previous = {
    count: process.env.GIT_CONFIG_COUNT,
    key: process.env.GIT_CONFIG_KEY_0,
    value: process.env.GIT_CONFIG_VALUE_0,
  };
  try {
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = `url.${source.remote}.insteadOf`;
    process.env.GIT_CONFIG_VALUE_0 = 'https://token-user:container-secret@git.example.test/acme/private.git';
    const wm = new WorktreeManager();
    const result = await wm.resolveCwd({
      baseWorkingDir: workingDir,
      ticketId: TICKET_C,
      role: 'assignee',
      bootstrapRepo: {
        resourceId: 'private-resource',
        url: remoteUrl,
        branch: 'main',
        credential: { username: 'token-user', token: 'container-secret' },
      },
    });
    assert.ok(result.isWorktree);
    const baseClone = join(workingDir, '.awb', 'base', 'private-resource');
    assert.equal(git(baseClone, ['remote', 'get-url', 'origin']), remoteUrl);
    const baseHelper = git(baseClone, ['config', '--get', 'credential.helper']);
    assert.equal(git(result.cwd, ['config', '--get', 'credential.helper']), baseHelper);
    const match = baseHelper.match(/^store --file="(.+)"$/);
    assert.ok(match);
    assert.match(await fsp.readFile(match[1], 'utf8'), /token-user:container-secret@git\.example\.test/);
  } finally {
    for (const [name, value] of Object.entries({
      GIT_CONFIG_COUNT: previous.count,
      GIT_CONFIG_KEY_0: previous.key,
      GIT_CONFIG_VALUE_0: previous.value,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await source.cleanup();
  }
});
