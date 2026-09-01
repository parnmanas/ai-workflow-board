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

async function readPid(pidPath: string): Promise<number | null> {
  try {
    const raw = await fsp.readFile(pidPath, 'utf8');
    const pid = parseInt(raw.trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
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
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    const deadline = Date.now() + KILL_BACKUP_DELAY_MS;
    while (isPidAlive(pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, KILL_CONFIRM_DELAY_MS));
    }
    if (isPidAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
      const killDeadline = Date.now() + KILL_BACKUP_DELAY_MS;
      while (isPidAlive(pid) && Date.now() < killDeadline) {
        await new Promise((resolve) => setTimeout(resolve, KILL_CONFIRM_DELAY_MS));
      }
    }
    if (isPidAlive(pid)) {
      throw new Error(`stale subagent pid=${pid} did not exit; sidecar retained`);
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
}

/**
 * Scan SUBAGENTS_BASE_DIR for leftover .pid sidecars and reap each one.
 * Idempotent and safe to call on every manager startup. Never throws —
 * failures are logged and swallowed.
 */
export async function cleanupOrphanSubagents(
  dir: string = SUBAGENTS_BASE_DIR,
  protectLiveSiblings = true,
): Promise<CleanupResult> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return { scanned: 0, reaped: 0 };
  }
  const pidFiles = entries.filter((e) => e.endsWith('.pid'));
  if (pidFiles.length === 0) {
    return { scanned: 0, reaped: 0 };
  }
  // manager lock을 이미 독점한 시작 경로는 같은 home의 live child를 모두
  // orphan으로 봐야 한다. 다른 독립 호출자는 기존 sibling 보호를 유지한다.
  const liveCfgPaths = protectLiveSiblings ? await readLiveCfgPathsFromProc() : null;
  log(
    `[orphan-cleanup] scanning ${pidFiles.length} pid sidecar(s) in ${dir} (live cfg paths in /proc: ${liveCfgPaths ? liveCfgPaths.size : 'unavailable'})`,
  );
  let reaped = 0;
  let skipped = 0;
  let failed = 0;
  for (const entry of pidFiles) {
    try {
      const r = await reapOne(dir, entry, liveCfgPaths);
      if (r.skipped) skipped++;
      else reaped++;
    } catch (err: any) {
      failed++;
      log(`[orphan-cleanup] skipping ${entry}: ${err?.message ?? err}`);
    }
  }
  log(
    `[orphan-cleanup] reaped ${reaped}/${pidFiles.length} orphan subagents (${skipped} protected as live-sibling)`,
  );
  return { scanned: pidFiles.length, reaped, skipped, failed };
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
