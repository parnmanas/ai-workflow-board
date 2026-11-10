// Agent Session 이 실제로 띄울 **claude 실행 파일** — 장비의 claude 와 어댑터가 번들한 CLI 중 하나.
//
// 배경(2026-11-10 실측): claude-agent-acp 는 `@anthropic-ai/claude-agent-sdk` 를 쓰고, 그 SDK 는
// **자기 버전의 claude 네이티브 바이너리를 같이 깐다**(`claude-agent-sdk-<platform>-<arch>/claude`).
// 어댑터는 `CLAUDE_CODE_EXECUTABLE` 이 없으면 그 바이너리를 띄우므로, 세션의 모델 목록 ·
// 기능은 **어댑터가 번들한 CLI 버전**이 정했다 — 장비에 깔린 `claude`(운영자가 `claude update` 로
// 올리는 것, 하트비트가 모델을 스캔하는 것, 티켓 디스패치가 `claude -p` 로 띄우는 것)와는
// 다른 파일이다. 그래서 같은 계정 · 같은 credential 인데도 호스트마다 세션 모델 목록이 달랐다:
// rolf/ralf 는 어댑터 0.102.0(SDK CLI 2.1.321, `claude-fable-5-2` 를 안다) 이라 Fable 5.2 가
// 보이고, ragnar 는 어댑터 0.101.0(SDK CLI 2.1.318) 이라 Fable 5.1 까지만 보였다. 호스트 `claude`
// 를 올려도 세션에는 아무 변화가 없었고, 반대로 "ACP 어댑터 업데이트" 가 모델 목록을 바꿨다 —
// 운영자가 짐작할 수 없는 레버다.
//
// 규칙: **장비의 claude 가 어댑터 번들 CLI 보다 같거나 새로우면 장비의 claude 를 쓴다.**
//   - 그러면 세션 · 티켓 · 하트비트 모델 스캔이 **한 바이너리**를 보고, `claude update`(화면의
//     CLI Update 포함) 하나가 셋 모두의 레버다.
//   - 장비의 claude 가 더 오래됐으면 번들 CLI 를 그대로 쓴다 — SDK 는 자기 세대의 CLI 플래그를
//     전제로 spawn 하므로 더 오래된 CLI 에 물리면 세션이 시작조차 못 할 수 있다(모르는 플래그).
//     이때는 로그로 "claude 를 올리라" 고 알린다. 조용히 넘어가지 않는다.
//   - claude 가 없는 장비(매니저만 있는 장비)는 예전처럼 번들 CLI 로 세션을 연다.
//   - 운영자가 `CLAUDE_CODE_EXECUTABLE` 을 매니저 env 에 직접 두었으면 그것이 이긴다(호출자가
//     이미 있는 키를 덮지 않는다).
//
// 버전은 `--version` 으로 잰다(파일 mtime 이 바뀌면 다시 잰다 — `claude update` 직후 반영).
// 어댑터 번들 CLI 의 위치는 SDK 와 같은 규칙으로 찾는다(어댑터 entry 기준 require 해석).

import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { resolveCliBin } from '../../cli-resolver.js';
import { REAL_SHIM_IO, resolveShimTarget } from '../../cli-adapters/model-introspect.js';
import { log } from '../../logging.js';
import { compareVersions } from '../bundled-acp.js';

export interface ClaudeExecutableCandidate {
  path: string;
  /** `--version` 의 semver. 못 읽었으면 null. */
  version: string | null;
}

export interface ClaudeExecutableDecision {
  /** 세션이 띄울 파일. `host` 면 `CLAUDE_CODE_EXECUTABLE` 로 넘긴다; `bundled` 면 env 를 더하지 않는다. */
  use: 'host' | 'bundled';
  /** 로그 한 줄에 쓸 사유 — 운영자가 "왜 이 파일인가" 를 알 수 있어야 한다. */
  why: string;
  host: ClaudeExecutableCandidate | null;
  bundled: ClaudeExecutableCandidate | null;
}

/** Windows 셸 shim — SDK 가 직접 spawn 하지 못한다(`.cmd` 는 EINVAL, `.ps1` 은 실행 파일이 아니다). */
const SHELL_SHIM_RE = /\.(cmd|bat|ps1)$/i;

/**
 * 순수 판정. 입력은 "찾았는가 · 버전을 읽었는가" 뿐이고 I/O 가 없어 표로 테스트한다.
 */
export function chooseSessionClaude(
  host: ClaudeExecutableCandidate | null,
  bundled: ClaudeExecutableCandidate | null,
): ClaudeExecutableDecision {
  if (!host) {
    return { use: 'bundled', why: 'no claude found on this host — using the CLI bundled with the ACP adapter', host, bundled };
  }
  if (SHELL_SHIM_RE.test(host.path)) {
    return {
      use: 'bundled',
      why: `host claude resolves to a shell shim (${host.path}) that the SDK cannot spawn — using the adapter's bundled CLI`,
      host,
      bundled,
    };
  }
  if (!host.version) {
    return {
      use: 'bundled',
      why: `could not read the version of host claude ${host.path} — using the adapter's bundled CLI`,
      host,
      bundled,
    };
  }
  if (!bundled?.version) {
    return { use: 'host', why: `host claude ${host.version} (adapter bundled CLI version unknown)`, host, bundled };
  }
  const cmp = compareVersions(host.version, bundled.version);
  if (cmp !== null && cmp < 0) {
    return {
      use: 'bundled',
      why:
        `host claude ${host.version} is older than the CLI bundled with the ACP adapter (${bundled.version}) — ` +
        'using the bundled CLI; run `claude update` on this host so sessions, tickets and model scans share one claude',
      host,
      bundled,
    };
  }
  return { use: 'host', why: `host claude ${host.version} (adapter bundled CLI ${bundled.version})`, host, bundled };
}

/** 테스트가 갈아끼우는 I/O. 기본은 실제 cli-resolver · 파일 · `--version`. */
export interface SessionClaudeIO {
  /** 장비의 claude 실행 파일(shim 을 따라간 실제 파일). 없으면 null. */
  hostClaude: () => string | null;
  /** 어댑터 entry(js) 기준으로 SDK 가 번들한 claude 바이너리. 없으면 null. */
  bundledClaude: (adapterEntry: string | null) => string | null;
  /** 실행 파일의 `--version` semver. 실패는 null. */
  version: (path: string) => Promise<string | null>;
}

function defaultHostClaude(): string | null {
  let bin: string;
  try {
    bin = resolveCliBin('claude');
  } catch {
    return null;
  }
  const target = resolveShimTarget(bin, REAL_SHIM_IO);
  try {
    return statSync(target).isFile() ? target : null;
  } catch {
    return null;
  }
}

/**
 * SDK 의 `installedClaudeCliPath()` 와 같은 규칙: 어댑터 → `@anthropic-ai/claude-agent-sdk` →
 * `@anthropic-ai/claude-agent-sdk-<platform>-<arch>[-musl]` 의 `claude[.exe]`.
 * 어느 단계든 못 찾으면 null — 번들 버전을 "모른다" 로 접고 판정은 chooseSessionClaude 가 한다.
 */
export function defaultBundledClaude(adapterEntry: string | null): string | null {
  if (!adapterEntry) return null;
  // 플랫폼 패키지는 보통 어댑터 옆에 hoist 돼 있다. 아니면 SDK 자신의 위치에서 다시 찾는다
  // (SDK 의 `exports` 가 `./package.json` 을 막으므로 entry(`sdk.mjs`)로 해석한다).
  const resolvers: NodeJS.Require[] = [];
  try {
    const fromAdapter = createRequire(adapterEntry);
    resolvers.push(fromAdapter);
    try {
      resolvers.push(createRequire(fromAdapter.resolve('@anthropic-ai/claude-agent-sdk')));
    } catch {
      /* 어댑터가 SDK 를 번들하지 않는 레이아웃 */
    }
  } catch {
    return null;
  }
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  for (const resolver of resolvers) {
    for (const pkg of [base, `${base}-musl`]) {
      try {
        const manifest = resolver.resolve(`${pkg}/package.json`);
        const bin = join(dirname(manifest), process.platform === 'win32' ? 'claude.exe' : 'claude');
        if (statSync(bin).isFile()) return bin;
      } catch {
        /* 다음 후보 */
      }
    }
  }
  return null;
}

/** `--version` 은 네이티브 바이너리 콜드 스타트라 느릴 수 있다 — 짧은 probe 한도(2.5초)를 쓰지 않는다. */
const VERSION_TIMEOUT_MS = 20_000;

const versionCache = new Map<string, { mtimeMs: number; version: string | null }>();

async function defaultVersion(path: string): Promise<string | null> {
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  const cached = versionCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) return cached.version;
  const version = await new Promise<string | null>((resolve) => {
    // `.js` entry(npm 설치의 cli.js)는 node 로 띄운다 — SDK 도 같은 구분을 한다.
    const viaNode = /\.(m?js)$/i.test(path);
    execFile(
      viaNode ? process.execPath : path,
      viaNode ? [path, '--version'] : ['--version'],
      { timeout: VERSION_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return resolve(null);
        const m = /(\d+)\.(\d+)\.(\d+)/.exec(`${stdout}\n${stderr}`);
        resolve(m ? `${m[1]}.${m[2]}.${m[3]}` : null);
      },
    );
  });
  versionCache.set(path, { mtimeMs, version });
  return version;
}

export const REAL_SESSION_CLAUDE_IO: SessionClaudeIO = {
  hostClaude: defaultHostClaude,
  bundledClaude: defaultBundledClaude,
  version: defaultVersion,
};

/** 테스트 전용 — mtime 캐시를 비운다. */
export function _resetSessionClaudeCacheForTests(): void {
  versionCache.clear();
  lastLogged = null;
}

let lastLogged: string | null = null;

/**
 * 세션 spawn 마다 부른다(버전은 캐시). 결정이 바뀔 때만 로그 — 어느 파일을 왜 쓰는지가
 * 매니저 로그에 한 번은 남아야 "모델 목록이 왜 이런가" 를 추적할 수 있다.
 */
export async function decideSessionClaude(
  adapterEntry: string | null,
  io: SessionClaudeIO = REAL_SESSION_CLAUDE_IO,
): Promise<ClaudeExecutableDecision> {
  const hostPath = io.hostClaude();
  const bundledPath = io.bundledClaude(adapterEntry);
  const [hostVersion, bundledVersion] = await Promise.all([
    hostPath ? io.version(hostPath) : Promise.resolve(null),
    bundledPath ? io.version(bundledPath) : Promise.resolve(null),
  ]);
  const decision = chooseSessionClaude(
    hostPath ? { path: hostPath, version: hostVersion } : null,
    bundledPath ? { path: bundledPath, version: bundledVersion } : null,
  );
  const line = `[claude] sessions use ${decision.use === 'host' ? decision.host!.path : (bundledPath ?? "the adapter's bundled CLI")} — ${decision.why}`;
  if (line !== lastLogged) {
    lastLogged = line;
    log(line);
  }
  return decision;
}

/** `decideSessionClaude` 를 어댑터 env 로 바꾼다 — host 면 `CLAUDE_CODE_EXECUTABLE`, bundled 면 빈 객체. */
export function sessionClaudeEnv(decision: ClaudeExecutableDecision): Record<string, string> {
  return decision.use === 'host' && decision.host ? { CLAUDE_CODE_EXECUTABLE: decision.host.path } : {};
}
