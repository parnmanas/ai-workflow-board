// Runtime Host 에 설치된 CLI 자체를 최신으로 올린다 — `update_cli` 커맨드의 알맹이.
//
// 매니저 자신의 self-update(self-update.ts)와는 다른 축이다: 저쪽은 awb-agent-manager
// 패키지를, 이쪽은 그 매니저가 spawn 하는 CLI(claude / codex / …)를 올린다.
//
// ── 올릴 대상은 CLI 가 아니라 **설치본(경로)** 이다 ─────────────────────────────
// 한 장비에 같은 CLI 가 여러 벌 있는 것은 정상 구성이다. ragnar 는 vLLM 백엔드용
// 으로 claude 를 두 벌 두고(`~/.local` prefix + nvm prefix), claude-backend runtime
// profile 의 `claude_executable` 로 어느 설치본을 쓸지 고른다. 그래서 "이 장비의
// claude 를 올린다" 는 말은 애매하다 — 호출자가 경로를 지정하지 않으면 **지금
// 해석되는 설치본**(= 지정이 없을 때 spawn 될 그것)을 올린다.
//
// ── 올리는 방법은 설치본마다 다르다 ────────────────────────────────────────────
// CLI 자체 업데이터(`claude update`)는 자기 자신이 아니라 PATH 위 npm 의 prefix
// 로 설치한다. ragnar 실측: `~/.local/bin/claude`(2.1.273)로 업데이트를 돌렸더니
// 새 버전이 `~/.nvm/.../bin/claude` 에 깔리고 exit 0 — 손대지 않은 다른 설치본이
// 올라갔고 정작 대상은 그대로였다. 그래서 순서는:
//
//   1) 설치 레이아웃에서 방법을 **증명할 수 있으면** 그것으로 올린다
//      (`npm --prefix <prefix> install -g <pkg>@latest`, `bun add -g`, …).
//      대상이 정확하므로 다른 설치본을 건드리지 않는다.
//   2) 증명이 안 되면(native installer, curl 설치 등) CLI 자체 업데이터에 맡긴다.
//   3) 어느 쪽이든 **그 경로를 다시 읽어** 버전이 움직였는지 확인한다. 자체
//      업데이터가 성공했다고 말했는데 대상이 그대로면, 마지막으로 1)의 방법을
//      시도해 본다(ragnar 의 복구 경로).
//   4) 그래도 안 움직였으면 실패다 — 무엇을 어떻게 올려야 하는지까지 적어서.

import crossSpawn from 'cross-spawn';
import { hostname } from 'node:os';
import { createAdapter } from './cli-adapters/index.js';
import { canonicalPathKey, invalidateCliBinCache, listCliBinCandidates } from './cli-resolver.js';
import {
  describeInstallMethod,
  detectInstallMethod,
  type InstallMethod,
} from './cli-install-method.js';
import { probeRuntimeCommand } from './runtime/probe-command.js';
import { runWithSudo, type SudoFailure } from './sudo-runner.js';
import { compareSemver } from './self-update.js';

/** 업데이터가 이만큼 안 끝나면 죽인다. npm 레지스트리 왕복 + 설치라 넉넉히 잡되,
 *  무한정 기다려 커맨드 ack 를 영원히 붙잡아 두지는 않는다. */
export const CLI_UPDATE_TIMEOUT_MS = 10 * 60 * 1000;

/** 한 번의 업데이트 시도 — 어떤 방법으로, 무엇을 돌렸고, 어떻게 끝났는지. */
export interface CliUpdateAttempt {
  method: string;
  command: string;
  ok: boolean;
  output: string;
}

export interface CliUpdateOutcome {
  supported: boolean;
  ok: boolean;
  before: string | null;
  after: string | null;
  detail: string;
  hostLabel: string;
  /** 실제로 올린 설치본의 경로. */
  resolvedPath: string | null;
  /** 그 설치본의 설치 방법(사람이 읽는 한 줄). */
  installMethod: string | null;
  /** 이 설치본을 올리려면 권한 상승이 필요한지. UI 가 비밀번호를 물을지 정한다. */
  needsSudo: boolean;
  /** 권한 상승 자체가 실패한 사유. `bad_password` 면 UI 는 다시 묻기만 하면 된다 —
   *  명령이 실패한 것과 섞이면 운영자가 엉뚱한 곳을 고치러 간다. */
  sudoFailure: SudoFailure | null;
  /** 시도 순서대로의 기록 — 자체 업데이터가 헛돌고 prefix 방법이 구한 경우를
   *  ack 만 보고도 알 수 있게 한다. */
  attempts: CliUpdateAttempt[];
  /** 같은 CLI 의 **다른** 설치본들. 실패가 아니다 — 여러 벌이 정상 구성이므로
   *  운영자가 "저것도 올려야 하나" 를 판단할 수 있게 그대로 보여준다. */
  otherInstalls: Array<{ path: string; version: string | null }>;
}

export interface CliUpdateDeps {
  /** argv 를 돌리고 (성공여부, 합쳐진 출력)을 돌려준다. 테스트가 갈아끼운다. */
  run?: (cmd: string, args: string[], timeoutMs: number) => Promise<{ ok: boolean; output: string }>;
  /** **실행 파일 경로**의 `--version` 재측정. CLI 이름이 아니라 경로를 받는다 —
   *  어느 설치본의 버전인지가 이 기능의 전부이기 때문이다. */
  probeVersion?: (bin: string) => Promise<string | null>;
  /** 이 CLI 로 실행될 수 있는 모든 설치본(우선순위 순). 기본은 cli-resolver. */
  listCandidates?: (cli: string) => string[];
  /** 설치 방법 판정. 기본은 cli-install-method. */
  detectMethod?: (bin: string, pkg: string | null) => InstallMethod;
  /** 이 CLI 가 지정 없이 어느 실행 파일로 해석되는지. 기본은 어댑터의 resolveBin.
   *  테스트가 갈아끼운다 — 이걸 주입할 수 없으면 "그 CLI 가 러너 장비에 깔려
   *  있는가" 에 결과가 좌우된다(board lesson: CLI resolver 테스트는 호스트 설치에
   *  의존하지 말 것). */
  resolveBin?: (cli: string) => string;
  /** 업데이터가 설치 위치를 옮겼을 수 있으므로 resolve 캐시를 버린다. */
  invalidateResolved?: (cli: string) => void;
  /** 권한 상승 실행. 기본은 sudo-runner. 테스트가 반드시 갈아끼운다 — 주입이 없으면
   *  테스트가 러너 장비에서 **진짜 sudo 인증 실패**를 일으켜 auth 로그를 더럽힌다. */
  runSudo?: typeof runWithSudo;
  hostLabel?: string;
  log?: (msg: string) => void;
}

export interface CliUpdateOptions {
  /** 올릴 설치본의 절대 경로. 생략하면 지금 해석되는 설치본. 호출자는 이 값이
   *  **열거된 후보 중 하나**임을 반드시 먼저 검증한다(임의 경로 실행 금지). */
  bin?: string | null;
  /** 이 CLI 의 최신 배포 버전(cli-latest.ts). 있으면 "버전이 안 움직였다" 를
   *  *이미 최신* 과 *못 올렸다* 로 가를 수 있다 — 없으면 업데이터의 종료 코드를
   *  믿는 수밖에 없고, 그게 ragnar 회귀의 뿌리였다. */
  latest?: string | null;
  /** 권한 상승이 실제로 필요할 때만 불린다. 일회용 sudo 티켓을 서버에서 당겨
   *  오는 함수이고, **여기서 불리지 않으면 티켓은 소비되지 않는다** — 권한 상승이
   *  필요 없는 설치본을 올릴 때 비밀번호를 괜히 네트워크에 태우지 않는다. */
  getSudoPassword?: (() => Promise<string | null>) | null;
}

function defaultRun(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    // cross-spawn: Windows 의 npm 배치 shim(`claude.cmd`, `npm.cmd`)은 node spawn
    // 으로 직접 실행되지 않는다 — 세션 어댑터와 같은 이유로 여기서도 cross-spawn.
    const child = crossSpawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env,
    });
    let output = '';
    let settled = false;
    const finish = (ok: boolean, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, output: (output + extra).trim() });
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish(false, `\n[timeout after ${timeoutMs}ms]`);
    }, timeoutMs);
    child.stdout?.on('data', (b) => {
      output += String(b);
    });
    child.stderr?.on('data', (b) => {
      output += String(b);
    });
    child.on('error', (err: any) => finish(false, `\n[spawn error: ${err?.message ?? err}]`));
    child.on('close', (code) => finish(code === 0, code === 0 ? '' : `\n[exit ${code}]`));
  });
}

async function defaultProbeVersion(bin: string): Promise<string | null> {
  const r = await probeRuntimeCommand(bin, ['--version']);
  return r.installed ? (r.version ?? null) : null;
}

/** `--version` 출력에서 semver 코어를 뽑는다. CLI 마다 장식이 달라서
 *  (`2.1.281 (Claude Code)`, `codex-cli 0.153.4`) 비교 전에 한 번 벗겨야 한다.
 *  숫자 세 자리를 못 찾으면 null — 비교를 포기한다는 뜻이지 0 이 아니다. */
export function extractSemver(version: string | null | undefined): string | null {
  if (!version) return null;
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** 두 `--version` 문자열을 semver 로 비교한다. 어느 한쪽이라도 숫자를 못 뽑으면
 *  null — 호출자는 "비교 불가" 와 "같다" 를 구분해야 한다. */
export function compareCliVersions(a: string | null, b: string | null): number | null {
  const aa = extractSemver(a);
  const bb = extractSemver(b);
  if (!aa || !bb) return null;
  return compareSemver(aa, bb);
}

/** 출력이 길면 ack 메시지가 통째로 로그를 삼키므로 꼬리만 남긴다 — 실패 사유는
 *  보통 마지막 몇 줄에 있다. */
function tail(output: string, max = 400): string {
  const trimmed = output.trim();
  if (trimmed.length <= max) return trimmed;
  return `…${trimmed.slice(-max)}`;
}

/** 후보를 열거할 때 쓸 이름. 다른 CLI 의 바이너리를 빌려 쓰는 어댑터(deepseek →
 *  claude)는 자기 이름으로 된 실행 파일이 없어, cliType 으로 물으면 후보가 늘 0개다.
 *  실제로 해석된 바이너리의 파일명이 곧 "이 CLI 가 무엇인가" 이므로 그것을 쓴다. */
export function candidateKeyFor(cli: string, resolvedPath: string): string {
  const base = resolvedPath.split(/[\\/]/).pop() ?? '';
  const name = base.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
  return name || cli;
}

/**
 * npm 레지스트리의 "latest" 를 이 설치본의 기준으로 삼아도 되는가.
 *
 * 삼으면 안 되는 경우가 실제로 있다(rolf 실측): `/snap/bin/codex` 는 OpenAI 가
 * 아니라 제3자(`jcat`)가 올린 스냅이고 그 채널의 최신이 0.114.0 이다. 같은
 * 호스트의 npm 최신은 0.156.1 이지만 **다른 배포 채널의 숫자**라 비교 대상이
 * 아니다. 그걸 기준으로 쓰면 `snap refresh` 가 "올릴 게 없다" 로 올바르게 끝난
 * 것을 실패로 보고하고, 화면은 영원히 "→ 0.156.1" 을 띄운다.
 *
 * npm 트리에서 패키지 이름을 읽어낸 설치본(npm prefix / bun / volta / pnpm)만
 * 참이다 — 그것들은 정말로 npm 레지스트리에서 온다. 나머지(snap / homebrew /
 * native installer / 미상)는 **모른다**, 그리고 모르는 것은 모른다고 둔다.
 */
export function npmLatestApplies(method: InstallMethod): boolean {
  return (
    method.kind === 'npm-prefix' ||
    method.kind === 'bun' ||
    method.kind === 'volta' ||
    method.kind === 'pnpm'
  );
}

/** 이 설치본은 우리가 못 건드리는 패키지 매니저가 소유하고 있는가. 그렇다면 CLI
 *  자체 업데이터를 돌리는 것은 **해롭다**: 제자리를 갈아 끼우는 대신 PATH 위 npm
 *  prefix 에 새 설치를 만들어, 대상은 그대로인데 남의 설치본만 바뀐다. */
function managedElsewhere(method: InstallMethod): boolean {
  return method.kind === 'snap' || method.kind === 'homebrew' || method.needsElevation;
}

/**
 * 이 CLI 로 실행될 수 있는 설치본 전체를 (경로, 버전) 으로 돌려준다. 여러 벌이
 * 있는 것은 정상이므로 실패가 아니고, `update_cli` 가 경로를 지정받을 때
 * **허용 목록**으로도 쓰인다 — 임의 경로를 실행하지 않기 위해서다.
 */
export async function listCliInstalls(
  cli: string,
  deps: Pick<CliUpdateDeps, 'probeVersion' | 'listCandidates' | 'detectMethod' | 'resolveBin'> = {},
): Promise<Array<{ path: string; version: string | null; method: InstallMethod }>> {
  const probeVersion = deps.probeVersion ?? defaultProbeVersion;
  const listCandidates = deps.listCandidates ?? listCliBinCandidates;
  const detectMethod = deps.detectMethod ?? detectInstallMethod;

  let key = cli;
  let pkg: string | null = null;
  try {
    const adapter = createAdapter(cli);
    pkg = adapter.updatePackage();
    key = candidateKeyFor(cli, (deps.resolveBin ?? ((c) => createAdapter(c).resolveBin()))(cli));
  } catch {
    // 해석 실패(미설치) — 이름 그대로 열거해 본다. 후보가 없으면 빈 배열이다.
  }
  const out: Array<{ path: string; version: string | null; method: InstallMethod }> = [];
  for (const path of listCandidates(key)) {
    out.push({ path, version: await probeVersion(path), method: detectMethod(path, pkg) });
  }
  return out;
}

/**
 * 한 설치본을 올린다. 절대 throw 하지 않고 결과를 돌려준다 — 호출자(커맨드
 * 핸들러)가 supported/ok 를 보고 ack 문구를 정한다.
 */
export async function runCliUpdate(
  cli: string,
  deps: CliUpdateDeps = {},
  options: CliUpdateOptions = {},
): Promise<CliUpdateOutcome> {
  const hostLabel = deps.hostLabel ?? hostname() ?? 'this host';
  const run = deps.run ?? defaultRun;
  const probeVersion = deps.probeVersion ?? defaultProbeVersion;
  const listCandidates = deps.listCandidates ?? listCliBinCandidates;
  const detectMethod = deps.detectMethod ?? detectInstallMethod;
  const invalidateResolved = deps.invalidateResolved ?? invalidateCliBinCache;
  const log = deps.log ?? (() => {});
  const attempts: CliUpdateAttempt[] = [];

  const fail = (detail: string, extra: Partial<CliUpdateOutcome> = {}): CliUpdateOutcome => ({
    supported: false,
    ok: false,
    before: null,
    after: null,
    detail,
    hostLabel,
    resolvedPath: null,
    installMethod: null,
    needsSudo: false,
    sudoFailure: null,
    attempts,
    otherInstalls: [],
    ...extra,
  });

  let adapter;
  let updater: { args: string[]; label: string } | null = null;
  let pkg: string | null = null;
  let bin: string;
  try {
    adapter = createAdapter(cli);
    updater = adapter.cliUpdate();
    pkg = adapter.updatePackage();
    bin = options.bin || adapter.resolveBin();
  } catch (err: any) {
    return fail(`cannot resolve ${cli}: ${err?.message ?? err}`);
  }

  const method = detectMethod(bin, pkg);
  // 권한 상승으로 올릴 수 있고, 이번 호출에 비밀번호를 받아올 수단이 함께 왔는가.
  // 둘 중 하나라도 없으면 이 설치본은 지금 올릴 수 없다.
  const canElevate = Boolean(method.elevatedArgv) && Boolean(options.getSudoPassword);
  // 올릴 방법이 아예 없다 — 자체 업데이터도, 증명된 설치 방법도, 권한 상승도.
  // 조용히 성공한 척하지 않고 무엇을 해야 하는지 그대로 알려준다.
  if ((!updater || managedElsewhere(method)) && !method.argv && !canElevate) {
    return fail(
      method.manualCommand
        ? `${cli} at ${bin} is a ${method.label}; AWB cannot update it from here — run: ${method.manualCommand} (on ${hostLabel})`
        : `${cli} at ${bin} has no self-updater and its install layout is not recognised — update it on ${hostLabel} yourself`,
      {
        resolvedPath: bin,
        installMethod: describeInstallMethod(method),
        needsSudo: Boolean(method.elevatedArgv),
      },
    );
  }

  const before = await probeVersion(bin);
  log(
    `[cli-update] ${cli} at ${bin} (current ${before ?? 'unknown'}) — install method: ` +
      `${describeInstallMethod(method)}`,
  );

  const attempt = async (label: string, cmd: string, args: string[]): Promise<boolean> => {
    const printable = `${cmd} ${args.join(' ')}`.trim();
    log(`[cli-update] ${cli}: trying ${label} — ${printable}`);
    const r = await run(cmd, args, CLI_UPDATE_TIMEOUT_MS);
    attempts.push({ method: label, command: printable, ok: r.ok, output: tail(r.output) });
    return r.ok;
  };

  // 1) 설치 레이아웃에서 증명된 방법이 있으면 그것부터 — 대상이 정확하고 다른
  //    설치본을 건드리지 않는다. 실패했을 때만 CLI 자체 업데이터로 물러선다
  //    (npm 재설치가 성공했는데 버전이 그대로면 그건 이미 최신이라는 뜻이다).
  let sudoFailure: SudoFailure | null = null;
  if (method.argv) {
    const ok = await attempt(method.label, method.argv.cmd, method.argv.args);
    if (!ok && updater) await attempt(`${updater.label} (fallback)`, bin, updater.args);
  } else if (canElevate && method.elevatedArgv) {
    // 권한 상승 경로. 비밀번호는 **여기서 처음** 당겨 온다 — 이 분기에 오지 않으면
    // 티켓은 소비되지 않는다. 받아 온 원문은 runWithSudo 안에서 stdin 으로만 나가고,
    // 이 스코프 밖으로는 새지 않는다(ack·로그·outcome 어디에도 담지 않는다).
    const password = await options.getSudoPassword!().catch(() => null);
    if (!password) {
      return fail(
        `${cli} at ${bin} needs root to update (${method.label}) but no usable sudo ticket arrived — ` +
          'press Update again and enter the password.',
        {
          supported: true,
          resolvedPath: bin,
          installMethod: describeInstallMethod(method),
          needsSudo: true,
        },
      );
    }
    const printable = `sudo ${method.elevatedArgv.cmd} ${method.elevatedArgv.args.join(' ')}`.trim();
    log(`[cli-update] ${cli}: trying ${method.label} with elevation — ${printable}`);
    const r = await (deps.runSudo ?? runWithSudo)(method.elevatedArgv, password);
    sudoFailure = r.reason;
    attempts.push({
      method: `${method.label} (sudo)`,
      command: printable,
      ok: r.ok,
      output: tail(r.output),
    });
  } else if (updater && !managedElsewhere(method)) {
    // 2) 증명이 안 되는 설치(native installer, curl 설치)는 CLI 자신이 제일 잘 안다.
    await attempt(updater.label, bin, updater.args);
  }
  // 3) snap / Homebrew / 쓰기 권한 없는 prefix 는 **아무것도 돌리지 않는다.**
  //    이런 설치본에 CLI 자체 업데이터를 돌리면 제자리를 갈아 끼우는 게 아니라
  //    PATH 위 npm prefix 에 새 설치를 만든다 — ragnar 에서 본 것과 똑같이
  //    "성공했는데 대상은 그대로" 가 되고, 덤으로 남의 설치본을 건드린다.

  // 자체 업데이터가 설치 위치를 옮기는 일이 실제로 있다(Claude Code 의 npm →
  // native installer 이전). 경로를 지정받지 않았을 때만 다시 해석한다 —
  // 지정받았다면 그 경로가 곧 대상이다.
  let target = bin;
  if (!options.bin) {
    invalidateResolved(cli);
    try {
      target = adapter.resolveBin();
    } catch {
      /* 업데이터가 설치를 망가뜨렸을 수도 있다 — 이전 경로로 계속 읽어 본다. */
    }
  }
  let after = await probeVersion(target);

  // 같은 CLI 의 다른 설치본 — 정보다, 실패가 아니다. vLLM 용 두 번째 claude 처럼
  // 일부러 둔 것일 수 있으므로 운영자가 직접 판단하게 한다.
  const mine = canonicalPathKey(target);
  const otherInstalls: Array<{ path: string; version: string | null }> = [];
  for (const candidate of listCandidates(candidateKeyFor(cli, target))) {
    if (canonicalPathKey(candidate) === mine) continue;
    otherInstalls.push({ path: candidate, version: await probeVersion(candidate) });
  }

  const lastAttempt = attempts[attempts.length - 1];
  const changed = (compareCliVersions(after, before) ?? (after === before ? 0 : 1)) !== 0;
  // 버전이 안 움직인 것은 두 가지 뜻이다: **이미 최신** 이거나 **못 올렸거나**.
  // 최신 버전을 알면 둘을 가를 수 있다. 모르면 업데이터의 종료 코드를 믿는
  // 수밖에 없는데, 그걸 믿은 것이 정확히 ragnar 회귀였으므로 detail 에 그
  // 불확실성을 적는다.
  // `latest` 는 **이 설치본의 채널 기준** 최신이다(호출자가 그렇게 골라서 넘긴다 —
  // npm 설치본은 npm 레지스트리, snap 은 추적 채널의 `snap info`). 그래서 여기서는
  // 채널을 다시 따지지 않는다. 값이 없으면 "모른다" 로 두고 업데이터의 말을 믿되,
  // 그 불확실성을 detail 에 적는다.
  const latest = options.latest ?? null;
  const atLatest = latest ? (compareCliVersions(after, latest) ?? -1) >= 0 : null;
  // 여기까지 왔으면 반드시 한 번은 시도했다 — 시도할 방법이 하나도 없는 설치본은
  // 위에서 이미 돌아갔다(managedElsewhere / 업데이터 없음).
  // 권한 상승이 실패했으면 버전 비교로 덮지 않는다. 비밀번호가 틀려서 아무것도
  // 안 돌았는데 "이미 최신" 으로 읽히면, 운영자는 올라간 줄 알고 넘어간다.
  const ok =
    sudoFailure === null && (changed || (atLatest === null ? Boolean(lastAttempt?.ok) : atLatest));

  let detail: string;
  if (sudoFailure === 'bad_password') {
    detail = `${cli} at ${target}: the sudo password was rejected — nothing was changed.`;
  } else if (sudoFailure === 'not_permitted') {
    detail =
      `${cli} at ${target}: this account may not run that command as root on ${hostLabel} ` +
      `(${method.manualCommand ?? method.label}) — nothing was changed.`;
  } else if (sudoFailure === 'no_sudo') {
    detail = `${cli} at ${target}: no sudo on ${hostLabel}, so this install cannot be updated from AWB.`;
  } else if (sudoFailure) {
    detail =
      `${cli} at ${target} is still ${after ?? 'unknown'} — ` +
      `${lastAttempt?.method ?? 'sudo'}: ${lastAttempt?.output || sudoFailure}`;
  } else if (changed) {
    detail = `${cli} ${before ?? 'unknown'} → ${after} at ${target} (${lastAttempt?.method ?? 'update'})`;
  } else if (ok) {
    detail =
      `${cli} stays at ${after ?? before ?? 'unknown'} at ${target} — already current` +
      (atLatest === null
        ? ` per ${lastAttempt?.method ?? 'the updater'} (latest version unknown, so this is the updater's word)`
        : ` (latest ${latest})`);
  } else {
    detail =
      `${cli} at ${target} is still ${after ?? 'unknown'}` +
      (latest ? ` while the latest available is ${latest}` : '') +
      ' — ' +
      attempts.map((a) => `${a.method}: ${a.ok ? 'ok but no change' : a.output || 'failed'}`).join(' | ') +
      (method.manualCommand ? ` — run on ${hostLabel}: ${method.manualCommand}` : '');
  }

  log(`[cli-update] ${cli} ${ok ? 'ok' : 'FAILED'}: ${detail}`);

  return {
    supported: true,
    ok,
    before,
    after,
    detail,
    hostLabel,
    resolvedPath: target,
    installMethod: describeInstallMethod(method),
    needsSudo: Boolean(method.elevatedArgv),
    sudoFailure,
    attempts,
    otherInstalls,
  };
}
