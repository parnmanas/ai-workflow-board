// Cross-platform descendant-process enumeration + reap.
//
// Why this exists (ticket 89716f04): a QA/security run is a one-shot session
// with no re-invocation contract. When that session ends its turn while a
// live background task (a child process the agent spawned — e.g. a build
// monitor) is still running, the CLI's positive-pid teardown kills the whole
// tree with no record, and the run is stranded in `running` until the ~45-min
// liveness reaper finally sweeps it. The chat session manager uses this module
// to detect those live descendants at turn end, kill them VISIBLY, and
// finalize the run as `error` immediately instead.
//
// No such utility existed before: orphan-cleanup.ts matches /proc cmdlines
// (Linux-only) and host-mcp/tools.ts lists processes flat without a tree walk.
// The parsing + tree-walk here are pure functions so they can be unit-tested
// against synthetic process tables; the enumerate/reap edges shell out.

import { hostPlatform, runCommand, runPowerShell } from './host-mcp/platform.js';
import { log } from './logging.js';

export interface ProcNode {
  pid: number;
  ppid: number;
  /** POSIX process-group id. Only populated by the `*WithGroup` parser (the
   *  one-shot exit path keys on it); undefined on the ppid-only parsers used by
   *  the persistent sweep. */
  pgid?: number;
  /** Full command line (best-effort). Used both to identify benign machinery
   *  and to describe the orphan in logs / the run summary. */
  cmd: string;
}

/** Command-line markers for processes that are part of a managed-agent CLI's
 *  OWN benign machinery and must never be treated as orphaned background
 *  tasks. The host-mcp stdio server — spawned by every managed-agent CLI as
 *  `<self> mcp-host` (see managed-agent-store.ts#writeMcpConfig) — is the one
 *  always-present benign child. A benign node's ENTIRE subtree is pruned
 *  (collectNonBenignDescendants), so the host server's own transient
 *  shell-outs (screenshots, log scans) are excluded with it. Exported +
 *  overridable so a follow-up can extend the denylist without touching logic. */
export const BENIGN_CMD_PATTERNS: readonly RegExp[] = Object.freeze([/\bmcp-host\b/]);

export function isBenignCmd(cmd: string, patterns: readonly RegExp[] = BENIGN_CMD_PATTERNS): boolean {
  return patterns.some((re) => re.test(cmd));
}

/** Parse `ps -A -ww -o pid=,ppid=,args=` output into flat ProcNodes. Lines
 *  that don't start with `<pid> <ppid> ` are skipped. Pure — unit-tested. */
export function parseProcListUnix(stdout: string): ProcNode[] {
  const out: ProcNode[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] });
  }
  return out;
}

/** Parse `Get-CimInstance Win32_Process | ConvertTo-Json` output into flat
 *  ProcNodes. Handles the single-object (not array) shape ConvertTo-Json emits
 *  for one row, and a null CommandLine. Pure — unit-tested. */
export function parseProcListWin(jsonText: string): ProcNode[] {
  let parsed: any;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : parsed == null ? [] : [parsed];
  const out: ProcNode[] = [];
  for (const r of rows) {
    const pid = Number(r?.ProcessId);
    if (!Number.isFinite(pid)) continue;
    const ppid = Number(r?.ParentProcessId);
    out.push({ pid, ppid: Number.isFinite(ppid) ? ppid : 0, cmd: String(r?.CommandLine ?? '') });
  }
  return out;
}

/** Walk the ppid graph from `rootPid` and return every live descendant,
 *  EXCLUDING any process whose command line is benign and everything beneath
 *  it (a benign node's whole subtree is pruned). `rootPid` itself is never
 *  included. A `seen` set guards against ppid cycles / pid reuse so a malformed
 *  table can't spin the walk forever. Pure — unit-tested. */
export function collectNonBenignDescendants(
  all: ProcNode[],
  rootPid: number,
  patterns: readonly RegExp[] = BENIGN_CMD_PATTERNS,
): ProcNode[] {
  const byParent = new Map<number, ProcNode[]>();
  for (const p of all) {
    const arr = byParent.get(p.ppid);
    if (arr) arr.push(p);
    else byParent.set(p.ppid, [p]);
  }
  const out: ProcNode[] = [];
  const seen = new Set<number>([rootPid]);
  const stack: number[] = [rootPid];
  while (stack.length) {
    const cur = stack.pop() as number;
    for (const child of byParent.get(cur) || []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      // Benign node → skip it AND don't descend into it (subtree pruned).
      if (isBenignCmd(child.cmd, patterns)) continue;
      out.push(child);
      stack.push(child.pid);
    }
  }
  return out;
}

/** Enumerate every live process on the host as a flat ProcNode list. Returns
 *  [] on any failure — availability-first: a broken enumeration must never
 *  crash a turn-end sweep. */
export async function listAllProcesses(): Promise<ProcNode[]> {
  if (hostPlatform() === 'win32') {
    const script =
      'Get-CimInstance Win32_Process | ' +
      'Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress';
    const res = await runPowerShell(script, { timeoutMs: 15_000 });
    if (res.spawnFailed || res.code !== 0) return [];
    return parseProcListWin(res.stdout);
  }
  const res = await runCommand('ps', ['-A', '-ww', '-o', 'pid=,ppid=,args='], { timeoutMs: 15_000 });
  if (res.spawnFailed || res.code !== 0) return [];
  return parseProcListUnix(res.stdout);
}

/** Enumerate + tree-walk: the live non-benign descendants of `rootPid`. */
export async function findLiveBackgroundTasks(
  rootPid: number,
  patterns: readonly RegExp[] = BENIGN_CMD_PATTERNS,
): Promise<ProcNode[]> {
  const all = await listAllProcesses();
  if (all.length === 0) return [];
  return collectNonBenignDescendants(all, rootPid, patterns);
}

// -- POSIX process-group enumeration (ticket 55d3063f) ------------------------
//
// The ppid tree-walk above only works while the root (the CLI child) is STILL
// ALIVE — the persistent chat session sweeps its turn end ~4s after the result
// line, before the CLI tears down, so `findLiveBackgroundTasks(sess.pid)` sees
// a live parent. The one-shot subagent path (codex / antigravity, or a declined
// persistent-chat fallback) has NO such pre-kill window: the CLI self-exits when
// its turn ends, so by the time our exit handler runs, `rootPid` is dead and any
// background task it spawned has been reparented to init — a ppid walk from the
// dead pid finds nothing. The one-shot child is spawned `detached` on POSIX
// (subagent-manager spawn), which makes it a process-group LEADER (pgid == pid);
// a descendant that didn't `setsid` itself keeps that pgid even after reparent.
// So the one-shot exit path keys on pgid, not ppid, to stay reparent-robust.
// Windows has no detached process groups (detached is off there), so this
// returns [] on win32 — the one-shot Windows orphan case is out of scope.

/** Parse `ps -A -ww -o pid=,ppid=,pgid=,args=` output into ProcNodes carrying
 *  `pgid`. Lines that don't start with `<pid> <ppid> <pgid> ` are skipped.
 *  Pure — unit-tested. */
export function parseProcListUnixWithGroup(stdout: string): ProcNode[] {
  const out: ProcNode[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), cmd: m[4] });
  }
  return out;
}

/** Live members of process group `pgid`, EXCLUDING the group leader (pid ==
 *  pgid — the now-dead CLI) and every benign process together with its subtree
 *  (a benign node's descendants are pruned via ppid among the group members,
 *  mirroring collectNonBenignDescendants so the mcp-host child and its transient
 *  shell-outs are never reaped). Unlike the ppid walk, membership is keyed on
 *  pgid so an orphan reparented to init when the leader exited is still found.
 *  Pure — unit-tested. */
export function collectNonBenignGroupMembers(
  all: ProcNode[],
  pgid: number,
  patterns: readonly RegExp[] = BENIGN_CMD_PATTERNS,
): ProcNode[] {
  const members = all.filter((p) => p.pgid === pgid && p.pid !== pgid);
  if (members.length === 0) return [];
  const byParent = new Map<number, ProcNode[]>();
  for (const p of members) {
    const arr = byParent.get(p.ppid);
    if (arr) arr.push(p);
    else byParent.set(p.ppid, [p]);
  }
  // Mark every benign member and its (in-group) subtree for exclusion.
  const excluded = new Set<number>();
  for (const p of members) {
    if (excluded.has(p.pid) || !isBenignCmd(p.cmd, patterns)) continue;
    const stack = [p.pid];
    excluded.add(p.pid);
    while (stack.length) {
      const cur = stack.pop() as number;
      for (const child of byParent.get(cur) || []) {
        if (excluded.has(child.pid)) continue;
        excluded.add(child.pid);
        stack.push(child.pid);
      }
    }
  }
  return members.filter((p) => !excluded.has(p.pid));
}

/** Enumerate the live non-benign members of the process group led by `pgid`
 *  (POSIX only — the one-shot exit path passes the detached child's pid, which
 *  is its own pgid). Returns [] on win32 (no detached groups) and on any
 *  enumeration failure — availability-first, exactly like listAllProcesses. */
export async function findLiveGroupBackgroundTasks(
  pgid: number,
  patterns: readonly RegExp[] = BENIGN_CMD_PATTERNS,
): Promise<ProcNode[]> {
  if (hostPlatform() === 'win32') return [];
  const res = await runCommand('ps', ['-A', '-ww', '-o', 'pid=,ppid=,pgid=,args='], { timeoutMs: 15_000 });
  if (res.spawnFailed || res.code !== 0) return [];
  const all = parseProcListUnixWithGroup(res.stdout);
  if (all.length === 0) return [];
  return collectNonBenignGroupMembers(all, pgid, patterns);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/** Best-effort kill of the given pids. The caller passes the FULL transitive
 *  non-benign descendant set (collectNonBenignDescendants already flattens the
 *  subtree), so every process is signalled by pid explicitly — reparent-to-init
 *  on a parent's death can't let a child escape. POSIX: SIGTERM, `graceMs`
 *  grace, then SIGKILL survivors. Windows: `taskkill /T /F` per pid (tree kill
 *  also mops up anything spawned between enumeration and the kill). Never
 *  throws; returns the pids that accepted the initial signal. */
export async function reapProcessTrees(pids: number[], graceMs = 2000): Promise<number[]> {
  if (pids.length === 0) return [];
  if (hostPlatform() === 'win32') {
    const killed: number[] = [];
    for (const pid of pids) {
      const res = await runCommand('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 10_000 });
      if (!res.spawnFailed && res.code === 0) killed.push(pid);
    }
    return killed;
  }
  const signalled: number[] = [];
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
      signalled.push(pid);
    } catch {
      /* already gone / no permission */
    }
  }
  await delay(graceMs);
  for (const pid of pids) {
    if (isPidAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* raced to exit */
      }
    }
  }
  if (signalled.length) {
    log(`[process-tree] reaped ${signalled.length}/${pids.length} background task(s): pids=${pids.join(',')}`);
  }
  return signalled;
}
