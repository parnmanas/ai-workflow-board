// ACP 어댑터를 **어디서** 띄울지 정한다.
//
// 배경: 어댑터는 모델 id 를 자기 번들에 하드코딩하므로 **어댑터 버전이 세션의 모델 목록·
// capability 를 정한다**. 예전에는 PATH 에서 이름으로만 찾았고 매니저와 무관한 전역 패키지라
// 아무도 모르게 5버전 썩었다(0.79 → 0.84, Opus 5.5 가 세션에 안 떴다). 그래서 어댑터를
// 매니저의 의존성으로 번들했다(83b519f4). 하지만 범위가 `^0.84.0` 이라 0.85 가 나와도 매니저를
// 다시 깔아도 따라오지 않았고 — **운영자가 어댑터를 올릴 방법은 여전히 없었다.**
//
// 그래서 두 번째 출처를 둔다: **매니저 홈에 운영자가 설치한 어댑터**(`managed`).
// `update_acp_adapter` 커맨드가 `npm install --prefix <home>/acp-adapters <pkg>@latest` 로
// 여기에 설치한다. 패키지 디렉터리가 아니라 홈에 두는 이유는 **매니저 업데이트에도 살아남게**
// 하기 위해서다(`npm i -g awb-agent-manager` 는 패키지 디렉터리를 통째로 갈아엎는다).
//
// 둘 다 있으면 **더 새 것**을 쓴다. 그래야
//   - 운영자가 올린 어댑터가 매니저 재설치로 조용히 되돌아가지 않고,
//   - 나중에 매니저 번들이 더 새 버전을 가져오면 낡은 홈 설치본이 그것을 가리지 않는다.
// 버전을 비교할 수 없으면 번들본을 쓴다(매니저와 함께 검증된 쪽이 안전하다).
//
// 해석 순서(agent-session-runner.ts `resolveAcpCommandForCli`):
//   1. env `AWB_ACP_COMMAND_<CLI>` — 운영자 탈출구(여전히 최우선)
//   2. managed / bundled 중 더 새 것 ← 이 모듈
//   3. PATH 의 어댑터 바이너리 — 둘 다 없는 구버전 설치 호환
//   4. `npx --yes <pkg>` — 마지막 수단
//
// `node <js>` 로 띄운다(bin 심링크·셸 shim 을 거치지 않는다): Windows 에서 npm 이 만드는 것은
// 실행 파일이 아니라 `.cmd`/`.ps1` shim 이고, 중첩 node_modules 에는 bin 링크가 없을 수 있다.

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';

import { AGENT_MANAGER_HOME } from '../constants.js';
import type { CliAcpCommand } from './cli-module.js';

const require_ = createRequire(import.meta.url);

/** 운영자가 올린 어댑터를 두는 곳. 테스트는 `AWB_ACP_ADAPTERS_DIR` 로 격리한다. */
export function managedAdapterRoot(): string {
  return process.env.AWB_ACP_ADAPTERS_DIR?.trim() || join(AGENT_MANAGER_HOME, 'acp-adapters');
}

export interface ResolvedAcpAdapter extends CliAcpCommand {
  version: string | null;
  source: 'managed' | 'bundled';
}

/** 매니저와 함께 설치된(번들) 어댑터. 없으면 null. */
export function resolveBundledAcpCommand(pkg: string, binName?: string): CliAcpCommand | null {
  const found = bundledAdapter(pkg, binName);
  return found ? { command: found.command, args: found.args } : null;
}

/** 매니저 홈에 운영자가 설치한 어댑터. 없으면 null. */
export function resolveManagedAcpAdapter(pkg: string, binName?: string): ResolvedAcpAdapter | null {
  const manifestPath = join(managedAdapterRoot(), 'node_modules', ...pkg.split('/'), 'package.json');
  if (!existsSync(manifestPath)) return null;
  return fromManifest(manifestPath, binName, 'managed');
}

/**
 * 실제로 띄울 어댑터 — managed 와 bundled 중 **더 새 것**. 둘 다 없으면 null(호출자는
 * PATH/npx 로 떨어진다). 비교할 수 없으면 bundled.
 */
export function resolveAcpAdapter(pkg: string, binName?: string): ResolvedAcpAdapter | null {
  const managed = resolveManagedAcpAdapter(pkg, binName);
  const bundled = bundledAdapter(pkg, binName);
  if (!managed) return bundled;
  if (!bundled) return managed;
  const cmp = compareVersions(managed.version, bundled.version);
  return cmp !== null && cmp > 0 ? managed : bundled;
}

function bundledAdapter(pkg: string, binName?: string): ResolvedAcpAdapter | null {
  let manifestPath: string;
  try {
    // `main`/`exports` 가 아니라 package.json 을 해석한다 — 어댑터의 exports 맵이 내부 경로를
    // 가리지 않는다는 보장이 없고, 우리가 필요한 것은 런타임 모듈이 아니라 **파일 경로**다.
    manifestPath = require_.resolve(`${pkg}/package.json`);
  } catch {
    return null;
  }
  return fromManifest(manifestPath, binName, 'bundled');
}

/**
 * package.json 에서 실행 명령과 버전을 만든다. **require 가 아니라 디스크에서 매번 읽는다** —
 * require 캐시를 타면 어댑터를 올린 직후에도 옛 버전을 보고하고 옛 entry 를 고른다.
 */
function fromManifest(
  manifestPath: string,
  binName: string | undefined,
  source: 'managed' | 'bundled',
): ResolvedAcpAdapter | null {
  let manifest: { bin?: unknown; version?: unknown };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin?: unknown; version?: unknown };
  } catch {
    return null;
  }
  const rel = pickBin(manifest.bin, binName);
  if (!rel) return null;
  const entry = normalize(join(dirname(manifestPath), rel));
  if (!existsSync(entry)) return null;
  // process.execPath = 지금 매니저를 돌리는 node. 어댑터는 매니저와 같은 런타임에서 돌아야 한다
  // (nvm 으로 여러 벌 깔린 호스트에서 PATH 의 node 는 다른 버전일 수 있다).
  return {
    command: process.execPath,
    args: [entry],
    version: typeof manifest.version === 'string' ? manifest.version : null,
    source,
  };
}

/** `bin` 필드에서 실행할 상대 경로 하나를 고른다. 문자열·객체 양쪽을 받는다. */
function pickBin(bin: unknown, binName?: string): string | null {
  if (typeof bin === 'string') return bin.trim() || null;
  if (!bin || typeof bin !== 'object') return null;
  const map = bin as Record<string, unknown>;
  const candidate = binName && typeof map[binName] === 'string' ? (map[binName] as string) : null;
  const first = Object.values(map).find((v): v is string => typeof v === 'string' && v.trim().length > 0);
  const rel = (candidate ?? first ?? '').trim();
  // 절대 경로를 쓰는 패키지는 없지만, 있다면 join 이 망가진다 — 그대로 거부한다.
  return rel && !isAbsolute(rel) ? rel : null;
}

/** `1.2.3` 코어만 비교한다. 어느 한쪽이라도 못 읽으면 null("비교 불가" ≠ "같다"). */
export function compareVersions(a: string | null, b: string | null): number | null {
  const pa = /(\d+)\.(\d+)\.(\d+)/.exec(a ?? '');
  const pb = /(\d+)\.(\d+)\.(\d+)/.exec(b ?? '');
  if (!pa || !pb) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return d;
  }
  return 0;
}
