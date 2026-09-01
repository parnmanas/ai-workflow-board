// Resolves an agent CLI's binary to an absolute executable path so spawn()
// doesn't depend on the inherited PATH.
//
// Resolution strategy (per CLI, first hit wins):
//   1. Explicit absolute path passed by adapter (`configured` arg)
//   2. Parent process exe (Linux /proc/{ppid}/exe — only useful for claude
//      legacy proxy use)
//   3. Per-CLI well-known install paths (windows / unix candidates)
//   4. `command -v <name>` / `where <name>` shell lookup
//   5. Fallback: literal CLI name (will ENOENT; caller's spawn error
//      listener absorbs it)
//
// PATH 우선순위 (ticket ce65cf25, 702d0ebe 후속): well-known 설치 경로가 shell
// PATH lookup 보다 먼저 온다. 702d0ebe 인시던트에서 호스트 PATH가 구버전 비공식
// snap codex(0.114.0)를 공식 npm 전역 설치본(0.146.0)보다 먼저 노출해 매 spawn
// 마다 잘못된 바이너리가 선택됐다 — well-known 후보가 디스크에 존재하면 PATH
// 어디에 무엇이 끼어들든 그것을 우선한다. well-known 후보가 전부 없는 호스트
// (예: nvm 전용 설치)는 그대로 PATH lookup 순서로 fallback 하므로 회귀는 없다.
// PATH 재배치만으로 부족하면 `delegation.<cli>Bin` override(resolveBinOverride)
// 로 특정 경로를 명시 고정할 수 있다.
//
// Windows shim 처리 (ticket e299c6b3): npm 글로벌 shim 으로만 설치된 CLI 는 형제
// `.exe` 없이 `<name>.cmd`(배치 래퍼)만 노출한다 — codex 가 대표 케이스
// (`%APPDATA%\npm\codex.cmd`). Node 의 spawn() 은 CreateProcess 를 직접 호출하는데
// `.cmd` 는 실행 대상이 아니어서, cmd.exe 는 PATHEXT 로 잘 찾는데도 bare
// `spawn("codex")` 는 ENOENT 로 던진다. 그래서 `.cmd`/`.bat` shim 은 LAST resort
// 로만 resolve 하고(진짜 `.exe` 가 항상 먼저 우선 — selectBinary 참고), spawn
// 사이트는 이를 cross-spawn 으로 실행한다. cross-spawn 은 shim 을
// `cmd.exe /d /s /c` 로 감싸되 인자를 PROPERLY ESCAPED 한다(순수 `shell: true` 는
// 인자를 escape 없이 이어붙여 codex 의 inline-TOML `-c` attribution 인자를 망가뜨림).
//
// Memory pin (`feedback_windows_claude_exe_only`): 진짜 `.exe` 가 어떤 shim 보다
// 반드시 우선하고, npm 이 shim 옆에 떨어뜨리는 MSYS/확장자 없는 bash 래퍼는 절대
// 채택하지 않는다(오직 `.cmd`/`.bat`). selectBinary 는 두 불변식을 모두 지킨다 —
// 진짜 `.exe` 를 가진 claude 는 여전히 `.exe` 로 resolve 되고, codex 처럼 shim 만
// 있는 CLI 만 배치 래퍼로 fall through 한다.

import { execSync } from 'node:child_process';
import { accessSync, constants as fsConstants, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, win32 } from 'node:path';
import { KNOWN_CLI_TYPES } from './constants.js';
import { log } from './logging.js';

const isWindows = process.platform === 'win32';
const WIN_EXE_EXT = /\.exe$/i;
// `.exe` 가 없을 때 fallback 으로 허용하는 Windows 배치 shim. `.ps1` 은 의도적으로
// 제외한다 — powershell 스크립트는 cross-spawn 의 cmd.exe 래퍼로 실행되지 않고, npm
// 은 항상 `.ps1` 옆에 `.cmd` 를 함께 떨어뜨린다.
const WIN_SHIM_EXT = /\.(cmd|bat)$/i;

/** Windows 설정값에 붙은 외부 인용부호와 중복 구분자를 제거한다. spawn 계열 API는
 * 실행 파일과 인자를 별도로 받으므로 인용부호가 경로 문자열에 남아 있으면 안 된다. */
export function normalizeWindowsExecutablePath(value: string): string {
  let normalized = value.trim();
  if (
    normalized.length >= 2 &&
    ((normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'")))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }
  return win32.normalize(normalized);
}

/** resolve 결과를 실제 프로세스 생성 직전에 다시 검증한다. 설정 hot-reload와
 * resolve 이후 파일 삭제까지 진단 가능한 동기 오류로 바꾸기 위해 spawn 호출부에서 쓴다. */
export function assertCliExecutable(bin: string, cliType: string): void {
  if (!fileExecutable(bin)) {
    throw new Error(
      `[cli-resolver:${cliType}] resolved executable is missing or not executable before spawn: ${bin}`,
    );
  }
}

/** fs 존재 + 실행 가능 여부 probe. Windows 에는 실행 비트 개념이 없어
 *  accessSync(X_OK) 는 존재 확인으로 degrade 된다. 확장자 게이팅(`.exe` vs `.cmd`)
 *  은 selectBinary 에서 처리한다. */
function fileExecutable(p: string | null | undefined): p is string {
  if (!p) return false;
  try {
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface SelectedBinary {
  bin: string;
  kind: 'exe' | 'shim' | 'literal';
}

/** 순서가 있는 후보 경로 목록(호출자가 우선순위대로 넘긴다 — resolveCliBin 은
 *  well-known 설치 위치를 먼저, shell-lookup 결과를 그다음에 둔다)에서 가장
 *  실행 가능한 바이너리를 고른다. 순수 함수 + 의존성 주입이라
 *  Windows-only-`.cmd` 케이스를 실제 Windows 호스트 없이 unit test 할 수 있다.
 *  Windows 에선 진짜 `.exe` 가 항상 이기고, 목록 어디에도 `.exe` 가 없을 때만
 *  `.cmd`/`.bat` shim 을 쓴다. POSIX 에선 실행 가능한 파일이면 무엇이든 이긴다.
 *  실행 가능한 것이 하나도 없으면 literal CLI 이름으로 fallback 한다(그 결과의
 *  ENOENT 는 호출자의 spawn error 리스너가 흡수). */
export function selectBinary(
  cliType: string,
  sources: Array<string | null | undefined>,
  opts: { isWindows: boolean; exists: (p: string) => boolean },
): SelectedBinary {
  let shim: string | null = null;
  for (const p of sources) {
    if (!p) continue;
    if (opts.isWindows) {
      if (WIN_EXE_EXT.test(p) && opts.exists(p)) return { bin: p, kind: 'exe' };
      if (!shim && WIN_SHIM_EXT.test(p) && opts.exists(p)) shim = p;
    } else if (opts.exists(p)) {
      return { bin: p, kind: 'exe' };
    }
  }
  if (shim) return { bin: shim, kind: 'shim' };
  return { bin: cliType, kind: 'literal' };
}

/** well-known 설치 후보를 shell PATH lookup 결과보다 앞에 둔다(ticket ce65cf25).
 *  순수 함수라 실제 shell/fs 없이 순서 계약 자체를 unit test 할 수 있다 — PATH
 *  가 무엇을 먼저 노출하든, well-known 후보가 디스크에 존재하면 그것이 이긴다.
 *  well-known 후보가 전부 없으면(예: nvm 전용 설치) 그대로 PATH 순서로
 *  fallback 되므로 커스텀 설치 경로에 대한 회귀는 없다. */
export function orderResolutionSources(wellKnown: string[], pathHits: string[]): string[] {
  return [...wellKnown, ...pathHits];
}

/** claude/codex delegation override 를 CLI 타입에 맞게 고른다(ticket ce65cf25).
 *  claude 는 runtime-lease(Hermes 백엔드 프로필) override 를 delegation.claudeBin
 *  보다 우선한다 — 기존 동작 그대로. codex 는 delegation.codexBin 만 본다(별도
 *  runtime-lease 개념 없음). 다른 CLI 타입은 override 가 아예 없다 — 이전처럼
 *  null. subagent-manager/base-session-manager 양쪽이 이 하나의 순수 함수를
 *  공유해 같은 판정을 중복 구현하지 않는다. */
export function resolveBinOverride(
  cliType: string,
  delegation: { claudeBin?: string | null; codexBin?: string | null } | null | undefined,
  claudeExecutableOverride?: string | null,
): string | null {
  if (cliType === 'claude') {
    return claudeExecutableOverride ?? delegation?.claudeBin ?? null;
  }
  if (cliType === 'codex') {
    return delegation?.codexBin ?? null;
  }
  return null;
}

interface CandidateProvider {
  unix: (home: string) => string[];
  windows: (home: string) => string[];
}

const CANDIDATE_PROVIDERS: Record<string, CandidateProvider> = {
  claude: { unix: claudeUnixCandidates, windows: claudeWindowsCandidates },
  agy: { unix: agyUnixCandidates, windows: agyWindowsCandidates },
  codex: { unix: codexUnixCandidates, windows: codexWindowsCandidates },
  pi: { unix: piUnixCandidates, windows: piWindowsCandidates },
};

function parentExeMatching(nameRegex: RegExp): string | null {
  try {
    const ppid = process.ppid;
    if (!ppid) return null;
    const exe = readlinkSync(`/proc/${ppid}/exe`);
    if (!exe || !fileExecutable(exe)) return null;
    if (/\.vscode\/extensions\//.test(exe)) return null;
    if (!nameRegex.test(basename(exe))) return null;
    return exe;
  } catch {
    return null;
  }
}

// ct 만으로 키잉하면, 오퍼레이터가 reload_config/SIGHUP으로 delegation.*Bin을
// 바꿔도(설정·변경·해제) 해당 CLI가 이미 한 번 resolve된 뒤에는 stale 캐시가
// 계속 반환돼 "재기동 없는 고정"이 첫 spawn 이후엔 조용히 무시됐다(리뷰 지적,
// ticket ce65cf25). effective override(대체 CLI 이름으로 새는 값은 무시한
// 후의 실질 override)까지 키에 포함해, override 값이 달라지면 다음 spawn부터
// 캐시 미스로 새 값을 즉시 반영하고, override를 제거하면 원래의 no-override
// 키로 돌아가 정상 탐색(또는 그 키의 기존 캐시)으로 복귀한다.
const cache = new Map<string, string>();

export function resolveCliBin(cliType: string, configured?: string | null): string {
  const ct = String(cliType || 'claude').toLowerCase();

  let effectiveOverride: string | null = null;
  if (configured && configured !== ct) {
    // Defense: if `configured` is the literal name of a *different* known
    // CLI (e.g. "claude" passed for codex), it's almost certainly the
    // legacy `delegation.claudeBin` default leaking through. Ignore it
    // and fall through to normal lookup so codex / antigravity spawns find
    // their actual binary instead of launching claude with foreign argv.
    if ((KNOWN_CLI_TYPES as readonly string[]).includes(configured)) {
      log(
        `[cli-resolver:${ct}] ignoring configured="${configured}" — it names a different known CLI; falling through to lookup`,
      );
    } else {
      effectiveOverride = configured;
    }
  }

  const key = `${ct}:${effectiveOverride ?? ''}`;
  const cached = cache.get(key);
  if (cached) return cached;

  if (effectiveOverride) {
    const configuredPath = isWindows
      ? normalizeWindowsExecutablePath(effectiveOverride)
      : effectiveOverride.trim();
    cache.set(key, configuredPath);
    log(`[cli-resolver:${ct}] using configured path: ${configuredPath}`);
    return configuredPath;
  }

  if (ct === 'claude') {
    const viaParent = parentExeMatching(/claude/i);
    if (viaParent) {
      cache.set(key, viaParent);
      log(`[cli-resolver:claude] resolved via parent /proc/${process.ppid}/exe: ${viaParent}`);
      return viaParent;
    }
  }

  // well-known 설치 위치를 먼저 모으고, shell PATH lookup 결과는 뒤에 붙인다
  // (orderResolutionSources — 위 "PATH 우선순위" 참고). selectBinary 가 진짜
  // `.exe` 를 우선하며 훑고, `.exe` 가 없을 때만 `.cmd`/`.bat` shim(Windows
  // npm-shim 설치)으로 fallback 한다 — 그래서 bare `spawn("codex")` 가 Windows
  // 에서 더 이상 ENOENT 나지 않는다.
  const provider = CANDIDATE_PROVIDERS[ct];
  const wellKnown = provider
    ? isWindows
      ? provider.windows(homedir())
      : provider.unix(homedir())
    : [];

  const pathHits: string[] = [];
  try {
    const cmd = isWindows
      ? `where ${ct}`
      : `command -v ${ct} 2>/dev/null || which ${ct} 2>/dev/null`;
    const out = execSync(cmd, {
      encoding: 'utf8',
      timeout: 2000,
      shell: isWindows ? undefined : '/bin/sh',
    }).trim();
    for (const line of out.split(/\r?\n/)) {
      const t = line.trim();
      if (t) pathHits.push(t);
    }
  } catch {
    /* shell 또는 spawn 실패 — well-known candidate 로 계속 시도한다 */
  }

  const sources = orderResolutionSources(wellKnown, pathHits);
  const picked = selectBinary(ct, sources, { isWindows, exists: fileExecutable });
  cache.set(key, picked.bin);
  if (picked.kind === 'literal') {
    throw new Error(
      `[cli-resolver:${ct}] executable not found or not executable; checked PATH and known install locations`,
    );
  } else {
    log(`[cli-resolver:${ct}] resolved via ${picked.kind}: ${picked.bin}`);
  }
  return picked.bin;
}

export function _resetResolverCache(): void {
  cache.clear();
}

function claudeUnixCandidates(home: string): string[] {
  return [
    join(home, '.npm-global/bin/claude'),
    join(home, '.bun/bin/claude'),
    join(home, '.local/bin/claude'),
    join(home, '.volta/bin/claude'),
    join(home, '.npm-packages/bin/claude'),
    join(home, 'node_modules/.bin/claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    '/usr/bin/claude',
  ];
}

function claudeWindowsCandidates(home: string): string[] {
  const appdata = process.env.APPDATA || join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  return [
    // npm 패키지 내부의 bin 경로는 설치 레이아웃이 아니며 claude.exe가 존재하지
    // 않을 수 있다. npm이 보장하는 전역 shim을 직접 resolve한다.
    join(appdata, 'npm', 'claude.exe'),
    join(localAppData, 'Programs', 'anthropic', 'claude-code', 'claude.exe'),
    // Last-resort npm 배치 shim — 위 .exe 경로가 하나도 없을 때만 도달한다
    // (selectBinary 는 항상 .exe 를 우선). 매니저가 %APPDATA%\npm 이 빠진 PATH 로
    // 서비스 실행될 때도 견고하다.
    join(appdata, 'npm', 'claude.cmd'),
  ];
}

function agyUnixCandidates(home: string): string[] {
  return [
    join(home, '.local/bin/agy'),
    join(home, '.npm-global/bin/agy'),
    join(home, '.bun/bin/agy'),
    join(home, '.volta/bin/agy'),
    join(home, '.npm-packages/bin/agy'),
    join(home, 'node_modules/.bin/agy'),
    '/usr/local/bin/agy',
    '/opt/homebrew/bin/agy',
    '/usr/bin/agy',
  ];
}

function agyWindowsCandidates(home: string): string[] {
  const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  return [
    join(localAppData, 'Antigravity', 'agy.exe'),
    join(localAppData, 'Programs', 'google', 'antigravity', 'agy.exe'),
  ];
}

function codexUnixCandidates(home: string): string[] {
  return [
    join(home, '.npm-global/bin/codex'),
    join(home, '.bun/bin/codex'),
    join(home, '.local/bin/codex'),
    join(home, '.volta/bin/codex'),
    join(home, '.npm-packages/bin/codex'),
    join(home, 'node_modules/.bin/codex'),
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
    '/usr/bin/codex',
  ];
}

function codexWindowsCandidates(home: string): string[] {
  const appdata = process.env.APPDATA || join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const pkgBin = join(appdata, 'npm', 'node_modules', '@openai', 'codex', 'bin');
  return [
    join(pkgBin, 'codex.exe'),
    join(appdata, 'npm', 'codex.exe'),
    join(localAppData, 'Programs', 'openai', 'codex', 'codex.exe'),
    // npm 글로벌 설치는 형제 .exe 없이 이 배치 shim 만 ship 한다 — ticket e299c6b3
    // 의 대표 repro. .exe 가 없으면 selectBinary 가 이걸로 fallback 하고 cross-spawn
    // 이 인자를 escape 해 cmd.exe 로 실행한다.
    join(appdata, 'npm', 'codex.cmd'),
  ];
}

// Pi (`@earendil-works/pi-coding-agent`) is a pure TypeScript/Node CLI, not
// a compiled binary like codex — `npm install -g` and the `pi.dev/install.sh`
// curl installer both drop a JS entrypoint, so unlike codex there is no
// sibling `.exe` to prefer on Windows, only the npm batch shim.
function piUnixCandidates(home: string): string[] {
  return [
    join(home, '.npm-global/bin/pi'),
    join(home, '.bun/bin/pi'),
    join(home, '.local/bin/pi'),
    join(home, '.volta/bin/pi'),
    join(home, '.npm-packages/bin/pi'),
    join(home, 'node_modules/.bin/pi'),
    '/usr/local/bin/pi',
    '/opt/homebrew/bin/pi',
    '/usr/bin/pi',
  ];
}

function piWindowsCandidates(home: string): string[] {
  const appdata = process.env.APPDATA || join(home, 'AppData', 'Roaming');
  return [join(appdata, 'npm', 'pi.cmd')];
}
