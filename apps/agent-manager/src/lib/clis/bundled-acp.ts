// 매니저와 **함께 설치되는** ACP 어댑터를 찾는다.
//
// 왜 필요한가: 예전에는 어댑터를 PATH 에서 이름으로만 찾았다
// (`findOnPath('claude-agent-acp')`). 어댑터는 매니저와 **무관하게** 전역 설치된
// 별개 패키지였고, 매니저를 몇 번 올려도 어댑터는 그대로였다. 그래서 아무도 모르게
// 5버전(0.79 → 0.84) 뒤처졌고, 그 번들이 모델 id 를 하드코딩하고 있었기 때문에
// 세션 안 모델 목록이 새 모델(claude-opus-5-5)을 영영 모른 채로 남았다 — CLI
// 바이너리에는 있는데도. 어댑터 버전은 세션의 capability(모델·mode·config option)를
// 실제로 정하는 값이라, 매니저와 함께 움직이지 않으면 안 된다.
//
// 그래서 어댑터를 `awb-agent-manager` 의 **의존성**으로 선언하고, 여기서 그 번들본을
// 먼저 찾는다. `npm i -g awb-agent-manager` 한 번이 매니저와 어댑터를 같이 올린다.
//
// 해석 순서(agent-session-runner.ts `resolveAcpCommandForCli`):
//   1. env `AWB_ACP_COMMAND_<CLI>` — 운영자 탈출구(여전히 최우선)
//   2. **번들본** ← 이 모듈
//   3. PATH 의 어댑터 바이너리 — 번들이 없는 구버전 설치/수동 설치 호환
//   4. `npx --yes <pkg>` — 마지막 수단
//
// `node <js>` 로 띄운다(bin 심링크나 셸 shim 을 거치지 않는다): Windows 에서 npm 이
// 만드는 것은 실행 파일이 아니라 `.cmd`/`.ps1` shim 이고, 번들본은 아예 bin 링크가
// 없을 수도 있다(중첩 node_modules). 패키지의 `bin` 이 가리키는 js 를 직접 돌리면
// 플랫폼 분기가 사라진다.

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';

import type { CliAcpCommand } from './cli-module.js';

const require_ = createRequire(import.meta.url);

/**
 * 이 매니저와 함께 설치된 `pkg` 의 ACP 어댑터 실행 명령. 못 찾으면 null —
 * 호출자는 기존 PATH/npx 경로로 떨어진다(판단은 항상 best-effort 다).
 *
 * `binName` 은 `bin` 이 객체일 때 고를 키. 생략하면 첫 항목을 쓴다.
 */
export function resolveBundledAcpCommand(pkg: string, binName?: string): CliAcpCommand | null {
  let manifestPath: string;
  try {
    // `main`/`exports` 가 아니라 package.json 을 해석한다 — 어댑터의 exports 맵이
    // 내부 경로를 가리지 않는다는 보장이 없고(claude-agent-acp 는 exports 를 쓴다),
    // 우리가 필요한 것은 런타임 모듈이 아니라 **파일 경로**다.
    manifestPath = require_.resolve(`${pkg}/package.json`);
  } catch {
    return null;
  }
  let manifest: { bin?: unknown };
  try {
    manifest = require_(manifestPath) as { bin?: unknown };
  } catch {
    return null;
  }
  const rel = pickBin(manifest.bin, binName);
  if (!rel) return null;
  const entry = normalize(join(dirname(manifestPath), rel));
  if (!existsSync(entry)) return null;
  // process.execPath = 지금 매니저를 돌리는 node. 어댑터는 매니저와 같은 런타임에서
  // 돌아야 한다(nvm 으로 여러 벌 깔린 호스트에서 PATH 의 node 는 다른 버전일 수 있다).
  return { command: process.execPath, args: [entry] };
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
