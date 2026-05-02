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
  existsSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AGENT_MANAGER_HOME, LEGACY_LOCK_PATH } from './constants.js';
import { join } from 'node:path';
import { log } from './logging.js';

export const LOCK_PATH = join(AGENT_MANAGER_HOME, 'agent.lock');

const FORCE_KILL_GRACE_MS = 1500;

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

function writeLockOverwrite(payload: LockPayload): void {
  try {
    mkdirSync(dirname(LOCK_PATH), { recursive: true });
  } catch {
    /* ignore */
  }
  writeFileSync(LOCK_PATH, JSON.stringify(payload, null, 2) + '\n');
}

/**
 * Acquire the agent-manager lockfile. Returns a release-handle on success,
 * throws on conflict.
 */
export function acquireAgentLock(opts: AcquireOptions): LockHandle {
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
    log(`[lockfile] removing unparseable lockfile at ${LOCK_PATH}`);
    try {
      unlinkSync(LOCK_PATH);
    } catch {
      /* race; fine */
    }
    writeLockAtomic(payload);
    log(`[lockfile] acquired after stale-cleanup (role=${role} pid=${process.pid})`);
    return makeReleaseHandle(payload);
  }

  if (!isPidAlive(existing.pid)) {
    log(
      `[lockfile] reusing stale lock (previous owner pid=${existing.pid} role=${existing.role || '?'} dead)`,
    );
    try {
      unlinkSync(LOCK_PATH);
    } catch {
      /* race; fine */
    }
    writeLockAtomic(payload);
    log(`[lockfile] acquired after stale-cleanup (role=${role} pid=${process.pid})`);
    return makeReleaseHandle(payload);
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
  return forceTakeover(payload, existing.pid);
}

async function forceTakeoverAsync(payload: LockPayload, prevPid: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < FORCE_KILL_GRACE_MS) {
    if (!isPidAlive(prevPid)) break;
    await delay(100);
  }
  try {
    writeLockAtomic(payload);
  } catch (err: any) {
    if (err?.code !== 'EEXIST') throw err;
    writeLockOverwrite(payload);
  }
  log(`[lockfile] --force: acquired by overwrite (role=${payload.role} pid=${process.pid})`);
}

function forceTakeover(payload: LockPayload, prevPid: number): LockHandle {
  try {
    writeLockOverwrite(payload);
  } catch (err: any) {
    log(`[lockfile] --force overwrite failed: ${err?.message ?? err}`);
    throw err;
  }
  forceTakeoverAsync(payload, prevPid).catch((err) =>
    log(`[lockfile] takeover poll: ${err?.message ?? err}`),
  );
  return makeReleaseHandle(payload);
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

export interface LegacyLockState {
  present: boolean;
  alive: boolean;
  pid: number | null;
  role?: string;
  version?: string;
  started_at?: string;
  path: string;
}

/**
 * Inspect the legacy claude-plugin lockfile (~/.claude/channels/awb/agent.lock).
 *
 * Used at startup so the standalone manager refuses to run alongside a still-
 * alive plugin daemon. Returns `present:false` when the legacy file is absent
 * (the common case once users migrate). Stale lockfiles are reported as
 * `present:true, alive:false` so the caller can log a benign warning instead
 * of aborting.
 */
export function inspectLegacyAgentLock(): LegacyLockState {
  if (!existsSync(LEGACY_LOCK_PATH)) {
    return { present: false, alive: false, pid: null, path: LEGACY_LOCK_PATH };
  }
  try {
    const raw = readFileSync(LEGACY_LOCK_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const pid = Number.isFinite(parsed?.pid) ? parsed.pid : 0;
    if (pid <= 0) {
      return { present: true, alive: false, pid: null, path: LEGACY_LOCK_PATH };
    }
    return {
      present: true,
      alive: isPidAlive(pid),
      pid,
      role: parsed.role,
      version: parsed.version,
      started_at: parsed.started_at,
      path: LEGACY_LOCK_PATH,
    };
  } catch {
    return { present: true, alive: false, pid: null, path: LEGACY_LOCK_PATH };
  }
}
