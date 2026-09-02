// Repo Resource별 clone 정책 회귀 테스트 (ticket bddb63ee).
//
// 이 티켓 이전의 clone 은 20분 고정 wall-clock 이었고, 그 timeout 은 execFile 의
// `timeout` 옵션이라 **직계 자식(git)에게만** 시그널이 갔다. 대형 저장소는 20분을
// 넘겨 실패했고, 실패한 뒤에도 git-remote-https / index-pack 같은 하위 프로세스가
// 살아남았다. 여기서 검증하는 것:
//
//   1. 정책이 없는 기존 저장소도 60분(3600초) 예산으로 clone 된다.
//   2. Repo별 override 가 wall-clock / idle 예산에 그대로 반영된다.
//   3. shallow(--depth) / partial(--filter) / single-branch 플래그가 실제 git argv 에
//      실린다(그리고 실제 clone 결과에 반영된다).
//   4. idle timeout 은 "진행 출력이 계속 나오는" clone 을 절대 죽이지 않고,
//      완전히 멈춘 clone 만 회수한다.
//   5. timeout 시 clone **프로세스 그룹 전체**가 정리돼 잔존 프로세스가 없고,
//      호출자가 실패를 돌려받은 시점에는 이미 정리가 끝나 있다.
//
// 4·5 는 실제 원격 없이 재현해야 하므로 PATH 에 가짜 `git` 실행 파일을 심어
// 진행 출력/정지/자식 프로세스를 직접 연출한다. argv 도 그 가짜 git 이 파일로
// 기록하므로 "플래그가 실제로 프로세스에 전달됐는지" 를 배열 비교가 아니라
// 프로세스 경계에서 확인한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import {
  cloneWithRepoCredential,
  parseClonePolicy,
  resolveCloneOptions,
  DEFAULT_CLONE_TIMEOUT_MS,
  DEFAULT_CLONE_IDLE_TIMEOUT_MS,
} from '../dist/lib/repo-credential.js';

const POSIX = process.platform !== 'win32';

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

/** 커밋 3개짜리 로컬 원격을 만든다 — depth/single-branch 를 실제로 관측하기 위함. */
async function makeSourceRepo() {
  const root = await fsp.mkdtemp(join(tmpdir(), 'awb-clonepol-src-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'test@awb.local']);
  git(root, ['config', 'user.name', 'AWB Test']);
  for (const n of [1, 2, 3]) {
    await fsp.writeFile(join(root, `f${n}.txt`), `commit ${n}\n`);
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', `c${n}`]);
  }
  return root;
}

/**
 * PATH 최상단에 가짜 `git` 을 심는다. MODE 로 동작을 고르고, 넘어온 argv 는
 * AWB_FAKE_GIT_ARGV 파일에 한 줄씩 기록한다.
 */
async function installFakeGit() {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'awb-fakegit-'));
  const argvFile = join(dir, 'argv.txt');
  const childPidFile = join(dir, 'child.pid');
  const script = `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$AWB_FAKE_GIT_ARGV"
case "$AWB_FAKE_GIT_MODE" in
  progress)
    # 진행 출력을 꾸준히 내보낸다 — idle 타이머가 매번 리셋돼야 한다.
    for i in 1 2 3 4 5 6 7 8; do printf 'Receiving objects: %d%%\\r' "$i" >&2; sleep 0.15; done
    exit 0 ;;
  stall)
    # 하위 프로세스를 하나 남기고, 자신은 아무 출력 없이 멈춘다.
    sleep 300 &
    echo $! > "$AWB_FAKE_GIT_CHILD_PID"
    sleep 300
    exit 0 ;;
  stream)
    # 출력은 계속 나오지만 끝나지 않는다 — wall-clock 예산만 회수할 수 있다.
    sleep 300 &
    echo $! > "$AWB_FAKE_GIT_CHILD_PID"
    while true; do printf 'chunk\\n' >&2; sleep 0.05; done ;;
  *)
    exit 0 ;;
esac
`;
  const bin = join(dir, 'git');
  await fsp.writeFile(bin, script, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}:${previousPath}`;
  process.env.AWB_FAKE_GIT_ARGV = argvFile;
  process.env.AWB_FAKE_GIT_CHILD_PID = childPidFile;
  return {
    argvFile,
    childPidFile,
    async readArgv() {
      return (await fsp.readFile(argvFile, 'utf8')).split('\n').filter(Boolean);
    },
    async readChildPid() {
      const raw = await fsp.readFile(childPidFile, 'utf8').catch(() => '');
      const pid = Number(raw.trim());
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    },
    async cleanup() {
      process.env.PATH = previousPath;
      delete process.env.AWB_FAKE_GIT_MODE;
      delete process.env.AWB_FAKE_GIT_ARGV;
      delete process.env.AWB_FAKE_GIT_CHILD_PID;
      await fsp.rm(dir, { recursive: true, force: true });
    },
  };
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDeath(pid, deadlineMs = 8000) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

// ── 1. 시스템 기본값: 정책이 없으면 60분 ─────────────────────────────────────

test('기본값: 정책이 없으면 clone 예산은 60분(3600초), idle 은 10분이다', () => {
  assert.equal(DEFAULT_CLONE_TIMEOUT_MS, 3600_000, '시스템 기본 clone timeout 은 60분이어야 한다');
  assert.equal(DEFAULT_CLONE_IDLE_TIMEOUT_MS, 600_000);
  for (const noPolicy of [undefined, null, {}, parseClonePolicy(undefined)]) {
    const opts = resolveCloneOptions(noPolicy);
    assert.equal(opts.timeoutMs, 3600_000, `정책 ${JSON.stringify(noPolicy)} → 60분이어야 한다`);
    assert.equal(opts.idleTimeoutMs, 600_000);
    assert.deepEqual(opts.strategyArgs, [], '정책이 없으면 clone 전략 플래그는 붙지 않는다');
  }
});

test('하위 호환: 정책이 아닌 wire 값은 전부 null 로 흡수된다', () => {
  for (const raw of [undefined, null, '', 'blob:none', 42, [], { unknown_key: 1 }]) {
    assert.equal(parseClonePolicy(raw), null, `${JSON.stringify(raw)} → null`);
  }
  // 알려진 키가 하나라도 있으면 그 키만 채워진 정책이 된다.
  const parsed = parseClonePolicy({ clone_timeout_seconds: 120, bogus: 'x' });
  assert.equal(parsed.clone_timeout_seconds, 120);
  assert.equal(parsed.clone_depth, undefined);
});

// ── 2. repo별 override ───────────────────────────────────────────────────────

test('repo override: wall-clock / idle 예산이 정책 값으로 바뀐다', () => {
  const opts = resolveCloneOptions({ clone_timeout_seconds: 7200, clone_idle_timeout_seconds: 1800 });
  assert.equal(opts.timeoutMs, 7200_000);
  assert.equal(opts.idleTimeoutMs, 1800_000);
});

test('repo override: idle 0 은 비활성이고, 범위를 벗어난 값은 clamp 된다', () => {
  assert.equal(resolveCloneOptions({ clone_idle_timeout_seconds: 0 }).idleTimeoutMs, 0);
  // 하한(60초) 미만 / 상한(24시간) 초과.
  assert.equal(resolveCloneOptions({ clone_timeout_seconds: 5 }).timeoutMs, 60_000);
  assert.equal(resolveCloneOptions({ clone_timeout_seconds: 999_999 }).timeoutMs, 86_400_000);
});

// ── 3. shallow / partial / single-branch ─────────────────────────────────────

test('clone 전략: depth / filter / single_branch 가 플래그로 번역된다', () => {
  const opts = resolveCloneOptions({ clone_depth: 1, clone_filter: 'blob:none', single_branch: true });
  assert.deepEqual(opts.strategyArgs, ['--depth=1', '--filter=blob:none', '--single-branch']);
});

test('clone 전략: 화이트리스트를 벗어난 filter / 비정수 depth 는 argv 에 실리지 않는다', () => {
  // `-` 로 시작하는 값이 그대로 argv 에 실리면 git 플래그로 해석된다 — 반드시 버려야 한다.
  for (const filter of ['--upload-pack=evil', 'blob none', '', 'x'.repeat(65)]) {
    assert.deepEqual(resolveCloneOptions({ clone_filter: filter }).strategyArgs, [], `filter=${filter}`);
  }
  for (const depth of [0, -1, 1.5, '3']) {
    assert.deepEqual(resolveCloneOptions({ clone_depth: depth }).strategyArgs, [], `depth=${depth}`);
  }
});

test('clone 전략: depth 정책이 실제 clone 결과(히스토리 깊이)에 반영된다', async () => {
  const source = await makeSourceRepo();
  const root = await fsp.mkdtemp(join(tmpdir(), 'awb-clonepol-dst-'));
  try {
    const full = join(root, 'full');
    const shallow = join(root, 'shallow');

    // `file://` 로 준다 — git 은 로컬 **경로** clone 에서 하드링크 최적화를 쓰며
    // `--depth` 를 무시하므로(경고만 출력), 실제 전송 경로를 태워야 shallow 가
    // 관측된다.
    const remote = `file://${source}`;
    const a = await cloneWithRepoCredential({ url: remote, dir: full, branch: 'main' });
    assert.equal(a.ok, true, a.stderr);
    assert.equal(git(full, ['rev-list', '--count', 'HEAD']), '3', '정책이 없으면 전체 히스토리');

    const b = await cloneWithRepoCredential({
      url: remote,
      dir: shallow,
      branch: 'main',
      policy: { clone_depth: 1, single_branch: true },
    });
    assert.equal(b.ok, true, b.stderr);
    assert.equal(git(shallow, ['rev-list', '--count', 'HEAD']), '1', 'depth=1 이면 커밋 1개만');
  } finally {
    await fsp.rm(source, { recursive: true, force: true });
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ── 4·5. idle timeout + timeout cleanup (가짜 git) ───────────────────────────

test('argv: idle 이 켜져 있으면 --progress 가 붙고, 꺼져 있으면 붙지 않는다', { skip: !POSIX }, async () => {
  const fake = await installFakeGit();
  try {
    process.env.AWB_FAKE_GIT_MODE = 'ok';
    const root = await fsp.mkdtemp(join(tmpdir(), 'awb-clonepol-argv-'));

    await cloneWithRepoCredential({ url: 'https://example.invalid/r.git', dir: join(root, 'a') });
    let argv = await fake.readArgv();
    assert.ok(argv.includes('--progress'), `idle 기본값이면 --progress 필요: ${argv.join(' ')}`);
    assert.ok(!argv.some((a) => a.startsWith('--depth')), '정책이 없으면 --depth 없음');
    assert.ok(!argv.includes('--single-branch'), '정책이 없으면 --single-branch 없음');

    await cloneWithRepoCredential({
      url: 'https://example.invalid/r.git',
      dir: join(root, 'b'),
      policy: { clone_idle_timeout_seconds: 0, clone_depth: 5, clone_filter: 'tree:0', single_branch: true },
    });
    argv = await fake.readArgv();
    assert.ok(!argv.includes('--progress'), 'idle 이 꺼져 있으면 --progress 를 붙이지 않는다');
    assert.ok(argv.includes('--depth=5'), argv.join(' '));
    assert.ok(argv.includes('--filter=tree:0'), argv.join(' '));
    assert.ok(argv.includes('--single-branch'), argv.join(' '));

    await fsp.rm(root, { recursive: true, force: true });
  } finally {
    await fake.cleanup();
  }
});

test('idle timeout: 진행 출력이 계속 나오는 clone 은 idle 예산을 넘겨도 죽지 않는다', { skip: !POSIX }, async () => {
  const fake = await installFakeGit();
  try {
    // 총 실행 ~1.2초, idle 예산 0.5초. idle 타이머가 출력마다 리셋되지 않으면
    // 0.5초에 죽는다 — 즉 이 단언은 리셋 로직이 없으면 반드시 실패한다.
    process.env.AWB_FAKE_GIT_MODE = 'progress';
    const root = await fsp.mkdtemp(join(tmpdir(), 'awb-clonepol-idle-'));
    const started = Date.now();
    const res = await cloneWithRepoCredential({
      url: 'https://example.invalid/r.git',
      dir: join(root, 'x'),
      policy: { clone_idle_timeout_seconds: 1 },
      timeoutMs: 30_000,
    });
    const elapsed = Date.now() - started;
    assert.equal(res.ok, true, `진행 중인 clone 이 중단됐다: ${res.stderr}`);
    assert.ok(elapsed > 1000, `실제로 idle 예산(1s)보다 오래 걸려야 의미가 있다 (실측 ${elapsed}ms)`);
    await fsp.rm(root, { recursive: true, force: true });
  } finally {
    await fake.cleanup();
  }
});

test('idle timeout: 출력이 완전히 멈추면 회수하고 프로세스 그룹 전체를 정리한다', { skip: !POSIX }, async () => {
  const fake = await installFakeGit();
  try {
    process.env.AWB_FAKE_GIT_MODE = 'stall';
    const root = await fsp.mkdtemp(join(tmpdir(), 'awb-clonepol-stall-'));
    const res = await cloneWithRepoCredential({
      url: 'https://example.invalid/r.git',
      dir: join(root, 'x'),
      policy: { clone_idle_timeout_seconds: 1 },
      timeoutMs: 60_000,
    });
    assert.equal(res.ok, false, '정지한 clone 은 실패로 회수돼야 한다');
    assert.match(res.stderr, /clone_idle_timeout_seconds/);
    assert.match(res.stderr, /process group terminated/);

    // 잔존 프로세스 0 — 가짜 git 이 남긴 하위 프로세스도 함께 죽어야 한다.
    const childPid = await fake.readChildPid();
    assert.ok(childPid, '테스트 픽스처가 하위 프로세스를 남기지 못했다면 검증이 공허하다');
    assert.equal(isAlive(childPid), false, `clone 하위 프로세스 ${childPid} 가 살아남았다`);
    await fsp.rm(root, { recursive: true, force: true });
  } finally {
    await fake.cleanup();
  }
});

test('wall-clock timeout: 출력이 계속 나와도 전체 예산을 넘기면 그룹째 회수한다', { skip: !POSIX }, async () => {
  const fake = await installFakeGit();
  try {
    // idle 은 끄고(출력이 계속 나오므로 어차피 안 걸린다) wall-clock 만 남긴다.
    process.env.AWB_FAKE_GIT_MODE = 'stream';
    const root = await fsp.mkdtemp(join(tmpdir(), 'awb-clonepol-wall-'));
    const res = await cloneWithRepoCredential({
      url: 'https://example.invalid/r.git',
      dir: join(root, 'x'),
      policy: { clone_idle_timeout_seconds: 0 },
      timeoutMs: 800,
    });
    assert.equal(res.ok, false);
    assert.match(res.stderr, /clone_timeout_seconds/);
    const childPid = await fake.readChildPid();
    assert.ok(childPid, '픽스처가 하위 프로세스를 남겨야 한다');
    assert.equal(await waitForDeath(childPid), true, `clone 하위 프로세스 ${childPid} 가 살아남았다`);
    await fsp.rm(root, { recursive: true, force: true });
  } finally {
    await fake.cleanup();
  }
});
