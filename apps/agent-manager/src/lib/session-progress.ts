// Shared "is this session making progress" gate for BaseSessionManager's idle
// reaper (ticket 6ff827cb).
//
// Governing principle (reporter decision, 2026-08-21): a timer expiring means
// CHECK, not KILL. Killing a session is justified only by the ABSENCE of
// progress evidence — clock elapsed alone is never evidence. Three
// independent signals are checked; any ONE being fresh counts as "alive":
//
//   1. model output   — sess._lastOutputAtMs, updated unconditionally by
//      #wireStdio on every parsed stdout line carrying a stage/result.
//   2. background tasks — live non-benign descendant processes of the CLI
//      child (findLiveBackgroundTasks). Catches long build/test children the
//      agent spawned and is waiting on.
//   3. cli-home activity — newest mtime under THIS SESSION's own subtree of
//      the per-agent CLI home directory. This is the ONLY observable signal
//      for an in-process Workflow/subagent tool call: it runs in the SAME OS
//      process as the parent turn, so it produces neither new stdout (the
//      parent turn is blocked awaiting the tool call) nor a child process
//      (signal 2 sees nothing) — but it DOES keep writing transcript files
//      under cli-home. This was the exact blind spot in the incident that
//      opened this ticket: a dead session's subagents/workflows/<id>/
//      agent-*.jsonl files kept growing until the moment stdin was closed,
//      while zero processes and zero stdout lines proved it.
//
//      ticket 6ff827cb round-1 review (P1) — signal 3 originally scanned
//      the WHOLE per-agent cli-home root, which every chat/ticket session of
//      that agent shares. Claude Code nests each cwd's own state under
//      `<cliHomeDir>/projects/<dash-encoded-cwd>/` (its own convention, see
//      encodeProjectDirName below), so scanning the root meant a busy
//      session B in a different ticket/room kept an actually-idle session A
//      "fresh" forever — a real resource-leak regression, not just noise.
//      Scoping the scan to THIS session's own cwd subtree (every managed
//      chat/ticket session gets its own dedicated workspace folder, so two
//      sessions of the same agent normally have two different cwds) fixes
//      the cross-session false positive while still covering the exact
//      subagents/workflows/<id>/ files that motivated signal 3 — they nest
//      under the same cwd subtree, not outside it.
//
// A session with none of the three signals fresh is NOT necessarily dead
// (see gap 3 in the ticket — a pure external wait has no observable
// evidence either) — that case is covered by the separate explicit
// keep-alive declaration (mcp__awb__keep_chat_session_alive), not by this
// module.

import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { findLiveBackgroundTasks } from './process-tree.js';
import { log } from './logging.js';

export interface ProgressCheckResult {
  alive: boolean;
  reasons: string[];
  /** ticket e18be8ff — live background descendant count from this same
   *  signal-2 scan, exposed as a number (not just folded into `reasons`) so
   *  callers can surface it verbatim in a status badge without re-parsing a
   *  human-readable string. 0 when the scan failed or found none. */
  backgroundTaskCount: number;
}

export interface ProgressCheckOptions {
  pid: number;
  /** Per-agent CLI home directory (agentContext.cli_home_dir at spawn time).
   *  Signal 3 is skipped when unset (legacy / operator-direct sessions with
   *  no managed cli-home) — the gate degrades to signals 1+2 only. */
  cliHomeDir?: string | null;
  /** The cwd this session's CLI was actually spawned with — REQUIRED to
   *  scope signal 3 to this session alone (see encodeProjectDirName).
   *  Signal 3 is skipped (not widened back to the whole cli-home) when this
   *  is unset, same posture as a missing cliHomeDir. */
  cwd?: string | null;
  /** How recent a signal must be to count as "fresh". Callers pass the
   *  configured idle window so "was there activity in the last idle period"
   *  is the single freshness definition shared by every caller. */
  freshMs: number;
}

/** Claude Code's own `~/.claude/projects/<dir>/` naming convention: every
 *  character outside `[A-Za-z0-9]` in the absolute cwd becomes `-` (no
 *  collapsing of consecutive dashes). Exported for unit testing against
 *  known cwd → directory-name pairs — this is an external CLI convention,
 *  not something AWB defines, so a test pins it against drift. */
export function encodeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Resolve the session-scoped subtree for signal 3, or null when it can't be
 *  scoped (missing cliHomeDir or cwd) — callers must SKIP the signal in
 *  that case rather than fall back to scanning the whole cli-home root,
 *  which is the exact cross-session false-positive this fixes. */
function sessionScopedScanRoot(
  cliHomeDir: string | null | undefined,
  cwd: string | null | undefined,
): string | null {
  if (!cliHomeDir || !cwd) return null;
  return join(cliHomeDir, 'projects', encodeProjectDirName(cwd));
}

const MTIME_SCAN_MAX_ENTRIES = 2000;
const MTIME_SCAN_MAX_DEPTH = 8;

/** Bounded recursive scan for the freshest file mtime under `rootDir`.
 *  Best-effort — returns null on any error (missing dir, permission, races)
 *  rather than throwing, matching process-tree.ts's availability-first
 *  posture ("never crash a turn-end sweep"). Caps total entries visited so a
 *  large cli-home directory can't turn a periodic idle-check into a slow
 *  scan; a per-agent cli-home is config/session/cache data, not a full repo
 *  checkout, so this cap is generous in practice. Exported for unit testing
 *  against a synthetic directory tree. */
export async function newestMtimeUnder(
  rootDir: string | null | undefined,
  { maxEntries = MTIME_SCAN_MAX_ENTRIES, maxDepth = MTIME_SCAN_MAX_DEPTH }: { maxEntries?: number; maxDepth?: number } = {},
): Promise<number | null> {
  if (!rootDir) return null;
  let newest: number | null = null;
  let visited = 0;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];
  while (stack.length > 0 && visited < maxEntries) {
    const top = stack.pop() as { dir: string; depth: number };
    let entries;
    try {
      entries = await fsp.readdir(top.dir, { withFileTypes: true });
    } catch {
      continue; // missing / no permission / raced deletion — best-effort
    }
    for (const entry of entries) {
      if (visited >= maxEntries) break;
      visited++;
      const full = join(top.dir, entry.name);
      if (entry.isDirectory()) {
        if (top.depth < maxDepth) stack.push({ dir: full, depth: top.depth + 1 });
        continue;
      }
      try {
        const st = await fsp.stat(full);
        if (newest === null || st.mtimeMs > newest) newest = st.mtimeMs;
      } catch {
        /* raced deletion between readdir and stat — ignore */
      }
    }
  }
  return newest;
}

/**
 * Evaluate the 3-signal progress gate. `lastOutputAtMs` is passed in
 * separately (rather than read off a SessionRecord) so this module stays
 * decoupled from BaseSessionManager's types — the caller owns the field.
 */
export async function checkSessionProgress(
  opts: ProgressCheckOptions,
  lastOutputAtMs: number | null | undefined,
): Promise<ProgressCheckResult> {
  const now = Date.now();
  const reasons: string[] = [];

  if (lastOutputAtMs && now - lastOutputAtMs < opts.freshMs) {
    reasons.push(`model output ${Math.round((now - lastOutputAtMs) / 1000)}s ago`);
  }

  const scanRoot = sessionScopedScanRoot(opts.cliHomeDir, opts.cwd);
  const [bgResult, mtimeResult] = await Promise.allSettled([
    findLiveBackgroundTasks(opts.pid),
    scanRoot ? newestMtimeUnder(scanRoot) : Promise.resolve(null),
  ]);

  let backgroundTaskCount = 0;
  if (bgResult.status === 'fulfilled') {
    backgroundTaskCount = bgResult.value.length;
    if (backgroundTaskCount > 0) {
      reasons.push(`${backgroundTaskCount} live background task(s)`);
    }
  } else {
    log(`[session-progress] background task check failed pid=${opts.pid}: ${bgResult.reason?.message ?? bgResult.reason}`);
  }

  if (mtimeResult.status === 'fulfilled') {
    const mtime = mtimeResult.value;
    if (mtime && now - mtime < opts.freshMs) {
      reasons.push(`cli-home activity ${Math.round((now - mtime) / 1000)}s ago`);
    }
  } else {
    log(`[session-progress] cli-home mtime check failed dir=${scanRoot}: ${mtimeResult.reason?.message ?? mtimeResult.reason}`);
  }

  return { alive: reasons.length > 0, reasons, backgroundTaskCount };
}
