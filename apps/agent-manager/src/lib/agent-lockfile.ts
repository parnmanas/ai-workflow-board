// Hard mutual exclusion for agent-manager instances on the same host. Only one
// agent-manager process may hold the lockfile at a time; a second instance's
// startup aborts unless launched with --force.
//
// Acquisition rules:
//   1. Try atomic create (O_EXCL via writeFile flag 'wx').
//   2. On EEXIST: read pid from the existing lock and `process.kill(pid, 0)`.
//      - alive   → owner is real. Abort unless force=true. With force=true,
//                  SIGTERM the owner, wait briefly, overwrite the lock.
//      - dead    → stale (last owner crashed). Remove and retry create.
//   3. Garbage on disk (unparseable JSON / pid=0): treat as stale, remove.
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

export const LOCK_PATH = join(AGENT_MANAGER_HOME, 'agent.lock');
const RECOVERY_LOCK_PATH = `${LOCK_PATH}.recovery`;
const RECOVERY_OWNER_PATH = join(RECOVERY_LOCK_PATH, 'owner.json');

const FORCE_KILL_GRACE_MS = 30_000;
const FORCE_KILL_CONFIRM_MS = 5_000;
const RECOVERY_LOCK_STALE_MS = 60_000;

export type LockRole = 'manager';

export interface LockPayload {
  pid: number;
  role: LockRole;
  version: string;
  started_at: string;
}

export interface LockHandle {
  release(): void;
  path: string;
  payload: LockPayload;
}

interface ParsedLock {
  pid: number;
  role?: string;
  started_at?: string;
  version?: string;
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
        }
      : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
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
  const payload: LockPayload = {
    pid: process.pid,
    role,
    version,
    started_at: new Date().toISOString(),
  };

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

  if (!isPidAlive(existing.pid)) {
    log(
      `[lockfile] reusing stale lock (previous owner pid=${existing.pid} role=${existing.role || '?'} dead)`,
    );
    return acquireAfterStaleCleanup(payload);
  }

  if (!force) {
    const e: any = new Error(
      `AWB agent-manager lockfile held by pid=${existing.pid} role=${existing.role || '?'} ` +
        `version=${existing.version || '?'} since ${existing.started_at || '?'}. ` +
        `Stop it first, or pass --force to take over.`,
    );
    e.code = 'EAGENTLOCKED';
    throw e;
  }

  log(`[lockfile] --force: SIGTERM previous owner pid=${existing.pid} role=${existing.role || '?'}`);
  try {
    process.kill(existing.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  await waitForExit(existing.pid, FORCE_KILL_GRACE_MS);
  if (isPidAlive(existing.pid)) {
    log(`[lockfile] --force: graceful shutdown timed out; SIGKILL previous owner pid=${existing.pid}`);
    try {
      process.kill(existing.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    await waitForExit(existing.pid, FORCE_KILL_CONFIRM_MS);
  }
  if (isPidAlive(existing.pid)) {
    const e: any = new Error(
      `AWB agent-manager previous owner pid=${existing.pid} did not exit; refusing overlapping takeover`,
    );
    e.code = 'EAGENTTAKEOVER';
    throw e;
  }

  // 종료 대기 중이던 force contender들을 회수 가드로 직렬화한다. 가드 안에서
  // owner를 다시 읽으므로 먼저 이긴 contender의 lock을 뒤늦게 삭제할 수 없다.
  const releaseRecovery = await acquireRecoveryLock();
  try {
    const current = readLock();
    if (current && current.pid !== existing.pid) throw lockedBy(current);
    if (current && isPidAlive(current.pid)) throw lockedBy(current);
    try {
      unlinkSync(LOCK_PATH);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
    }
    writeLockAtomic(payload);
  } finally {
    releaseRecovery();
  }
  log(`[lockfile] --force: acquired after previous owner exit (role=${payload.role} pid=${process.pid})`);
  return makeReleaseHandle(payload);
}

async function acquireAfterStaleCleanup(payload: LockPayload): Promise<LockHandle> {
  const releaseRecovery = await acquireRecoveryLock();
  try {
    const current = readLock();
    if (current && isPidAlive(current.pid)) throw lockedBy(current);
    try {
      unlinkSync(LOCK_PATH);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
    }
    writeLockAtomic(payload);
  } finally {
    releaseRecovery();
  }
  log(`[lockfile] acquired after stale-cleanup (role=${payload.role} pid=${process.pid})`);
  return makeReleaseHandle(payload);
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

function lockedBy(existing: ParsedLock): Error {
  const e: any = new Error(`AWB agent-manager lockfile held by pid=${existing.pid}`);
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
