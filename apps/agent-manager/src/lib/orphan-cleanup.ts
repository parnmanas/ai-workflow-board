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
import { SUBAGENTS_BASE_DIR } from './constants.js';
import { log } from './logging.js';

const KILL_BACKUP_DELAY_MS = 2000;

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
    const t = setTimeout(() => {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }, KILL_BACKUP_DELAY_MS);
    if (typeof t.unref === 'function') t.unref();
  }
  await fsp.unlink(pidPath).catch(() => {});
  await fsp.unlink(cfgPath).catch(() => {});
  return { skipped: false };
}

export interface CleanupResult {
  scanned: number;
  reaped: number;
  skipped?: number;
}

/**
 * Scan SUBAGENTS_BASE_DIR for leftover .pid sidecars and reap each one.
 * Idempotent and safe to call on every manager startup. Never throws —
 * failures are logged and swallowed.
 */
export async function cleanupOrphanSubagents(): Promise<CleanupResult> {
  let entries: string[];
  try {
    entries = await fsp.readdir(SUBAGENTS_BASE_DIR);
  } catch {
    return { scanned: 0, reaped: 0 };
  }
  const pidFiles = entries.filter((e) => e.endsWith('.pid'));
  if (pidFiles.length === 0) {
    return { scanned: 0, reaped: 0 };
  }
  const liveCfgPaths = await readLiveCfgPathsFromProc();
  log(
    `[orphan-cleanup] scanning ${pidFiles.length} pid sidecar(s) in ${SUBAGENTS_BASE_DIR} (live cfg paths in /proc: ${liveCfgPaths ? liveCfgPaths.size : 'unavailable'})`,
  );
  let reaped = 0;
  let skipped = 0;
  for (const entry of pidFiles) {
    try {
      const r = await reapOne(SUBAGENTS_BASE_DIR, entry, liveCfgPaths);
      if (r.skipped) skipped++;
      else reaped++;
    } catch (err: any) {
      log(`[orphan-cleanup] skipping ${entry}: ${err?.message ?? err}`);
    }
  }
  log(
    `[orphan-cleanup] reaped ${reaped}/${pidFiles.length} orphan subagents (${skipped} protected as live-sibling)`,
  );
  return { scanned: pidFiles.length, reaped, skipped };
}
