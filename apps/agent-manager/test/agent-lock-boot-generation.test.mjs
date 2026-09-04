// 티켓 7e60b497 — 갑작스러운 리부팅 후 stale agent.lock 오판으로 기동 불가.
//
// 재부팅하면 pid 는 낮은 번호부터 다시 배분된다. 부팅 직후 뜬 매니저가 lock 에
// 적어 둔 낮은 pid 는 다음 부팅에서 거의 확실히 다른 프로세스(대개 root 소유 초기
// 데몬)가 차지하고, `process.kill(pid, 0)` 은 EPERM 을 던진다. 예전 판정은 EPERM 을
// 무조건 "살아있음" 으로 읽어 stale 회수 경로를 타지 못했고, main.ts 가 exit(2) 를
// 하는 동안 systemd 는 5초마다 영원히 재시도했다 — 사람이 락을 지우기 전까지
// 자가 복구가 없었다.
//
// 그래서 판정을 **부팅 세대 → pid 존재 → pid 신원** 순서로 바꿨다. 이 파일은 그
// 판정을 두 층에서 검증한다.
//   1. 순수 판정(judgeLockOwner): OS 사실을 주입해 실제 재부팅·pid 재사용 없이
//      모든 분기를 결정적으로 단언한다. 이 파일의 `resolveLostCreateRace` 와 같은
//      주입 스타일이다.
//   2. 실제 acquireAgentLock 경로: 유령 lock 을 디스크에 깔고 자식 프로세스를
//      띄워, ExecStartPre 반창고 없이 스스로 기동하는지(그리고 살아 있는 매니저는
//      여전히 밀어내지 못하는지) 확인한다.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { judgeLockOwner } from '../dist/lib/agent-lockfile.js';
import {
  currentBootIdentity,
  processStartTimeMs,
  readProcessStartTicks,
} from '../dist/lib/boot-identity.js';

const lockModuleUrl = pathToFileURL(
  join(fileURLToPath(new URL('.', import.meta.url)), '../dist/lib/agent-lockfile.js'),
).href;

const tempDirs = [];
after(async () => {
  await Promise.all(tempDirs.map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

// ── 순수 판정 층 ──────────────────────────────────────────────────────────
//
// 고정 시각을 쓰면 벽시계에 의존하지 않아 CI 부하와 무관하게 결정적이다.
const THIS_BOOT = '11111111-1111-4111-8111-111111111111';
const PREVIOUS_BOOT = '22222222-2222-4222-8222-222222222222';
const NOW = Date.UTC(2026, 8, 4, 9, 0, 0);
const BOOT_TIME = NOW - 6 * 3_600_000; // 6시간 전 부팅
const OWNER_STARTED_AT = BOOT_TIME + 30_000; // 부팅 30초 뒤 매니저 기동

function facts(overrides = {}) {
  return {
    bootId: THIS_BOOT,
    bootTimeMs: BOOT_TIME,
    pidPresence: 'present',
    pidStartTicks: null,
    pidStartedAtMs: null,
    ...overrides,
  };
}

function lockOf(overrides = {}) {
  return {
    pid: 1468, // 실측: 이 호스트의 지난 부팅에서 매니저가 받은 낮은 pid
    role: 'manager',
    version: '1.6.94',
    started_at: new Date(OWNER_STARTED_AT).toISOString(),
    boot_id: THIS_BOOT,
    boot_time_ms: BOOT_TIME,
    ...overrides,
  };
}

/** boot 필드가 없는, 이 기능 이전에 만들어진 lock. */
function legacyLockOf(overrides = {}) {
  return {
    pid: 1468,
    role: 'manager',
    version: '1.6.90',
    started_at: new Date(OWNER_STARTED_AT).toISOString(),
    ...overrides,
  };
}

test('(a) 이전 부팅의 boot_id 를 담은 lock 은 그 pid 가 살아 있어도 회수한다', () => {
  // 정확히 이 티켓이 보고한 상황이다: pid 번호는 다른 프로세스가 쓰고 있어
  // 'present' 로 보이지만, 부팅 세대가 다르므로 이전 부팅의 유령이다.
  const verdict = judgeLockOwner(lockOf({ boot_id: PREVIOUS_BOOT }), facts());
  assert.equal(verdict.stale, true);
  assert.equal(verdict.reason, 'boot_id_mismatch');
  assert.match(verdict.detail, /boot_id/, '회수 근거가 사람이 읽을 수 있게 실려야 한다');
});

test('(b) 같은 boot_id + 살아있는 pid 는 회수하지 않는다 — 상호 배제 유지', () => {
  const verdict = judgeLockOwner(lockOf(), facts());
  assert.equal(verdict.stale, false);
  assert.equal(verdict.reason, 'owner_alive');
});

test('(c) 같은 boot_id + 죽은 pid 는 회수한다', () => {
  const verdict = judgeLockOwner(lockOf(), facts({ pidPresence: 'dead' }));
  assert.equal(verdict.stale, true);
  assert.equal(verdict.reason, 'pid_dead');
});

test('(d-1) boot 필드 없는 구버전 lock 이 이번 부팅보다 이르면 회수한다', () => {
  const verdict = judgeLockOwner(
    legacyLockOf({ started_at: new Date(BOOT_TIME - 3_600_000).toISOString() }),
    facts(),
  );
  assert.equal(verdict.stale, true);
  assert.equal(verdict.reason, 'lock_predates_boot');
});

test('(d-2) boot 필드 없는 구버전 lock 이 이번 부팅 이후이고 pid 도 살아 있으면 유지한다', () => {
  // 부팅 세대를 확정할 수 없는 상태다. 애매하면 회수하지 않는다 — 살아 있는
  // 매니저를 밀어내는 것보다 자가 복구를 한 번 놓치는 편이 낫다.
  const verdict = judgeLockOwner(legacyLockOf(), facts());
  assert.equal(verdict.stale, false);
  assert.equal(verdict.reason, 'owner_unverifiable');
});

test('(d-3) boot 필드 없는 구버전 lock 이라도 pid 가 아예 없으면 회수한다', () => {
  const verdict = judgeLockOwner(legacyLockOf(), facts({ pidPresence: 'dead' }));
  assert.equal(verdict.stale, true);
  assert.equal(verdict.reason, 'pid_dead');
});

test('(e) pid 는 살아 있어도 프로세스 시작 시각이 lock started_at 보다 나중이면 회수한다', () => {
  // 진짜 owner 는 자기가 시작한 뒤에 lock 을 적으므로 이 부등호가 성립할 수 없다.
  // 성립한다면 번호만 물려받은 남이다.
  const verdict = judgeLockOwner(
    legacyLockOf(),
    facts({ pidStartedAtMs: OWNER_STARTED_AT + 10 * 60_000 }),
  );
  assert.equal(verdict.stale, true);
  assert.equal(verdict.reason, 'pid_recycled');
});

test('(e-보수) 시작 시각 차이가 허용 폭 안이면 회수하지 않는다', () => {
  // 부팅 이후의 wall-clock 조정으로 몇 초쯤 어긋나는 것은 재사용 근거가 아니다.
  const verdict = judgeLockOwner(legacyLockOf(), facts({ pidStartedAtMs: OWNER_STARTED_AT + 5_000 }));
  assert.equal(verdict.stale, false);
});

test('starttime tick 이 lock 에 적힌 값과 다르면 재사용으로 확정한다', () => {
  const verdict = judgeLockOwner(
    lockOf({ pid_start_ticks: 4321 }),
    facts({ pidStartTicks: 98_765, pidStartedAtMs: OWNER_STARTED_AT - 1_000 }),
  );
  assert.equal(verdict.stale, true);
  assert.equal(verdict.reason, 'pid_recycled');
});

test('starttime tick 이 일치하면 wall-clock 이 어긋나도 같은 프로세스로 확정한다', () => {
  // tick 은 부팅 기준 단조 값이라 NTP step 에 면역이다. 일치하면 시각 환산 결과가
  // 아무리 흔들려도 재사용이 아니다 — 그 흔들림으로 살아 있는 매니저를 밀어내지 않는다.
  const verdict = judgeLockOwner(
    lockOf({ pid_start_ticks: 4321 }),
    facts({ pidStartTicks: 4321, pidStartedAtMs: OWNER_STARTED_AT + 60 * 60_000 }),
  );
  assert.equal(verdict.stale, false);
  assert.equal(verdict.reason, 'owner_alive');
});

test('boot_id 를 못 읽는 플랫폼은 부팅 시각 근사치로 세대를 가른다', () => {
  const nonLinux = { bootId: null };
  // 이전 부팅에서 남은 lock — 부팅 시각이 하루 어긋난다.
  const stale = judgeLockOwner(
    lockOf({ boot_id: undefined, boot_time_ms: BOOT_TIME - 24 * 3_600_000 }),
    facts(nonLinux),
  );
  assert.equal(stale.stale, true);
  assert.equal(stale.reason, 'boot_time_mismatch');

  // 같은 부팅 — 근사치가 몇 초 흔들려도 회수하지 않는다.
  const live = judgeLockOwner(
    lockOf({ boot_id: undefined, boot_time_ms: BOOT_TIME + 3_000 }),
    facts(nonLinux),
  );
  assert.equal(live.stale, false);
});

test('lock 에 boot_id 가 있어도 현재 boot_id 를 못 읽으면 부팅 시각 폴백으로 내려간다', () => {
  const verdict = judgeLockOwner(lockOf(), facts({ bootId: null }));
  assert.equal(verdict.stale, false);
  assert.equal(verdict.reason, 'owner_unverifiable', '확정 비교가 불가능하므로 단정하지 않는다');
});

// ── OS probe 층 (플랫폼별 계약을 명시적으로 단언한다) ───────────────────────

test('부팅 식별자 probe 는 플랫폼별 계약을 지킨다', () => {
  const identity = currentBootIdentity();
  assert.ok(Number.isFinite(identity.approxBootTimeMs));
  assert.ok(identity.approxBootTimeMs <= Date.now(), '부팅 시각은 현재보다 과거여야 한다');
  if (process.platform === 'linux') {
    assert.match(identity.id, /^[0-9a-f]{8}-[0-9a-f]{4}-/, 'Linux 는 /proc 의 boot_id UUID 를 읽는다');
  } else {
    assert.equal(identity.id, null, 'Linux 외 플랫폼은 boot_id 없이 부팅 시각 폴백만 쓴다');
  }
});

test('프로세스 시작 시각 probe 는 플랫폼별 계약을 지킨다', () => {
  const ticks = readProcessStartTicks(process.pid);
  if (process.platform === 'linux') {
    assert.ok(Number.isInteger(ticks) && ticks > 0, `/proc/<pid>/stat field 22 를 읽어야 한다: ${ticks}`);
    const bootTimeMs = currentBootIdentity().approxBootTimeMs;
    const startedAt = processStartTimeMs(ticks, bootTimeMs);
    assert.ok(startedAt !== null, '자기 자신의 시작 시각은 환산 가능해야 한다');
    assert.ok(startedAt >= bootTimeMs - 60_000, '시작 시각이 부팅보다 앞설 수는 없다');
    assert.ok(startedAt <= Date.now() + 60_000, '시작 시각이 미래일 수는 없다');
  } else {
    assert.equal(ticks, null, 'Linux 외 플랫폼에는 procfs 가 없다');
    assert.equal(processStartTimeMs(ticks, Date.now()), null);
  }
});

test('존재하지 않는 pid 의 starttime 은 모든 플랫폼에서 null 이다', () => {
  assert.equal(readProcessStartTicks(999_999_999), null);
  assert.equal(readProcessStartTicks(0), null);
  assert.equal(readProcessStartTicks(-1), null);
});

test('환산 결과가 부팅~현재 범위를 크게 벗어나면 추측하지 않고 null 로 degrade 한다', () => {
  // USER_HZ 가정이 안 맞는 아키텍처에서 tick 이 몇 배로 부풀어도, 틀린 시각으로
  // stale 을 단정하는 대신 "모른다" 로 떨어져야 한다.
  const bootTimeMs = Date.now() - 3_600_000;
  assert.equal(processStartTimeMs(365 * 24 * 3600 * 100, bootTimeMs), null);
  assert.equal(processStartTimeMs(-365 * 24 * 3600 * 100, bootTimeMs), null);
});

// ── 실제 acquireAgentLock 경로 ────────────────────────────────────────────

async function acquireInChild(home) {
  const source = `
    const { acquireAgentLock } = await import(${JSON.stringify(lockModuleUrl)});
    try {
      const lock = await acquireAgentLock({ role: 'manager', version: 'e2e' });
      console.log('ACQUIRED:' + JSON.stringify(lock.payload));
      lock.release();
    } catch (error) {
      console.log('REJECTED:' + error.code);
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, AWB_AGENT_MANAGER_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    // 제품 로그를 부모 stderr 로도 흘려 CI 진단이 사라지지 않게 한다.
    process.stderr.write(chunk);
  });
  const code = await new Promise((resolve) => child.on('close', resolve));
  return { code, stdout, stderr };
}

async function writeLock(home, payload) {
  await fsp.writeFile(join(home, 'agent.lock'), JSON.stringify(payload, null, 2) + '\n');
}

async function makeHome(tag) {
  const home = await fsp.mkdtemp(join(tmpdir(), `awb-lock-${tag}-`));
  tempDirs.push(home);
  return home;
}

test('하드 리부팅으로 남은 lock 은 pid 가 살아 있어도 스스로 회수하고 기동한다', async () => {
  const home = await makeHome('reboot');
  // 이전 부팅의 유령 lock. pid 에는 **지금 확실히 살아 있는 번호**(이 테스트
  // 러너 자신)를 적는다 — 재부팅 뒤 그 낮은 번호를 다른 데몬이 차지해
  // `process.kill(pid, 0)` 이 성공/EPERM 을 내는 상황과 같은 관측값이다.
  // 수정 전 코드는 여기서 EAGENTLOCKED 를 던졌고, systemd 는 5초마다 영원히
  // 재시도했다.
  await writeLock(home, {
    pid: process.pid,
    role: 'manager',
    version: 'previous-boot',
    started_at: new Date(Date.now() - 30 * 24 * 3_600_000).toISOString(),
    boot_id: '00000000-0000-4000-8000-000000000000',
    boot_time_ms: Date.now() - 30 * 24 * 3_600_000,
    pid_start_ticks: 1,
  });

  const { stdout, stderr } = await acquireInChild(home);
  assert.match(stdout, /ACQUIRED:/, `이전 부팅 lock 에 갇히면 안 된다: ${stdout}`);
  assert.match(
    stderr,
    /reusing stale lock — boot_(id|time)_mismatch/,
    '무엇을 근거로 회수했는지가 로그에 남아야 한다',
  );

  // 새 lock 에는 부팅 세대가 항상 실려야 다음 부팅에서 같은 판정을 할 수 있다.
  const payload = JSON.parse(stdout.slice(stdout.indexOf('ACQUIRED:') + 'ACQUIRED:'.length).split('\n')[0]);
  assert.equal(typeof payload.boot_time_ms, 'number');
  assert.ok('boot_id' in payload, '새 lock 은 boot_id 키를 항상 갖는다 (플랫폼에 따라 null)');
  assert.ok('pid_start_ticks' in payload);
  if (process.platform === 'linux') {
    assert.equal(typeof payload.boot_id, 'string');
    assert.equal(typeof payload.pid_start_ticks, 'number');
  }
});

test('이번 부팅에서 살아 있는 매니저의 lock 은 회수하지 않는다 — EAGENTLOCKED 유지', async () => {
  const home = await makeHome('live');
  const boot = currentBootIdentity();
  const ticks = readProcessStartTicks(process.pid);
  await writeLock(home, {
    pid: process.pid,
    role: 'manager',
    version: 'live',
    started_at: new Date().toISOString(),
    boot_id: boot.id,
    boot_time_ms: boot.approxBootTimeMs,
    pid_start_ticks: ticks,
  });

  const { stdout } = await acquireInChild(home);
  assert.match(stdout, /REJECTED:EAGENTLOCKED/, `상호 배제가 깨지면 안 된다: ${stdout}`);
  // 회수하지 않았으므로 원래 lock 이 그대로 남아 있어야 한다.
  const kept = JSON.parse(await fsp.readFile(join(home, 'agent.lock'), 'utf8'));
  assert.equal(kept.version, 'live');
});

test('boot 필드 없는 구버전 lock 도 이번 부팅보다 이르면 회수한다 (하위 호환)', async () => {
  const home = await makeHome('legacy-stale');
  await writeLock(home, {
    pid: process.pid,
    role: 'manager',
    version: 'legacy',
    // 어떤 호스트의 uptime 보다도 확실히 이른 시각.
    started_at: '2020-01-01T00:00:00.000Z',
  });

  const { stdout, stderr } = await acquireInChild(home);
  assert.match(stdout, /ACQUIRED:/, `구버전 lock 에 갇히면 안 된다: ${stdout}`);
  assert.match(stderr, /reusing stale lock — lock_predates_boot/);
});

test('boot 필드 없는 구버전 lock 이라도 살아 있는 owner 면 유지한다 (하위 호환)', async () => {
  const home = await makeHome('legacy-live');
  await writeLock(home, {
    pid: process.pid,
    role: 'manager',
    version: 'legacy-live',
    started_at: new Date().toISOString(),
  });

  const { stdout } = await acquireInChild(home);
  assert.match(stdout, /REJECTED:EAGENTLOCKED/, `구버전 lock 이라고 밀어내면 안 된다: ${stdout}`);
});
