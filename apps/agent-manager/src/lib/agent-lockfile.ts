// Hard mutual exclusion for agent-manager instances on the same host. Only one
// agent-manager process may hold the lockfile at a time; a second instance's
// startup aborts unless launched with --force.
//
// Acquisition rules:
//   1. Try atomic create (O_EXCL via writeFile flag 'wx').
//   2. On EEXIST: judge the existing lock (judgeLockOwner). pid liveness alone is
//      NOT enough — 재부팅하면 pid 가 낮은 번호부터 다시 배분되므로 이전 부팅의
//      매니저가 적어 둔 pid 를 대개 root 소유 초기 데몬이 차지한다. 그러면
//      `process.kill(pid, 0)` 이 EPERM 을 던지는데, 이걸 "살아있음" 으로 읽으면
//      전원 차단·하드리셋 뒤 매니저가 영원히 못 올라온다(티켓 7e60b497).
//      그래서 **부팅 세대**를 먼저 보고, 그 다음에 그 pid 가 아직 lock 을 적은 그
//      프로세스인지 확인한다.
//      - stale   → 이전 부팅 산물 / 죽은 pid / 재사용된 pid. Remove and retry create.
//      - alive   → owner is real. Abort unless force=true. With force=true,
//                  SIGTERM the owner, wait briefly, overwrite the lock.
//      판정이 애매하면 stale 로 보지 않는다 — 상호 배제가 자가 복구보다 우선이다.
//   3. Garbage on disk (unparseable JSON / pid=0): treat as stale, remove.
//   4. 2·3 의 회수(remove→create)는 회수 가드로 직렬화되지만, 그 가드는 회수
//      경로에 들어온 contender 만 붙잡는다 — 1번 happy path 의 create 는 가드를
//      거치지 않으므로 remove 와 create 사이를 파고들 수 있다. 그렇게 create 가
//      EEXIST 로 지면 raw fs 오류를 올리지 않고 승자를 다시 읽어 판정한다:
//      살아 있으면 EAGENTLOCKED, 그마저 죽었으면 처음부터 재시도(createAfterCleanup).
//   5. force 인수는 kill 까지 통째로 회수 가드 안에서 한다. 가드를 잡은 뒤 owner
//      를 다시 읽어, 대기 중 동료 force contender 가 먼저 인수를 끝냈으면(관측한
//      pid 와 다르면) 그 새 owner 를 죽이지 않고 EAGENTLOCKED 로 거절한다.
//
// Release rules:
//   - On clean shutdown call release(); only unlinks if pid still matches ours.
//   - process.on('exit') hook acts as a synchronous safety net for crashes.

import {
  writeFileSync,
  readFileSync,
  unlinkSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AGENT_MANAGER_HOME } from './constants.js';
import { join } from 'node:path';
import { log } from './logging.js';
import {
  currentBootIdentity,
  processStartTimeMs,
  readProcessStartTicks,
} from './boot-identity.js';

export const LOCK_PATH = join(AGENT_MANAGER_HOME, 'agent.lock');
const RECOVERY_LOCK_PATH = `${LOCK_PATH}.recovery`;
const RECOVERY_OWNER_PATH = join(RECOVERY_LOCK_PATH, 'owner.json');

const FORCE_KILL_GRACE_MS = 30_000;
const FORCE_KILL_CONFIRM_MS = 5_000;
const RECOVERY_LOCK_STALE_MS = 60_000;
// 회수 경로가 create 레이스에서 졌는데 승자마저 이미 죽어 있을 때만 재시도한다.
// 살아 있는 승자에게 진 경우는 재시도 없이 곧바로 EAGENTLOCKED 다.
const MAX_ACQUIRE_ATTEMPTS = 5;

// 부팅 시각 근사치(Date.now() - os.uptime())는 같은 부팅 안에서도 부팅 이후의
// wall-clock 조정(NTP step) 때문에 흔들린다. 이 폭을 넘게 어긋났을 때만 "다른 부팅"
// 으로 단정한다. 크게 잡는 쪽이 안전한 방향이다 — 너무 작으면 살아 있는 매니저의
// lock 을 남의 것으로 오인해 상호 배제가 깨지고, 너무 크면 그저 이 지름길을 놓쳐
// 아래 pid 검사로 내려갈 뿐이다.
const BOOT_TIME_TOLERANCE_MS = 120_000;

// 프로세스 시작 시각 대조(구버전 lock 폴백)의 허용 폭. 같은 이유로 크게 잡는다.
const PID_START_TOLERANCE_MS = 60_000;

export type LockRole = 'manager';

export interface LockPayload {
  pid: number;
  role: LockRole;
  version: string;
  started_at: string;
  /** 이 lock 을 만든 부팅의 커널 UUID. Linux 외 플랫폼에서는 null. */
  boot_id: string | null;
  /** 이 lock 을 만든 부팅의 시각 근사치(epoch ms). boot_id 가 없는 플랫폼의 폴백. */
  boot_time_ms: number;
  /** owner 프로세스의 `/proc/<pid>/stat` starttime tick. Linux 외에서는 null.
   *  부팅 기준 단조 값이라 wall-clock 조정에 면역 — pid 재사용을 시각 환산 없이
   *  정확히 가려낸다. */
  pid_start_ticks: number | null;
}

export interface LockHandle {
  release(): void;
  path: string;
  payload: LockPayload;
}

export interface ParsedLock {
  pid: number;
  role?: string;
  started_at?: string;
  version?: string;
  /** 아래 셋은 이 기능(티켓 7e60b497) 이전에 만들어진 lock 에는 없다 — 구버전
   *  lock 도 계속 읽히도록 전부 optional 이며, 없으면 폴백 경로로 판정한다. */
  boot_id?: string;
  boot_time_ms?: number;
  pid_start_ticks?: number;
}

interface AcquireOptions {
  role: LockRole;
  version: string;
  force?: boolean;
}

function readLock(): ParsedLock | null {
  try {
    const raw = readFileSync(LOCK_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const pid = Number.isFinite(parsed?.pid) ? parsed.pid : 0;
    return pid > 0
      ? {
          pid,
          role: parsed.role,
          started_at: parsed.started_at,
          version: parsed.version,
          boot_id: typeof parsed.boot_id === 'string' && parsed.boot_id ? parsed.boot_id : undefined,
          boot_time_ms: Number.isFinite(parsed.boot_time_ms) ? parsed.boot_time_ms : undefined,
          pid_start_ticks: Number.isFinite(parsed.pid_start_ticks)
            ? parsed.pid_start_ticks
            : undefined,
        }
      : null;
  } catch {
    return null;
  }
}

/** "그 번호를 쓰는 프로세스가 하나라도 있는가" 만 답한다. 인수(force) 경로의 kill
 *  대기와 회수 가드 회수처럼 **소유자 신원이 아니라 번호의 점유 여부**가 질문인
 *  곳에서만 쓴다. lock 소유권 판정에는 쓰지 말 것 — EPERM 을 곧바로 "살아있는
 *  매니저"로 승격시키는 것이 바로 이 티켓의 버그다. 그 판정은 judgeLockOwner. */
function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

export type LockStaleReason =
  | 'boot_id_mismatch'
  | 'boot_time_mismatch'
  | 'lock_predates_boot'
  | 'pid_dead'
  | 'pid_recycled';

export type LockOwnerVerdict =
  | { stale: true; reason: LockStaleReason; detail: string }
  | { stale: false; reason: 'owner_alive' | 'owner_unverifiable'; detail: string };

/** judgeLockOwner 가 보는 OS 사실 전부. 주입 가능하게 분리해 두면 실제 재부팅이나
 *  pid 재사용을 재현하지 않고도 판정 분기를 결정적으로 검증할 수 있다
 *  (이 파일의 `resolveLostCreateRace` 와 같은 주입 스타일). */
export interface LockOwnerFacts {
  /** 지금 이 부팅의 커널 UUID. 읽을 수 없는 플랫폼에서는 null. */
  bootId: string | null;
  /** 지금 이 부팅의 시각 근사치(epoch ms). */
  bootTimeMs: number;
  /** 'dead' 는 ESRCH — 그 번호를 쓰는 프로세스가 확정적으로 없다.
   *  'present' 는 성공(우리 소유) 또는 EPERM(남의 소유) — 번호는 쓰이고 있다. */
  pidPresence: 'dead' | 'present';
  /** 그 pid 의 현재 starttime tick. 모르면 null. */
  pidStartTicks: number | null;
  /** 위 tick 을 epoch ms 로 환산한 값. 모르거나 신뢰할 수 없으면 null. */
  pidStartedAtMs: number | null;
}

type BootGeneration =
  | { same: false; reason: 'boot_id_mismatch' | 'boot_time_mismatch' | 'lock_predates_boot'; detail: string }
  | { same: true; detail: string }
  | { same: null; detail: string };

function parseIsoMs(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** lock 이 이번 부팅에서 만들어진 것인지. `same: null` 은 "판별 불가" 이며, 그 자체로는
 *  회수 근거가 되지 않는다. */
function compareBootGeneration(lock: ParsedLock, facts: LockOwnerFacts): BootGeneration {
  // 1순위: 커널 boot UUID 직접 대조. 유일하게 확정적이다.
  if (lock.boot_id && facts.bootId) {
    return lock.boot_id === facts.bootId
      ? { same: true, detail: `boot_id=${facts.bootId} 일치` }
      : {
          same: false,
          reason: 'boot_id_mismatch',
          detail: `lock boot_id=${lock.boot_id} 이 현재 부팅 ${facts.bootId} 과 다름`,
        };
  }

  // 2순위(Windows/macOS): 부팅 시각 근사치 대조.
  if (typeof lock.boot_time_ms === 'number') {
    const driftMs = Math.abs(facts.bootTimeMs - lock.boot_time_ms);
    if (driftMs > BOOT_TIME_TOLERANCE_MS) {
      return {
        same: false,
        reason: 'boot_time_mismatch',
        detail:
          `부팅 시각 근사치가 ${Math.round(driftMs / 1000)}s 어긋남 ` +
          `(허용 ${BOOT_TIME_TOLERANCE_MS / 1000}s, lock=${new Date(lock.boot_time_ms).toISOString()})`,
      };
    }
    return {
      same: null,
      detail: `부팅 시각 근사치가 ${Math.round(driftMs / 1000)}s 이내 — 같은 부팅으로 단정하지는 않음`,
    };
  }

  // 3순위(구버전 lock — boot 필드 자체가 없음): 기록된 시작 시각이 이번 부팅보다
  // 이르면 이전 부팅 산물이다. 이 경로는 이 기능 이전에 만들어진 lock 을 한 번
  // 넘기기 위한 것이며, 새 lock 은 항상 boot 필드를 싣는다.
  const startedAtMs = parseIsoMs(lock.started_at);
  if (startedAtMs !== null && startedAtMs < facts.bootTimeMs - BOOT_TIME_TOLERANCE_MS) {
    return {
      same: false,
      reason: 'lock_predates_boot',
      detail:
        `구버전 lock(boot 필드 없음)의 started_at=${lock.started_at} 이 ` +
        `이번 부팅(${new Date(facts.bootTimeMs).toISOString()})보다 이름`,
    };
  }
  return { same: null, detail: '구버전 lock(boot 필드 없음) — 부팅 세대를 판별할 수 없음' };
}

/** lock 을 적은 그 프로세스가 아직 그 pid 를 쓰고 있는지. **아니라고 확정될 때만**
 *  사유를 돌려주고, 모르면 null 이다 — 애매하면 회수하지 않는다. */
function judgePidRecycled(lock: ParsedLock, facts: LockOwnerFacts): string | null {
  // 1순위: 부팅 기준 starttime tick 직접 대조. wall-clock 조정에 면역이라 확정적이다.
  if (typeof lock.pid_start_ticks === 'number' && facts.pidStartTicks !== null) {
    return lock.pid_start_ticks === facts.pidStartTicks
      ? null
      : `pid=${lock.pid} 의 starttime tick 이 ${lock.pid_start_ticks} → ${facts.pidStartTicks} 로 바뀜 ` +
          `— 번호만 물려받은 다른 프로세스`;
  }

  // 폴백(구버전 lock): 프로세스 시작 시각이 lock 기록 시각보다 **나중**이면 남이다.
  // 진짜 owner 는 자기가 시작한 뒤에 lock 을 적으므로 이 부등호가 성립할 수 없다.
  const startedAtMs = parseIsoMs(lock.started_at);
  if (
    facts.pidStartedAtMs !== null &&
    startedAtMs !== null &&
    facts.pidStartedAtMs > startedAtMs + PID_START_TOLERANCE_MS
  ) {
    return (
      `pid=${lock.pid} 의 프로세스 시작 시각(${new Date(facts.pidStartedAtMs).toISOString()})이 ` +
      `lock started_at(${lock.started_at})보다 나중 — 재사용된 번호`
    );
  }
  return null;
}

/** lock 소유권 판정. 순수 함수 + 사실 주입이라 실제 재부팅/pid 재사용 없이도
 *  모든 분기를 결정적으로 검증할 수 있다.
 *
 *  회수(stale) 는 **확정 근거가 있을 때만** 낸다. 판별 불가는 전부 유지 쪽으로
 *  떨어진다 — 살아 있는 매니저를 밀어내는 것보다 자가 복구를 한 번 놓치는 편이
 *  낫다(요구사항 5). */
export function judgeLockOwner(lock: ParsedLock, facts: LockOwnerFacts): LockOwnerVerdict {
  const boot = compareBootGeneration(lock, facts);
  if (boot.same === false) {
    // 부팅이 다르면 그 pid 가 지금 살아 있든 말든 이전 부팅의 유령이다.
    return { stale: true, reason: boot.reason, detail: boot.detail };
  }

  if (facts.pidPresence === 'dead') {
    return { stale: true, reason: 'pid_dead', detail: `pid=${lock.pid} 를 쓰는 프로세스가 없음 (ESRCH)` };
  }

  const recycled = judgePidRecycled(lock, facts);
  if (recycled) return { stale: true, reason: 'pid_recycled', detail: recycled };

  return {
    stale: false,
    reason: boot.same === true ? 'owner_alive' : 'owner_unverifiable',
    detail: `pid=${lock.pid} 가 살아 있고 재사용 근거 없음 — ${boot.detail}`,
  };
}

/** `process.kill(pid, 0)` 의 결과를 두 갈래로 정리한다. ESRCH 만 "확정적으로 없음"
 *  이고, EPERM(남의 소유)이나 예상 못 한 오류는 번호가 쓰이고 있을 수 있다고 본다. */
function probePidPresence(pid: number): 'dead' | 'present' {
  if (!Number.isFinite(pid) || pid <= 0) return 'dead';
  try {
    process.kill(pid, 0);
    return 'present';
  } catch (err: any) {
    return err?.code === 'ESRCH' ? 'dead' : 'present';
  }
}

/** OS 에 실제로 물어보는 층. 판정은 하지 않는다. */
export function probeLockOwner(lock: ParsedLock): LockOwnerFacts {
  const boot = currentBootIdentity();
  const pidStartTicks = readProcessStartTicks(lock.pid);
  return {
    bootId: boot.id,
    bootTimeMs: boot.approxBootTimeMs,
    pidPresence: probePidPresence(lock.pid),
    pidStartTicks,
    pidStartedAtMs: processStartTimeMs(pidStartTicks, boot.approxBootTimeMs),
  };
}

function writeLockAtomic(payload: LockPayload): void {
  try {
    mkdirSync(dirname(LOCK_PATH), { recursive: true });
  } catch {
    /* ignore */
  }
  // 'wx' = O_CREAT | O_EXCL. Throws EEXIST if anyone beat us.
  writeFileSync(LOCK_PATH, JSON.stringify(payload, null, 2) + '\n', { flag: 'wx' });
}

/**
 * Acquire the agent-manager lockfile. Returns a release-handle on success,
 * throws on conflict.
 */
export async function acquireAgentLock(opts: AcquireOptions): Promise<LockHandle> {
  const role = opts?.role;
  const version = opts?.version || 'unknown';
  const force = opts?.force === true;
  if (role !== 'manager') {
    throw new Error(`acquireAgentLock: invalid role ${JSON.stringify(role)}`);
  }
  const boot = currentBootIdentity();
  const payload: LockPayload = {
    pid: process.pid,
    role,
    version,
    started_at: new Date().toISOString(),
    boot_id: boot.id,
    boot_time_ms: boot.approxBootTimeMs,
    pid_start_ticks: readProcessStartTicks(process.pid),
  };

  // 회수 경로가 create 레이스에서 이미 죽은 승자에게 졌을 때만 다시 돈다
  // (ELOCKRACE). 그 외 결과는 첫 시도에서 그대로 확정된다.
  for (let attempt = 1; ; attempt++) {
    try {
      return await attemptAcquire(payload, force);
    } catch (err: any) {
      if (err?.code !== 'ELOCKRACE' || attempt >= MAX_ACQUIRE_ATTEMPTS) throw err;
    }
  }
}

async function attemptAcquire(payload: LockPayload, force: boolean): Promise<LockHandle> {
  const role = payload.role;

  // First attempt — pure happy path.
  try {
    writeLockAtomic(payload);
    log(`[lockfile] acquired ${LOCK_PATH} (role=${role} pid=${process.pid})`);
    return makeReleaseHandle(payload);
  } catch (err: any) {
    if (err?.code !== 'EEXIST') throw err;
  }

  const existing = readLock();
  if (!existing) {
    return acquireAfterStaleCleanup(payload);
  }

  const verdict = judgeLockOwner(existing, probeLockOwner(existing));
  if (verdict.stale) {
    log(
      `[lockfile] reusing stale lock — ${verdict.reason}: ${verdict.detail} ` +
        `(previous owner pid=${existing.pid} role=${existing.role || '?'} ` +
        `version=${existing.version || '?'} started_at=${existing.started_at || '?'})`,
    );
    return acquireAfterStaleCleanup(payload);
  }

  if (!force) {
    const e: any = new Error(
      `AWB agent-manager lockfile held by pid=${existing.pid} role=${existing.role || '?'} ` +
        `version=${existing.version || '?'} since ${existing.started_at || '?'} ` +
        `[${verdict.reason}: ${verdict.detail}]. ` +
        `Stop it first, or pass --force to take over.`,
    );
    e.code = 'EAGENTLOCKED';
    throw e;
  }

  // 인수 **전체**(kill 포함)를 회수 가드 안에서 수행한다. 예전에는 kill 이 가드
  // 밖에 있어서, 위에서 `existing` 을 읽은 뒤 SIGTERM 을 보내기까지의 창에 동료
  // force contender 가 먼저 인수를 끝내고 자기 lock 을 설치하면 진 쪽이 그 **갓
  // 태어난 owner** 를 죽였다 — 가드가 lockfile 쓰기만 직렬화하고 kill 은 보호하지
  // 않았던 것이다(Windows CI 실측: 이긴 쪽이 TerminateProcess 로 exit 1). 가드
  // 안에서 owner 를 다시 읽어, 관측했던 그 owner 가 아니면 죽이지 않고
  // EAGENTLOCKED 로 거절한다 — 인수 후 재확인이 이미 쓰던 규칙과 같다.
  log(
    `[lockfile] --force: waiting for takeover guard (owner pid=${existing.pid} role=${existing.role || '?'})`,
  );
  const releaseRecovery = await acquireRecoveryLock();
  try {
    const owner = readLock();
    if (owner && isPidAlive(owner.pid)) {
      if (owner.pid !== existing.pid) throw lockedBy(owner);

      log(`[lockfile] --force: SIGTERM previous owner pid=${owner.pid} role=${owner.role || '?'}`);
      try {
        process.kill(owner.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
      await waitForExit(owner.pid, FORCE_KILL_GRACE_MS);
      if (isPidAlive(owner.pid)) {
        log(`[lockfile] --force: graceful shutdown timed out; SIGKILL previous owner pid=${owner.pid}`);
        try {
          process.kill(owner.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
        await waitForExit(owner.pid, FORCE_KILL_CONFIRM_MS);
      }
      if (isPidAlive(owner.pid)) {
        const e: any = new Error(
          `AWB agent-manager previous owner pid=${owner.pid} did not exit; refusing overlapping takeover`,
        );
        e.code = 'EAGENTTAKEOVER';
        throw e;
      }

      // 죽인 owner 는 종료 훅으로 자기 lock 을 지운다. 그 사이 가드를 거치지 않는
      // happy path 로 새 프로세스가 lock 을 만들었을 수 있으니, 우리가 죽인 그
      // owner 의 lock 이 아니면 지우지 않는다.
      const current = readLock();
      if (current && current.pid !== owner.pid) throw lockedBy(current);
      if (current && isPidAlive(current.pid)) throw lockedBy(current);
    }
    try {
      unlinkSync(LOCK_PATH);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
    }
    createAfterCleanup(payload);
  } finally {
    releaseRecovery();
  }
  log(`[lockfile] --force: acquired after previous owner exit (role=${payload.role} pid=${process.pid})`);
  return makeReleaseHandle(payload);
}

async function acquireAfterStaleCleanup(payload: LockPayload): Promise<LockHandle> {
  const releaseRecovery = await acquireRecoveryLock();
  try {
    // 가드를 잡는 사이 lock 이 바뀌었을 수 있으니 다시 읽어 판정한다. 여기서
    // pid liveness 만 보면 회수 근거(다른 부팅 등)를 무시하고 EAGENTLOCKED 로
    // 되돌아가 위의 stale 판정이 통째로 무력해진다.
    const current = readLock();
    if (current) {
      const currentVerdict = judgeLockOwner(current, probeLockOwner(current));
      if (!currentVerdict.stale) {
        throw lockedBy(current, `${currentVerdict.reason}: ${currentVerdict.detail}`);
      }
    }
    try {
      unlinkSync(LOCK_PATH);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
    }
    createAfterCleanup(payload);
  } finally {
    releaseRecovery();
  }
  log(`[lockfile] acquired after stale-cleanup (role=${payload.role} pid=${process.pid})`);
  return makeReleaseHandle(payload);
}

/** 회수 가드(acquireRecoveryLock) 안에서 unlink 직후 새 lock 을 만든다.
 *
 *  가드는 **회수 경로에 들어온 contender 만** 직렬화한다. 첫 시도의 O_EXCL
 *  create(위 attemptAcquire happy path)는 가드를 거치지 않으므로, 회수 경로가
 *  unlink 한 뒤 create 하기 전 사이에 갓 시작한 contender 의 첫 시도가 파일을
 *  선점할 수 있다. 그 창은 Windows CI 에서 실제로 관측됐다(파일 연산이 느려
 *  창이 넓다): 회수 경로가 raw `EEXIST` 를 그대로 올려, `EAGENTLOCKED` 를
 *  기대하는 호출자에게 fs 오류 코드가 새어 나갔다.
 *
 *  창 자체는 O_EXCL 의미상 없앨 수 없으므로 결과를 다시 판정한다 —
 *  살아 있는 승자에게 졌으면 EAGENTLOCKED, 승자마저 죽었으면 재시도. */
function createAfterCleanup(payload: LockPayload): void {
  try {
    writeLockAtomic(payload);
  } catch (err: any) {
    if (err?.code !== 'EEXIST') throw err;
    const verdict = resolveLostCreateRace(readLock, isPidAlive);
    if (verdict.outcome === 'locked') throw lockedBy(verdict.owner);
    const retry: any = new Error(
      'AWB agent-manager lock create lost a race to an owner that is already gone; retrying',
    );
    retry.code = 'ELOCKRACE';
    throw retry;
  }
}

/** createAfterCleanup 의 판정 규칙. 순수 로직 + 의존성 주입이라 실제 프로세스
 *  레이스를 재현하지 않고도 두 분기를 결정적으로 unit test 할 수 있다
 *  (cli-resolver 의 `selectBinary` 와 같은 주입 스타일). */
export function resolveLostCreateRace(
  read: () => ParsedLock | null,
  alive: (pid: number) => boolean,
): { outcome: 'locked'; owner: ParsedLock } | { outcome: 'retry' } {
  const winner = read();
  if (winner && alive(winner.pid)) return { outcome: 'locked', owner: winner };
  return { outcome: 'retry' };
}

async function acquireRecoveryLock(): Promise<() => void> {
  for (;;) {
    try {
      mkdirSync(RECOVERY_LOCK_PATH);
      writeFileSync(RECOVERY_OWNER_PATH, JSON.stringify({ pid: process.pid }));
      return () => {
        try {
          rmSync(RECOVERY_LOCK_PATH, { recursive: true, force: true });
        } catch {
          /* 프로세스 종료 시 stale 회수 가드가 안전하게 정리한다 */
        }
      };
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
    }

    if (reclaimStaleRecoveryLock()) continue;
    await delay(25);
  }
}

function reclaimStaleRecoveryLock(): boolean {
  let ownerPid = 0;
  let ageMs = 0;
  try {
    const parsed = JSON.parse(readFileSync(RECOVERY_OWNER_PATH, 'utf8'));
    ownerPid = Number.isFinite(parsed?.pid) ? parsed.pid : 0;
  } catch {
    try {
      ageMs = Date.now() - statSync(RECOVERY_LOCK_PATH).mtimeMs;
    } catch {
      return true;
    }
  }
  if ((ownerPid > 0 && isPidAlive(ownerPid)) || (ownerPid === 0 && ageMs < RECOVERY_LOCK_STALE_MS)) {
    return false;
  }

  const quarantine = `${RECOVERY_LOCK_PATH}.stale-${process.pid}-${Date.now()}`;
  try {
    // rename은 현재 recovery 디렉터리 자체를 원자적으로 격리한다. 이후 생성된
    // contender의 가드는 다른 경로 객체이므로 이 정리가 삭제하지 않는다.
    renameSync(RECOVERY_LOCK_PATH, quarantine);
  } catch (err: any) {
    return err?.code === 'ENOENT';
  }
  rmSync(quarantine, { recursive: true, force: true });
  return true;
}

function lockedBy(existing: ParsedLock, why?: string): Error {
  const e: any = new Error(
    `AWB agent-manager lockfile held by pid=${existing.pid}${why ? ` [${why}]` : ''}`,
  );
  e.code = 'EAGENTLOCKED';
  return e;
}

async function waitForExit(prevPid: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isPidAlive(prevPid)) return;
    await delay(100);
  }
}

function makeReleaseHandle(payload: LockPayload): LockHandle {
  let released = false;
  process.on('exit', () => {
    if (released) return;
    safeUnlinkOwn(payload.pid);
  });
  return {
    release(): void {
      if (released) return;
      released = true;
      safeUnlinkOwn(payload.pid);
    },
    path: LOCK_PATH,
    payload,
  };
}

function safeUnlinkOwn(myPid: number): void {
  // Re-read so we never delete a lockfile that another instance has taken
  // over. Pid-match guard only.
  try {
    const raw = readFileSync(LOCK_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.pid !== myPid) return;
  } catch {
    return;
  }
  try {
    unlinkSync(LOCK_PATH);
    log(`[lockfile] released ${LOCK_PATH}`);
  } catch {
    /* race; fine */
  }
}

/** Pure inspector — does not touch the lockfile. */
export function inspectAgentLock(): ParsedLock | null {
  return readLock();
}
