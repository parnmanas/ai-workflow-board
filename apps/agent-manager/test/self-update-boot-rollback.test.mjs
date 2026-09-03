// 설치 후 부팅 검증 실패 시 이전 버전으로 복귀·핀 (ticket 23753dc7 — 정책 C·G).
//
// 이 파일이 증명해야 하는 것:
//   - 부팅 실패를 주입하면 실제로 복귀 분기를 타고 이전 버전이 핀된다
//   - 부팅 실패에는 재시도가 없다(= 같은 나쁜 버전을 다시 설치하지 않는다)
//   - 설치 실패 재시도는 상한(추가 2회, 백오프 5분→15분) 안에서만 일어난다
//   - 시도 카운터와 핀 사유가 **프로세스 재시작을 넘어** 보존된다
//   - 핀은 자동으로 풀리지 않고, 사람이 파일을 지우면 다시 시도할 수 있다
//
// 의도적으로 나눈 축: "상한 판정"(순수 함수)과 "재시작 보존"(실제 자식
// 프로세스)은 서로 다른 테스트에 둔다. 하나로 뭉치면 상태가 전혀 보존되지
// 않아도 상한 로직만으로 통과해버려, 실제로는 매번 0부터 세는 무한 재시도를
// 잡지 못한다.
//
// 헬퍼 소스에 대한 `node --check` 구문 검사로 갈음하지 않는다 — 아래 테스트는
// 프로덕션 함수 runBootVerification() 을 직접 호출해 복귀 분기를 태운다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  hasPendingSelfUpdate,
  markBootVerified,
  runBootVerificationTimeout,
  resolveEffectiveUpdateChannel,
  runBootVerification,
  UpdateChecker,
  UPDATE_CHANNEL_OFF,
} from '../dist/lib/self-update.js';
import {
  BOOT_VERIFY_TIMEOUT_MS,
  withBootAttempt,
  INSTALL_RETRY_BACKOFFS_MS,
  MAX_INSTALL_ATTEMPTS,
  bootStatePath,
  evaluateBootProbe,
  evaluateBootVerification,
  evaluateInstallRetryGate,
  newInstallRecord,
  readBootVerificationRecord,
  readUpdatePin,
  updatePinPath,
  withInstallFailure,
  writeBootVerificationRecord,
} from '../dist/lib/self-update-rollback.js';

const HERE = resolve(fileURLToPath(import.meta.url), '..');
const SELF_UPDATE_DIST = pathToFileURL(join(HERE, '..', 'dist', 'lib', 'self-update.js')).href;
const ROLLBACK_DIST = pathToFileURL(join(HERE, '..', 'dist', 'lib', 'self-update-rollback.js')).href;

/** 이 테스트가 돌고 있는 빌드의 실제 버전 — 복귀 시나리오의 "나쁜 버전" 역할. */
const RUNNING_VERSION = JSON.parse(
  readFileSync(join(HERE, '..', 'dist', 'package.json'), 'utf8'),
).version;
const OLDER_VERSION = '0.0.1-previous';

function freshStateDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'awb-boot-rollback-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * 별도의 node 프로세스에서 dist 모듈을 불러 코드를 돌리고 JSON 을 받아온다.
 * `AWB_AGENT_MANAGER_HOME` 만 주입하므로 자식은 **프로덕션 기본 경로**(매니저 홈)를
 * 그대로 쓴다 — 테스트 전용 dir 인자로 우회하지 않는다는 뜻이다.
 */
function runInChildProcess(home, body) {
  const source = `
    const selfUpdate = await import(${JSON.stringify(SELF_UPDATE_DIST)});
    const rollback = await import(${JSON.stringify(ROLLBACK_DIST)});
    const emit = (v) => process.stdout.write('<<RESULT>>' + JSON.stringify(v));
    ${body}
  `;
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
    env: { ...process.env, AWB_AGENT_MANAGER_HOME: home },
  });
  const marker = stdout.lastIndexOf('<<RESULT>>');
  assert.notEqual(marker, -1, `자식 프로세스가 결과를 내지 않았다: ${stdout}`);
  return JSON.parse(stdout.slice(marker + '<<RESULT>>'.length));
}

// ─── 1. 설치 실패 재시도 상한 (순수 판정) ───────────────────────────────────
// 여기서는 파일을 전혀 건드리지 않는다. 상한 규칙만 깨져도 이 블록이 빨개진다.

test('evaluateInstallRetryGate: 첫 시도는 재시도가 아니라 그대로 진행한다', () => {
  const d = evaluateInstallRetryGate({
    installFailures: 0,
    lastFailureAtMs: null,
    nowMs: 1_000,
    withinWindow: true,
  });
  assert.equal(d.proceed, true);
  assert.equal(d.stop, false);
  // 정상 경로에서는 로그를 늘리지 않는다 — 동작이 변하지 않았다는 표시.
  assert.equal(d.summary, null);
});

test('evaluateInstallRetryGate: 실패 1회 — 백오프 5분이 지나야 재시도한다', () => {
  const failedAt = 100_000;
  const backoff = INSTALL_RETRY_BACKOFFS_MS[0];
  assert.equal(backoff, 5 * 60_000, '정책 G 가 지정한 첫 백오프는 5분이다');

  const tooEarly = evaluateInstallRetryGate({
    installFailures: 1,
    lastFailureAtMs: failedAt,
    nowMs: failedAt + backoff - 1,
    withinWindow: true,
  });
  assert.equal(tooEarly.proceed, false);
  assert.equal(tooEarly.stop, false, '백오프 대기는 "중단"이 아니다');
  assert.equal(tooEarly.waitMs, 1);

  const ready = evaluateInstallRetryGate({
    installFailures: 1,
    lastFailureAtMs: failedAt,
    nowMs: failedAt + backoff,
    withinWindow: true,
  });
  assert.equal(ready.proceed, true);
  assert.equal(ready.stop, false);
});

test('evaluateInstallRetryGate: 실패 2회 — 백오프 15분이 지나야 재시도한다', () => {
  const failedAt = 100_000;
  const backoff = INSTALL_RETRY_BACKOFFS_MS[1];
  assert.equal(backoff, 15 * 60_000, '정책 G 가 지정한 두 번째 백오프는 15분이다');

  assert.equal(
    evaluateInstallRetryGate({
      installFailures: 2,
      lastFailureAtMs: failedAt,
      nowMs: failedAt + backoff - 1,
      withinWindow: true,
    }).proceed,
    false,
  );
  assert.equal(
    evaluateInstallRetryGate({
      installFailures: 2,
      lastFailureAtMs: failedAt,
      nowMs: failedAt + backoff,
      withinWindow: true,
    }).proceed,
    true,
  );
});

test('evaluateInstallRetryGate: 누적 3회 실패 — 시간이 얼마가 지나도 멈춘다', () => {
  assert.equal(MAX_INSTALL_ATTEMPTS, 3, '최초 1회 + 추가 2회');
  const d = evaluateInstallRetryGate({
    installFailures: 3,
    lastFailureAtMs: 0,
    // 백오프를 한참 넘긴 시각을 줘도 상한이 이긴다.
    nowMs: 10 * 24 * 60 * 60_000,
    withinWindow: true,
  });
  assert.equal(d.proceed, false);
  assert.equal(d.stop, true, '상한 소진은 "대기"가 아니라 "중단"이다');
  assert.match(d.summary, /retry limit reached/);
});

test('evaluateInstallRetryGate: 재시도 도중 창을 벗어나면 남은 횟수가 있어도 멈춘다', () => {
  const failedAt = 100_000;
  const d = evaluateInstallRetryGate({
    installFailures: 1,
    lastFailureAtMs: failedAt,
    // 백오프는 끝났고 상한도 남았다 — 오직 창 밖이라는 이유로만 멈춰야 한다.
    nowMs: failedAt + INSTALL_RETRY_BACKOFFS_MS[0],
    withinWindow: false,
  });
  assert.equal(d.proceed, false);
  assert.equal(d.stop, true);
  assert.match(d.summary, /outside the maintenance window/);
});

// ─── 2. 부팅 판정 seam — 성공·실패 양 분기 ─────────────────────────────────

test('evaluateBootProbe: 하트비트 1회 성공이면 상한 전이라도 검증 통과다', () => {
  assert.equal(evaluateBootProbe({ heartbeatOk: true, elapsedMs: 0, timeoutMs: 1000 }), 'verified');
  assert.equal(
    evaluateBootProbe({ heartbeatOk: true, elapsedMs: 99_999, timeoutMs: 1000 }),
    'verified',
  );
});

test('evaluateBootProbe: 하트비트가 없으면 상한 전에는 대기, 상한에서 실패다', () => {
  assert.equal(evaluateBootProbe({ heartbeatOk: false, elapsedMs: 999, timeoutMs: 1000 }), 'waiting');
  assert.equal(evaluateBootProbe({ heartbeatOk: false, elapsedMs: 1000, timeoutMs: 1000 }), 'failed');
});

test('evaluateBootVerification: 첫 부팅은 무장, 두 번째 부팅은 복귀다 (재시도 0회)', () => {
  const base = {
    phase: 'awaiting_boot',
    previousVersion: '1.0.0',
    targetVersion: '2.0.0',
    installFailures: 0,
    lastInstallFailureAtMs: null,
    rollbackAttempts: 0,
    reason: '',
    updatedAtMs: 0,
  };

  const first = evaluateBootVerification({
    record: { ...base, bootAttempts: 0 },
    currentVersion: '2.0.0',
  });
  assert.equal(first.kind, 'arm');

  // 첫 부팅이 하트비트에 도달하지 못하고 사라졌다 → 그 자리에서 복귀.
  const second = evaluateBootVerification({
    record: { ...base, bootAttempts: 1 },
    currentVersion: '2.0.0',
  });
  assert.equal(second.kind, 'rollback');
  assert.equal(second.rollbackToVersion, '1.0.0');
});

test('evaluateBootVerification: 이전 빌드가 되살아났으면 설치 실패로 센다', () => {
  const d = evaluateBootVerification({
    record: {
      phase: 'installing',
      previousVersion: '1.0.0',
      targetVersion: '2.0.0',
      bootAttempts: 0,
      installFailures: 0,
      lastInstallFailureAtMs: null,
      rollbackAttempts: 0,
      reason: '',
      updatedAtMs: 0,
    },
    currentVersion: '1.0.0',
  });
  assert.equal(d.kind, 'install_failed');
});

test('evaluateBootVerification: 이미 센 실패는 다음 부팅에서 다시 세지 않는다', () => {
  // phase 가 install_failed 로 넘어간 뒤의 부팅 — 중복 계수는 상한을 앞당겨
  // 멀쩡한 재시도를 잡아먹는다.
  const d = evaluateBootVerification({
    record: {
      phase: 'install_failed',
      previousVersion: '1.0.0',
      targetVersion: '2.0.0',
      bootAttempts: 0,
      installFailures: 1,
      lastInstallFailureAtMs: 1,
      rollbackAttempts: 0,
      reason: 'x',
      updatedAtMs: 0,
    },
    currentVersion: '1.0.0',
  });
  assert.equal(d.kind, 'none');
});

// ─── 3. 복귀 분기를 실제로 태운다 (프로덕션 함수 호출) ──────────────────────

test('runBootVerification: 부팅 실패를 주입하면 이전 버전으로 복귀하고 그 버전이 핀된다', async (t) => {
  const dir = freshStateDir(t);
  // 이 프로세스가 돌고 있는 버전을 "방금 설치한 나쁜 버전"으로 두고, 첫 부팅이
  // 하트비트 없이 끝난 상태(bootAttempts=1)를 만들어 부팅 실패를 주입한다.
  writeBootVerificationRecord(
    {
      phase: 'awaiting_boot',
      previousVersion: OLDER_VERSION,
      targetVersion: RUNNING_VERSION,
      bootAttempts: 1,
      installFailures: 0,
      lastInstallFailureAtMs: null,
      rollbackAttempts: 0,
      reason: '',
      updatedAtMs: Date.now(),
    },
    dir,
  );

  const lines = [];
  const outcome = await runBootVerification({
    stateDir: dir,
    noReExec: true,
    log: (m) => lines.push(m),
  });

  assert.equal(outcome.kind, 'rollback');

  // 완료 기준 1 — 이전 버전이 핀됐다.
  const pin = readUpdatePin(dir);
  assert.ok(pin, '복귀는 반드시 핀을 남긴다');
  assert.equal(pin.version, OLDER_VERSION);
  assert.notEqual(pin.version, RUNNING_VERSION, '나쁜 버전이 핀되면 안 된다');
  // 핀 사유가 사람이 읽을 수 있어야 한다 — 왜 멈췄는지 알아야 풀 수 있다.
  assert.match(pin.reason, /boot verification failed/);
  assert.match(pin.reason, new RegExp(RUNNING_VERSION.replace(/\./g, '\\.')));

  // 완료 기준 8 — 판정·실행이 기존 로그 접두사로 남는다.
  assert.ok(
    lines.some((l) => l.startsWith('Self-update: ') && /boot verification failed/.test(l)),
    `Self-update: 접두사 로그가 없다: ${JSON.stringify(lines)}`,
  );
  assert.ok(lines.some((l) => l.includes('pinned to') && l.includes(OLDER_VERSION)));

  // 부팅 실패에는 재시도가 없다: 복귀 시도는 정확히 1회로 기록된다.
  const after = readBootVerificationRecord(dir);
  assert.equal(after.phase, 'rolling_back');
  assert.equal(after.rollbackAttempts, 1);
});

test('runBootVerification: 복귀가 진행되지 못해도 매니저를 죽이지 않고 핀은 남는다', async (t) => {
  const dir = freshStateDir(t);
  writeBootVerificationRecord(
    {
      phase: 'awaiting_boot',
      previousVersion: OLDER_VERSION,
      targetVersion: RUNNING_VERSION,
      bootAttempts: 1,
      installFailures: 0,
      lastInstallFailureAtMs: null,
      rollbackAttempts: 0,
      reason: '',
      updatedAtMs: Date.now(),
    },
    dir,
  );

  // noReExec 는 "설치·재기동까지 가지 못한 복귀"를 대표한다.
  const outcome = await runBootVerification({ stateDir: dir, noReExec: true, log: () => {} });

  // 완료 기준 7 — 재기동을 예약하지 않았으므로 운영자는 매니저 없는 상태로
  // 남지 않는다(이 프로세스가 계속 살아 있다).
  assert.equal(outcome.willReExec, false);
  // 그럼에도 핀은 남아야 한다 — 그래야 다음 tick 이 불량 버전을 다시 집지 않는다.
  assert.equal(readUpdatePin(dir).version, OLDER_VERSION);
});

test('runBootVerification: 검증 대기 중인 업데이트가 없으면 아무 일도 하지 않는다', async (t) => {
  const dir = freshStateDir(t);
  const outcome = await runBootVerification({ stateDir: dir, noReExec: true, log: () => {} });
  assert.equal(outcome.kind, 'none');
  assert.equal(outcome.armed, false);
  assert.equal(readUpdatePin(dir), null, '평소 부팅은 핀을 만들지 않는다');
  assert.equal(existsSync(bootStatePath(dir)), false);
});

test('markBootVerified: 하트비트 1회 성공이 기록을 지우되 핀은 건드리지 않는다', (t) => {
  const dir = freshStateDir(t);
  writeBootVerificationRecord(
    {
      phase: 'awaiting_boot',
      previousVersion: OLDER_VERSION,
      targetVersion: RUNNING_VERSION,
      bootAttempts: 1,
      installFailures: 0,
      lastInstallFailureAtMs: null,
      rollbackAttempts: 0,
      reason: '',
      updatedAtMs: Date.now(),
    },
    dir,
  );
  writeFileSync(
    updatePinPath(dir),
    JSON.stringify({ version: OLDER_VERSION, reason: '이전 복귀', pinnedAtMs: 1 }),
    'utf8',
  );

  assert.equal(markBootVerified({ stateDir: dir, log: () => {} }), true);
  assert.equal(readBootVerificationRecord(dir), null, '검증에 성공하면 기록은 사라진다');
  // 핀 자동 해제 경로를 만들지 않는다 — 성공한 부팅과 이미 걸린 핀은 별개다.
  assert.equal(readUpdatePin(dir).version, OLDER_VERSION);

  // 여러 번 불려도 안전하다(하트비트는 30초마다 돈다).
  assert.equal(markBootVerified({ stateDir: dir, log: () => {} }), false);
});

// ─── 4. 핀이 다음 tick 을 막는다 (루프 부재) ────────────────────────────────

test('resolveEffectiveUpdateChannel: 핀이 있으면 dist-tag 대신 그 정확한 버전을 쓴다', () => {
  const pin = { version: OLDER_VERSION, reason: 'r', pinnedAtMs: 1 };
  assert.equal(resolveEffectiveUpdateChannel('latest', pin), OLDER_VERSION);
  // 핀이 없으면 원래 채널 그대로 — 정상 경로의 동작은 변하지 않는다.
  assert.equal(resolveEffectiveUpdateChannel('latest', null), 'latest');
  assert.equal(resolveEffectiveUpdateChannel('next', null), 'next');
  // off 는 운영자가 건 하드 핀이라 복귀 핀보다 우선한다.
  assert.equal(resolveEffectiveUpdateChannel(UPDATE_CHANNEL_OFF, pin), UPDATE_CHANNEL_OFF);
});

test('UpdateChecker: 핀이 걸린 홈에서는 채널이 핀 버전으로 시작한다', (t) => {
  const dir = freshStateDir(t);
  writeFileSync(
    updatePinPath(dir),
    JSON.stringify({ version: OLDER_VERSION, reason: 'rollback', pinnedAtMs: 1 }),
    'utf8',
  );
  const checker = new UpdateChecker({
    installMode: 'npm-global',
    updateChannel: 'latest',
    currentVersion: OLDER_VERSION,
    stateDir: dir,
    log: () => {},
  });
  const status = checker.status();
  assert.equal(status.update_channel, OLDER_VERSION);
  assert.notEqual(status.update_channel, 'latest', '핀을 무시하면 다음 tick 이 불량 버전을 다시 집는다');
});

// ─── 5. 프로세스 재시작을 넘어 보존된다 (실제 자식 프로세스) ────────────────
// 위 상한 테스트와 의도적으로 분리했다: 여기 있는 것은 오직 "재-exec 을 넘겨
// 카운터와 사유가 살아남는가"이고, 상한 규칙이 완벽해도 상태가 휘발되면 이
// 블록만 빨개진다.

test('설치 실패 카운터가 프로세스 재시작을 넘어 보존된다', (t) => {
  const home = freshStateDir(t);

  // 프로세스 #1 — 설치를 개시하고 실패를 한 번 센다.
  const first = runInChildProcess(
    home,
    `
    const rec = rollback.newInstallRecord({
      previousVersion: '1.0.0', targetVersion: '2.0.0', nowMs: 1000, carryFrom: null,
    });
    rollback.writeBootVerificationRecord(rollback.withInstallFailure(rec, 1000, 'npm exit 1'));
    emit(rollback.readBootVerificationRecord());
  `,
  );
  assert.equal(first.installFailures, 1);
  assert.equal(first.phase, 'install_failed');

  // 프로세스 #2 — 완전히 새 프로세스(메모리 상태 없음)가 이어서 한 번 더 센다.
  const second = runInChildProcess(
    home,
    `
    const prior = rollback.readBootVerificationRecord();
    if (!prior) throw new Error('재시작 뒤 기록이 사라졌다');
    rollback.writeBootVerificationRecord(rollback.withInstallFailure(prior, 2000, 'npm exit 1'));
    emit(rollback.readBootVerificationRecord());
  `,
  );
  assert.equal(second.installFailures, 2, '새 프로세스가 1부터 이어 세지 않고 0부터 다시 셌다');

  // 프로세스 #3 — 세 번째 실패에서 상한에 닿아 자동 시도가 멈춘다.
  const third = runInChildProcess(
    home,
    `
    const prior = rollback.readBootVerificationRecord();
    rollback.writeBootVerificationRecord(rollback.withInstallFailure(prior, 3000, 'npm exit 1'));
    const rec = rollback.readBootVerificationRecord();
    const gate = rollback.evaluateInstallRetryGate({
      installFailures: rec.installFailures,
      lastFailureAtMs: rec.lastInstallFailureAtMs,
      nowMs: 9_999_999_999,
      withinWindow: true,
    });
    emit({ rec, gate });
  `,
  );
  assert.equal(third.rec.installFailures, 3);
  assert.equal(third.rec.phase, 'install_blocked');
  assert.equal(third.gate.stop, true, '재시작을 세 번 넘긴 뒤에도 상한이 살아 있어야 한다');
  // 핀 사유와 같은 이유로, 멈춘 사유도 재시작을 넘어 읽을 수 있어야 한다.
  assert.match(third.rec.reason, /automatic attempts stopped/);
});

test('복귀 핀과 그 사유가 프로세스 재시작을 넘어 보존되고 다음 tick 을 막는다', (t) => {
  const home = freshStateDir(t);
  const running = RUNNING_VERSION;

  // 프로세스 #1 — 부팅 실패를 주입해 프로덕션 복귀 경로를 태운다.
  const rolled = runInChildProcess(
    home,
    `
    rollback.writeBootVerificationRecord({
      phase: 'awaiting_boot',
      previousVersion: ${JSON.stringify(OLDER_VERSION)},
      targetVersion: ${JSON.stringify(running)},
      bootAttempts: 1,
      installFailures: 0,
      lastInstallFailureAtMs: null,
      rollbackAttempts: 0,
      reason: '',
      updatedAtMs: Date.now(),
    });
    const outcome = await selfUpdate.runBootVerification({ noReExec: true, log: () => {} });
    emit({ outcome, pin: rollback.readUpdatePin() });
  `,
  );
  assert.equal(rolled.outcome.kind, 'rollback');
  assert.equal(rolled.pin.version, OLDER_VERSION);

  // 프로세스 #2 — 새 프로세스가 핀을 읽어 채널을 고정한다. 이것이 "다음 tick 이
  // 같은 나쁜 버전을 다시 집지 않는다"의 실제 집행 지점이다.
  const nextTick = runInChildProcess(
    home,
    `
    const pin = rollback.readUpdatePin();
    const checker = new selfUpdate.UpdateChecker({
      installMode: 'npm-global', updateChannel: 'latest',
      currentVersion: ${JSON.stringify(OLDER_VERSION)}, log: () => {},
    });
    emit({ pin, channel: checker.status().update_channel });
  `,
  );
  assert.equal(nextTick.pin.version, OLDER_VERSION, '핀이 재시작을 넘어 남아야 한다');
  assert.match(nextTick.pin.reason, /boot verification failed/, '핀 사유도 함께 보존된다');
  assert.equal(nextTick.channel, OLDER_VERSION);
  assert.notEqual(nextTick.channel, running, '재시작 뒤 채널이 불량 버전으로 되돌아갔다');

  // 프로세스 #3 — 운영자가 핀 파일을 지우면(유일한 해제 수단) 다시 시도 가능해진다.
  unlinkSync(join(home, 'self-update-pin.json'));
  const released = runInChildProcess(
    home,
    `
    const checker = new selfUpdate.UpdateChecker({
      installMode: 'npm-global', updateChannel: 'latest',
      currentVersion: ${JSON.stringify(OLDER_VERSION)}, log: () => {},
    });
    emit({ pin: rollback.readUpdatePin(), channel: checker.status().update_channel });
  `,
  );
  assert.equal(released.pin, null);
  assert.equal(released.channel, 'latest', '핀을 지운 뒤에는 원래 채널로 돌아와야 한다');
});

test('부팅 검증에 성공한 프로세스의 기록은 재시작 뒤에도 되살아나지 않는다', (t) => {
  const home = freshStateDir(t);

  // 프로세스 #1 — 새 빌드가 부팅해 하트비트 1회를 성공시킨 상황.
  runInChildProcess(
    home,
    `
    rollback.writeBootVerificationRecord({
      phase: 'awaiting_boot',
      previousVersion: ${JSON.stringify(OLDER_VERSION)},
      targetVersion: ${JSON.stringify(RUNNING_VERSION)},
      bootAttempts: 1,
      installFailures: 0,
      lastInstallFailureAtMs: null,
      rollbackAttempts: 0,
      reason: '',
      updatedAtMs: Date.now(),
    });
    emit({ marked: selfUpdate.markBootVerified({ log: () => {} }) });
  `,
  );

  // 프로세스 #2 — 이후의 평범한 재시작이 복귀를 촉발하면 안 된다. 기록을
  // 지우지 않으면 며칠 뒤 무관한 재시작에서 복귀가 튀어나오는 지뢰가 된다.
  const later = runInChildProcess(
    home,
    `
    const outcome = await selfUpdate.runBootVerification({ noReExec: true, log: () => {} });
    emit({ outcome, pin: rollback.readUpdatePin() });
  `,
  );
  assert.equal(later.outcome.kind, 'none');
  assert.equal(later.pin, null, '검증에 성공한 업데이트가 뒤늦게 핀을 만들면 안 된다');
});

// ─── 6. 정상 경로 불변 ──────────────────────────────────────────────────────

test('상태 파일이 손상돼도 부팅을 막지 않는다', async (t) => {
  const dir = freshStateDir(t);
  writeFileSync(bootStatePath(dir), '{ 이건 JSON 이 아니다', 'utf8');
  const outcome = await runBootVerification({ stateDir: dir, noReExec: true, log: () => {} });
  // 되돌리려던 장치가 매니저를 못 뜨게 만드는 것이 최악이다.
  assert.equal(outcome.kind, 'none');
  assert.equal(outcome.willReExec, false);
});

test('newInstallRecord: 같은 대상 버전이면 카운터를 이어받고 다른 버전이면 새로 센다', () => {
  const prior = withInstallFailure(
    newInstallRecord({ previousVersion: '1.0.0', targetVersion: '2.0.0', nowMs: 1 }),
    1,
    'boom',
  );
  assert.equal(prior.installFailures, 1);

  const sameTarget = newInstallRecord({
    previousVersion: '1.0.0',
    targetVersion: '2.0.0',
    nowMs: 2,
    carryFrom: prior,
  });
  assert.equal(sameTarget.installFailures, 1, '같은 버전의 실패 이력은 이어져야 상한이 성립한다');

  const otherTarget = newInstallRecord({
    previousVersion: '1.0.0',
    targetVersion: '3.0.0',
    nowMs: 2,
    carryFrom: prior,
  });
  assert.equal(otherTarget.installFailures, 0, '다른 버전의 실패를 물려받으면 안 된다');
});

test('BOOT_VERIFY_TIMEOUT_MS 는 하트비트 주기보다 충분히 길다', () => {
  // 하트비트는 30초 주기다 — 상한이 그보다 짧으면 멀쩡한 빌드도 되돌린다.
  assert.ok(BOOT_VERIFY_TIMEOUT_MS >= 5 * 60_000, `상한이 너무 짧다: ${BOOT_VERIFY_TIMEOUT_MS}`);
});

// ─── 7. 백오프를 소진할 주체가 실제로 있는가 ────────────────────────────────
// 상한과 백오프가 있어도 그것을 다시 찾아올 주체가 없으면 "재시도한다"는
// 선언에 그친다. UpdateChecker 의 tick 이 이 신호를 읽고 runSelfUpdate 를
// 다시 부른다.

test('hasPendingSelfUpdate: 설치 실패 기록이 남아 있으면 재시도 대상이다', (t) => {
  const dir = freshStateDir(t);
  assert.equal(hasPendingSelfUpdate({ stateDir: dir }), false, '기록이 없으면 재시도할 것도 없다');

  const rec = newInstallRecord({ previousVersion: '1.0.0', targetVersion: '2.0.0', nowMs: 1 });
  writeBootVerificationRecord(withInstallFailure(rec, 1, 'npm exit 1'), dir);
  assert.equal(hasPendingSelfUpdate({ stateDir: dir }), true);
});

test('hasPendingSelfUpdate: 상한을 소진하면 자동 재시도가 멈춘다', (t) => {
  const dir = freshStateDir(t);
  let rec = newInstallRecord({ previousVersion: '1.0.0', targetVersion: '2.0.0', nowMs: 1 });
  for (let i = 1; i <= MAX_INSTALL_ATTEMPTS; i++) rec = withInstallFailure(rec, i, 'npm exit 1');
  writeBootVerificationRecord(rec, dir);

  assert.equal(rec.phase, 'install_blocked');
  // 여기서 true 를 돌려주면 체커가 영원히 다시 시도한다 — 정책 G 위반.
  assert.equal(hasPendingSelfUpdate({ stateDir: dir }), false);
});

test('hasPendingSelfUpdate: 설치 성공을 기다리는 중에는 재시도 대상이 아니다', (t) => {
  const dir = freshStateDir(t);
  const rec = newInstallRecord({ previousVersion: '1.0.0', targetVersion: '2.0.0', nowMs: 1 });
  writeBootVerificationRecord({ ...rec, phase: 'awaiting_boot' }, dir);
  assert.equal(hasPendingSelfUpdate({ stateDir: dir }), false);
});

// ─── 8. 무장된 기록은 반드시 종결된다 (지뢰 방지) ───────────────────────────

test('설치 실패 기록에서 무장해도 하트비트 성공이 기록을 종결시킨다', (t) => {
  const dir = freshStateDir(t);
  // 설치가 실패로 관측된 뒤 뒤늦게 새 빌드가 떠버린 경우(카운터는 이미 1).
  const failed = withInstallFailure(
    newInstallRecord({ previousVersion: OLDER_VERSION, targetVersion: RUNNING_VERSION, nowMs: 1 }),
    1,
    'npm exit 1',
  );
  assert.equal(failed.phase, 'install_failed');

  const armed = withBootAttempt(failed, 2);
  // phase 가 install_failed 로 남으면 markBootVerified 가 자기 소관으로 보지 않아
  // 기록이 영원히 남고, 며칠 뒤 무관한 재시작에서 복귀가 튀어나온다.
  assert.equal(armed.phase, 'awaiting_boot');
  assert.equal(armed.bootAttempts, 1);
  assert.equal(armed.installFailures, 1, '무장이 설치 실패 카운터를 지워서는 안 된다');

  writeBootVerificationRecord(armed, dir);
  assert.equal(markBootVerified({ stateDir: dir, log: () => {} }), true);
  assert.equal(readBootVerificationRecord(dir), null);
});


// ─── 9. 복귀 재기동은 이벤트 루프를 붙잡아야 한다 ───────────────────────────
// 복귀는 부팅 직후에 실행될 수 있고, 그 시점에는 SSE·세션·하트비트 등 루프를
// 붙잡는 핸들이 하나도 없다. 예약을 unref 타이머로 하면 재기동이 발화하기 전에
// 프로세스가 조용히 끝나고, systemd 는 exit 0 을 재시작 대상으로 보지 않는다 —
// 되돌리기는 성공했는데 운영자는 매니저 없는 상태로 남는다(완료 기준 7).

test('복귀 재기동 예약은 빈 이벤트 루프에서도 실제로 발화한다', () => {
  const source = `
    const selfUpdate = await import(${JSON.stringify(SELF_UPDATE_DIST)});
    // 이 시점의 이벤트 루프는 비어 있다 — 프로덕션의 부팅 직후와 같은 조건.
    selfUpdate._scheduleRollbackRestartForTests(() => {
      process.stdout.write('RESTART_FIRED');
      process.exit(0);
    });
  `;
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(
    stdout.trim(),
    'RESTART_FIRED',
    '예약된 재기동이 발화하기 전에 프로세스가 끝났다 — unref 타이머로 예약하면 안 된다',
  );
});


// ─── 10. 하트비트를 아예 못 보내는 호스트는 되돌리지 않는다 ─────────────────
// 페어링 전(agent.json 에 agent_id 없음)이면 InstanceHeartbeat 는 POST 자체를
// 하지 않는다. 그 침묵을 부팅 실패로 읽으면 멀쩡한 빌드가 상한마다 downgrade +
// 핀되고, 핀은 사람만 풀 수 있어 호스트가 그 자리에 묶인다.

test('상한 판정: 하트비트를 보낼 수 없는 호스트는 복귀 대신 기록만 버린다', async (t) => {
  const dir = freshStateDir(t);
  writeBootVerificationRecord(
    {
      phase: 'awaiting_boot',
      previousVersion: OLDER_VERSION,
      targetVersion: RUNNING_VERSION,
      bootAttempts: 1,
      installFailures: 0,
      lastInstallFailureAtMs: null,
      rollbackAttempts: 0,
      reason: '',
      updatedAtMs: Date.now(),
    },
    dir,
  );

  const outcome = await runBootVerificationTimeout({
    stateDir: dir,
    noReExec: true,
    heartbeatEnabled: false,
    log: () => {},
  });

  assert.equal(outcome.kind, 'none');
  assert.equal(readUpdatePin(dir), null, '검증할 수 없는 호스트에 핀을 걸면 안 된다');
  // 기록을 남겨두면 나중에 무관한 재시작이 이를 부팅 실패로 읽는다.
  assert.equal(readBootVerificationRecord(dir), null);
});

test('상한 판정: 하트비트가 가능한 호스트에서는 상한이 복귀를 실행한다', async (t) => {
  const dir = freshStateDir(t);
  writeBootVerificationRecord(
    {
      phase: 'awaiting_boot',
      previousVersion: OLDER_VERSION,
      targetVersion: RUNNING_VERSION,
      bootAttempts: 1,
      installFailures: 0,
      lastInstallFailureAtMs: null,
      rollbackAttempts: 0,
      reason: '',
      updatedAtMs: Date.now(),
    },
    dir,
  );

  const outcome = await runBootVerificationTimeout({
    stateDir: dir,
    noReExec: true,
    heartbeatEnabled: true,
    log: () => {},
  });

  assert.equal(outcome.kind, 'rollback');
  assert.equal(readUpdatePin(dir).version, OLDER_VERSION);
});

test('상한 판정: 하트비트가 이미 성공했으면 상한이 지나도 복귀하지 않는다', async (t) => {
  const dir = freshStateDir(t);
  // markBootVerified 가 기록을 지운 상태 = 검증 통과.
  const outcome = await runBootVerificationTimeout({
    stateDir: dir,
    noReExec: true,
    heartbeatEnabled: true,
    log: () => {},
  });
  assert.equal(outcome.kind, 'none');
  assert.equal(readUpdatePin(dir), null);
});
