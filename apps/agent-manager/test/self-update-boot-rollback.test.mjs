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
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync } from 'node:fs';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  _npmGlobalUpdaterSourceForTests,
  _resetSelfUpdateInFlightForTests,
  hasPendingSelfUpdate,
  markBootVerified,
  probeInstalledEntrypoint,
  resolveVerifiedRollbackSpec,
  runBootVerificationTimeout,
  runSelfUpdate,
  resolveEffectiveUpdateChannel,
  runBootVerification,
  UpdateChecker,
  UPDATE_CHANNEL_OFF,
} from '../dist/lib/self-update.js';
import {
  BOOT_VERIFY_TIMEOUT_MS,
  UPDATE_WINDOW_ENV,
  isWithinMaintenanceWindow,
  parseMaintenanceWindow,
  withBootAttempt,
  withinMaintenanceWindowNow,
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

// ═══ 리뷰 반영 ═══════════════════════════════════════════════════════════════
// 리뷰 지적 1: 조기 부팅 실패(구문 오류·누락 모듈·최상위 import 예외)는 매니저
// 런타임 안의 어떤 검증에도 도달하지 못한다. 그래서 판정을 **재기동을 넘기기
// 전으로** 옮겼다 — 아직 이전 빌드를 메모리에 들고 살아 있는 프로세스가 새
// 진입점을 자식으로 띄워 본다.

/** 임시 진입점 스크립트를 만들어 절대 경로를 돌려준다. */
function writeEntrypoint(t, body) {
  const dir = mkdtempSync(join(tmpdir(), 'awb-entrypoint-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'main.mjs');
  writeFileSync(file, body, 'utf8');
  return file;
}

test('probeInstalledEntrypoint: 정상 진입점은 통과하고 보고 버전을 돌려준다', async (t) => {
  const entry = writeEntrypoint(t, `process.stdout.write('1.2.3\\n');\n`);
  const r = await probeInstalledEntrypoint({ expectVersion: '1.2.3', entrypoint: entry });
  assert.equal(r.ok, true);
  assert.equal(r.reportedVersion, '1.2.3');
});

test('probeInstalledEntrypoint: 최상위 import 예외로 죽는 빌드를 잡는다', async (t) => {
  // 이것이 이 티켓이 막으려는 대표 실패다 — 런타임 안의 검증은 여기 도달 못 한다.
  const entry = writeEntrypoint(t, `throw new Error('boom at module load');\n`);
  const r = await probeInstalledEntrypoint({ expectVersion: '1.2.3', entrypoint: entry });
  assert.equal(r.ok, false);
  assert.equal(r.reportedVersion, null);
  assert.match(r.detail, /boom at module load/);
});

test('probeInstalledEntrypoint: 누락 모듈 import 를 잡는다', async (t) => {
  const entry = writeEntrypoint(t, `import './definitely-not-here.js';\n`);
  const r = await probeInstalledEntrypoint({ expectVersion: '1.2.3', entrypoint: entry });
  assert.equal(r.ok, false);
});

test('probeInstalledEntrypoint: 구문 오류를 잡는다', async (t) => {
  const entry = writeEntrypoint(t, `const = ;\n`);
  const r = await probeInstalledEntrypoint({ expectVersion: '1.2.3', entrypoint: entry });
  assert.equal(r.ok, false);
});

test('probeInstalledEntrypoint: 설치는 됐다는데 버전이 다르면 실패로 본다', async (t) => {
  // npm 이 성공을 보고했는데 정작 파일이 안 바뀐 경우(다른 prefix 등).
  const entry = writeEntrypoint(t, `process.stdout.write('0.0.9\\n');\n`);
  const r = await probeInstalledEntrypoint({ expectVersion: '1.2.3', entrypoint: entry });
  assert.equal(r.ok, false);
  assert.equal(r.reportedVersion, '0.0.9');
  assert.match(r.detail, /reports v0\.0\.9 but v1\.2\.3 was installed/);
});

test('probeInstalledEntrypoint: 진입점 파일이 없으면 실패다', async () => {
  const r = await probeInstalledEntrypoint({
    expectVersion: '1.2.3',
    entrypoint: join(tmpdir(), 'awb-nope', 'main.js'),
  });
  assert.equal(r.ok, false);
  assert.match(r.detail, /entrypoint missing/);
});

// ─── 프로덕션 경로: 프로브 실패 시 재기동하지 않고 그 자리에서 되돌린다 ──────

/** runSelfUpdate 를 실제 네트워크 없이 태우기 위한 포트 묶음. */
function fakePorts(overrides = {}) {
  const calls = { install: [], restart: 0, probe: 0, provenance: [] };
  const ports = {
    install: async (spec) => {
      calls.install.push(spec);
      return overrides.installResult ? overrides.installResult(spec) : { ok: true, detail: '' };
    },
    verifyProvenance: async (channel) => {
      calls.provenance.push(channel);
      return overrides.provenance
        ? overrides.provenance(channel)
        : { ok: true, version: channel === 'latest' ? '99.0.0' : channel, reason: 'fake ok' };
    },
    restart: () => {
      calls.restart += 1;
    },
    probe: async () => {
      calls.probe += 1;
      return overrides.probeResult ?? { ok: true, reportedVersion: '99.0.0', detail: 'fake' };
    },
  };
  return { ports, calls };
}

test('runSelfUpdate: 새 빌드가 뜨지 않으면 재기동 없이 그 자리에서 이전 버전으로 되돌린다', {
  skip: process.platform === 'win32' &&
    'POSIX 인-프로세스 설치 경로 전용 — Windows 는 설치를 분리 헬퍼에 위임하므로 여기서 돌리면 실제 헬퍼가 뜨고 테스트 프로세스가 SIGTERM 된다. 같은 판정의 Windows 쪽은 아래 헬퍼 테스트가 덮는다',
}, async (t) => {
  const dir = freshStateDir(t);
  _resetSelfUpdateInFlightForTests();
  t.after(() => _resetSelfUpdateInFlightForTests());

  const { ports, calls } = fakePorts({
    probeResult: { ok: false, reportedVersion: null, detail: 'boom at module load' },
  });
  const lines = [];
  const r = await runSelfUpdate({ stateDir: dir, ports, log: (m) => lines.push(m) });

  // 설치는 두 번: 새 버전, 그리고 되돌릴 이전 버전.
  assert.equal(calls.install.length, 2, `install 호출: ${JSON.stringify(calls.install)}`);
  assert.equal(calls.install[0], 'awb-agent-manager@99.0.0');
  assert.equal(calls.install[1], `awb-agent-manager@${RUNNING_VERSION}`);
  // 핵심: 불량 빌드로 **재기동하지 않는다**.
  assert.equal(calls.restart, 0, '뜨지 않는 빌드로 재기동하면 안 된다');
  assert.equal(r.willReExec, undefined);
  // 되돌린 버전이 핀된다.
  assert.equal(readUpdatePin(dir).version, RUNNING_VERSION);
  assert.ok(lines.some((l) => /failed to start/.test(l) && l.startsWith('Self-update: ')));
});

test('runSelfUpdate: 새 빌드가 정상이면 되돌리지 않고 재기동한다 (정상 경로 불변)', {
  skip: process.platform === 'win32' &&
    'POSIX 인-프로세스 설치 경로 전용 — Windows 는 설치를 분리 헬퍼에 위임하므로 여기서 돌리면 실제 헬퍼가 뜨고 테스트 프로세스가 SIGTERM 된다. 같은 판정의 Windows 쪽은 아래 헬퍼 테스트가 덮는다',
}, async (t) => {
  const dir = freshStateDir(t);
  _resetSelfUpdateInFlightForTests();
  t.after(() => _resetSelfUpdateInFlightForTests());

  const { ports, calls } = fakePorts();
  const r = await runSelfUpdate({ stateDir: dir, ports, log: () => {} });

  assert.equal(calls.install.length, 1, '정상 경로에서 복귀 설치가 일어나면 안 된다');
  assert.equal(calls.install[0], 'awb-agent-manager@99.0.0');
  assert.equal(calls.probe, 1);
  assert.equal(r.willReExec, true);
  assert.equal(readUpdatePin(dir), null, '정상 설치는 핀을 만들지 않는다');
  // 하트비트 1회 성공을 기다리는 상태로 넘어간다.
  assert.equal(readBootVerificationRecord(dir).phase, 'awaiting_boot');
  // 재기동은 1.5초 뒤 예약이라 여기서 아직 0인 것이 정상 — 예약 자체는 위
  // "빈 이벤트 루프" 테스트가 따로 단언한다.
  assert.equal(calls.restart, 0);
});

// ─── 복귀 경로를 포트로 동적 검증 (리뷰 지적 3) ─────────────────────────────

function armedRollbackRecord(dir) {
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
}

test('runBootVerification: 복귀 설치를 1회 수행하고 이전 버전으로 재기동한다', {
  skip: process.platform === 'win32' &&
    'POSIX 인-프로세스 설치 경로 전용 — Windows 는 설치를 분리 헬퍼에 위임하므로 여기서 돌리면 실제 헬퍼가 뜨고 테스트 프로세스가 SIGTERM 된다. 같은 판정의 Windows 쪽은 아래 헬퍼 테스트가 덮는다',
}, async (t) => {
  const dir = freshStateDir(t);
  _resetSelfUpdateInFlightForTests();
  t.after(() => _resetSelfUpdateInFlightForTests());
  armedRollbackRecord(dir);

  const { ports, calls } = fakePorts({
    provenance: (channel) => ({ ok: true, version: channel, reason: 'fake ok' }),
  });
  const restarted = new Promise((resolve) => {
    ports.restart = () => {
      calls.restart += 1;
      resolve();
    };
  });

  const outcome = await runBootVerification({ stateDir: dir, ports, log: () => {} });
  assert.equal(outcome.kind, 'rollback');
  assert.equal(outcome.willReExec, true);
  // 복귀 설치는 정확히 1회, 이전 버전으로.
  assert.deepEqual(calls.install, [`awb-agent-manager@${OLDER_VERSION}`]);
  // provenance 는 되돌릴 버전에도 적용된다(정책 E).
  assert.deepEqual(calls.provenance, [OLDER_VERSION]);
  await restarted;
  assert.equal(calls.restart, 1, '이전 버전으로 재기동해야 한다');
});

test('runBootVerification: provenance 가 거부하면 설치하지 않지만 핀은 남는다', async (t) => {
  const dir = freshStateDir(t);
  _resetSelfUpdateInFlightForTests();
  t.after(() => _resetSelfUpdateInFlightForTests());
  armedRollbackRecord(dir);

  const { ports, calls } = fakePorts({
    provenance: () => ({ ok: false, version: null, reason: 'no attestations (unsigned publish)' }),
  });
  const outcome = await runBootVerification({ stateDir: dir, ports, log: () => {} });

  assert.equal(calls.install.length, 0, '증명 없는 버전을 설치하면 정책 E 가 깨진다');
  assert.equal(calls.restart, 0);
  assert.equal(outcome.willReExec, false);
  // 설치를 못 해도 핀은 남아야 불량 버전이 다시 잡히지 않는다.
  assert.equal(readUpdatePin(dir).version, OLDER_VERSION);
});

test('runBootVerification: 복귀 설치가 실패해도 재기동하지 않고 프로세스는 살아 있다', {
  skip: process.platform === 'win32' &&
    'POSIX 인-프로세스 설치 경로 전용 — Windows 는 설치를 분리 헬퍼에 위임하므로 여기서 돌리면 실제 헬퍼가 뜨고 테스트 프로세스가 SIGTERM 된다. 같은 판정의 Windows 쪽은 아래 헬퍼 테스트가 덮는다',
}, async (t) => {
  const dir = freshStateDir(t);
  _resetSelfUpdateInFlightForTests();
  t.after(() => _resetSelfUpdateInFlightForTests());
  armedRollbackRecord(dir);

  const { ports, calls } = fakePorts({
    provenance: (channel) => ({ ok: true, version: channel, reason: 'fake ok' }),
    installResult: () => ({ ok: false, detail: 'EACCES: permission denied' }),
  });
  const outcome = await runBootVerification({ stateDir: dir, ports, log: () => {} });

  assert.equal(calls.install.length, 1);
  assert.equal(calls.restart, 0, '되돌리지 못한 채 재기동하면 불량 빌드로 다시 들어간다');
  assert.equal(outcome.willReExec, false);
  assert.equal(readUpdatePin(dir).version, OLDER_VERSION);
  // 이 단언이 실행된다는 사실 자체가 프로세스 생존의 증거다(완료 기준 7).
  assert.equal(typeof process.pid, 'number');
});

// ─── 유지보수 창이 프로덕션 경로에 배선됐는가 (리뷰 지적 2) ─────────────────

test('parseMaintenanceWindow: 형식이 맞을 때만 창을 만든다', () => {
  assert.deepEqual(parseMaintenanceWindow('02:00-04:30'), { startMinute: 120, endMinute: 270 });
  assert.deepEqual(parseMaintenanceWindow('22:00-02:00'), { startMinute: 1320, endMinute: 120 });
  // 미설정·오타·범위 초과·폭 0 은 전부 "창 없음" — 잘못 적은 값 때문에 재시도가
  // 영영 막히는 쪽이 더 나쁘다.
  for (const bad of ['', null, undefined, 'nonsense', '25:00-26:00', '02:70-03:00', '03:00-03:00']) {
    assert.equal(parseMaintenanceWindow(bad), null, `${JSON.stringify(bad)} 는 창이 아니어야 한다`);
  }
});

test('isWithinMaintenanceWindow: 자정을 넘는 창도 다룬다', () => {
  const w = parseMaintenanceWindow('22:00-02:00');
  const at = (h, m) => new Date(2026, 0, 2, h, m, 0, 0);
  assert.equal(isWithinMaintenanceWindow(at(23, 0), w), true);
  assert.equal(isWithinMaintenanceWindow(at(1, 0), w), true);
  assert.equal(isWithinMaintenanceWindow(at(12, 0), w), false);
  // 창이 없으면 항상 안 — 이 기능 도입 전 동작과 같아야 한다.
  assert.equal(isWithinMaintenanceWindow(at(12, 0), null), true);
});

test('withinMaintenanceWindowNow: 환경변수 미설정이면 항상 창 안이다', () => {
  assert.equal(withinMaintenanceWindowNow(new Date(), undefined), true);
  assert.equal(withinMaintenanceWindowNow(new Date(), ''), true);
});

test('runSelfUpdate: 창 밖에서는 설치 실패 재시도가 프로덕션 경로에서 멈춘다', async (t) => {
  const dir = freshStateDir(t);
  _resetSelfUpdateInFlightForTests();
  t.after(() => _resetSelfUpdateInFlightForTests());

  // 이미 한 번 실패한 기록 — 다음 호출은 "재시도"다.
  const failed = withInstallFailure(
    newInstallRecord({ previousVersion: RUNNING_VERSION, targetVersion: '99.0.0', nowMs: 1 }),
    1,
    'npm exit 1',
  );
  writeBootVerificationRecord(failed, dir);

  // 지금 시각을 확실히 벗어나는 창을 만든다(현재 +2시간 ~ +3시간).
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const shift = (h) => pad((now.getHours() + h) % 24);
  const prev = process.env[UPDATE_WINDOW_ENV];
  process.env[UPDATE_WINDOW_ENV] = `${shift(2)}:${pad(now.getMinutes())}-${shift(3)}:${pad(now.getMinutes())}`;
  t.after(() => {
    if (prev === undefined) delete process.env[UPDATE_WINDOW_ENV];
    else process.env[UPDATE_WINDOW_ENV] = prev;
  });

  const { ports, calls } = fakePorts();
  const r = await runSelfUpdate({ stateDir: dir, ports, log: () => {} });

  assert.equal(calls.install.length, 0, '창 밖에서는 설치를 시도하면 안 된다');
  assert.equal(calls.restart, 0);
  assert.match(r.summary, /outside the maintenance window/);
});

test('runSelfUpdate: 창 안에서는 백오프가 지난 재시도가 진행된다 (창 배선의 양성 대조)', {
  skip: process.platform === 'win32' &&
    'POSIX 인-프로세스 설치 경로 전용 — Windows 는 설치를 분리 헬퍼에 위임하므로 여기서 돌리면 실제 헬퍼가 뜨고 테스트 프로세스가 SIGTERM 된다. 같은 판정의 Windows 쪽은 아래 헬퍼 테스트가 덮는다',
}, async (t) => {
  const dir = freshStateDir(t);
  _resetSelfUpdateInFlightForTests();
  t.after(() => _resetSelfUpdateInFlightForTests());

  const failed = withInstallFailure(
    newInstallRecord({ previousVersion: RUNNING_VERSION, targetVersion: '99.0.0', nowMs: 1 }),
    1,
    'npm exit 1',
  );
  writeBootVerificationRecord(failed, dir);

  const prev = process.env[UPDATE_WINDOW_ENV];
  process.env[UPDATE_WINDOW_ENV] = '00:00-23:59';
  t.after(() => {
    if (prev === undefined) delete process.env[UPDATE_WINDOW_ENV];
    else process.env[UPDATE_WINDOW_ENV] = prev;
  });

  const { ports, calls } = fakePorts();
  const r = await runSelfUpdate({ stateDir: dir, ports, log: () => {} });

  assert.equal(calls.install.length, 1, '창 안이고 백오프도 지났으면 재시도해야 한다');
  assert.equal(r.changed, true);
});

// ─── 11. Windows 헬퍼의 복귀 분기를 실제로 태운다 ───────────────────────────
// Windows 경로에서는 부모가 설치 전에 종료하므로, 새 진입점이 뜨는지 보고 못
// 뜨면 되돌리는 일을 (교체 대상 패키지 밖에 있는) 헬퍼가 맡는다. 헬퍼는 템플릿
// 리터럴에 담긴 생성 소스라 `node --check` 로만 검증돼 왔는데, 그 구문 검사는
// 아래 분기를 한 줄도 실행하지 않는다. 그래서 가짜 npm 을 PATH 에 얹고 헬퍼를
// 실제로 돌린다.

/**
 * 가짜 npm + 가짜 전역 루트를 만들고 헬퍼를 실제로 실행한다.
 *
 * 진입점은 셸이 아니라 여기서 JS 로 직접 만든다 — 셸 printf 로 JS 를 찍으면
 * 이스케이프가 어긋나 픽스처 자체가 구문 오류가 되고, 그러면 "프로브가 잡았다"가
 * 아니라 "픽스처가 깨졌다"를 보게 된다(실제로 한 번 겪었다).
 * 재기동된 진입점은 `--force` 를 보고 로그를 남기므로, 되돌린 매니저가 실제로
 * 다시 떴는지를 간접 신호가 아니라 그 로그로 단언할 수 있다.
 */
function runHelper(t, { installSpec, expectVersion, previousSpec, badVersion }) {
  const base = mkdtempSync(join(tmpdir(), 'awb-helper-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const binDir = join(base, 'bin');
  const globalRoot = join(base, 'root');
  const distDir = join(globalRoot, 'awb-agent-manager', 'dist');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(distDir, { recursive: true });
  const installLog = join(base, 'installs.txt');
  const relaunchLog = join(base, 'relaunch.txt');
  const pinPath = join(base, 'self-update-pin.json');
  const entrypoint = join(distDir, 'main.js');
  const versionFile = join(distDir, 'VERSION');

  // 정상 진입점: --version 이면 버전을 찍고, --force(재기동)면 로그를 남긴다.
  const goodTemplate = join(base, 'tpl-good.js');
  writeFileSync(
    goodTemplate,
    [
      "const { readFileSync, appendFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      "const version = readFileSync(join(__dirname, 'VERSION'), 'utf8').trim();",
      "if (process.argv.includes('--force')) {",
      "  appendFileSync(process.env.AWB_TEST_RELAUNCH_LOG, version + '\\n');",
      '  process.exit(0);',
      '}',
      'console.log(version);',
      '',
    ].join('\n'),
    'utf8',
  );
  // 뜨지 않는 진입점: 모듈 로드 시점에 죽는다 — 이 티켓이 막으려는 실패 클래스.
  const badTemplate = join(base, 'tpl-bad.js');
  writeFileSync(badTemplate, "throw new Error('installed build cannot start');\n", 'utf8');

  // 가짜 npm 은 Node 스크립트 하나로 두고 얇은 shim 만 플랫폼별로 만든다.
  // CI 의 agent-manager 잡은 ubuntu + windows-latest 양축에서 이 파일을 돌린다 —
  // `#!/bin/sh` 스크립트는 Windows 에서 실행되지 않고, 헬퍼는 그쪽에서
  // `shell:true` 로 `npm.cmd` 를 찾는다. 로직을 한 곳(Node)에 두면 양축이 같은
  // 코드를 태우고, 다른 것은 두 줄짜리 shim 뿐이다.
  const fakeNpmJs = join(base, 'fake-npm.js');
  writeFileSync(
    fakeNpmJs,
    [
      "const { appendFileSync, writeFileSync, copyFileSync } = require('node:fs');",
      `const GLOBAL_ROOT = ${JSON.stringify(globalRoot)};`,
      `const INSTALL_LOG = ${JSON.stringify(installLog)};`,
      `const VERSION_FILE = ${JSON.stringify(versionFile)};`,
      `const ENTRYPOINT = ${JSON.stringify(entrypoint)};`,
      `const GOOD_TPL = ${JSON.stringify(goodTemplate)};`,
      `const BAD_TPL = ${JSON.stringify(badTemplate)};`,
      `const BAD_VERSION = ${JSON.stringify(String(badVersion))};`,
      "const PREFIX = 'awb-agent-manager@';",
      'const args = process.argv.slice(2);',
      "if (args[0] === 'root') { process.stdout.write(GLOBAL_ROOT + '\\n'); process.exit(0); }",
      "if (args[0] === 'install') {",
      '  const spec = args.find((a) => a.startsWith(PREFIX)) || PREFIX;',
      '  const ver = spec.slice(PREFIX.length);',
      "  appendFileSync(INSTALL_LOG, ver + '\\n');",
      "  writeFileSync(VERSION_FILE, ver + '\\n');",
      '  copyFileSync(ver === BAD_VERSION ? BAD_TPL : GOOD_TPL, ENTRYPOINT);',
      '  process.exit(0);',
      '}',
      'process.exit(1);',
      '',
    ].join('\n'),
    'utf8',
  );
  const shim = `"${process.execPath}" "${fakeNpmJs}"`;
  const npmPath = join(binDir, 'npm');
  writeFileSync(npmPath, `#!/bin/sh\n${shim} "$@"\n`, 'utf8');
  chmodSync(npmPath, 0o755);
  // Windows 에서 헬퍼는 shell:true 로 돌아 PATHEXT 를 통해 npm.cmd 를 찾는다.
  writeFileSync(join(binDir, 'npm.cmd'), `@echo off\r\n${shim} %*\r\n`, 'utf8');

  const helperPath = join(base, 'updater.mjs');
  writeFileSync(helperPath, _npmGlobalUpdaterSourceForTests(), 'utf8');

  // managerPid=0 → managerAlive() 이 즉시 false 라 대기 없이 진행한다.
  const r = spawnSync(
    process.execPath,
    [
      helperPath,
      '0',
      installSpec,
      expectVersion,
      previousSpec,
      pinPath,
      process.execPath,
      entrypoint,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: [binDir, process.env.PATH].join(delimiter),
        AWB_TEST_RELAUNCH_LOG: relaunchLog,
      },
      timeout: 60_000,
    },
  );

  // 재기동은 detached spawn 이라 await 할 promise 가 없다. 상한은 정상 동기화
  // 수단이 아니라 hang 진단용이며, 나타나는 즉시 빠져나온다.
  const readRelaunch = () =>
    existsSync(relaunchLog) ? readFileSync(relaunchLog, 'utf8').split('\n').filter(Boolean) : [];
  const sleepSlot = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 15_000;
  let relaunched = readRelaunch();
  while (relaunched.length === 0 && Date.now() < deadline) {
    Atomics.wait(sleepSlot, 0, 0, 25);
    relaunched = readRelaunch();
  }

  const installs = existsSync(installLog)
    ? readFileSync(installLog, 'utf8').split('\n').filter(Boolean)
    : [];
  const pin = existsSync(pinPath) ? JSON.parse(readFileSync(pinPath, 'utf8')) : null;
  const finalVersion = existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : '';
  return { status: r.status, installs, pin, finalVersion, relaunched, helperPath };
}

test('헬퍼: 새 빌드가 뜨지 않으면 이전 버전을 다시 설치하고 핀을 남긴다', (t) => {
  const r = runHelper(t, {
    installSpec: 'awb-agent-manager@2.0.0',
    expectVersion: '2.0.0',
    previousSpec: 'awb-agent-manager@1.0.0',
    badVersion: '2.0.0',
  });

  // 설치는 두 번: 새 버전, 그리고 프로브 실패 후 이전 버전.
  assert.deepEqual(r.installs, ['2.0.0', '1.0.0'], `설치 로그: ${JSON.stringify(r.installs)}`);
  // 디스크에 최종적으로 남은 것은 되돌린 빌드다.
  assert.equal(r.finalVersion, '1.0.0');
  // 그리고 그 되돌린 매니저가 **실제로 다시 떴다** — 재기동된 프로세스가 남긴
  // 로그로 직접 확인한다(헬퍼 자기삭제 같은 간접 신호가 아니다).
  assert.deepEqual(r.relaunched, ['1.0.0'], '이전 버전 매니저가 재기동돼야 한다');
  // 핀이 남아 다음 tick 이 같은 불량 버전을 다시 집지 않는다.
  assert.ok(r.pin, '복귀했으면 핀이 있어야 한다');
  assert.equal(r.pin.version, '1.0.0');
  assert.match(r.pin.reason, /2\.0\.0/, '핀 사유에 어떤 빌드가 문제였는지 남아야 한다');
  // 복귀했다는 사실이 종료 코드로도 드러난다.
  assert.equal(r.status, 1);
});

test('헬퍼: 새 빌드가 정상이면 되돌리지 않고 핀도 만들지 않는다', (t) => {
  const r = runHelper(t, {
    installSpec: 'awb-agent-manager@2.0.0',
    expectVersion: '2.0.0',
    previousSpec: 'awb-agent-manager@1.0.0',
    badVersion: 'never-matches',
  });

  assert.deepEqual(r.installs, ['2.0.0'], '정상 경로에서 복귀 설치가 일어나면 안 된다');
  assert.equal(r.finalVersion, '2.0.0');
  assert.deepEqual(r.relaunched, ['2.0.0'], '정상 경로는 새 버전으로 재기동한다');
  assert.equal(r.pin, null, '정상 설치는 핀을 만들지 않는다');
  assert.equal(r.status, 0);
});

test('헬퍼: 되돌릴 대상이 없으면(복귀 중·provenance 우회) 프로브를 건너뛴다', (t) => {
  // 이미 복귀 중인 호출은 previousSpec 을 빈 문자열로 넘긴다 — 여기서 또
  // 되돌리려 하면 무한 복귀가 된다. provenance 를 명시적으로 우회한 경로도
  // 대상 버전을 특정할 수 없어 같은 모양이 된다.
  //
  // 주의: "복귀 대상 검증 실패" 는 더 이상 이 상태로 오지 않는다 — 그 경우
  // 부모가 업데이트 자체를 거부하므로 헬퍼가 뜨지 않는다(아래 fail-closed 테스트).
  const r = runHelper(t, {
    installSpec: 'awb-agent-manager@1.0.0',
    expectVersion: '',
    previousSpec: '',
    badVersion: 'never-matches',
  });

  assert.deepEqual(r.installs, ['1.0.0'], '복귀 중에는 추가 복귀 설치가 없어야 한다');
  assert.deepEqual(r.relaunched, ['1.0.0'], '되돌린 매니저는 그대로 재기동된다');
  assert.equal(r.pin, null);
});

test('헬퍼: 복귀 뒤에도 재기동·정리 단계까지 반드시 도달한다', (t) => {
  // 헬퍼는 설치 결과와 무관하게 항상 재기동을 시도한다 — 이 무조건 경로가
  // 완료 기준 7 을 떠받친다. 다만 아래 단언이 증명하는 것은 "매니저가 살아
  // 있다"가 아니라 "헬퍼가 4~5단계(재기동 시도 + 자기 정리)까지 도달했다"
  // 이다. 실제로 되살아났는지는 위 복귀 테스트의 relaunched 로그가 단언한다.
  const r = runHelper(t, {
    installSpec: 'awb-agent-manager@2.0.0',
    expectVersion: '2.0.0',
    previousSpec: 'awb-agent-manager@1.0.0',
    badVersion: '2.0.0',
  });
  // 헬퍼가 끝까지 돌아 자기 자신을 지웠다는 것은 4~5단계(재기동 + 정리)까지
  // 도달했다는 뜻이다. 중간에 던졌다면 파일이 남는다.
  assert.equal(existsSync(r.helperPath), false, '헬퍼가 재기동·정리 단계까지 도달해야 한다');
});


test('runSelfUpdate: provenance 가 거부하면 새 버전을 설치조차 하지 않는다', async (t) => {
  // 위 소스 가드(self-update-provenance-gate.test.mjs)가 배선을 보는 것과 달리,
  // 이쪽은 거부 판정을 실제로 주입해 **설치가 일어나지 않는지**를 본다.
  const dir = freshStateDir(t);
  _resetSelfUpdateInFlightForTests();
  t.after(() => _resetSelfUpdateInFlightForTests());

  const { ports, calls } = fakePorts({
    provenance: () => ({ ok: false, version: null, reason: 'no npm attestations (unsigned publish)' }),
  });
  const r = await runSelfUpdate({ stateDir: dir, ports, log: () => {} });

  assert.equal(calls.install.length, 0, '증명 없는 tarball 을 설치하면 정책 E 가 깨진다');
  assert.equal(calls.probe, 0);
  assert.equal(calls.restart, 0);
  assert.equal(r.changed, false);
  assert.match(r.summary, /refused/);
  // 거부는 상태 기록도 남기지 않는다 — 설치를 시도조차 안 했기 때문이다.
  assert.equal(readBootVerificationRecord(dir), null);
});


// ─── 12. Windows 복귀도 provenance 게이트를 통과해야 한다 (리뷰 라운드 2) ────
// 헬퍼는 부모가 죽은 뒤에 돌아 레지스트리 판정을 스스로 할 수 없다. 그래서
// 부모가 **헬퍼를 띄우기 전에** 이전 버전의 provenance 를 검증하고, 통과한
// 정확한 버전만 넘긴다. 검증에 실패하면 빈 spec 이 넘어가 복귀 자체가 없다 —
// 증명 없는 이전 버전을 설치하는 것은 정책 E 위반이기 때문이다.

test('resolveVerifiedRollbackSpec: 검증에 통과하면 검증된 정확 버전을 넘긴다', async () => {
  const seen = [];
  const spec = await resolveVerifiedRollbackSpec({
    previousVersion: '1.0.0',
    verifyProvenance: async (channel) => {
      seen.push(channel);
      return { ok: true, version: '1.0.0', reason: 'signed' };
    },
    out: () => {},
  });
  assert.equal(spec, 'awb-agent-manager@1.0.0');
  assert.deepEqual(seen, ['1.0.0'], '되돌릴 버전 자체를 조회해야 한다(활성 채널이 아니라)');
});

test('resolveVerifiedRollbackSpec: 거부되면 빈 spec 을 넘겨 복귀를 포기한다', async () => {
  const lines = [];
  const spec = await resolveVerifiedRollbackSpec({
    previousVersion: '1.0.0',
    verifyProvenance: async () => ({
      ok: false,
      version: null,
      reason: 'no npm attestations (unsigned publish)',
    }),
    out: (m) => lines.push(m),
    bypassed: false,
  });
  assert.equal(spec, '', '증명 없는 이전 버전을 넘기면 헬퍼가 그대로 설치해버린다');
  assert.ok(
    lines.some((l) => l.startsWith('Self-update: ') && /rollback to v1\.0\.0 is NOT available/.test(l)),
    `사유가 Self-update: 접두사로 남아야 한다: ${JSON.stringify(lines)}`,
  );
});

test('resolveVerifiedRollbackSpec: 명시적 opt-in 이 있을 때만 미검증 복귀를 허용한다', async () => {
  const spec = await resolveVerifiedRollbackSpec({
    previousVersion: '1.0.0',
    verifyProvenance: async () => ({ ok: false, version: null, reason: 'unsigned' }),
    out: () => {},
    bypassed: true,
  });
  assert.equal(spec, 'awb-agent-manager@1.0.0');
});

test('헬퍼: provenance 를 통과한 이전 버전은 정상적으로 복귀된다 (위 테스트의 양성 대조)', async (t) => {
  const rollbackSpec = await resolveVerifiedRollbackSpec({
    previousVersion: '1.0.0',
    verifyProvenance: async () => ({ ok: true, version: '1.0.0', reason: 'signed' }),
    out: () => {},
  });
  assert.equal(rollbackSpec, 'awb-agent-manager@1.0.0');

  const r = runHelper(t, {
    installSpec: 'awb-agent-manager@2.0.0',
    expectVersion: '2.0.0',
    previousSpec: rollbackSpec,
    badVersion: '2.0.0',
  });
  assert.deepEqual(r.installs, ['2.0.0', '1.0.0']);
  assert.equal(r.pin.version, '1.0.0');
  assert.deepEqual(r.relaunched, ['1.0.0']);
});


// ─── 13. 되돌릴 수 없는 업데이트는 시작하지 않는다 (리뷰 라운드 3) ──────────
// 앞 라운드에서는 복귀 대상 검증에 실패하면 "복귀만 끄고 설치는 진행"했는데,
// 그러면 헬퍼의 부팅 프로브까지 함께 꺼져 불량 빌드를 검증 없이 재기동한다.
// 안전망을 끄느니 업데이트를 시작하지 않는 쪽이 맞다.

/** 새 대상은 통과시키고 이전 버전만 거부하는 provenance 포트. */
function portsRefusingRollbackTarget() {
  return fakePorts({
    provenance: (channel) =>
      channel === 'latest'
        ? { ok: true, version: '99.0.0', reason: 'signed' }
        : { ok: false, version: null, reason: 'no npm attestations (unsigned publish)' },
  });
}

test('runSelfUpdate: 검증된 복귀 대상이 없으면 설치를 시작하지 않는다', async (t) => {
  const dir = freshStateDir(t);
  _resetSelfUpdateInFlightForTests();
  t.after(() => _resetSelfUpdateInFlightForTests());

  const { ports, calls } = portsRefusingRollbackTarget();
  const lines = [];
  const r = await runSelfUpdate({ stateDir: dir, ports, log: (m) => lines.push(m) });

  // 헬퍼도 뜨지 않고 새 버전 설치도 없다 — 되돌릴 수 없는 업데이트는 개시 자체를
  // 하지 않는다.
  assert.equal(calls.install.length, 0, '되돌릴 수 없는데 새 버전을 설치하면 안 된다');
  assert.equal(calls.probe, 0);
  assert.equal(calls.restart, 0, '기존 매니저를 종료·재기동하지 않는다');
  assert.equal(r.changed, false);
  assert.equal(r.willReExec, undefined);
  assert.match(r.summary, /no verified rollback target/);
  // 설치를 시작하지 않았으므로 부팅 검증 기록도 남기지 않는다 — 남기면 다음
  // 부팅이 있지도 않은 설치 실패를 센다.
  assert.equal(readBootVerificationRecord(dir), null);
  assert.equal(readUpdatePin(dir), null);
  assert.ok(lines.some((l) => l.startsWith('Self-update: ') && /refused/.test(l)));
  // 이 단언이 실행된다는 사실 자체가 기존 프로세스 생존의 증거다(완료 기준 7).
  assert.equal(typeof process.pid, 'number');
});

test('runSelfUpdate: 명시적 opt-in 이 있으면 미검증 복귀 대상이어도 진행한다', async (t) => {
  const dir = freshStateDir(t);
  _resetSelfUpdateInFlightForTests();
  t.after(() => _resetSelfUpdateInFlightForTests());

  const prev = process.env.AWB_SELF_UPDATE_ALLOW_UNVERIFIED;
  process.env.AWB_SELF_UPDATE_ALLOW_UNVERIFIED = '1';
  t.after(() => {
    if (prev === undefined) delete process.env.AWB_SELF_UPDATE_ALLOW_UNVERIFIED;
    else process.env.AWB_SELF_UPDATE_ALLOW_UNVERIFIED = prev;
  });

  const { ports, calls } = portsRefusingRollbackTarget();
  const r = await runSelfUpdate({ stateDir: dir, ports, log: () => {} });

  assert.equal(calls.install.length, 1, 'opt-in 은 예외로 남는다');
  assert.equal(r.changed, true);
});

test('runSelfUpdate: 복귀 대상이 검증되면 평소대로 설치·프로브를 진행한다 (양성 대조)', async (t) => {
  const dir = freshStateDir(t);
  _resetSelfUpdateInFlightForTests();
  t.after(() => _resetSelfUpdateInFlightForTests());

  // fakePorts 기본값은 어떤 채널이든 통과시킨다 = 복귀 대상도 검증된다.
  const { ports, calls } = fakePorts();
  const r = await runSelfUpdate({ stateDir: dir, ports, log: () => {} });

  assert.equal(calls.install.length, 1);
  assert.equal(calls.probe, 1, '복귀 대상이 확보됐으면 부팅 프로브가 반드시 돈다');
  assert.equal(r.willReExec, true);
  // 복귀 대상 조회가 이전 버전 자체를 향했는지 확인한다.
  assert.ok(
    calls.provenance.includes(RUNNING_VERSION),
    `복귀 대상 provenance 조회가 없다: ${JSON.stringify(calls.provenance)}`,
  );
});
