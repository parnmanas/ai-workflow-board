// When the manager exits cleanly each subagent's exit hook unlinks its
// mcp-config tempfile + pid sidecar. When it dies hard (SIGKILL, crash,
// host reboot) those hooks never run. Children we spawn are detached + unref'd,
// so they survive — and their config files + pid sidecars stay on disk.
//
// On startup we scan SUBAGENTS_BASE_DIR, read each `.pid` sidecar, and reap
// anything genuinely orphaned:
//   1. Build a set of cfg paths that appear in the argv of any live process
//      (`/proc/*/cmdline`, looking for the `--mcp-config <path>` flag the
//      children are spawned with).
//   2. For each `.pid` sidecar:
//        - if the cfg path is in the live-argv set → a sibling manager still
//          owns this subagent. Leave the files alone.
//        - else → genuine orphan. SIGTERM the pid (+ delayed SIGKILL),
//          unlink the .pid + .json files.
//
// On non-Linux hosts /proc isn't available — we fall back to the
// kill-anything-alive behavior, which is no worse than before.

import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { MANAGED_AGENTS_DIR, SUBAGENTS_BASE_DIR } from './constants.js';
import { log } from './logging.js';

const KILL_BACKUP_DELAY_MS = 2000;
const KILL_CONFIRM_DELAY_MS = 100;
/** SIGTERM/SIGKILL 로도 안 끝난 뒤 최후로 한 번 더 확인하는 유예. */
const KILL_FINAL_GRACE_MS = 2000;

/**
 * 죽이지 못한 orphan 기록 — 부팅을 중단하는 대신 격리한다. ralf 실측(2026-10-03):
 * 끝나지 않은 CLI 하나 때문에 부팅 전체가 exit 1 로 죽고, 업데이터가 띄운 프로세스라
 * 재시작 장치도 없어 장시간 다운됐다. 격리된 pid 가 살아 있는 동안은 resume 으로
 * 같은 세션 UUID 를 다시 물지 않고 fresh 로 띄워 a511b50b 의 충돌도 막는다.
 */
export const QUARANTINE_FILE = join(SUBAGENTS_BASE_DIR, 'quarantine.json');

export interface QuarantinedProcess {
  pid: number;
  /** `.pid` sidecar 파일명 — 다음 부팅이 같은 항목을 다시 정리한다. */
  entry: string;
  reason: string;
  at: string;
}

/** 격리 파일명 — `readQuarantine(dir)` 과 같은 위치다. */
export const QUARANTINE_FILENAME = 'quarantine.json';

/** 격리 파일을 읽는다. 없거나 깨졌으면 빈 목록(깨진 파일은 버린다). */
export async function readQuarantine(dir: string = SUBAGENTS_BASE_DIR): Promise<QuarantinedProcess[]> {
  const path = join(dir, QUARANTINE_FILENAME);
  let raw: string;
  try {
    raw = await fsp.readFile(path, 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : parsed?.quarantined;
    if (!Array.isArray(list)) return [];
    return list.filter(
      (e: any): e is QuarantinedProcess =>
        e && Number.isInteger(e.pid) && e.pid > 0 && typeof e.entry === 'string',
    );
  } catch {
    await fsp.unlink(path).catch(() => undefined);
    return [];
  }
}

async function writeQuarantine(dir: string, entries: QuarantinedProcess[]): Promise<void> {
  const path = join(dir, QUARANTINE_FILENAME);
  if (entries.length === 0) {
    await fsp.unlink(path).catch(() => undefined);
    return;
  }
  await fsp.writeFile(path, JSON.stringify(entries, null, 2), 'utf8');
}

/**
 * 지금 살아 있는 격리 pid 가 하나라도 있는가. 호출 시점에 매번 판정한다 —
 * 격리 파일은 부팅 때만 쓰이고, pid 죽음은 여기서(매 dispatch) 확인한다.
 */
export async function hasLiveQuarantine(dir: string = SUBAGENTS_BASE_DIR): Promise<boolean> {
  const entries = await readQuarantine(dir);
  return entries.some((e) => isPidAlive(e.pid));
}

async function readPid(pidPath: string): Promise<number | null> {
  try {
    const raw = await fsp.readFile(pidPath, 'utf8');
    const pid = parseInt(raw.trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** pid 살아있음 판정 — 업데이터 인계 대기(부모 종료 확인)도 같은 의미로 쓴다. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

/**
 * Scan /proc for the set of `--mcp-config <path>` argv values across all
 * live processes. Returns null on non-Linux / unreadable /proc so callers
 * know to fall back.
 */
async function readLiveCfgPathsFromProc(): Promise<Set<string> | null> {
  let procEntries: string[];
  try {
    procEntries = await fsp.readdir('/proc');
  } catch {
    return null;
  }
  const live = new Set<string>();
  for (const entry of procEntries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = await fsp.readFile(`/proc/${entry}/cmdline`, 'utf8');
      const parts = cmdline.split('\0');
      const idx = parts.indexOf('--mcp-config');
      if (idx >= 0 && parts[idx + 1]) live.add(parts[idx + 1]);
    } catch {
      /* process vanished mid-scan, or perms error — ignore */
    }
  }
  return live;
}

interface ReapResult {
  skipped: boolean;
}

/**
 * Windows 에서 프로세스 트리를 죽인다. bare `process.kill` 은 `.cmd` shim 체인의
 * 부모만 죽이고 자식을 남기거나(자식이 세션을 계속 물고 있으면 다음 정리가 또
 * 실패한다), 권한 없는 pid 재사용에 EPERM 으로 매번 살아 있다고 본다. Hermes
 * 정리와 같은 `taskkill /T /F` 를 쓴다.
 */
async function killTreeWin32(pid: number): Promise<string | null> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    child.once('error', (err: any) => resolve(err?.code ?? 'spawn_error'));
    child.once('exit', (code) => resolve(code === 0 ? null : `exit_${code}`));
  });
}

async function reapOne(
  dir: string,
  entry: string,
  liveCfgPaths: Set<string> | null,
): Promise<ReapResult> {
  const pidPath = join(dir, entry);
  const cfgPath = pidPath.replace(/\.pid$/, '.json');

  // Sibling protection: if any live process on this host has this cfg path
  // on its argv, the cfg is in active use. Skip — leave files + child alone.
  if (liveCfgPaths && liveCfgPaths.has(cfgPath)) {
    return { skipped: true };
  }

  const pid = await readPid(pidPath);
  if (pid != null && isPidAlive(pid)) {
    log(`[orphan-cleanup] killing stale subagent pid=${pid} (${entry})`);
    // kill 시도마다의 errno 를 남긴다 — EPERM(권한 없는 pid 재사용 등)이면 SIGKILL 을
    // 쏴도 영원히 "살아 있다"로 보여 격리 사유 판정에 필요하다(ralf 2026-10-03 실측).
    const killNotes: string[] = [];
    try {
      process.kill(pid, 'SIGTERM');
    } catch (err: any) {
      killNotes.push(`term:${err?.code ?? 'error'}`);
    }
    const deadline = Date.now() + KILL_BACKUP_DELAY_MS;
    while (isPidAlive(pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, KILL_CONFIRM_DELAY_MS));
    }
    if (isPidAlive(pid)) {
      if (process.platform === 'win32') {
        const treeError = await killTreeWin32(pid);
        if (treeError) killNotes.push(`tree:${treeError}`);
      } else {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (err: any) {
          killNotes.push(`kill:${err?.code ?? 'error'}`);
        }
      }
      const killDeadline = Date.now() + KILL_BACKUP_DELAY_MS;
      while (isPidAlive(pid) && Date.now() < killDeadline) {
        await new Promise((resolve) => setTimeout(resolve, KILL_CONFIRM_DELAY_MS));
      }
    }
    if (isPidAlive(pid)) {
      // 최후 유예 — 죽어가는 중이면 격리 없이 끝낸다.
      await new Promise((resolve) => setTimeout(resolve, KILL_FINAL_GRACE_MS));
    }
    if (isPidAlive(pid)) {
      throw Object.assign(
        new Error(`stale subagent pid=${pid} did not exit; sidecar retained${killNotes.length ? ` (${killNotes.join(', ')})` : ''}`),
        { code: 'EORPHANUNREAPABLE', pid, entry },
      );
    }
  }
  await fsp.unlink(pidPath).catch(() => {});
  await fsp.unlink(cfgPath).catch(() => {});
  return { skipped: false };
}

export interface CleanupResult {
  scanned: number;
  reaped: number;
  skipped?: number;
  failed?: number;
  /** 죽이지 못해 격리한 항목 — 부팅은 계속되고 다음 부팅이 다시 정리한다. */
  failedPids?: { pid: number; entry: string }[];
}

/**
 * Scan SUBAGENTS_BASE_DIR for leftover .pid sidecars and reap each one.
 * Idempotent and safe to call on every manager startup. Never throws —
 * failures are logged and swallowed.
 *
 * 죽이지 못한 항목은 `failedPids` 로 돌려주고 격리 파일에 남긴다 — 호출자가 부팅을
 * 중단하는 대신 격리하고 계속해야 한다(ralf 2026-10-03: 부팅 중단 → 재시작 장치
 * 없음 → 장시간 다운). 이전 부팅의 격리 항목은 여기서 먼저 재처리한다: 죽었으면
 * sidecar 를 지우고 격리 해제, 살아 있으면 새 예산으로 다시 죽인다.
 */
export async function cleanupOrphanSubagents(
  dir: string = SUBAGENTS_BASE_DIR,
  protectLiveSiblings = true,
): Promise<CleanupResult> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return { scanned: 0, reaped: 0, failedPids: [] };
  }
  const pidFiles = entries.filter((e) => e.endsWith('.pid'));
  const pidFileSet = new Set(pidFiles);
  // 이전 격리 항목 재처리 — 죽은 것은 해제, 살아 있는 것은 이번 예산으로 재시도.
  // sidecar 파일이 이미 없으면 pid 죽음만 보고 해제한다.
  const quarantined = await readQuarantine(dir);
  if (pidFiles.length === 0 && quarantined.length === 0) {
    return { scanned: 0, reaped: 0, failedPids: [] };
  }
  // manager lock을 이미 독점한 시작 경로는 같은 home의 live child를 모두
  // orphan으로 봐야 한다. 다른 독립 호출자는 기존 sibling 보호를 유지한다.
  const liveCfgPaths = protectLiveSiblings ? await readLiveCfgPathsFromProc() : null;
  log(
    `[orphan-cleanup] scanning ${pidFiles.length} pid sidecar(s) in ${dir} (live cfg paths in /proc: ${liveCfgPaths ? liveCfgPaths.size : 'unavailable'})`,
  );

  const stillQuarantined: QuarantinedProcess[] = [];
  const retried = new Set<string>();
  for (const q of quarantined) {
    if (!isPidAlive(q.pid)) {
      log(`[orphan-cleanup] quarantine cleared: pid=${q.pid} (${q.entry}) exited on its own`);
      if (pidFileSet.has(q.entry)) {
        await fsp.unlink(join(dir, q.entry)).catch(() => undefined);
        await fsp.unlink(join(dir, q.entry.replace(/\.pid$/, '.json'))).catch(() => undefined);
      }
      continue;
    }
    stillQuarantined.push(q);
    if (pidFileSet.has(q.entry)) retried.add(q.entry);
  }

  let reaped = 0;
  let skipped = 0;
  let failed = 0;
  const failedPids: { pid: number; entry: string }[] = [];
  // 격리 재시도 항목을 먼저 — 이번 부팅의 작업량을 앞에서 확정한다.
  const ordered = [
    ...pidFiles.filter((e) => retried.has(e)),
    ...pidFiles.filter((e) => !retried.has(e)),
  ];
  for (const entry of ordered) {
    try {
      const r = await reapOne(dir, entry, liveCfgPaths);
      if (r.skipped) skipped++;
      else reaped++;
    } catch (err: any) {
      failed++;
      const pid = typeof err?.pid === 'number' ? err.pid : await readPid(join(dir, entry));
      log(`[orphan-cleanup] skipping ${entry}: ${err?.message ?? err}`);
      if (pid != null) {
        failedPids.push({ pid, entry });
        if (!stillQuarantined.some((q) => q.pid === pid && q.entry === entry)) {
          stillQuarantined.push({ pid, entry, reason: String(err?.message ?? err), at: new Date().toISOString() });
        }
      }
    }
  }
  await writeQuarantine(dir, stillQuarantined);
  log(
    `[orphan-cleanup] reaped ${reaped}/${pidFiles.length} orphan subagents (${skipped} protected as live-sibling, ${failed} quarantined)`,
  );
  return { scanned: pidFiles.length, reaped, skipped, failed, failedPids };
}

interface HermesOwnerSidecar {
  pid: number;
  ownerPid: number;
  agentId?: string;
}

/** Reap Hermes ACP process trees whose owning Runtime Host is no longer
 * alive. A live owner pid protects sibling hosts that accidentally share a
 * state directory; a dead owner makes the sidecar authoritative cleanup
 * evidence. */
export async function cleanupOrphanHermesProcesses(
  agentsDir = MANAGED_AGENTS_DIR,
): Promise<CleanupResult> {
  let agentIds: string[];
  try {
    agentIds = await fsp.readdir(agentsDir);
  } catch {
    return { scanned: 0, reaped: 0 };
  }

  let scanned = 0;
  let reaped = 0;
  let skipped = 0;
  for (const agentId of agentIds) {
    const sidecarPath = join(agentsDir, agentId, 'hermes', 'runtime-owner.json');
    let owner: HermesOwnerSidecar;
    try {
      owner = JSON.parse(await fsp.readFile(sidecarPath, 'utf8'));
    } catch {
      continue;
    }
    scanned++;
    if (
      !Number.isInteger(owner.pid)
      || owner.pid <= 0
      || !Number.isInteger(owner.ownerPid)
      || owner.ownerPid <= 0
    ) {
      await fsp.unlink(sidecarPath).catch(() => undefined);
      reaped++;
      continue;
    }
    if (isPidAlive(owner.ownerPid)) {
      skipped++;
      continue;
    }
    if (isPidAlive(owner.pid)) {
      log(`[orphan-cleanup] killing orphan Hermes ACP tree pid=${owner.pid} agent=${agentId}`);
      if (process.platform === 'win32') {
        const { spawn } = await import('node:child_process');
        await new Promise<void>((resolve) => {
          const child = spawn(
            'taskkill',
            ['/PID', String(owner.pid), '/T', '/F'],
            { windowsHide: true, stdio: 'ignore' },
          );
          child.once('error', () => resolve());
          child.once('exit', () => resolve());
        });
      } else {
        try { process.kill(-owner.pid, 'SIGTERM'); } catch { /* already gone */ }
      }
    }
    await fsp.unlink(sidecarPath).catch(() => undefined);
    reaped++;
  }
  return { scanned, reaped, skipped };
}
