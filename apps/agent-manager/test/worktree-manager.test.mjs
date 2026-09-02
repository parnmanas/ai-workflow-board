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

test('신규 티켓은 stale base clone을 fetch한 최신 origin/base에서 시작한다', async () => {
  const source = await makeRepoWithRemote();
  const workingDir = join(source.root, 'freshness-agent-dir');
  try {
    const wm = new WorktreeManager();
    const first = await wm.resolveCwd({
      baseWorkingDir: workingDir,
      ticketId: TICKET_A,
      role: 'assignee',
      bootstrapRepo: { resourceId: 'repo-freshness', url: source.remote, branch: 'main' },
    });
    assert.equal(first.repositoryContext.baseSha, git(source.remote, ['rev-parse', 'refs/heads/main']));

    git(source.repo, ['push', '-q', 'origin', 'main']);
    const remoteTip = git(source.remote, ['rev-parse', 'refs/heads/main']);
    const second = await wm.resolveCwd({
      baseWorkingDir: workingDir,
      ticketId: TICKET_B,
      role: 'assignee',
      bootstrapRepo: { resourceId: 'repo-freshness', url: source.remote, branch: 'main' },
    });
    assert.equal(git(second.cwd, ['rev-parse', 'HEAD']), remoteTip);
    assert.equal(second.repositoryContext.baseSha, remoteTip);
    assert.equal(second.repositoryContext.workingBranch, `ticket/${TICKET_B}-work`);
    assert.equal(second.repositoryContext.resumed, false);
  } finally {
    await source.cleanup();
  }
});

test('재개 티켓은 dirty 변경과 기존 브랜치를 보존하고 ahead/behind를 보고한다', async () => {
  const source = await makeRepoWithRemote();
  const workingDir = join(source.root, 'resume-agent-dir');
  try {
    const wm = new WorktreeManager();
    const first = await wm.resolveCwd({
      baseWorkingDir: workingDir,
      ticketId: TICKET_A,
      role: 'assignee',
      bootstrapRepo: { resourceId: 'repo-resume', url: source.remote, branch: 'main' },
    });
    await fsp.writeFile(join(first.cwd, 'dirty.txt'), '보존할 변경\n');
    git(source.repo, ['push', '-q', 'origin', 'main']);

    const resumed = await wm.resolveCwd({
      baseWorkingDir: workingDir,
      ticketId: TICKET_A,
      role: 'assignee',
      bootstrapRepo: { resourceId: 'repo-resume', url: source.remote, branch: 'main' },
    });
    assert.equal(resumed.cwd, first.cwd);
    assert.equal(resumed.repositoryContext.workingBranch, `ticket/${TICKET_A}-work`);
    assert.equal(resumed.repositoryContext.dirty, true);
    assert.equal(resumed.repositoryContext.behind, 1);
    assert.equal(resumed.repositoryContext.ahead, 0);
    assert.equal(resumed.repositoryContext.resumed, true);
    assert.equal(await fsp.readFile(join(first.cwd, 'dirty.txt'), 'utf8'), '보존할 변경\n');
  } finally {
    await source.cleanup();
  }
});

// ── detached HEAD 복구 (ticket 15db8628) ────────────────────────────────────
//
// `git worktree add --detach` 로 시작한 체크아웃을 feature branch 에 붙이는
// 마지막 한 걸음이 빠지면 디스패치가 detached HEAD 로 도착한다. 실제로 관측된
// 형태는 두 가지이고 (worktree 재생성 / 기존 worktree 재개) 둘 다 살아남은
// stale branch 때문에 `switch -c` 가 "already exists" 로 실패하던 경우다.
// detached 에서 만든 커밋은 어떤 branch 에도 안 붙어 조용히 유실되므로,
// 복구 순서는 항상 "커밋을 버리지 않는 쪽"이 우선이다.

const COMMIT_ID = ['-c', 'user.email=test@awb.local', '-c', 'user.name=AWB Test'];

// 커밋된 파일은 checkout/rebase 로 다시 펼쳐질 때 Windows 러너의
// core.autocrlf 를 타므로, 내용 단언은 줄바꿈을 정규화해서 비교한다.
async function readNormalized(...segments) {
  return (await fsp.readFile(join(...segments), 'utf8')).replace(/\r\n/g, '\n');
}

function commit(cwd, message) {
  git(cwd, ['add', '.']);
  git(cwd, [...COMMIT_ID, 'commit', '-q', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

async function detachedFixture(label) {
  const source = await makeRepoWithRemote();
  const workingDir = join(source.root, `${label}-agent-dir`);
  const bootstrapRepo = { resourceId: 'repo-detached', url: source.remote, branch: 'main' };
  const wm = new WorktreeManager();
  const resolve = () => wm.resolveCwd({
    baseWorkingDir: workingDir,
    ticketId: TICKET_A,
    role: 'assignee',
    bootstrapRepo,
  });
  const first = await resolve();
  assert.equal(first.isWorktree, true);
  assert.equal(first.repositoryContext.workingBranch, `ticket/${TICKET_A}-work`);
  return {
    source,
    resolve,
    first,
    base: join(workingDir, '.awb', 'base', 'repo-detached'),
    branch: `ticket/${TICKET_A}-work`,
    /** origin/main 을 전진시키고 새 tip 을 돌려준다 — stale branch 재현용. */
    advanceBase: () => {
      git(source.repo, ['push', '-q', 'origin', 'main']);
      return git(source.remote, ['rev-parse', 'refs/heads/main']);
    },
  };
}

test('worktree 만 사라지고 살아남은 stale branch 는 재생성 시 detached 로 남지 않는다', async () => {
  const fx = await detachedFixture('recreate');
  try {
    // 관측된 원인: worktree 디렉터리는 정리됐지만 branch ref 는 공유 .git 에
    // 남아 다음 `worktree add --detach` + `switch -c` 를 "already exists" 로 깬다.
    await fsp.rm(fx.first.cwd, { recursive: true, force: true });
    git(fx.base, ['worktree', 'prune']);
    assert.equal(git(fx.base, ['rev-parse', '--verify', `refs/heads/${fx.branch}`]).length, 40);
    const remoteTip = fx.advanceBase();

    const second = await fx.resolve();
    assert.equal(second.isWorktree, true, 'branch_prepare_failed 로 떨어지지 않아야 한다');
    assert.equal(second.reason, undefined);
    assert.equal(git(second.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']), fx.branch);
    assert.equal(git(second.cwd, ['rev-parse', 'HEAD']), remoteTip, 'stale branch 가 base tip 으로 ff 된다');
    assert.equal(second.repositoryContext.workingBranch, fx.branch);
    assert.equal(second.repositoryContext.behind, 0);
    assert.equal(second.repositoryContext.ahead, 0);
  } finally {
    await fx.source.cleanup();
  }
});

test('재개 시 detached HEAD + stale branch 조합은 ff attach 로 복구된다', async () => {
  const fx = await detachedFixture('resume-detached');
  try {
    const remoteTip = fx.advanceBase();
    // 디스패치가 실제로 마주친 상태: worktree 는 살아 있는데 HEAD 만 detached
    // 이고 feature branch 는 뒤처진 채 체크아웃되어 있지 않다.
    git(fx.first.cwd, ['checkout', '--detach']);
    assert.equal(git(fx.first.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD');
    // 복구가 재개 worktree 의 작업 파일을 건드리지 않는지도 함께 고정한다.
    await fsp.writeFile(join(fx.first.cwd, 'dirty.txt'), '보존할 변경\n');

    const resumed = await fx.resolve();
    assert.equal(resumed.isWorktree, true);
    assert.equal(resumed.cwd, fx.first.cwd);
    assert.equal(resumed.repositoryContext.resumed, true);
    assert.equal(git(resumed.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']), fx.branch);
    assert.equal(git(resumed.cwd, ['rev-parse', 'HEAD']), remoteTip);
    assert.equal(resumed.repositoryContext.workingBranch, fx.branch);
    assert.equal(resumed.repositoryContext.behind, 0);
    assert.equal(await fsp.readFile(join(resumed.cwd, 'dirty.txt'), 'utf8'), '보존할 변경\n');
    assert.equal(resumed.repositoryContext.dirty, true);
  } finally {
    await fx.source.cleanup();
  }
});

test('detached HEAD 에서 만든 커밋은 버려지지 않고 feature branch 가 그 위로 전진한다', async () => {
  const fx = await detachedFixture('orphan-rescue');
  try {
    git(fx.first.cwd, ['checkout', '--detach']);
    await fsp.writeFile(join(fx.first.cwd, 'orphan.txt'), '유실되면 안 되는 작업\n');
    const orphanSha = commit(fx.first.cwd, 'detached 상태에서 만든 커밋');

    const resumed = await fx.resolve();
    assert.equal(resumed.isWorktree, true);
    assert.equal(git(resumed.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']), fx.branch);
    assert.equal(git(resumed.cwd, ['rev-parse', 'HEAD']), orphanSha, 'branch 가 고아 커밋을 흡수한다');
    assert.ok(git(resumed.cwd, ['branch', '--contains', orphanSha]).includes(fx.branch));
    assert.equal(await readNormalized(resumed.cwd, 'orphan.txt'), '유실되면 안 되는 작업\n');
    assert.equal(resumed.repositoryContext.ahead, 1);
  } finally {
    await fx.source.cleanup();
  }
});

test('자기 커밋이 있는 feature branch 는 detached 재개 시 base 위로 rebase 되어 attach 된다', async () => {
  const fx = await detachedFixture('rebase-branch');
  try {
    await fsp.writeFile(join(fx.first.cwd, 'work.txt'), '티켓 작업\n');
    commit(fx.first.cwd, '티켓 작업 커밋');
    const remoteTip = fx.advanceBase();
    git(fx.first.cwd, ['checkout', '--detach']);

    const resumed = await fx.resolve();
    assert.equal(resumed.isWorktree, true);
    assert.equal(git(resumed.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']), fx.branch);
    assert.equal(git(resumed.cwd, ['rev-list', '--count', `${remoteTip}..HEAD`]), '1', 'base tip 위로 rebase 된다');
    assert.equal(await readNormalized(resumed.cwd, 'work.txt'), '티켓 작업\n');
    assert.equal(resumed.repositoryContext.ahead, 1);
    assert.equal(resumed.repositoryContext.behind, 0);
  } finally {
    await fx.source.cleanup();
  }
});

test('detached HEAD 와 feature branch 가 각자 고유 커밋을 가지면 어느 쪽도 버리지 않고 실패로 올린다', async () => {
  const fx = await detachedFixture('diverged');
  try {
    await fsp.writeFile(join(fx.first.cwd, 'branch-work.txt'), 'branch 쪽 작업\n');
    const branchTip = commit(fx.first.cwd, 'branch 커밋');
    git(fx.first.cwd, ['checkout', '--detach', 'HEAD~1']);
    await fsp.writeFile(join(fx.first.cwd, 'detached-work.txt'), 'detached 쪽 작업\n');
    const headTip = commit(fx.first.cwd, 'detached 커밋');

    const resumed = await fx.resolve();
    assert.equal(resumed.isWorktree, false);
    assert.equal(resumed.reason, 'branch_prepare_failed');
    assert.equal(classifyWorktreeOutcome(resumed).blocked, true);
    // 자동 복구를 포기했을 뿐, 양쪽 커밋은 그대로 남아 수동 복구가 가능해야 한다.
    assert.equal(git(fx.first.cwd, ['rev-parse', 'HEAD']), headTip);
    assert.equal(git(fx.base, ['rev-parse', fx.branch]), branchTip);
  } finally {
    await fx.source.cleanup();
  }
});

test('shared slot 재부착도 detached HEAD 를 남기지 않는다', async () => {
  const source = await makeRepoWithRemote();
  const workingDir = join(source.root, 'shared-detached-agent-dir');
  try {
    const wm = new WorktreeManager();
    const args = {
      baseWorkingDir: workingDir,
      ticketId: TICKET_A,
      role: 'assignee',
      mode: 'shared',
      poolSize: 1,
      bootstrapRepo: { resourceId: 'repo-detached', url: source.remote, branch: 'main' },
    };
    const first = await wm.resolveCwd(args);
    assert.equal(first.isWorktree, true);
    git(first.cwd, ['checkout', '--detach']);

    const resumed = await wm.resolveCwd(args);
    assert.equal(resumed.isWorktree, true);
    assert.equal(resumed.cwd, first.cwd);
    assert.equal(git(resumed.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']), `ticket/${TICKET_A}-work`);
    assert.equal(resumed.repositoryContext.workingBranch, `ticket/${TICKET_A}-work`);
  } finally {
    await source.cleanup();
  }
});

test('repo 미연결과 fetch 실패는 서로 다른 provisioning 진단을 반환한다', async () => {
  const source = await makeRepoWithRemote();
  const workingDir = join(source.root, 'failure-agent-dir');
  try {
    const wm = new WorktreeManager();
    const unlinked = await wm.resolveCwd({
      baseWorkingDir: workingDir,
      ticketId: TICKET_A,
      role: 'assignee',
      bootstrapRepo: null,
    });
    assert.equal(unlinked.reason, 'repository_unlinked');

    await wm.resolveCwd({
      baseWorkingDir: workingDir,
      ticketId: TICKET_A,
      role: 'assignee',
      bootstrapRepo: { resourceId: 'repo-failure', url: source.remote, branch: 'main' },
    });
    await fsp.rename(source.remote, `${source.remote}.offline`);
    const failed = await wm.resolveCwd({
      baseWorkingDir: workingDir,
      ticketId: TICKET_B,
      role: 'assignee',
      bootstrapRepo: { resourceId: 'repo-failure', url: source.remote, branch: 'main' },
    });
    assert.equal(failed.reason, 'repository_fetch_failed');
    assert.match(failed.detail, /does not appear to be a git repository|Could not read from remote repository/);
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
    // clone argv에는 credential이 없는 clean URL만 들어가므로 clean URL을 치환한다.
    process.env.GIT_CONFIG_VALUE_0 = remoteUrl;
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
    assert.equal(git(baseClone, ['config', '--get', 'remote.origin.url']), remoteUrl);
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

// ── ticket 112ea3c5: board repo를 상속하는 티켓이 DIFFERENT resource의
// 기존 worktree로 절대 빠지면 안 된다 ────────────────────────────────────
//
// 보고된 사고를 정확히 재현한다: 이미 무관한 resource의 체크아웃을 갖고
// 있는 agent working_dir(이전에, 다른 board/티켓에서의 정상적인 작업으로
// 생긴 것)이, 자신의 base_repo_resource_id는 비어 있고 board environment를
// 통해 DIFFERENT resource로 resolve되는 NEW 티켓으로 새어들어가면 안 된다.
// WorktreeManager.resolveCwd는 모든 worktree 루트를 `resourceSlug`
// (`.awb/wt/<resourceSlug>/…`)로 격리하므로, 이는 동시에
// classifyWorktreeOutcome의 hard-fail 계약(완료 기준 #4)에 대한
// integration 레벨 증명이기도 하다: CORRECT resource의 프로비저닝 실패는
// 이미 존재하는 다른 resource의 체크아웃으로 절대 폴백하면 안 된다.

const TICKET_OTHER_BOARD = 'dddddddd-1111-2222-3333-444444444444';
const TICKET_D = 'eeeeeeee-1111-2222-3333-444444444444';
const TICKET_E = 'ffffffff-1111-2222-3333-444444444444';

for (const ticketMode of ['per_ticket', 'shared']) {
  test(`resolveCwd (${ticketMode}): a pre-existing OTHER resource's shared worktree is never reused for a ticket resolved to a DIFFERENT resource`, async () => {
    const other = await makeRepoWithRemote(); // 예: "GameClient" — 무관한 resource
    const correct = await makeRepoWithRemote(); // 예: "Emberdelve" — board-resolved repo
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
      // 기존 상태: EARLIER의 무관한 티켓이 같은 agent working_dir에서 OTHER
      // resource의 shared pool slot을 이미 leased한 상태 — 정확히 "agent
      // home에 이미 다른 repo의 shared-0이 존재" 전제조건이다(완료 기준 #7).
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

      // NEW 티켓: 자신의 base_repo_resource_id는 비어 있었고, caller
      // (resolveBootstrapRepository)가 resolveCwd 호출 전에 board의 repo —
      // DIFFERENT resource — 로 이미 resolve해둔 상태다.
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

      // other resource의 기존 slot은 완전히 그대로다 — "warm한 걸 아무거나
      // 재사용" 폴백이 아님을 증명한다.
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

    // 이전의 무관한 작업에서 생긴 기존 OTHER resource shared-0.
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

    // `git worktree add`가 거부하도록 강제한다: correct resource의
    // per_ticket 체크아웃이 쓸 EXACT 경로에 worktree가 아닌 디렉터리를
    // 미리 만들어둔다(#ensureWorktree가 문서화한 "path exists but isn't a
    // registered worktree — refuse to clobber" 가드를 그대로 재현).
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
    // classifyWorktreeOutcome(실제 dispatch 게이트)이 이 결과를 반드시
    // hard-block해야 한다 — #applyWorktreeCwd가 이 result가 담은 어떤
    // `cwd`로도 spawn하지 않고 dispatch를 중단함을 증명한다.
    const gate = classifyWorktreeOutcome(result);
    assert.equal(gate.blocked, true);
    assert.equal(gate.kind, 'worktree:path_conflict');

    // other resource의 기존 worktree로 절대 폴백하지 않는다.
    assert.notEqual(result.cwd, otherSlotPath);
    assert.doesNotMatch(result.worktreePath ?? '', /gameclient-resource/);
    // 실패한 시도로 other resource의 slot이 건드려지지 않는다.
    assert.equal(git(otherSlotPath, ['rev-parse', 'HEAD']), otherHeadBefore);
    // 충돌을 일으킨 디렉터리 자체도 그대로 남아있다(절대 덮어쓰지 않음).
    assert.equal(await fsp.readFile(join(conflictPath, 'stray.txt'), 'utf8'), 'not a git worktree\n');
  } finally {
    await other.cleanup();
    await correct.cleanup();
  }
});

async function makeManagedTerminalRepo(ticketId) {
  const fixture = await makeRepoWithRemote();
  const workingDir = join(fixture.root, 'agent-home');
  const base = join(workingDir, '.awb', 'base', 'repo-resource');
  const wtRoot = join(workingDir, '.awb', 'wt', 'repo-resource');
  const wt = join(wtRoot, ticketId.slice(0, 8));
  await fsp.mkdir(join(workingDir, '.awb', 'base'), { recursive: true });
  execFileSync('git', ['clone', '-q', fixture.remote, base]);
  git(base, ['config', 'user.email', 'test@awb.local']);
  git(base, ['config', 'user.name', 'AWB Test']);
  await fsp.mkdir(wtRoot, { recursive: true });
  const branch = `ticket/${ticketId}-cleanup-test`;
  git(base, ['worktree', 'add', '-q', '-b', branch, wt, 'origin/main']);
  git(wt, ['push', '-q', '-u', 'origin', branch]);
  return { ...fixture, workingDir, base, wt, branch };
}

test('cleanupTerminalTicketGit: clean이고 base에 반영된 티켓 worktree와 로컬/origin 브랜치만 멱등 삭제한다', async () => {
  const fixture = await makeManagedTerminalRepo(TICKET_A);
  try {
    git(fixture.base, ['checkout', '-q', 'main']);
    const first = await new WorktreeManager().cleanupTerminalTicketGit({
      baseWorkingDir: fixture.workingDir,
      ticketId: TICKET_A,
      baseBranch: 'main',
      repositoryResourceId: 'repo-resource',
    });
    assert.equal(first.removedWorktrees, 1);
    assert.deepEqual(first.removedLocalBranches, [fixture.branch]);
    assert.deepEqual(first.removedRemoteBranches, [fixture.branch]);
    assert.deepEqual(first.remainingBranches, []);
    assert.deepEqual(first.heldReasons, []);
    assert.equal(existsSync(fixture.wt), false);

    const repeated = await new WorktreeManager().cleanupTerminalTicketGit({
      baseWorkingDir: fixture.workingDir,
      ticketId: TICKET_A,
      baseBranch: 'main',
      repositoryResourceId: 'repo-resource',
    });
    assert.deepEqual(repeated, {
      removedWorktrees: 0,
      removedLocalBranches: [],
      removedRemoteBranches: [],
      remainingBranches: [],
      heldReasons: [],
    });
  } finally {
    await fixture.cleanup();
  }
});

test('cleanupTerminalTicketGit: dirty·미병합·다른 티켓 브랜치를 보존하고 사유를 반환한다', async () => {
  const fixture = await makeManagedTerminalRepo(TICKET_A);
  const other = 'bbbbbbbb-1111-2222-3333-444444444444';
  const otherBranch = `ticket/${other.slice(0, 8)}-keep`;
  try {
    await fsp.writeFile(join(fixture.wt, 'dirty.txt'), '보존');
    git(fixture.base, ['branch', otherBranch, 'origin/main']);
    const dirty = await new WorktreeManager().cleanupTerminalTicketGit({
      baseWorkingDir: fixture.workingDir,
      ticketId: TICKET_A,
      baseBranch: 'main',
      repositoryResourceId: 'repo-resource',
    });
    assert.ok(dirty.heldReasons.some((reason) => reason.startsWith('dirty worktree:')));
    assert.ok(dirty.remainingBranches.includes(fixture.branch));
    assert.equal(git(fixture.base, ['branch', '--list', otherBranch]), otherBranch);

    await fsp.rm(join(fixture.wt, 'dirty.txt'));
    await fsp.writeFile(join(fixture.wt, 'unique.txt'), '고유 커밋');
    git(fixture.wt, ['add', '.']);
    git(fixture.wt, ['commit', '-q', '-m', 'unique']);
    const unmerged = await new WorktreeManager().cleanupTerminalTicketGit({
      baseWorkingDir: fixture.workingDir,
      ticketId: TICKET_A,
      baseBranch: 'main',
      repositoryResourceId: 'repo-resource',
    });
    assert.ok(unmerged.heldReasons.some((reason) => reason.includes('미병합/고유 커밋')));
    assert.ok(existsSync(fixture.wt));
    assert.equal(git(fixture.base, ['branch', '--list', otherBranch]), otherBranch);
  } finally {
    await fixture.cleanup();
  }
});

test('cleanupTerminalTicketGit: worktree 제거 실패 시 로컬과 origin 브랜치를 모두 보존한다', async () => {
  const fixture = await makeManagedTerminalRepo(TICKET_A);
  try {
    const result = await new WorktreeManager({
      terminalCleanupHooks: { removeWorktree: () => false },
    }).cleanupTerminalTicketGit({
      baseWorkingDir: fixture.workingDir,
      ticketId: TICKET_A,
      baseBranch: 'main',
      repositoryResourceId: 'repo-resource',
    });

    assert.ok(result.heldReasons.some((reason) => reason.startsWith('worktree 삭제 실패:')));
    assert.ok(git(fixture.base, ['branch', '--list', fixture.branch]).endsWith(fixture.branch));
    assert.equal(git(fixture.base, ['ls-remote', '--heads', 'origin', fixture.branch]).length > 0, true);
  } finally {
    await fixture.cleanup();
  }
});

test('cleanupTerminalTicketGit: 검증 뒤 원격 tip이 전진하면 lease 불일치로 삭제를 보류한다', async () => {
  const fixture = await makeManagedTerminalRepo(TICKET_A);
  try {
    const racer = join(fixture.root, 'racer');
    execFileSync('git', ['clone', '-q', fixture.remote, racer]);
    git(racer, ['config', 'user.email', 'test@awb.local']);
    git(racer, ['config', 'user.name', 'AWB Test']);
    git(racer, ['switch', '-q', fixture.branch]);
    await fsp.writeFile(join(racer, 'race.txt'), '원격 전진\n');
    git(racer, ['add', '.']);
    git(racer, ['commit', '-q', '-m', '원격 전진']);

    let advanced = false;
    const result = await new WorktreeManager({
      terminalCleanupHooks: {
        beforeRemoteDelete: (branch) => {
          if (advanced || branch !== fixture.branch) return;
          advanced = true;
          git(racer, ['push', '-q', 'origin', fixture.branch]);
        },
      },
    }).cleanupTerminalTicketGit({
      baseWorkingDir: fixture.workingDir,
      ticketId: TICKET_A,
      baseBranch: 'main',
      repositoryResourceId: 'repo-resource',
    });

    assert.deepEqual(result.removedRemoteBranches, []);
    assert.ok(result.heldReasons.includes(`원격 브랜치 삭제 실패: origin/${fixture.branch}`));
    assert.equal(existsSync(fixture.wt), true);
    assert.equal(git(fixture.wt, ['branch', '--show-current']), fixture.branch);
    assert.ok(git(fixture.base, ['branch', '--list', fixture.branch]).endsWith(fixture.branch));
    assert.equal(git(fixture.base, ['ls-remote', '--heads', 'origin', fixture.branch]).length > 0, true);
  } finally {
    await fixture.cleanup();
  }
});

test('cleanupTerminalTicketGit: origin만 미병합인 일반 티켓 branch는 worktree와 ref를 모두 보존한다', async () => {
  const fixture = await makeManagedTerminalRepo(TICKET_A);
  try {
    const racer = join(fixture.root, 'ticket-racer');
    execFileSync('git', ['clone', '-q', fixture.remote, racer]);
    git(racer, ['config', 'user.email', 'test@awb.local']);
    git(racer, ['config', 'user.name', 'AWB Test']);
    git(racer, ['switch', '-q', fixture.branch]);
    await fsp.writeFile(join(racer, 'unique.txt'), '원격 고유 커밋\n');
    git(racer, ['add', '.']);
    git(racer, ['commit', '-q', '-m', '원격 고유 커밋']);
    git(racer, ['push', '-q', 'origin', fixture.branch]);

    const result = await new WorktreeManager().cleanupTerminalTicketGit({
      baseWorkingDir: fixture.workingDir,
      ticketId: TICKET_A,
      baseBranch: 'main',
      repositoryResourceId: 'repo-resource',
    });

    assert.equal(result.removedWorktrees, 0, JSON.stringify(result));
    assert.ok(result.heldReasons.includes(`미병합/고유 커밋: origin/${fixture.branch}`));
    assert.ok(result.remainingBranches.includes(fixture.branch));
    assert.ok(result.remainingBranches.includes(`origin/${fixture.branch}`));
    assert.equal(existsSync(fixture.wt), true);
    assert.equal(git(fixture.wt, ['branch', '--show-current']), fixture.branch);
    assert.ok(git(fixture.base, ['branch', '--list', fixture.branch]).endsWith(fixture.branch));
    assert.equal(git(fixture.base, ['ls-remote', '--heads', 'origin', fixture.branch]).length > 0, true);
  } finally {
    await fixture.cleanup();
  }
});

test('cleanupTerminalTicketGit: 검증된 worktree 소유권 밖의 고아·동일 8자 prefix·불일치 ref를 보존한다', async () => {
  const fixture = await makeManagedTerminalRepo(TICKET_A);
  const collisionTicket = 'aaaaaaaa-9999-8888-7777-666666666666';
  const collisionBranch = `ticket/${collisionTicket}-collision`;
  const orphanBranch = `ticket/${TICKET_A}-orphan`;
  const legacyShortBranch = `ticket/${TICKET_A.slice(0, 8)}-legacy`;
  try {
    for (const branch of [collisionBranch, orphanBranch, legacyShortBranch]) {
      git(fixture.base, ['branch', branch, 'origin/main']);
      git(fixture.base, ['push', '-q', 'origin', branch]);
    }

    const result = await new WorktreeManager().cleanupTerminalTicketGit({
      baseWorkingDir: fixture.workingDir,
      ticketId: TICKET_A,
      baseBranch: 'main',
      repositoryResourceId: 'repo-resource',
    });

    assert.deepEqual(result.removedLocalBranches, [fixture.branch]);
    assert.deepEqual(result.removedRemoteBranches, [fixture.branch]);
    for (const branch of [collisionBranch, orphanBranch, legacyShortBranch]) {
      assert.equal(git(fixture.base, ['branch', '--list', branch]), branch);
      assert.equal(git(fixture.base, ['ls-remote', '--heads', 'origin', branch]).length > 0, true);
    }
    for (const branch of [orphanBranch, legacyShortBranch]) {
      assert.ok(result.remainingBranches.includes(branch));
      assert.ok(result.remainingBranches.includes(`origin/${branch}`));
      assert.ok(result.heldReasons.includes(`소유권 미확인 브랜치 보존: ${branch}`));
    }
    assert.ok(result.heldReasons.some((reason) => reason.startsWith('worktree 소유권 불일치:')) === false);
  } finally {
    await fixture.cleanup();
  }
});

test('cleanupTerminalTicketGit: 티켓 경로의 소유권 불일치 branch를 잔여 목록과 보류 사유로 보고한다', async () => {
  const fixture = await makeManagedTerminalRepo(TICKET_A);
  const otherBranch = `ticket/${TICKET_B}-wrong-owner`;
  try {
    git(fixture.wt, ['switch', '-q', '-c', otherBranch, 'origin/main']);
    const result = await new WorktreeManager().cleanupTerminalTicketGit({
      baseWorkingDir: fixture.workingDir,
      ticketId: TICKET_A,
      baseBranch: 'main',
      repositoryResourceId: 'repo-resource',
    });
    assert.ok(result.heldReasons.some((reason) => reason.includes(`worktree 소유권 불일치:`)));
    assert.ok(result.heldReasons.includes(`소유권 미확인 브랜치 보존: ${otherBranch}`));
    assert.ok(result.remainingBranches.includes(otherBranch));
    assert.equal(git(fixture.wt, ['branch', '--show-current']), otherBranch);
  } finally {
    await fixture.cleanup();
  }
});

async function makeSharedTerminalRepo(ticketId) {
  const fixture = await makeRepoWithRemote();
  const workingDir = join(fixture.root, 'agent-home');
  const wm = new WorktreeManager();
  const resolved = await wm.resolveCwd({
    baseWorkingDir: workingDir,
    ticketId,
    role: 'assignee',
    mode: 'shared',
    poolSize: 1,
    bootstrapRepo: { resourceId: 'repo-resource', url: fixture.remote, branch: 'main' },
  });
  assert.equal(resolved.isWorktree, true);
  const base = join(workingDir, '.awb', 'base', 'repo-resource');
  const branch = `ticket/${ticketId}-shared-cleanup`;
  git(resolved.cwd, ['switch', '-q', '-c', branch]);
  git(resolved.cwd, ['push', '-q', '-u', 'origin', branch]);
  return { ...fixture, workingDir, base, wt: resolved.cwd, branch };
}

test('cleanupTerminalTicketGit: shared slot은 보존하고 clean·merged 티켓 ref만 삭제한 뒤 lease를 해제한다', async () => {
  const fixture = await makeSharedTerminalRepo(TICKET_A);
  try {
    const result = await new WorktreeManager().cleanupTerminalTicketGit({
      baseWorkingDir: fixture.workingDir,
      ticketId: TICKET_A,
      baseBranch: 'main',
      repositoryResourceId: 'repo-resource',
    });
    assert.equal(result.removedWorktrees, 0);
    assert.deepEqual(result.removedLocalBranches, [fixture.branch]);
    assert.deepEqual(result.removedRemoteBranches, [fixture.branch]);
    assert.equal(existsSync(fixture.wt), true, 'shared slot 자체는 warm pool로 보존한다');
    assert.equal(git(fixture.wt, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD');
    const registry = JSON.parse(await fsp.readFile(join(fixture.workingDir, '.awb', 'wt', 'repo-resource', '.pool-leases.json'), 'utf8'));
    assert.equal(registry.slots['shared-0'].active, false);
  } finally {
    await fixture.cleanup();
  }
});

test('shared warm slot 재할당은 remote default가 아닌 티켓 지정 baseRef에서 시작한다', async () => {
  const fixture = await makeRepoWithRemote();
  const workingDir = join(fixture.root, 'agent-home-release-base');
  const wm = new WorktreeManager();
  try {
    const seed = join(fixture.root, 'release-seed');
    execFileSync('git', ['clone', '-q', fixture.remote, seed]);
    git(seed, ['config', 'user.email', 'test@awb.local']);
    git(seed, ['config', 'user.name', 'AWB Test']);
    git(seed, ['switch', '-q', '-c', 'release']);
    await fsp.writeFile(join(seed, 'RELEASE.md'), 'release base\n');
    git(seed, ['add', '.']);
    git(seed, ['commit', '-q', '-m', 'release base']);
    git(seed, ['push', '-q', '-u', 'origin', 'release']);

    const first = await wm.resolveCwd({
      baseWorkingDir: workingDir,
      ticketId: TICKET_A,
      role: 'assignee',
      mode: 'shared',
      poolSize: 1,
      bootstrapRepo: { resourceId: 'repo-release-base', url: fixture.remote, branch: 'main' },
    });
    assert.equal(first.isWorktree, true);
    const firstBranch = git(first.cwd, ['branch', '--show-current']);
    git(first.cwd, ['push', '-q', '-u', 'origin', firstBranch]);
    await wm.cleanupTerminalTicketGit({
      baseWorkingDir: workingDir,
      ticketId: TICKET_A,
      baseBranch: 'main',
      repositoryResourceId: 'repo-release-base',
    });

    const second = await wm.resolveCwd({
      baseWorkingDir: workingDir,
      ticketId: TICKET_B,
      role: 'assignee',
      mode: 'shared',
      poolSize: 1,
      bootstrapRepo: { resourceId: 'repo-release-base', url: fixture.remote, branch: 'release' },
    });
    assert.equal(second.isWorktree, true);
    assert.equal(git(second.cwd, ['rev-parse', 'HEAD']), git(second.cwd, ['rev-parse', 'origin/release']));
    assert.notEqual(git(second.cwd, ['rev-parse', 'HEAD']), git(second.cwd, ['rev-parse', 'origin/main']));
    assert.equal(existsSync(join(second.cwd, 'RELEASE.md')), true);
    assert.equal(second.repositoryContext.baseBranch, 'release');
    assert.equal(second.repositoryContext.baseSha, git(second.cwd, ['rev-parse', 'origin/release']));
  } finally {
    await fixture.cleanup();
  }
});

test('cleanupTerminalTicketGit: dirty shared slot은 ref와 active lease를 함께 보존하고 사유를 보고한다', async () => {
  const fixture = await makeSharedTerminalRepo(TICKET_A);
  try {
    await fsp.writeFile(join(fixture.wt, 'dirty.txt'), '보존\n');
    const result = await new WorktreeManager().cleanupTerminalTicketGit({
      baseWorkingDir: fixture.workingDir,
      ticketId: TICKET_A,
      baseBranch: 'main',
      repositoryResourceId: 'repo-resource',
    });
    assert.ok(result.heldReasons.some((reason) => reason.startsWith('dirty worktree:')));
    assert.ok(result.remainingBranches.includes(fixture.branch));
    assert.equal(git(fixture.wt, ['branch', '--show-current']), fixture.branch);
    const registry = JSON.parse(await fsp.readFile(join(fixture.workingDir, '.awb', 'wt', 'repo-resource', '.pool-leases.json'), 'utf8'));
    assert.equal(registry.slots['shared-0'].active, true);
  } finally {
    await fixture.cleanup();
  }
});

test('cleanupTerminalTicketGit: origin만 미병합인 shared branch는 ref와 active lease를 함께 보존한다', async () => {
  const fixture = await makeSharedTerminalRepo(TICKET_A);
  try {
    const racer = join(fixture.root, 'shared-racer');
    execFileSync('git', ['clone', '-q', fixture.remote, racer]);
    git(racer, ['config', 'user.email', 'test@awb.local']);
    git(racer, ['config', 'user.name', 'AWB Test']);
    git(racer, ['switch', '-q', fixture.branch]);
    await fsp.writeFile(join(racer, 'unique.txt'), '원격 고유 커밋\n');
    git(racer, ['add', '.']);
    git(racer, ['commit', '-q', '-m', '원격 고유 커밋']);
    git(racer, ['push', '-q', 'origin', fixture.branch]);

    const result = await new WorktreeManager().cleanupTerminalTicketGit({
      baseWorkingDir: fixture.workingDir,
      ticketId: TICKET_A,
      baseBranch: 'main',
      repositoryResourceId: 'repo-resource',
    });

    assert.ok(result.heldReasons.includes(`미병합/고유 커밋: origin/${fixture.branch}`));
    assert.ok(result.remainingBranches.includes(fixture.branch));
    assert.ok(result.remainingBranches.includes(`origin/${fixture.branch}`));
    assert.ok(git(fixture.base, ['branch', '--list', fixture.branch]).endsWith(fixture.branch));
    assert.equal(git(fixture.wt, ['branch', '--show-current']), fixture.branch);
    const registry = JSON.parse(await fsp.readFile(join(fixture.workingDir, '.awb', 'wt', 'repo-resource', '.pool-leases.json'), 'utf8'));
    assert.equal(registry.slots['shared-0'].active, true);
  } finally {
    await fixture.cleanup();
  }
});

test('cleanupTerminalTicketGit: shared 원격 삭제 경쟁 시 checkout·로컬 ref·active lease를 함께 보존한다', async () => {
  const fixture = await makeSharedTerminalRepo(TICKET_A);
  try {
    const racer = join(fixture.root, 'shared-delete-racer');
    execFileSync('git', ['clone', '-q', fixture.remote, racer]);
    git(racer, ['config', 'user.email', 'test@awb.local']);
    git(racer, ['config', 'user.name', 'AWB Test']);
    git(racer, ['switch', '-q', fixture.branch]);
    await fsp.writeFile(join(racer, 'race.txt'), '원격 전진\n');
    git(racer, ['add', '.']);
    git(racer, ['commit', '-q', '-m', '원격 전진']);

    let advanced = false;
    const result = await new WorktreeManager({
      terminalCleanupHooks: {
        beforeRemoteDelete: (branch) => {
          if (advanced || branch !== fixture.branch) return;
          advanced = true;
          git(racer, ['push', '-q', 'origin', fixture.branch]);
        },
      },
    }).cleanupTerminalTicketGit({
      baseWorkingDir: fixture.workingDir,
      ticketId: TICKET_A,
      baseBranch: 'main',
      repositoryResourceId: 'repo-resource',
    });

    assert.deepEqual(result.removedRemoteBranches, []);
    assert.ok(result.heldReasons.includes(`원격 브랜치 삭제 실패: origin/${fixture.branch}`));
    assert.equal(git(fixture.base, ['ls-remote', '--heads', 'origin', fixture.branch]).length > 0, true);
    assert.ok(git(fixture.base, ['branch', '--list', fixture.branch]).endsWith(fixture.branch));
    assert.equal(git(fixture.wt, ['branch', '--show-current']), fixture.branch);
    const registry = JSON.parse(await fsp.readFile(join(fixture.workingDir, '.awb', 'wt', 'repo-resource', '.pool-leases.json'), 'utf8'));
    assert.equal(registry.slots['shared-0'].active, true);
  } finally {
    await fixture.cleanup();
  }
});
