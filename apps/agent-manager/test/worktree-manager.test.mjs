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
import { isAbsolute, join } from 'node:path';
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
import { classifyWorktreeOutcome } from '../dist/lib/dispatch-preflight.js';

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function credentialFileFromHelper(helper) {
  const match = helper.match(/^store --file=("(?:\\.|[^"])*")$/);
  assert.ok(match, `helper 형식 불일치: ${helper}`);
  return JSON.parse(match[1]);
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
    // Windows git checkout 은 core.autocrlf 로 LF→CRLF 변환하므로 개행 정규화 후 비교 (ticket e09fa003).
    assert.equal((await fsp.readFile(join(result.cwd, 'README.md'), 'utf8')).replace(/\r\n/g, '\n'), '# base\n');
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
    // Windows git checkout 은 core.autocrlf 로 LF→CRLF 변환하므로 개행 정규화 후 비교 (ticket e09fa003).
    assert.equal((await fsp.readFile(join(b.cwd, 'SECOND.md'), 'utf8')).replace(/\r\n/g, '\n'), 'second repository\n');
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
    const credentialFile = credentialFileFromHelper(baseHelper);
    assert.ok(isAbsolute(credentialFile), `credential 파일이 절대경로가 아님: ${credentialFile}`);
    assert.equal(await fsp.stat(credentialFile).then((stat) => stat.isFile()), true);
    assert.match(await fsp.readFile(credentialFile, 'utf8'), /token-user:container-secret@git\.example\.test/);
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

// ── verifyCheckout (ticket feaa7ab0, completion criterion #1/#4) ──────────────
// Drive the real git probe against throwaway trees so the three named
// regression scenarios — valid checkout, wrong path (not a git repo), and an
// incomplete checkout — are covered end-to-end, plus the foreign-repo defense.

test('verifyCheckout: a provisioned worktree is a valid checkout of its expected repo', async () => {
  const source = await makeRepoWithRemote();
  const workingDir = join(source.root, 'verify-agent-dir');
  try {
    const wm = new WorktreeManager();
    const result = await wm.resolveCwd({
      baseWorkingDir: workingDir,
      ticketId: TICKET_A,
      role: 'assignee',
      bootstrapRepo: { resourceId: 'repo-verify', url: source.remote, branch: 'main' },
    });
    assert.ok(result.isWorktree, 'provisioning succeeds');
    // The freshly-provisioned worktree passes verification against its repo url —
    // proving the new gate never blocks a legitimately-provisioned tree.
    assert.deepEqual(await wm.verifyCheckout(result.cwd, source.remote), { ok: true });
    // With no expectation the origin match is skipped but the tree is still valid.
    assert.deepEqual(await wm.verifyCheckout(result.cwd), { ok: true });
    // Claiming it should be a DIFFERENT repo is caught as wrong_repository.
    const wrong = await wm.verifyCheckout(result.cwd, 'https://github.com/acme/not-this.git');
    assert.equal(wrong.ok, false);
    assert.equal(wrong.reason, 'wrong_repository');
    assert.match(wrong.detail, /does not match/);
  } finally {
    await source.cleanup();
  }
});

test('verifyCheckout: an empty / missing / non-git path → not_a_git_repo (wrong path, blocked)', async () => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'awb-verify-empty-'));
  try {
    const wm = new WorktreeManager();
    const empty = join(root, 'not-a-repo');
    await fsp.mkdir(empty, { recursive: true });
    assert.equal((await wm.verifyCheckout(empty, 'https://github.com/acme/widget.git')).reason, 'not_a_git_repo');
    // A path that does not exist at all is likewise not a work tree.
    assert.equal((await wm.verifyCheckout(join(root, 'nope'), 'https://github.com/acme/widget.git')).reason, 'not_a_git_repo');
    // Defensive: no cwd at all.
    assert.equal((await wm.verifyCheckout('')).reason, 'not_a_git_repo');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('verifyCheckout: an initialized-but-unpopulated checkout → incomplete_checkout (blocked)', async () => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'awb-verify-incomplete-'));
  try {
    const wm = new WorktreeManager();
    const half = join(root, 'half');
    await fsp.mkdir(half, { recursive: true });
    // A work tree whose HEAD does not resolve — mirrors an interrupted clone/add.
    git(half, ['init', '-q', '-b', 'main']);
    const d = await wm.verifyCheckout(half, 'https://github.com/acme/widget.git');
    assert.equal(d.ok, false);
    assert.equal(d.reason, 'incomplete_checkout');
    assert.match(d.detail, /HEAD does not resolve/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ── ticket 112ea3c5: a ticket that inherits the board's repo must never land
// in a DIFFERENT resource's pre-existing worktree ──────────────────────────
//
// Reproduces the reported incident precisely: an agent working_dir that
// already carries an unrelated resource's checkout (from earlier, correctly-
// scoped work on a different board/ticket) must not leak into a NEW ticket
// whose own base_repo_resource_id is empty and resolves to a DIFFERENT
// resource via the board environment. WorktreeManager.resolveCwd scopes every
// worktree root by `resourceSlug` (`.awb/wt/<resourceSlug>/…`), so this also
// serves as the integration-level proof for classifyWorktreeOutcome's
// hard-fail contract (completion criterion #4): a provisioning failure for
// the CORRECT resource must never fall back to the other, already-present
// resource's checkout.

const TICKET_OTHER_BOARD = 'dddddddd-1111-2222-3333-444444444444';
const TICKET_D = 'eeeeeeee-1111-2222-3333-444444444444';
const TICKET_E = 'ffffffff-1111-2222-3333-444444444444';

for (const ticketMode of ['per_ticket', 'shared']) {
  test(`resolveCwd (${ticketMode}): a pre-existing OTHER resource's shared worktree is never reused for a ticket resolved to a DIFFERENT resource`, async () => {
    const other = await makeRepoWithRemote(); // e.g. "GameClient" — unrelated resource
    const correct = await makeRepoWithRemote(); // e.g. "Emberdelve" — the board-resolved repo
    const workingDir = join(other.root, 'shared-agent-home');
    try {
      await fsp.writeFile(join(other.repo, 'OTHER_MARKER.md'), 'other resource content\n');
      git(other.repo, ['add', 'OTHER_MARKER.md']);
      git(other.repo, ['commit', '-q', '-m', 'other resource marker']);
      git(other.repo, ['push', '-q', 'origin', 'main']);
      await fsp.writeFile(join(correct.repo, 'CORRECT_MARKER.md'), 'correct resource content\n');
      git(correct.repo, ['add', 'CORRECT_MARKER.md']);
      git(correct.repo, ['commit', '-q', '-m', 'correct resource marker']);
      git(correct.repo, ['push', '-q', 'origin', 'main']);
      await fsp.mkdir(workingDir, { recursive: true });

      const wm = new WorktreeManager();
      // Pre-existing: an EARLIER, unrelated ticket already leased a shared
      // pool slot for the OTHER resource on this same agent working_dir —
      // exactly the "agent home already carries a different repo's shared-0"
      // precondition (completion criterion #7).
      const otherResult = await wm.resolveCwd({
        baseWorkingDir: workingDir,
        ticketId: TICKET_OTHER_BOARD,
        role: 'assignee',
        mode: 'shared',
        poolSize: 1,
        bootstrapRepo: { resourceId: 'gameclient-resource', url: other.remote, branch: 'main' },
      });
      assert.ok(otherResult.isWorktree, 'the other resource\'s own worktree provisions normally');
      const otherSlotPath = otherResult.worktreePath;
      const otherHeadBefore = git(otherSlotPath, ['rev-parse', 'HEAD']);

      // The NEW ticket: its own base_repo_resource_id was empty; the caller
      // (resolveBootstrapRepository) resolved it to the board's repo — a
      // DIFFERENT resource — before calling resolveCwd.
      const result = await wm.resolveCwd({
        baseWorkingDir: workingDir,
        ticketId: ticketMode === 'shared' ? TICKET_D : TICKET_E,
        role: 'assignee',
        mode: ticketMode,
        poolSize: 1,
        bootstrapRepo: { resourceId: 'emberdelve-resource', url: correct.remote, branch: 'main' },
      });

      assert.ok(result.isWorktree, `${ticketMode}: provisioning against the correct, isolated resource succeeds`);
      assert.ok(
        result.worktreePath.startsWith(join(workingDir, '.awb', 'wt', 'emberdelve-resource')),
        `${ticketMode}: worktree lands under the board-resolved resource's own slug dir, got ${result.worktreePath}`,
      );
      assert.doesNotMatch(result.worktreePath, /gameclient-resource/, `${ticketMode}: never touches the other resource's tree`);
      assert.notEqual(result.cwd, otherSlotPath, `${ticketMode}: cwd is not the other resource's shared slot`);
      assert.equal(
        (await fsp.readFile(join(result.cwd, 'CORRECT_MARKER.md'), 'utf8')).replace(/\r\n/g, '\n'),
        'correct resource content\n',
      );
      assert.equal(existsSync(join(result.cwd, 'OTHER_MARKER.md')), false, `${ticketMode}: the other resource's file never appears here`);

      // The other resource's pre-existing slot is completely undisturbed —
      // proves this isn't a "reuse whatever's warm" fallback.
      assert.equal(git(otherSlotPath, ['rev-parse', 'HEAD']), otherHeadBefore);
      assert.equal(
        (await fsp.readFile(join(otherSlotPath, 'OTHER_MARKER.md'), 'utf8')).replace(/\r\n/g, '\n'),
        'other resource content\n',
      );
    } finally {
      await other.cleanup();
      await correct.cleanup();
    }
  });
}

test('resolveCwd: a provisioning failure for the resolved (correct) resource hard-fails via classifyWorktreeOutcome — never silently falls back to another resource\'s pre-existing worktree', async () => {
  const other = await makeRepoWithRemote();
  const correct = await makeRepoWithRemote();
  const workingDir = join(other.root, 'conflict-agent-home');
  const ticketId = 'aaaabbbb-1111-2222-3333-444444444444';
  try {
    await fsp.mkdir(workingDir, { recursive: true });
    const wm = new WorktreeManager();

    // Pre-existing OTHER resource shared-0, from earlier unrelated work.
    const otherResult = await wm.resolveCwd({
      baseWorkingDir: workingDir,
      ticketId: TICKET_OTHER_BOARD,
      role: 'assignee',
      mode: 'shared',
      poolSize: 1,
      bootstrapRepo: { resourceId: 'gameclient-resource', url: other.remote, branch: 'main' },
    });
    assert.ok(otherResult.isWorktree);
    const otherSlotPath = otherResult.worktreePath;
    const otherHeadBefore = git(otherSlotPath, ['rev-parse', 'HEAD']);

    // Force `git worktree add` to refuse: pre-create a non-worktree directory
    // at the EXACT path the correct resource's per_ticket checkout would use
    // (mirrors #ensureWorktree's documented "path exists but isn't a
    // registered worktree — refuse to clobber" guard).
    const conflictPath = join(workingDir, '.awb', 'wt', 'emberdelve-resource', worktreeSlug(ticketId, 'per_ticket'));
    await fsp.mkdir(conflictPath, { recursive: true });
    await fsp.writeFile(join(conflictPath, 'stray.txt'), 'not a git worktree\n');

    const result = await wm.resolveCwd({
      baseWorkingDir: workingDir,
      ticketId,
      role: 'assignee',
      mode: 'per_ticket',
      bootstrapRepo: { resourceId: 'emberdelve-resource', url: correct.remote, branch: 'main' },
    });

    assert.equal(result.isWorktree, false, 'provisioning for the correct resource is refused, not silently swapped');
    assert.equal(result.reason, 'path_conflict');
    // classifyWorktreeOutcome (the actual dispatch gate) must hard-block this
    // outcome — proving #applyWorktreeCwd aborts the dispatch instead of
    // spawning into whatever `cwd` this result carries.
    const gate = classifyWorktreeOutcome(result);
    assert.equal(gate.blocked, true);
    assert.equal(gate.kind, 'worktree:path_conflict');

    // Never falls back to the other resource's pre-existing worktree.
    assert.notEqual(result.cwd, otherSlotPath);
    assert.doesNotMatch(result.worktreePath ?? '', /gameclient-resource/);
    // The other resource's slot is untouched by the failed attempt.
    assert.equal(git(otherSlotPath, ['rev-parse', 'HEAD']), otherHeadBefore);
    // The conflicting directory itself is left alone too (never clobbered).
    assert.equal(await fsp.readFile(join(conflictPath, 'stray.txt'), 'utf8'), 'not a git worktree\n');
  } finally {
    await other.cleanup();
    await correct.cleanup();
  }
});
