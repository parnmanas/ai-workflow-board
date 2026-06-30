// Self-update branch-adoption tests (ticket dc38dce6). Exercises the real git
// machinery against throwaway repos so the structural fix — adopting
// origin/<branch> via `git fetch` + `git checkout --detach` instead of
// `git checkout <branch>` + `git pull --ff-only` — is proven against the exact
// field condition that self-locked the manager: a ticket worktree holding the
// default branch checked out while self-update runs in the shared base repo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { adoptRemoteBranch } from '../dist/lib/self-update.js';

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

// Like git() but never throws — used to assert that a command FAILS.
function gitTry(cwd, args) {
  try {
    return { ok: true, out: git(cwd, args) };
  } catch (e) {
    return { ok: false, out: String(e?.stderr || e?.stdout || e?.message || e) };
  }
}

function commit(repo, file, content, msg) {
  // writeFileSync via execFileSync's sibling — keep it sync to match git() flow.
  execFileSync('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(join(repo, file))}, ${JSON.stringify(content)})`]);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', msg]);
  return git(repo, ['rev-parse', 'HEAD']);
}

/**
 * Build a bare `origin` + a `publisher` clone (mints releases) + a `manager`
 * clone (the self-updating agent-manager checkout). Mirrors the worktree-manager
 * test harness style.
 */
async function makeCluster() {
  const root = await fsp.mkdtemp(join(tmpdir(), 'awb-su-'));
  const origin = join(root, 'origin.git');
  const publisher = join(root, 'publisher');
  const manager = join(root, 'manager');

  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);

  execFileSync('git', ['clone', '-q', origin, publisher]);
  git(publisher, ['config', 'user.email', 'pub@awb.local']);
  git(publisher, ['config', 'user.name', 'AWB Publisher']);
  commit(publisher, 'README.md', '# v1\n', 'v1');
  git(publisher, ['push', '-q', 'origin', 'main']);

  execFileSync('git', ['clone', '-q', origin, manager]);
  git(manager, ['config', 'user.email', 'mgr@awb.local']);
  git(manager, ['config', 'user.name', 'AWB Manager']);

  return {
    root,
    origin,
    publisher,
    manager,
    cleanup: () => fsp.rm(root, { recursive: true, force: true }),
  };
}

test('adoptRemoteBranch updates the tree even when a worktree holds the default branch', async () => {
  const c = await makeCluster();
  try {
    // Reproduce the field condition: the manager's primary tree sits on
    // production.private, and a ticket worktree holds `main` checked out.
    git(c.manager, ['checkout', '-q', '-b', 'production.private']);
    const wt = join(c.root, 'mgr-wt');
    git(c.manager, ['worktree', 'add', '-q', wt, 'main']);

    // Sanity: the OLD self-update step (`git checkout main`) is exactly what
    // self-locked the manager — git refuses because main is held by the wt.
    const bug = gitTry(c.manager, ['checkout', 'main']);
    assert.equal(bug.ok, false, 'git checkout main must fail while a worktree holds main');
    assert.match(bug.out, /already used by worktree|already checked out/i);

    // Publish a new release to origin/main.
    const newSha = commit(c.publisher, 'VERSION', '0.9.1\n', 'v2 release');
    git(c.publisher, ['push', '-q', 'origin', 'main']);

    const prodShaBefore = git(c.manager, ['rev-parse', 'production.private']);

    // The fix: fetch + detached checkout. Must succeed despite the worktree.
    const logs = [];
    const res = await adoptRemoteBranch(c.manager, 'main', (m) => logs.push(m));
    assert.equal(res.ok, true, `adopt should succeed; got ${JSON.stringify(res)}`);

    // HEAD is detached (no branch ref held → cannot collide with the worktree).
    const headIsBranch = gitTry(c.manager, ['symbolic-ref', '-q', 'HEAD']);
    assert.equal(headIsBranch.ok, false, 'primary HEAD must be detached after adopt');

    // HEAD now points at the freshly published commit, and its file is present.
    assert.equal(git(c.manager, ['rev-parse', 'HEAD']), newSha, 'adopted the new release commit');
    assert.equal(await fsp.readFile(join(c.manager, 'VERSION'), 'utf8'), '0.9.1\n');

    // The unrelated local branch was NOT moved (the `git reset --hard` hazard
    // the detached checkout deliberately avoids).
    assert.equal(
      git(c.manager, ['rev-parse', 'production.private']),
      prodShaBefore,
      'production.private ref must be untouched',
    );

    // The ticket worktree holding main is left intact.
    assert.ok(git(c.manager, ['worktree', 'list']).includes(wt), 'worktree still registered');
  } finally {
    await c.cleanup();
  }
});

test('adoptRemoteBranch is a no-op-safe detach when already on the default branch', async () => {
  const c = await makeCluster();
  try {
    // Primary on main (the clone default). Publish a new commit, then adopt.
    const newSha = commit(c.publisher, 'CHANGELOG.md', 'v2\n', 'v2');
    git(c.publisher, ['push', '-q', 'origin', 'main']);

    const res = await adoptRemoteBranch(c.manager, 'main', () => {});
    assert.equal(res.ok, true);
    assert.equal(git(c.manager, ['rev-parse', 'HEAD']), newSha, 'fast-forwarded to new commit');
    const headIsBranch = gitTry(c.manager, ['symbolic-ref', '-q', 'HEAD']);
    assert.equal(headIsBranch.ok, false, 'ends on a detached HEAD regardless of start state');
  } finally {
    await c.cleanup();
  }
});

test('adoptRemoteBranch surfaces a structured failure when the branch cannot be fetched', async () => {
  const c = await makeCluster();
  try {
    const res = await adoptRemoteBranch(c.manager, 'no-such-branch', () => {});
    assert.equal(res.ok, false);
    assert.match(res.summary, /git fetch failed/);
  } finally {
    await c.cleanup();
  }
});
