// "이 파일을 쥐고 있는 프로세스는 누구인가" — 세션 재개를 막는 잠금의 주인을 찾는다.
//
// 왜 필요한가: codex 는 스레드마다 writer 잠금을 건다(`<CODEX_HOME>/thread-writer-locks/
// <id>.lock`). 그 세션이 터미널이나 Codex 앱에서 열려 있으면 AWB 의 재개가
// `thread … already has an active writer` 로 거절된다. 잠금 파일은 **0바이트**라 안에
// 주인 정보가 없다(실측). 그래서 OS 에 "이 핸들을 누가 열고 있나" 를 직접 물어야 한다.
//
// 이 모듈의 계약:
//   - 절대 throw 하지 않는다. 알아내지 못하면 빈 목록이다("모른다" ≠ "아무도 안 쥐었다").
//   - 죽이지 않는다. 판별만 한다. 종료는 호출자가 정책을 적용한 뒤 `killHolder()` 로 한다.
//
// 분류가 이 모듈의 핵심이다. AWB 가 띄운 ACP 어댑터(`codex-acp` / `claude-agent-acp` /
// `opencode acp`)는 정리해도 잃을 것이 없지만, 운영자의 Codex 데스크톱 앱은 그 앱의
// **다른 대화까지** 함께 내려간다(실측: ralf 의 잠금 주인은 스레드 전용 프로세스가 아니라
// `codex.exe … app-server`, 즉 앱 하나가 모든 스레드를 호스팅하는 공용 백엔드였다).
// 그래서 둘을 절대 같은 것으로 취급하지 않는다.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 판별·종료에 쓰는 상한. 잠금 조회 하나가 세션 열기를 오래 붙잡지 않게 한다. */
const PROBE_TIMEOUT_MS = 8_000;

export type LockHolderKind =
  /** AWB 가 spawn 하는 ACP 어댑터. 정리해도 잃는 것은 그 어댑터 프로세스뿐이다. */
  | 'awb_adapter'
  /** 그 밖의 모든 것(운영자의 Codex 앱, 터미널의 codex, 알 수 없는 프로세스). */
  | 'external';

export interface LockHolder {
  pid: number;
  /** 사람이 읽는 이름(`codex.exe`). */
  name: string;
  /** 판별에 쓴 명령줄 일부. 확인 대화상자가 "무엇을 죽이는지" 보여 주는 근거. */
  command: string;
  kind: LockHolderKind;
}

/**
 * ACP 어댑터로 인정하는 실행 형태. 이 이름들은 이 배포에서 AWB 만 띄운다
 * (`agent-session-runner` 의 `resolveAcpCommandForCli` 가 유일한 spawn 지점).
 *
 * 한계는 정직하게 적어 둔다: 사람이 터미널에서 손수 `codex-acp` 를 실행했다면 이 판별은
 * 그것도 "AWB 것" 으로 본다. 그 경우까지 가리려면 프로세스 계보를 봐야 하는데, 매니저
 * 재시작을 건너뛴 유령 어댑터(이 기능이 노리는 바로 그 경우)는 계보가 이미 끊겨 있어
 * 그 방법으로는 오히려 못 찾는다.
 */
const ADAPTER_PATTERNS: readonly RegExp[] = [
  /\bcodex-acp\b/i,
  /\bclaude-agent-acp\b/i,
  /\bhermes-acp\b/i,
  /\bopencode\b[^\n]*\bacp\b/i,
];

export function classifyHolder(command: string): LockHolderKind {
  return ADAPTER_PATTERNS.some((re) => re.test(command)) ? 'awb_adapter' : 'external';
}

/** 확인 대화상자·오류 문구에 그대로 쓰는 한 줄 요약. */
export function describeHolders(holders: readonly LockHolder[]): string {
  if (!holders.length) return '';
  return holders
    .map((h) => `${h.name} (pid ${h.pid}${h.kind === 'awb_adapter' ? ', AWB 어댑터' : ''})`)
    .join(', ');
}

// ─── Windows ──────────────────────────────────────────────────────────────

/**
 * Restart Manager(`rstrtmgr.dll`)에 묻는다. Windows 에서 "이 파일을 누가 열고 있나" 에
 * 답하는 표준 경로이고, Sysinternals 같은 추가 설치물이 필요 없다. `openfiles` 는 전역
 * 객체 목록 플래그가 켜져 있어야 하고 그 플래그는 재부팅을 요구하므로 쓰지 않는다.
 */
const WINDOWS_HOLDER_SCRIPT = `
$sig = @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class AwbRM {
  [StructLayout(LayoutKind.Sequential)] public struct FILETIME { public uint dwLowDateTime; public uint dwHighDateTime; }
  [StructLayout(LayoutKind.Sequential)] public struct RM_UNIQUE_PROCESS { public int dwProcessId; public FILETIME ProcessStartTime; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public int ApplicationType; public uint AppStatus; public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint h, int flags, string key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint h);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint h, uint nFiles, string[] files, uint nApps, RM_UNIQUE_PROCESS[] apps, uint nSvc, string[] svc);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint h, out uint nProcInfoNeeded, ref uint nProcInfo, [In,Out] RM_PROCESS_INFO[] info, ref uint reason);
  public static List<int> Holders(string path) {
    var res = new List<int>();
    uint h; var key = Guid.NewGuid().ToString();
    if (RmStartSession(out h, 0, key) != 0) return res;
    try {
      if (RmRegisterResources(h, 1, new[]{path}, 0, null, 0, null) != 0) return res;
      uint need = 0, got = 0, reason = 0;
      RmGetList(h, out need, ref got, null, ref reason);
      if (need == 0) return res;
      got = need; var arr = new RM_PROCESS_INFO[need];
      if (RmGetList(h, out need, ref got, arr, ref reason) != 0) return res;
      for (int i = 0; i < got; i++) res.Add(arr[i].Process.dwProcessId);
      return res;
    } finally { RmEndSession(h); }
  }
}
"@
Add-Type -TypeDefinition $sig -Language CSharp | Out-Null
foreach ($p in [AwbRM]::Holders($env:AWB_LOCK_PATH)) {
  $ci = Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue
  if ($ci) { "$p\`t$($ci.Name)\`t$($ci.CommandLine)" }
}
`;

async function windowsHolders(lockPath: string): Promise<LockHolder[]> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_HOLDER_SCRIPT],
    { timeout: PROBE_TIMEOUT_MS, windowsHide: true, env: { ...process.env, AWB_LOCK_PATH: lockPath } },
  );
  return parseHolderLines(stdout);
}

// ─── POSIX ────────────────────────────────────────────────────────────────

async function posixHolders(lockPath: string): Promise<LockHolder[]> {
  // `lsof -t` 는 pid 만 준다. 이름·명령줄은 ps 로 따로 읽는다.
  const { stdout } = await execFileAsync('lsof', ['-t', '--', lockPath], {
    timeout: PROBE_TIMEOUT_MS,
  });
  const pids = stdout.split('\n').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  const out: LockHolder[] = [];
  for (const pid of [...new Set(pids)]) {
    let command = '';
    try {
      const ps = await execFileAsync('ps', ['-o', 'command=', '-p', String(pid)], { timeout: PROBE_TIMEOUT_MS });
      command = ps.stdout.trim();
    } catch {
      /* 프로세스가 그 사이 사라졌다 — 이름 없이 둔다. */
    }
    out.push({ pid, name: command.split(/\s+/)[0] || `pid ${pid}`, command, kind: classifyHolder(command) });
  }
  return out;
}

/** `pid\tname\tcommand` 줄을 파싱한다(Windows 경로). 테스트가 직접 부른다. */
export function parseHolderLines(stdout: string): LockHolder[] {
  const out: LockHolder[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const pid = Number(parts[0].trim());
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const name = parts[1].trim();
    const command = (parts[2] ?? '').trim();
    out.push({ pid, name: name || `pid ${pid}`, command, kind: classifyHolder(command || name) });
  }
  return out;
}

// ─── 공개 API ─────────────────────────────────────────────────────────────

export interface LockHolderDeps {
  /** 테스트 seam. 기본은 플랫폼별 실제 조회. */
  probe?: (lockPath: string) => Promise<LockHolder[]>;
  log?: (msg: string) => void;
}

/**
 * 잠금 파일을 쥔 프로세스들. 알아내지 못하면 빈 배열이다 — 그 경우 호출자는
 * "주인을 모른다" 로 처리해야지 "아무도 없다" 로 단정하면 안 된다.
 */
export async function findLockHolders(
  lockPath: string,
  deps: LockHolderDeps = {},
): Promise<LockHolder[]> {
  const probe = deps.probe ?? (process.platform === 'win32' ? windowsHolders : posixHolders);
  try {
    return await probe(lockPath);
  } catch (err: any) {
    deps.log?.(`[lock-holders] probe failed for ${lockPath}: ${err?.message ?? err}`);
    return [];
  }
}

/**
 * 어떤 주인을 종료할 것인가 — 이 기능의 정책이 여기 한 곳에 있다.
 *
 *   - AWB 가 띄운 ACP 어댑터는 확인 없이 정리한다. 잃는 것은 그 어댑터 프로세스뿐이고,
 *     매니저 재시작 뒤 남은 고아가 잠금을 계속 쥐는 것이 가장 흔한 경우다.
 *   - 그 밖의 프로세스는 `force` 로 명시할 때만 대상이 된다. 화면이 이름·PID 를 보여 주고
 *     확인을 받은 뒤에만 그 플래그가 켜진다.
 *   - 매니저 자신은 어떤 경우에도 대상이 아니다. 스스로를 죽여 잠금을 푸는 것은 회복이 아니다.
 */
export function selectKillTargets(
  holders: readonly LockHolder[],
  opts: { force?: boolean; selfPid?: number } = {},
): LockHolder[] {
  const selfPid = opts.selfPid ?? process.pid;
  return holders.filter((h) => h.pid !== selfPid && (h.kind === 'awb_adapter' || opts.force === true));
}

/** pid 하나를 종료한다. 이미 없어졌으면 성공으로 본다(목표는 "잠금이 풀리는 것"). */
export function killHolder(pid: number, log?: (msg: string) => void): boolean {
  try {
    process.kill(pid, 'SIGKILL');
    return true;
  } catch (err: any) {
    if (err?.code === 'ESRCH') return true;
    log?.(`[lock-holders] kill ${pid} failed: ${err?.message ?? err}`);
    return false;
  }
}
