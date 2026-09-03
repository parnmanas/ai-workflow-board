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
// 죽은 shim 건너뛰기: shim 은 "파일이 존재한다"만으로 채택되지 않는다. 배치 shim
// 본문에서 실행 대상을 파싱해(parseWindowsShimTargets) 그 대상이 디스크에 있을
// 때만 후보로 인정한다(windowsShimIsUsable). 계기: Claude Code 자기 업데이트가
// `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe` 를
// `claude.exe.old.<ts>` 로 rename 해놓고 새 바이너리를 못 떨어뜨린 호스트에서,
// `%APPDATA%\npm\claude.cmd` 는 멀쩡히 남아 well-known 후보로 먼저 매칭됐다.
// 위 "PATH 우선순위" 규칙 때문에 이 죽은 shim 이 PATH 상의 정상 설치(nvm 전역,
// 같은 CLI 의 최신 버전)를 이겨서, 모든 claude dispatch 가 cmd.exe 의 로케일
// 의존적인 "내부 또는 외부 명령이 아닙니다" 로 죽었다. 대상까지 확인하면
// 반쯤 업데이트된 설치는 건너뛰고 다음 후보로 넘어간다. 대상을 식별하지 못하는
// shim(알 수 없는 레이아웃, 읽기 실패)은 보수적으로 그대로 채택한다.
//
// Memory pin (`feedback_windows_claude_exe_only`): 진짜 `.exe` 가 어떤 shim 보다
// 반드시 우선하고, npm 이 shim 옆에 떨어뜨리는 MSYS/확장자 없는 bash 래퍼는 절대
// 채택하지 않는다(오직 `.cmd`/`.bat`). selectBinary 는 두 불변식을 모두 지킨다 —
// 진짜 `.exe` 를 가진 claude 는 여전히 `.exe` 로 resolve 되고, codex 처럼 shim 만
// 있는 CLI 만 배치 래퍼로 fall through 한다.

import { execSync } from 'node:child_process';
import { accessSync, constants as fsConstants, readFileSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, posix, win32 } from 'node:path';
import { KNOWN_CLI_TYPES } from './constants.js';
import { log } from './logging.js';

const isWindows = process.platform === 'win32';
const WIN_EXE_EXT = /\.exe$/i;
// `.exe` 가 없을 때 fallback 으로 허용하는 Windows 배치 shim. `.ps1` 은 의도적으로
// 제외한다 — powershell 스크립트는 cross-spawn 의 cmd.exe 래퍼로 실행되지 않고, npm
// 은 항상 `.ps1` 옆에 `.cmd` 를 함께 떨어뜨린다.
const WIN_SHIM_EXT = /\.(cmd|bat)$/i;

// npm 배치 shim 안에서 shim 자신의 디렉터리를 기준으로 쓰인 인용된 경로 토큰.
// npm 7+ 는 `SET dp0=%~dp0` 후 `%dp0%` 를, npm 6 은 `%~dp0` 를 직접 쓴다.
const WIN_SHIM_TARGET_RE = /"(%~?dp0%?[^"]*)"/gi;
// shim 이 참조하지만 형제로 존재할 필요가 없는 인터프리터. npm 의 JS-entrypoint
// shim 은 `%dp0%\node.exe` 가 없으면 PATH 의 `node` 로 fall back 하도록 쓰였다
// (`IF EXIST … ELSE SET "_prog=node"`), 그러므로 부재가 고장이 아니다.
const WIN_SHIM_OPTIONAL_TARGET = /^node(\.exe)?$/i;

/** 배치 shim 본문에서 "이 shim 이 실행하려는 대상" 경로를 뽑아낸다(ticket에서
 *  발견된 half-updated 설치 진단용). 순수 함수 — 파일 IO 없이 unit test 한다.
 *
 *  대입/가드 줄은 필수 대상이 아니다: `IF EXIST "%dp0%\node.exe" (` 와
 *  `SET "_prog=%dp0%\node.exe"` 는 인터프리터 탐색의 두 갈래일 뿐이고, 실제
 *  실행 대상은 마지막 호출 줄의 `%dp0%\node_modules\…\cli.js` 다. 확장자 없는
 *  토큰과 node 인터프리터도 제외한다 — 남는 것은 "없으면 반드시 깨지는" 경로뿐. */
export function parseWindowsShimTargets(contents: string, shimPath: string): string[] {
  // 경로 조작은 반드시 win32.* 로 한다. 이 함수는 Windows 배치 shim 만 파싱하는데,
  // 플랫폼 기본 path.* 를 쓰면 Linux(CI, POSIX 개발기)에서 백슬래시가 구분자로
  // 취급되지 않아 dirname 이 "." 을 돌려주고 결과가 통째로 어긋난다.
  const shimDir = win32.dirname(shimPath);
  const targets: string[] = [];
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^@?if\s+exist\b/i.test(line) || /^@?set\b/i.test(line)) continue;
    for (const match of line.matchAll(WIN_SHIM_TARGET_RE)) {
      const token = match[1];
      const rest = token.replace(/^%~?dp0%?/i, '');
      if (!rest) continue;
      const resolved = win32.normalize(win32.join(shimDir, rest));
      if (!/\.[a-z0-9]+$/i.test(resolved)) continue;
      if (WIN_SHIM_OPTIONAL_TARGET.test(win32.basename(resolved))) continue;
      if (!targets.includes(resolved)) targets.push(resolved);
    }
  }
  return targets;
}

/** 배치 shim 이 실제로 실행 가능한지 — 즉 그 shim 이 가리키는 대상이 디스크에
 *  있는지 — 판정한다. `false` 는 "이 shim 은 고장났다"는 뜻이므로, 대상을 하나도
 *  식별하지 못한 경우(알 수 없는 shim 레이아웃, 읽기 실패)는 보수적으로 `true`.
 *
 *  존재 이유: Claude Code 자기 업데이트가 `bin/claude.exe` 를 `claude.exe.old.<ts>`
 *  로 rename 해놓고 새 바이너리를 못 떨어뜨리면, shim 파일 자체는 멀쩡히 남는다.
 *  shim 의 존재만 보던 selectBinary 는 그 죽은 shim 을 well-known 후보라는 이유로
 *  PATH 상의 멀쩡한 설치보다 우선 고정했고(ticket ce65cf25 의 well-known-first
 *  순서), 모든 claude dispatch 가 cmd.exe 의 "내부 또는 외부 명령이 아닙니다"
 *  로 죽었다. 대상까지 확인하면 반쯤 업데이트된 설치는 건너뛰고 다음 후보로 간다. */
export function windowsShimIsUsable(
  shimPath: string,
  opts: { read: (p: string) => string | null; exists: (p: string) => boolean },
): boolean {
  const contents = opts.read(shimPath);
  if (contents === null) return true;
  const targets = parseWindowsShimTargets(contents, shimPath);
  if (targets.length === 0) return true;
  return targets.every((t) => opts.exists(t));
}

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
  // 죽은 배치 shim 은 존재 검사를 통과하고 cmd.exe 안에서 로케일 의존적인
  // "내부 또는 외부 명령이 아닙니다" 로만 실패한다 — 여기서 어떤 대상이 없는지
  // 이름으로 짚어주는 편이 훨씬 진단 가능하다.
  if (isWindows && WIN_SHIM_EXT.test(bin) && !shimUsable(bin)) {
    const missing = parseWindowsShimTargets(readTextFile(bin) ?? '', bin).filter((t) => !fileExists(t));
    throw new Error(
      `[cli-resolver:${cliType}] batch shim points at a missing target before spawn: ${bin} -> ${missing.join(', ')}`,
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

/** shim 대상 존재 확인. 대상은 `.js` 처럼 실행 비트가 없는 파일일 수도 있으므로
 *  X_OK 가 아니라 F_OK 로 본다. */
function fileExists(p: string): boolean {
  try {
    accessSync(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function readTextFile(p: string): string | null {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** windowsShimIsUsable 을 실제 fs 에 바인딩한 것. 건너뛴 shim 은 로그로 남긴다 —
 *  후보를 조용히 버리면 "왜 다른 설치가 선택됐는지" 를 추적할 수 없다. */
function shimUsable(p: string): boolean {
  if (windowsShimIsUsable(p, { read: readTextFile, exists: fileExists })) return true;
  const missing = parseWindowsShimTargets(readTextFile(p) ?? '', p).filter((t) => !fileExists(t));
  log(`[cli-resolver] skipping dead batch shim ${p} (missing target: ${missing.join(', ')})`);
  return false;
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
 *  ENOENT 는 호출자의 spawn error 리스너가 흡수).
 *
 *  shim 은 존재만으로 채택되지 않는다 — `shimUsable` 로 그 shim 이 가리키는
 *  대상까지 확인하고, 대상이 없는 죽은 shim(반쯤 끝난 자기 업데이트가 남긴
 *  잔해)은 건너뛰어 다음 후보로 넘어간다. 기본값은 "항상 사용 가능" 이라 이
 *  검사를 주입하지 않는 호출자의 동작은 그대로다. */
export function selectBinary(
  cliType: string,
  sources: Array<string | null | undefined>,
  opts: {
    isWindows: boolean;
    exists: (p: string) => boolean;
    shimUsable?: (p: string) => boolean;
  },
): SelectedBinary {
  // 모듈 스코프의 fs 바인딩 `shimUsable` 을 가리지 않도록 이름을 달리 둔다.
  const isShimUsable = opts.shimUsable ?? (() => true);
  let shim: string | null = null;
  for (const p of sources) {
    if (!p) continue;
    if (opts.isWindows) {
      if (WIN_EXE_EXT.test(p) && opts.exists(p)) return { bin: p, kind: 'exe' };
      if (!shim && WIN_SHIM_EXT.test(p) && opts.exists(p) && isShimUsable(p)) shim = p;
    } else if (opts.exists(p)) {
      return { bin: p, kind: 'exe' };
    }
  }
  if (shim) return { bin: shim, kind: 'shim' };
  return { bin: cliType, kind: 'literal' };
}

/** `where` / `command -v` 를 쓰지 않는 순수 PATH 스캔. shell lookup 이 timeout
 *  이나 spawn 실패로 빈손일 때만 쓰이는 fallback 이며, 같은 후보 목록을
 *  서브프로세스 없이 만들어낸다.
 *
 *  Windows 에서는 PATHEXT 의 각 확장자를 순서대로 붙여 본다 — cmd.exe 가 bare
 *  `codex` 를 찾을 때 쓰는 규칙과 같다. POSIX 에서는 확장자 없이 실행 비트만
 *  본다. 순수 함수 + `exists` 주입이라 실제 호스트 설치 없이 unit test 할 수
 *  있다(board lesson: CLI resolver 테스트는 호스트 설치에 의존하지 말 것). */
export function scanPathForBinary(
  cliType: string,
  pathValue: string | null | undefined,
  opts: {
    isWindows: boolean;
    pathExt?: string | null;
    exists: (p: string) => boolean;
  },
): string[] {
  if (!pathValue) return [];
  const sep = opts.isWindows ? ';' : ':';
  // 플랫폼 기본 `join` 이 아니라 **명시적으로** 분기한다 — win32 호스트에서
  // 기본 join 은 POSIX 입력도 `\\` 로 붙여 버려, isWindows=false 계약이 호스트에
  // 따라 달라진다(Windows CI 에서 실측한 실패).
  const pathJoin = opts.isWindows ? win32.join : posix.join;
  const suffixes = opts.isWindows
    ? (opts.pathExt || '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .map((ext) => ext.trim())
        .filter(Boolean)
    : [''];

  const hits: string[] = [];
  for (const rawDir of pathValue.split(sep)) {
    // Windows PATH 항목은 인용부호가 붙어 있을 수 있고, 빈 항목(중복 구분자)은
    // "현재 디렉터리" 로 해석되면 안 되므로 건너뛴다.
    const dir = rawDir.trim().replace(/^"(.*)"$/, '$1');
    if (!dir) continue;
    for (const suffix of suffixes) {
      const candidate = pathJoin(dir, `${cliType}${suffix}`);
      if (opts.exists(candidate) && !hits.includes(candidate)) hits.push(candidate);
    }
  }
  return hits;
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
    /* shell 또는 spawn 실패 — 아래 순수 PATH 스캔으로 계속 시도한다 */
  }

  // 위 shell lookup 은 서브프로세스라 호스트 부하에 좌우된다. 부하가 높으면
  // 2000ms timeout 에 걸려 빈손으로 돌아오고, well-known 위치에도 없는 CLI 는
  // PATH 에 멀쩡히 설치돼 있는데도 "executable not found" 로 죽었다
  // (Windows CI 실측: `where codex` 가 timeout → resolveCliBin throw). PATH 를
  // 직접 훑는 fallback 은 서브프로세스 없이 같은 후보를 결정적으로 만들어낸다.
  // 성공 경로의 순서·의미론은 그대로다 — shell lookup 이 결과를 낸 경우 이
  // 스캔은 아예 돌지 않는다.
  if (pathHits.length === 0) {
    pathHits.push(
      ...scanPathForBinary(ct, process.env.PATH, {
        isWindows,
        pathExt: process.env.PATHEXT,
        exists: fileExecutable,
      }),
    );
  }

  const sources = orderResolutionSources(wellKnown, pathHits);
  const picked = selectBinary(ct, sources, { isWindows, exists: fileExecutable, shimUsable });
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
