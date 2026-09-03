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

import { hostPlatform, runCommand, runPowerShell, type RunResult } from './host-mcp/platform.js';
import { log } from './logging.js';

export interface ProcNode {
  pid: number;
  ppid: number;
  /** POSIX process-group id. Only populated by the `*WithGroup` parser (the
   *  one-shot exit path keys on it); undefined on the ppid-only parsers used by
   *  the persistent sweep. */
  pgid?: number;
  /** Process-state token from `ps -o stat=` (e.g. 'S', 'Ss', 'R+', 'Z'). Only
   *  the `*WithGroup` parser populates it — the one-shot pid-reuse guard
   *  (isGroupLeaderReused) needs it to tell a still-unreaped zombie leader
   *  ('Z', ours) from a LIVE leader (pid reused by an unrelated group).
   *  undefined on the ppid-only parsers. */
  state?: string;
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
export const BENIGN_CMD_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bmcp-host\b/,
  // Windows attaches a console host to CLI processes. It is infrastructure,
  // not work left running by the agent; counting it as a background task
  // makes an idle session look alive forever and triggers a process scan every
  // idleRecheckSeconds (60s by default).
  /(?:^|[\\/])conhost\.exe(?:\s|$)/i,
]);

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
      "Select-Object ProcessId,ParentProcessId,@{Name='CommandLine';Expression={if ($_.CommandLine) {$_.CommandLine} else {$_.Name}}} | " +
      'ConvertTo-Json -Compress';
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

/** Parse `ps -A -ww -o pid=,ppid=,pgid=,stat=,args=` output into ProcNodes
 *  carrying `pgid` and the process-`state` token. `stat` is a single no-space
 *  field (e.g. 'Ss', 'R+', 'Z'), so it's captured with `\S+` before the free-form
 *  args. Lines that don't start with `<pid> <ppid> <pgid> <stat> ` are skipped.
 *  Pure — unit-tested. */
export function parseProcListUnixWithGroup(stdout: string): ProcNode[] {
  const out: ProcNode[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), state: m[4], cmd: m[5] });
  }
  return out;
}

/** pid-reuse guard for the one-shot group sweep. A process-group leader has
 *  `pid == pgid`. Our one-shot leader is a DEAD CLI, so its group-id (== the pid
 *  we key on) must have NO live leader: the leader row is either gone (already
 *  reaped) or a lingering zombie ('Z', parent hasn't `wait()`ed yet) — both
 *  still "ours". If instead a LIVE, non-zombie process now holds `pid == pgid`,
 *  the OS reused that pid for an UNRELATED detached group leader between the
 *  leader's death and this scan; the members keyed on this pgid are that group's,
 *  not our orphans, so the caller must abort the sweep. Absent leader → not
 *  reused (proceed). Present-but-unparseable state → treated as reused (abort),
 *  the safe direction: a missed sweep falls back to the ~45-min liveness reaper,
 *  strictly less harmful than a mis-reap of an unrelated run. Pure — unit-tested. */
export function isGroupLeaderReused(all: ProcNode[], pgid: number): boolean {
  const leader = all.find((p) => p.pid === pgid);
  if (!leader) return false; // reaped — our dead leader, safe to sweep
  return (leader.state ?? '')[0] !== 'Z'; // zombie → ours; live/unknown → reused
}

/** Live members of process group `pgid`, EXCLUDING the group leader (pid ==
 *  pgid — the now-dead CLI) and every benign process together with its subtree
 *  (a benign node's descendants are pruned via ppid among the group members,
 *  mirroring collectNonBenignDescendants so the mcp-host child and its transient
 *  shell-outs are never reaped). Unlike the ppid walk, membership is keyed on
 *  pgid so an orphan reparented to init when the leader exited is still found.
 *  Returns [] when the leader's pid was reused (isGroupLeaderReused) — the group
 *  isn't ours. Pure — unit-tested. */
export function collectNonBenignGroupMembers(
  all: ProcNode[],
  pgid: number,
  patterns: readonly RegExp[] = BENIGN_CMD_PATTERNS,
): ProcNode[] {
  // pid-reuse window (ticket 7b5f2572): if the dead leader's pid is now held by
  // a LIVE process, the pid was reused for an unrelated detached group — abort
  // so we don't mis-reap it / falsely error a stranger's run.
  if (isGroupLeaderReused(all, pgid)) return [];
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
 *  is its own pgid). The `stat` column is requested so collectNonBenignGroupMembers
 *  can run its pid-reuse guard (abort if a live leader now holds our old pid).
 *  Returns [] on win32 (no detached groups) and on any enumeration failure —
 *  availability-first, exactly like listAllProcesses. */
export async function findLiveGroupBackgroundTasks(
  pgid: number,
  patterns: readonly RegExp[] = BENIGN_CMD_PATTERNS,
): Promise<ProcNode[]> {
  if (hostPlatform() === 'win32') return [];
  const res = await runCommand('ps', ['-A', '-ww', '-o', 'pid=,ppid=,pgid=,stat=,args='], { timeoutMs: 15_000 });
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

// Every call site here is on a path its caller `await`s for a real result
// (reaped pids, drained tree) — unref'ing this timer let the grace period go
// unfulfilled whenever it was the last thing holding the event loop open
// (observed as Node's test runner reporting "Promise resolution is still
// pending but the event loop has already resolved" for the awaiting
// terminateDetachedProcessTree() caller). Keep it ref'd so the wait is
// deterministic; the explicit SIGTERM/SIGINT shutdown path in main.ts is
// what bounds overall shutdown time, not this timer.
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
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

/** 자식 프로세스 핸들에서 "아직 살아 있는가" 만 읽어 가는 최소 계약.
 *  `ChildProcess` 가 구조적으로 이 모양을 만족하므로 호출부는 핸들을 그대로
 *  넘기면 되고, 테스트는 가벼운 스텁을 넘길 수 있다. */
export interface ExitObservableChild {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
}

/** 핸들이 이미 종료를 보고했는가. exitCode 는 정상 종료, signalCode 는 시그널
 *  종료에서 채워지므로 둘 다 봐야 한다. */
export function childHasExited(child: ExitObservableChild): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export interface TerminateTreeOptions {
  /** 이 pid 를 만들어 낸 자식 프로세스 핸들. **win32 에서만** 쓰인다.
   *
   *  Windows 는 프로세스 그룹이 없어 tree-kill 의 유일한 키가 pid 인데, pid 는
   *  종료 즉시 OS 가 재사용한다. 즉 자식이 죽은 뒤의 `taskkill /PID <pid>` 는
   *  "우리 트리"가 아니라 그 pid 를 물려받은 **남의 프로세스**를 죽일 수 있다.
   *  pid 와 달리 ChildProcess 핸들은 재사용되지 않으므로, 재사용에 안전한
   *  판정은 이 핸들뿐이다(POSIX 의 `isGroupLeaderReused` 에 대응하는 win32 측
   *  가드가 여태 없었다 — ticket a992ce71).
   *
   *  넘기지 않으면 종전 그대로 pid 만 믿는 best-effort 경로로 동작한다. */
  child?: ExitObservableChild;
}

/** taskkill 한 번의 결과를 로그에 남긴다. 남기는 값은 pid·pass·종료코드와
 *  taskkill 자신의 짧은 메시지뿐 — 경로나 자격증명은 싣지 않는다. */
function logTaskkill(pass: 'soft' | 'force', rootPid: number, res: RunResult): void {
  const detail = res.spawnFailed
    ? `spawnFailed=${res.spawnError}`
    : `code=${res.code}${res.stderr.trim() ? ` stderr=${oneLine(res.stderr)}` : ''}`;
  log(`[process-tree] win32 taskkill ${pass} pid=${rootPid} ${detail}`);
}

function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** win32 전용 tree-kill. `deps` 는 테스트 이음매다 — process-tree.ts 는
 *  `hostPlatform`/`runCommand` 를 정적 import 하므로, 이걸 주입할 수 없으면
 *  리눅스에서 이 분기를 한 줄도 태울 수 없다. */
export async function terminateWindowsProcessTree(
  rootPid: number,
  graceMs: number,
  options: TerminateTreeOptions & {
    run?: typeof runCommand;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const run = options.run ?? runCommand;
  const sleep = options.sleep ?? delay;
  const child = options.child;

  // 이미 죽은 자식의 pid 로는 아무것도 죽여선 안 된다 — 그 pid 는 이미 남의
  // 것일 수 있다. 죽은 자식의 손자를 못 거두는 손해보다 무고한 프로세스를
  // 죽이는 손해가 크다(후자는 형제 테스트 파일이 출력 한 줄 없이 exit 1 로
  // 죽는 CI flake 로 나타났다).
  if (child && childHasExited(child)) {
    log(`[process-tree] win32 tree-kill skipped: pid=${rootPid} already exited (pid may be recycled)`);
    return;
  }

  logTaskkill('soft', rootPid, await run('taskkill', ['/PID', String(rootPid), '/T'], { timeoutMs: 10_000 }));
  await sleep(graceMs);

  // grace 동안 자식이 끝났으면 force 패스를 쏘지 않는다. 이 창(hermes 250ms,
  // runtime-profiles 5000ms)이 pid 재사용이 실제로 일어나는 구간이고, `/F` 는
  // soft 패스와 달리 콘솔 프로세스도 확실히 죽인다.
  if (child && childHasExited(child)) {
    log(`[process-tree] win32 force tree-kill skipped: pid=${rootPid} exited during the ${graceMs}ms grace`);
    return;
  }

  logTaskkill('force', rootPid, await run('taskkill', ['/PID', String(rootPid), '/T', '/F'], { timeoutMs: 10_000 }));
}

/**
 * Drain a detached runtime and its complete process tree.  POSIX runtimes are
 * spawned as process-group leaders, so group signalling remains valid after
 * the leader exits and its children are reparented.  Windows uses taskkill's
 * native tree traversal.
 *
 * `options.child` 는 win32 분기의 pid 재사용 가드에만 쓰인다. POSIX 는 죽은
 * 리더의 pgid 가 여전히 유효한 키이고(리페어런팅돼도 그룹은 남는다) 재사용
 * 가드도 `isGroupLeaderReused` 로 이미 있으므로, 여기서 핸들로 조기 반환하면
 * ticket 55d3063f/7b5f2572 가 세운 그룹 스윕을 오히려 되돌린다 — 그래서 POSIX
 * 경로는 핸들을 보지 않는다.
 */
export async function terminateDetachedProcessTree(
  rootPid: number,
  graceMs = 5000,
  options: TerminateTreeOptions = {},
): Promise<void> {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return;
  if (hostPlatform() === 'win32') {
    await terminateWindowsProcessTree(rootPid, graceMs, { child: options.child });
    return;
  }

  try { process.kill(-rootPid, 'SIGTERM'); } catch { /* group already gone */ }
  await delay(graceMs);

  // Do not key completion on the leader: it may have obeyed SIGTERM while a
  // grandchild ignored it. The process group survives reparenting.
  const survivors = await findLiveGroupBackgroundTasks(rootPid, []);
  try { process.kill(-rootPid, 'SIGKILL'); } catch { /* group raced to exit */ }
  if (survivors.length > 0) {
    for (const survivor of survivors) {
      if (!isPidAlive(survivor.pid)) continue;
      try { process.kill(survivor.pid, 'SIGKILL'); } catch { /* raced to exit */ }
    }
    await delay(100);
  }
}
