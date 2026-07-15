// git-mode 업데이트 감지 + rebuild 후 수렴 검증 (ticket 433f6cbd).
//
// 회귀 배경: publish 시점 버전 자동계산으로 전환하면서 소스 package.json.version 이
// seed(1.6.28)로 **동결**됐다. 예전 git-mode #tick 은 origin/<branch> 의 package.json
// version 을 latest 로 읽어 current 와 semver 비교했는데, 둘 다 영원히 seed 로 같으니
// git fallback 채널이 코드 변경을 **영구히 감지 못 하는** 기능 회귀가 생겼다
// (canonical 이 npm-global 이어도 명시적으로 지원하는 fallback 을 조용히 무력화 X).
//
// 근본 수정: git-mode 는 버전이 아니라 **remote commit 차이**로 update 를 판단한다.
// origin/<branch> 가 이 빌드의 checkout 보다 앞서면 update_available=true, self-update
// 가 `checkout --detach origin/<branch>` 로 tip 을 채택(+rebuild)하면 HEAD==origin 이
// 되어 update_available=false 로 **수렴**한다 — 버전 동결과 무관하게.
//
// 실 git 리포지토리로 end-to-end 검증한다 (가짜 payload 아님, board lesson #1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { computeGitUpdateState, UpdateChecker } = await import('../dist/lib/self-update.js');

// 격리된 git 환경 — 사용자 전역 config 간섭 차단.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { env: GIT_ENV, encoding: 'utf8' }).trim();
}

/** seed 버전을 담은 apps/agent-manager/package.json 을 커밋 (readRemoteVersion 경로용). */
function writePkg(root, version, extraFile) {
  const dir = join(root, 'apps', 'agent-manager');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'awb-agent-manager', version }) + '\n');
  if (extraFile) writeFileSync(join(root, extraFile), `${extraFile}\n`);
}

/** remote(bare) + runtime(작업 checkout) 를 만들고, origin/main = runtime HEAD 로 동기화. */
function setupRepo() {
  const base = mkdtempSync(join(tmpdir(), 'awb-gitmode-'));
  const remote = join(base, 'remote.git');
  const runtime = join(base, 'runtime');
  mkdirSync(remote, { recursive: true });
  mkdirSync(runtime, { recursive: true });
  execFileSync('git', ['init', '--bare', '-b', 'main', remote], { env: GIT_ENV });
  execFileSync('git', ['init', '-b', 'main', runtime], { env: GIT_ENV });
  git(runtime, 'remote', 'add', 'origin', remote);
  writePkg(runtime, '1.6.28', 'a.txt');
  git(runtime, 'add', '-A');
  git(runtime, 'commit', '-m', 'A: seed');
  git(runtime, 'push', '-u', 'origin', 'main');
  return { base, remote, runtime };
}

test('computeGitUpdateState: HEAD == origin/main → update_available=false (수렴 상태)', () => {
  const { base, runtime } = setupRepo();
  try {
    const s = computeGitUpdateState(runtime, 'main');
    assert.equal(s.update_available, false);
    assert.equal(s.ahead, 0);
    assert.equal(s.head_sha, s.remote_sha);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('computeGitUpdateState: origin/main 이 앞서면 update_available=true (버전 동결과 무관)', () => {
  const { base, runtime } = setupRepo();
  try {
    // 새 코드가 main 에 랜딩 — package.json.version 은 seed 그대로(동결).
    writePkg(runtime, '1.6.28', 'b.txt');
    git(runtime, 'add', '-A');
    git(runtime, 'commit', '-m', 'B: new code, same seed version');
    git(runtime, 'push', 'origin', 'main'); // origin/main = B

    // "옛 빌드가 A 를 실행 중" 재현 — checkout 을 A 로 되돌린다.
    const head = git(runtime, 'rev-list', '--max-parents=0', 'HEAD'); // 첫 커밋 A
    git(runtime, 'checkout', '--detach', head);

    const s = computeGitUpdateState(runtime, 'main');
    assert.equal(s.update_available, true, 'commit 이 앞서면 버전이 같아도 update 를 감지해야 한다');
    assert.equal(s.ahead, 1);
    assert.notEqual(s.head_sha, s.remote_sha);

    // self-update 의 adopt 재현: origin/main tip 채택 → 수렴.
    git(runtime, 'checkout', '--detach', 'origin/main');
    const after = computeGitUpdateState(runtime, 'main');
    assert.equal(after.update_available, false, 'rebuild(=origin tip 채택) 뒤 update_available 이 false 로 수렴해야 한다');
    assert.equal(after.ahead, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('computeGitUpdateState: HEAD 가 앞서면(로컬 dev commit) update_available=false', () => {
  const { base, runtime } = setupRepo();
  try {
    // origin 에 push 하지 않은 로컬 커밋 — HEAD 가 origin/main 보다 앞섬.
    writePkg(runtime, '1.6.28', 'local.txt');
    git(runtime, 'add', '-A');
    git(runtime, 'commit', '-m', 'C: local-only');
    const s = computeGitUpdateState(runtime, 'main');
    assert.equal(s.update_available, false, 'HEAD 가 앞서면 update 아님 (dev 브랜치)');
    assert.equal(s.ahead, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('computeGitUpdateState: origin/<branch> ref 없으면 error + update_available=false', () => {
  const { base, runtime } = setupRepo();
  try {
    const s = computeGitUpdateState(runtime, 'nonexistent-branch');
    assert.equal(s.update_available, false);
    assert.ok(s.error, 'ref 부재는 error 로 보고 (fail-safe: 업데이트 있다고 오판 X)');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('UpdateChecker #tick (git mode): fetch → commit-diff 감지 → adopt 후 수렴', async () => {
  const { base, remote, runtime } = setupRepo();
  try {
    // origin 에 새 커밋을 올린다 (remote 만; runtime 은 아직 A).
    const clone = join(base, 'pusher');
    execFileSync('git', ['clone', '-b', 'main', remote, clone], { env: GIT_ENV });
    writePkg(clone, '1.6.28', 'c.txt');
    git(clone, 'add', '-A');
    git(clone, 'commit', '-m', 'B: remote-ahead');
    git(clone, 'push', 'origin', 'main');

    // runtime 은 여전히 A 에 체크아웃돼 있음. checker 가 fetch 로 B 를 당겨와 감지.
    const checker = new UpdateChecker({
      repoRoot: runtime,
      branch: 'main',
      installMode: 'git',
      currentVersion: '1.6.28',
      log: () => {},
    });
    const before = await checker.checkNow();
    assert.equal(before.install_mode, 'git');
    assert.equal(before.update_available, true, '#tick 이 commit-diff 로 update 를 감지해야 한다');
    assert.equal(before.last_error, null);
    assert.ok(before.last_checked_at, 'fetch 성공 시 last_checked_at 갱신');

    // self-update adopt 재현 후 재확인 → 수렴.
    git(runtime, 'checkout', '--detach', 'origin/main');
    const after = await checker.checkNow();
    assert.equal(after.update_available, false, 'origin tip 채택 뒤 update_available 이 false 로 수렴');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
