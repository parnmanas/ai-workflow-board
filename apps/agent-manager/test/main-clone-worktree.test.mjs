// Board-less projects (docs/tickets.md) — the per-host "main clone folder".
//
// When `base_repo.main_clone_dir` names an absolute folder, WorktreeManager uses
// THAT folder as the base repository instead of `<working_dir>/.awb/base/<slug>`:
//   - missing / empty      → cloned into (same credential flow + clone policy);
//   - matching git origin  → only fetched — the operator's checkout is never
//                            reset, checked out, cleaned or detached;
//   - anything else        → durable failure (MAIN_CLONE_*), folder untouched.
// Ticket worktrees live at `<main>/.awb/wt/<ticket8>`, `.awb/` is excluded via
// `.git/info/exclude`, and terminal/archive cleanup + sweeps find them through the
// `mainCloneDir` option and the persisted main-clone registry.
//
// Real `git` against throwaway repos, same style as worktree-manager.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import {
  WorktreeManager,
  mainCloneWorktreesRootFor,
  MAIN_CLONE_NOT_GIT_REPO,
  MAIN_CLONE_WRONG_REPOSITORY,
} from '../dist/lib/worktree-manager.js';
import { classifyWorktreeOutcome, isDurableProvisioningBlocker, isSafeTicketProvisioningFallback } from '../dist/lib/dispatch-preflight.js';

const TICKET_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const TICKET_B = 'bbbbbbbb-1111-2222-3333-444444444444';

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

/** A bare `remote.git` with one commit on main, plus a scratch working copy
 *  (`seed`) that can push further commits to it. */
async function makeRemote() {
  const root = await fsp.mkdtemp(join(tmpdir(), 'awb-main-clone-'));
  const remote = join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const seed = join(root, 'seed');
  await fsp.mkdir(seed, { recursive: true });
  git(seed, ['init', '-q', '-b', 'main']);
  git(seed, ['config', 'user.email', 'test@awb.local']);
  git(seed, ['config', 'user.name', 'AWB Test']);
  await fsp.writeFile(join(seed, 'README.md'), '# base\n');
  git(seed, ['add', '.']);
  git(seed, ['commit', '-q', '-m', 'base']);
  git(seed, ['remote', 'add', 'origin', remote]);
  git(seed, ['push', '-q', '-u', 'origin', 'main']);
  return { root, remote, seed, cleanup: () => fsp.rm(root, { recursive: true, force: true }) };
}

async function pushCommit(seed, file, content) {
  await fsp.writeFile(join(seed, file), content);
  git(seed, ['add', file]);
  git(seed, ['commit', '-q', '-m', `add ${file}`]);
  git(seed, ['push', '-q', 'origin', 'main']);
  return git(seed, ['rev-parse', 'HEAD']);
}

function resolveArgs(fx, mainCloneDir, ticketId = TICKET_A, extra = {}) {
  return {
    baseWorkingDir: join(fx.root, 'agent-home'),
    ticketId,
    role: 'assignee',
    mode: 'per_ticket',
    bootstrapRepo: { resourceId: 'project-1', url: fx.remote, branch: 'main', mainCloneDir, ...extra },
  };
}

async function excludeLines(mainClone) {
  const raw = await fsp.readFile(join(mainClone, '.git', 'info', 'exclude'), 'utf8');
  return raw.split(/\r?\n/).filter((line) => line.trim() === '/.awb/');
}

test('missing main clone folder is cloned into; the ticket worktree lives at <main>/.awb/wt/<ticket8>', async () => {
  const fx = await makeRemote();
  const mainClone = join(fx.root, 'projects', 'web');
  try {
    const wm = new WorktreeManager();
    const res = await wm.resolveCwd(resolveArgs(fx, mainClone));
    assert.equal(res.isWorktree, true, res.reason);
    assert.equal(res.worktreePath, join(mainClone, '.awb', 'wt', 'aaaaaaaa'));
    assert.equal(mainCloneWorktreesRootFor(mainClone), join(mainClone, '.awb', 'wt'));
    assert.equal(git(mainClone, ['remote', 'get-url', 'origin']), fx.remote);
    assert.equal(git(res.cwd, ['branch', '--show-current']), `ticket/${TICKET_A}-work`);
    // The managed .awb/base container is NOT used when a main clone is named.
    assert.equal(existsSync(join(fx.root, 'agent-home', '.awb', 'base')), false);
    // `.awb/` is excluded, so the main clone stays clean despite the worktree inside it.
    assert.deepEqual(await excludeLines(mainClone), ['/.awb/']);
    assert.equal(git(mainClone, ['status', '--porcelain']), '');
    assert.deepEqual(await wm.knownMainClones(), [mainClone]);
  } finally {
    await fx.cleanup();
  }
});

test('an empty existing main clone folder is cloned into', async () => {
  const fx = await makeRemote();
  const mainClone = join(fx.root, 'empty-web');
  try {
    await fsp.mkdir(mainClone, { recursive: true });
    const res = await new WorktreeManager().resolveCwd(resolveArgs(fx, mainClone));
    assert.equal(res.isWorktree, true, res.reason);
    assert.equal(
      await fsp.realpath(git(mainClone, ['rev-parse', '--show-toplevel'])),
      await fsp.realpath(mainClone),
      'the folder itself became the checkout root',
    );
    assert.equal(res.worktreePath, join(mainClone, '.awb', 'wt', 'aaaaaaaa'));
    assert.equal(git(mainClone, ['remote', 'get-url', 'origin']), fx.remote);
  } finally {
    await fx.cleanup();
  }
});

test('an existing main clone with the project origin is only fetched — HEAD, branch and dirty files untouched', async () => {
  const fx = await makeRemote();
  const mainClone = join(fx.root, 'operator-web');
  try {
    // The operator's own checkout: different URL spelling (no `.git`, trailing
    // slash) for the same repository, on `main`, with uncommitted work.
    execFileSync('git', ['clone', '-q', fx.remote, mainClone]);
    git(mainClone, ['remote', 'set-url', 'origin', `${fx.remote.replace(/\.git$/, '')}/`]);
    await fsp.writeFile(join(mainClone, 'README.md'), '# operator edit (uncommitted)\n');
    await fsp.writeFile(join(mainClone, 'notes.txt'), 'untracked operator file\n');
    const operatorHead = git(mainClone, ['rev-parse', 'HEAD']);
    const remoteTip = await pushCommit(fx.seed, 'feature.txt', 'new upstream work\n');

    const wm = new WorktreeManager();
    const res = await wm.resolveCwd(resolveArgs(fx, mainClone));
    assert.equal(res.isWorktree, true, res.reason);
    assert.equal(res.worktreePath, join(mainClone, '.awb', 'wt', 'aaaaaaaa'));
    // fetched: the ticket starts from the NEW origin/main …
    assert.equal(git(mainClone, ['rev-parse', 'refs/remotes/origin/main']), remoteTip);
    assert.equal(res.repositoryContext.baseSha, remoteTip);
    assert.equal(git(res.cwd, ['merge-base', '--is-ancestor', remoteTip, 'HEAD']), '');
    // … but the operator's checkout itself was not moved, detached or cleaned.
    assert.equal(git(mainClone, ['rev-parse', 'HEAD']), operatorHead);
    assert.equal(git(mainClone, ['branch', '--show-current']), 'main', 'never detached');
    assert.equal(await fsp.readFile(join(mainClone, 'README.md'), 'utf8'), '# operator edit (uncommitted)\n');
    assert.equal(await fsp.readFile(join(mainClone, 'notes.txt'), 'utf8'), 'untracked operator file\n');
    const status = git(mainClone, ['status', '--porcelain']);
    assert.match(status, /README\.md/);
    assert.doesNotMatch(status, /\.awb/, '.awb/ is excluded from the operator\'s status');

    // Idempotent: a second ticket reuses the same clone and does not duplicate the exclude line.
    const second = await wm.resolveCwd(resolveArgs(fx, mainClone, TICKET_B));
    assert.equal(second.worktreePath, join(mainClone, '.awb', 'wt', 'bbbbbbbb'));
    assert.deepEqual(await excludeLines(mainClone), ['/.awb/']);
  } finally {
    await fx.cleanup();
  }
});

test('a non-empty folder that is not a git checkout root is a durable failure and is never wiped', async () => {
  const fx = await makeRemote();
  const mainClone = join(fx.root, 'not-a-repo');
  try {
    await fsp.mkdir(mainClone, { recursive: true });
    await fsp.writeFile(join(mainClone, 'keep.txt'), 'operator data\n');
    const res = await new WorktreeManager().resolveCwd(resolveArgs(fx, mainClone));
    assert.equal(res.isWorktree, false);
    assert.equal(res.reason, MAIN_CLONE_NOT_GIT_REPO);
    assert.match(res.detail, /not the root of a git checkout/);
    assert.deepEqual(await fsp.readdir(mainClone), ['keep.txt'], 'folder left exactly as it was');

    // A folder INSIDE another repository is not a checkout root either.
    const inner = join(fx.seed, 'sub');
    await fsp.mkdir(inner, { recursive: true });
    await fsp.writeFile(join(inner, 'x.txt'), 'x\n');
    const nested = await new WorktreeManager().resolveCwd(resolveArgs(fx, inner));
    assert.equal(nested.reason, MAIN_CLONE_NOT_GIT_REPO);

    const gate = classifyWorktreeOutcome(res);
    assert.deepEqual(gate, { blocked: true, kind: `worktree:${MAIN_CLONE_NOT_GIT_REPO}`, reason: MAIN_CLONE_NOT_GIT_REPO });
    assert.equal(isDurableProvisioningBlocker(gate.kind), true, 'operator must fix the folder — pend at once');
    assert.equal(isSafeTicketProvisioningFallback(gate.reason), false, 'no agent-side repair attempt');
  } finally {
    await fx.cleanup();
  }
});

test('a main clone whose origin is another repository is a durable failure and is left untouched', async () => {
  const fx = await makeRemote();
  const other = await makeRemote();
  const mainClone = join(fx.root, 'foreign');
  try {
    execFileSync('git', ['clone', '-q', other.remote, mainClone]);
    const head = git(mainClone, ['rev-parse', 'HEAD']);
    const res = await new WorktreeManager().resolveCwd(resolveArgs(fx, mainClone));
    assert.equal(res.isWorktree, false);
    assert.equal(res.reason, MAIN_CLONE_WRONG_REPOSITORY);
    assert.match(res.detail, /not the project repository/);
    assert.equal(git(mainClone, ['rev-parse', 'HEAD']), head);
    assert.equal(existsSync(join(mainClone, '.awb')), false, 'no worktree root created');
    assert.equal(isDurableProvisioningBlocker(`worktree:${MAIN_CLONE_WRONG_REPOSITORY}`), true);
  } finally {
    await fx.cleanup();
    await other.cleanup();
  }
});

test('terminal cleanup, archive removal and sweep find worktrees inside the main clone', async () => {
  const fx = await makeRemote();
  const mainClone = join(fx.root, 'web');
  try {
    const wm = new WorktreeManager();
    const a = await wm.resolveCwd(resolveArgs(fx, mainClone, TICKET_A));
    const b = await wm.resolveCwd(resolveArgs(fx, mainClone, TICKET_B));
    assert.equal(a.isWorktree && b.isWorktree, true);

    // Ticket A lands: commit, push the feature branch, merge it into origin/main.
    git(a.cwd, ['config', 'user.email', 'test@awb.local']);
    git(a.cwd, ['config', 'user.name', 'AWB Test']);
    await fsp.writeFile(join(a.cwd, 'a.txt'), 'ticket a\n');
    git(a.cwd, ['add', 'a.txt']);
    git(a.cwd, ['commit', '-q', '-m', 'ticket a']);
    const branchA = `ticket/${TICKET_A}-work`;
    git(a.cwd, ['push', '-q', '-u', 'origin', branchA]);
    git(a.cwd, ['push', '-q', 'origin', `${branchA}:main`]);

    // A working_dir-only call (no main clone) sees nothing of this ticket.
    const viaWorkingDir = await wm.cleanupTerminalTicketGit({
      baseWorkingDir: join(fx.root, 'agent-home'), ticketId: TICKET_A, baseBranch: 'main',
    });
    assert.equal(viaWorkingDir.removedWorktrees, 0);

    const report = await wm.cleanupTerminalTicketGit({
      mainCloneDir: mainClone, ticketId: TICKET_A, baseBranch: 'main', repositoryResourceId: 'project-1',
    });
    assert.equal(report.removedWorktrees, 1, JSON.stringify(report));
    assert.deepEqual(report.removedLocalBranches, [branchA]);
    assert.deepEqual(report.removedRemoteBranches, [branchA]);
    assert.deepEqual(report.heldReasons, []);
    assert.equal(existsSync(a.cwd), false);
    assert.equal(existsSync(b.cwd), true, 'another ticket\'s worktree is untouched');
    assert.equal(git(mainClone, ['branch', '--show-current']), 'main', 'operator HEAD untouched by cleanup');

    // A different project's resource id never touches this clone.
    assert.equal(await wm.removeTicketWorktrees({
      mainCloneDir: mainClone, ticketId: TICKET_B, repositoryResourceId: 'other-project',
    }), 0);
    // Archive removal force-removes ticket B's worktree (even if dirty).
    await fsp.writeFile(join(b.cwd, 'wip.txt'), 'dirty\n');
    assert.equal(await wm.removeTicketWorktrees({ mainCloneDir: mainClone, ticketId: TICKET_B }), 1);
    assert.equal(existsSync(b.cwd), false);

    // Sweep reclaims an idle clean worktree under the main clone, keeps active ones.
    const c = await wm.resolveCwd(resolveArgs(fx, mainClone, TICKET_B));
    assert.equal(await wm.sweep({ mainCloneDir: mainClone, activeKeys: new Set(['bbbbbbbb']) }), 0);
    assert.equal(await wm.sweep({ mainCloneDir: mainClone, activeKeys: new Set() }), 1);
    assert.equal(existsSync(c.cwd), false);
    assert.equal(git(mainClone, ['status', '--porcelain']), '');
  } finally {
    await fx.cleanup();
  }
});

test('the main clone registry persists across manager restarts', async () => {
  const fx = await makeRemote();
  const mainClone = join(fx.root, 'persisted-web');
  const registry = join(fx.root, 'manager-home', 'main-clones.json');
  try {
    const first = new WorktreeManager({ mainCloneRegistryPath: registry });
    assert.deepEqual(await first.knownMainClones(), []);
    const res = await first.resolveCwd(resolveArgs(fx, mainClone));
    assert.equal(res.isWorktree, true, res.reason);
    const saved = JSON.parse(await fsp.readFile(registry, 'utf8'));
    assert.equal(saved.clones[mainClone].resourceId, 'project-1');

    const restarted = new WorktreeManager({ mainCloneRegistryPath: registry });
    assert.deepEqual(await restarted.knownMainClones(), [mainClone]);
    const snapshot = await restarted.snapshotWorktrees({ mainCloneDir: mainClone, liveTicketIds: new Set([TICKET_A]) });
    assert.deepEqual(snapshot.map((e) => ({ slot: e.slot, ticketId: e.ticketId, state: e.state })), [
      { slot: 'aaaaaaaa', ticketId: TICKET_A, state: 'allocated' },
    ]);
  } finally {
    await fx.cleanup();
  }
});

test('a relative main_clone_dir is ignored — the managed .awb/base clone is used', async () => {
  const fx = await makeRemote();
  try {
    const res = await new WorktreeManager().resolveCwd(resolveArgs(fx, 'relative/web'));
    assert.equal(res.isWorktree, true, res.reason);
    assert.equal(res.worktreePath, join(fx.root, 'agent-home', '.awb', 'wt', 'project-1', 'aaaaaaaa'));
  } finally {
    await fx.cleanup();
  }
});
