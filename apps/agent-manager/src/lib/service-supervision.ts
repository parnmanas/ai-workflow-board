// 이 매니저를 띄우는 **서비스**(macOS launchd 작업 · Windows 예약 작업)를 찾고, 재기동을 그
// 서비스에 맡기는 명령을 만든다. systemd 는 supervisor.ts 가 따로 본다(부모 프로세스 판정).
//
// 왜 필요한가 — 재기동이 서비스 밖에서 프로세스를 띄우면 생기는 일(2026-10-22 ~ 11-09 실측):
//   - MacBook.VX: 업데이트 재기동이 분리(detached) 자식으로 새 매니저를 띄웠다. launchd 작업의
//     프로세스는 `--force` 인수에 밀려 비정상 종료됐고, KeepAlive(SuccessfulExit=false)가 작업을
//     다시 띄우면 그 프로세스는 분리 자식이 쥔 락에 막혀 exit 2 — 10초마다 영원히. 하루 8천 건의
//     `EXIT code=2` 가 서버 오류 로그로 올라갔다.
//   - PC.VX(Windows, 매니저 두 개): 같은 일이 1분 주기로 일어났고, 업데이트 직후 그 주기 실행이
//     새 빌드의 부팅으로 한 번 더 세어져 멀쩡한 v1.6.338 이 "부팅 2회, 하트비트 없음" 으로
//     되돌려지고 핀됐다.
// 서비스가 있으면 새 프로세스도 서비스가 띄워야 한다. 그래야 감독이 이어지고 중복 실행이 없다.
//
// "이 서비스가 이 홈의 것인가" 를 반드시 본다: 예전 설치는 홈과 무관하게 이름이 하나였으므로,
// 같은 이름의 작업이 다른 홈의 매니저를 띄우는 장비가 있다(PC.VX). 남의 작업을 깨우면 그 작업은
// 이미 돌고 있어 아무 일도 없고, 이 인스턴스는 돌아오지 못한다.

import { spawnSync } from 'node:child_process';
import { posix as posixPath, win32 as win32Path } from 'node:path';
import { userInfo } from 'node:os';

import { AGENT_MANAGER_HOME } from './constants.js';
import { LAUNCHD_LABEL, WINDOWS_TASK_NAME, serviceSuffixForHome } from './service-install.js';

export interface ServiceSupervision {
  kind: 'launchd' | 'task';
  /** launchd label / 예약 작업 이름. */
  name: string;
  /** 이 프로세스가 그 서비스가 띄운 프로세스인가. 판별하지 못하면 null. */
  isServiceProcess: boolean | null;
  /** 서비스로 이 매니저를 (다시) 띄우는 명령. 서비스가 이미 돌고 있으면 아무 일도 하지 않는다. */
  relaunch: string[];
}

const SPAWN_TIMEOUT_MS = 10_000;

function run(cmd: string, args: string[]): { ok: boolean; stdout: Buffer } {
  try {
    const r = spawnSync(cmd, args, { windowsHide: true, timeout: SPAWN_TIMEOUT_MS });
    return { ok: r.status === 0 && !r.error, stdout: r.stdout ?? Buffer.alloc(0) };
  } catch {
    return { ok: false, stdout: Buffer.alloc(0) };
  }
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const P = platform === 'win32' ? win32Path : posixPath;
  const na = P.resolve(a);
  const nb = P.resolve(b);
  return platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

// ─── Windows 예약 작업 ──────────────────────────────────────────────────────

/** `schtasks /XML` 출력은 설치에 따라 UTF-16LE 다. BOM 이나 NUL 바이트로 가린다. */
export function decodeSchtasksOutput(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  const sample = buf.subarray(0, Math.min(buf.length, 200));
  const nuls = sample.filter((b) => b === 0).length;
  return nuls > sample.length / 4 ? buf.toString('utf16le') : buf.toString('utf8');
}

/**
 * 작업 정의가 이 홈의 매니저를 띄우는가. service-install 이 만든 작업은 `<홈>\service\launch-hidden.vbs`
 * 를 실행하므로 그 경로의 홈을 비교한다. launcher 를 쓰지 않는 예전 작업(node main.js 직접)은 홈을
 * 알 수 없으니 이름(홈마다 다르다)을 소유의 근거로 삼는다.
 */
export function taskXmlBelongsToHome(xml: string, home: string): boolean {
  const m = /([A-Za-z]:\\[^"<>\r\n]*?)\\service\\launch-hidden\.vbs/i.exec(xml);
  if (!m) return true;
  return samePath(m[1], home, 'win32');
}

/** 예약 작업을 띄운 쪽으로 보이는 부모 프로세스 이름들. */
const TASK_PARENT_IMAGES = ['wscript.exe', 'cscript.exe', 'svchost.exe', 'taskhostw.exe', 'taskeng.exe'];

/** `tasklist /FO CSV /NH` 한 줄에서 이미지 이름을 읽는다. 프로세스가 없으면 null. */
export function parseTasklistImage(csv: string): string | null {
  const line = csv.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith('"'));
  if (!line) return null;
  const m = /^"([^"]+)"/.exec(line);
  return m ? m[1].toLowerCase() : null;
}

function windowsSupervision(home: string): ServiceSupervision | null {
  const name = WINDOWS_TASK_NAME;
  const q = run('schtasks', ['/Query', '/TN', name, '/XML']);
  if (!q.ok) return null;
  if (!taskXmlBelongsToHome(decodeSchtasksOutput(q.stdout), home)) return null;
  let isServiceProcess: boolean | null = null;
  const parent = run('tasklist', ['/FI', `PID eq ${process.ppid}`, '/FO', 'CSV', '/NH']);
  if (parent.ok) {
    const image = parseTasklistImage(parent.stdout.toString('utf8'));
    isServiceProcess = image ? TASK_PARENT_IMAGES.includes(image) : false;
  }
  return { kind: 'task', name, isServiceProcess, relaunch: ['schtasks', '/Run', '/TN', name] };
}

// ─── macOS launchd ─────────────────────────────────────────────────────────

/** `launchctl print` 출력에서 실행 중 pid 와 작업 환경의 AWB_AGENT_MANAGER_HOME 을 읽는다. */
export function parseLaunchctlPrint(text: string): { pid: number | null; home: string | null } {
  const pid = /^\s*pid\s*=\s*(\d+)/m.exec(text);
  const home = /AWB_AGENT_MANAGER_HOME\s*=>\s*(.+)$/m.exec(text);
  return { pid: pid ? Number(pid[1]) : null, home: home ? home[1].trim() : null };
}

function launchdSupervision(home: string): ServiceSupervision | null {
  const label = LAUNCHD_LABEL;
  let uid: number | null = null;
  try {
    uid = userInfo().uid;
  } catch {
    uid = null;
  }
  const domains = [...(uid !== null && uid >= 0 ? [`gui/${uid}`] : []), 'system'];
  for (const domain of domains) {
    const target = `${domain}/${label}`;
    const r = run('launchctl', ['print', target]);
    if (!r.ok) continue;
    const info = parseLaunchctlPrint(r.stdout.toString('utf8'));
    // 작업 환경에 홈이 있으면 그 홈과 같아야 하고, 없으면 기본 홈의 작업이다.
    const ours = info.home ? samePath(info.home, home, 'darwin') : serviceSuffixForHome(home) === null;
    if (!ours) return null;
    return {
      kind: 'launchd',
      name: label,
      isServiceProcess: info.pid === null ? false : info.pid === process.pid,
      relaunch: ['launchctl', 'kickstart', target],
    };
  }
  return null;
}

let cached: { value: ServiceSupervision | null } | null = null;

/**
 * 이 홈의 서비스. 없으면 null. 한 번 조회해 기억한다 — 서비스 등록은 프로세스 수명 중에
 * 바뀌지 않고, 조회는 프로세스를 띄운다.
 */
export function detectServiceSupervision(
  opts: { home?: string; platform?: NodeJS.Platform; refresh?: boolean } = {},
): ServiceSupervision | null {
  if (cached && !opts.refresh && !opts.home && !opts.platform) return cached.value;
  const home = opts.home ?? AGENT_MANAGER_HOME;
  const platform = opts.platform ?? process.platform;
  let value: ServiceSupervision | null = null;
  try {
    if (platform === 'win32') value = windowsSupervision(home);
    else if (platform === 'darwin') value = launchdSupervision(home);
  } catch {
    value = null;
  }
  if (!opts.home && !opts.platform) cached = { value };
  return value;
}

/** 테스트 전용 — 기억한 조회 결과를 버린다. */
export function _resetServiceSupervisionForTests(value?: ServiceSupervision | null): void {
  cached = value === undefined ? null : { value };
}
