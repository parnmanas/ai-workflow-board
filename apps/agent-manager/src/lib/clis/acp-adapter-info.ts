// "이 장비는 어느 ACP 어댑터를 어느 버전으로 쓰는가" — 하트비트 `acp_adapters`.
//
// 왜 필요한가: 어댑터 버전이 세션의 capability(모델 목록 · mode · config option)를
// **실제로** 정한다. 어댑터는 모델 id 를 자기 번들에 하드코딩하므로, 어댑터가
// 뒤처지면 CLI 바이너리에 있는 새 모델도 세션에서 고를 수 없다. 2026-10-01 에
// 세 호스트 모두 claude-agent-acp 0.79.0 (최신 0.84.0) 이었고, 아무도 그 사실을
// 볼 수 없었다 — AWB 는 CLI 버전만 보고했고 어댑터는 "있다/없다" 만 봤다.
// 그래서 5버전이 조용히 썩었다.
//
// 이제 어댑터는 매니저의 의존성으로 번들되어 함께 올라간다(bundled-acp.ts). 그러면
// 이 보고의 역할이 하나 더 생긴다: **번들본이 실제로 쓰이고 있는지** 확인하는 것.
// PATH 에 옛 전역 설치가 남아 있어도 번들본이 이기도록 해석 순서를 바꿨으므로,
// `source` 가 'path' 로 나오면 그 매니저는 번들이 없는 구버전이라는 뜻이다.
//
// **업데이트 경로에 대한 중요한 사실**: 번들본을 쓰는 매니저에서 어댑터만 따로
// `npm i -g` 해도 **아무 효과가 없다**(번들본이 이긴다). 올리는 유일한 경로는
// 매니저를 올리는 것이고, 매니저가 가져오는 버전은 AWB 저장소의 의존성 범위가
// 정한다. 그래서 화면은 "어댑터 Update 버튼" 을 내놓아선 안 된다 — 눌러도 안 되는
// 버튼이 된다. 대신 뒤처짐을 보여주고, 그것이 AWB 쪽 범위 조정 사항임을 말한다.

import { createRequire } from 'node:module';

import { cliSessions, listCliModules } from './index.js';
import { resolveBundledAcpCommand } from './bundled-acp.js';

const require_ = createRequire(import.meta.url);

/** 하트비트에 싣는 어댑터 한 줄. server·agent-manager 공동 contract. */
export interface AcpAdapterEntry {
  /** 이 어댑터를 쓰는 CLI (claude / codex …). */
  cli: string;
  /** npm 패키지 이름. 패키지로 배포되지 않는 어댑터는 null(예: opencode 내장). */
  package: string | null;
  /** 지금 쓰이는 어댑터의 버전. 읽을 수 없으면 null(npx·env override 등). */
  version: string | null;
  /**
   * 어디서 온 어댑터인가 — 해석 순서와 같은 어휘다.
   *   override: env AWB_ACP_COMMAND_<CLI> 가 정했다 (운영자가 고정한 것)
   *   bundled : 매니저와 함께 설치된 것 (정상 상태)
   *   path    : 장비에 전역 설치된 것 (번들 없는 구버전 매니저)
   *   npx     : 그때그때 당겨오는 것 (설치돼 있지 않다)
   *   builtin : CLI 자신이 ACP 를 내장한다 (별도 어댑터 없음)
   */
  source: 'override' | 'bundled' | 'path' | 'npx' | 'builtin';
}

/** CLI → 어댑터 npm 패키지. 모듈 선언에서 끌어낼 수 없는 유일한 값이라 여기 둔다
 *  (resolveAcpCommand 는 명령만 돌려주고 패키지 이름은 그 안에 숨어 있다). 새 ACP
 *  CLI 를 추가하면 여기도 한 줄 — 빠지면 그 어댑터의 버전이 화면에서 사라진다. */
const ADAPTER_PACKAGES: Readonly<Record<string, { pkg: string; bin: string }>> = {
  claude: { pkg: '@agentclientprotocol/claude-agent-acp', bin: 'claude-agent-acp' },
  codex: { pkg: '@agentclientprotocol/codex-acp', bin: 'codex-acp' },
};

/** 이 빌드가 어댑터 버전을 보고할 수 있는 패키지들 — npm latest 조회 대상. */
export function acpAdapterPackages(): string[] {
  return [...new Set(Object.values(ADAPTER_PACKAGES).map((a) => a.pkg))];
}

/**
 * 지금 이 장비가 쓰는 ACP 어댑터들. **spawn 하지 않는다** — 파일만 읽는다
 * (하트비트 경로이므로 느려지거나 던지면 안 된다).
 *
 * `findOnPath` 를 받는 이유는 PATH 해석을 호출자(런타임)와 공유하기 위해서다.
 */
export async function collectAcpAdapters(
  findOnPath: (name: string) => Promise<string | null>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AcpAdapterEntry[]> {
  const out: AcpAdapterEntry[] = [];
  for (const module of listCliModules()) {
    const sessions = cliSessions(module.id);
    if (!sessions) continue;
    const known = ADAPTER_PACKAGES[module.id];
    if (!known) {
      // ACP 세션은 되는데 별도 어댑터 패키지가 없는 CLI(opencode 처럼 CLI 가 ACP 를
      // 내장). 버전은 CLI 버전과 같으므로 여기서 또 보고하지 않는다.
      out.push({ cli: module.id, package: null, version: null, source: 'builtin' });
      continue;
    }
    if (env[`AWB_ACP_COMMAND_${module.id.toUpperCase()}`]?.trim()) {
      // 운영자가 명령을 고정했다 — 그 경로의 버전은 우리가 알 수 없다.
      out.push({ cli: module.id, package: known.pkg, version: null, source: 'override' });
      continue;
    }
    const bundled = resolveBundledAcpCommand(known.pkg, known.bin);
    if (bundled) {
      out.push({ cli: module.id, package: known.pkg, version: readVersion(known.pkg), source: 'bundled' });
      continue;
    }
    const onPath = await findOnPath(known.bin).catch(() => null);
    out.push({
      cli: module.id,
      package: known.pkg,
      // PATH 설치본의 버전은 그 실행 파일에서 패키지 루트를 거슬러 올라가야 읽을 수
      // 있다. 번들이 없는 구버전 매니저용 경로라 깊이 파지 않는다 — source 가
      // 'path' 라는 사실만으로 운영자는 "매니저를 올려 번들을 받으라" 를 안다.
      version: null,
      source: onPath ? 'path' : 'npx',
    });
  }
  return out;
}

/** 번들된 패키지의 version. 못 읽으면 null. */
function readVersion(pkg: string): string | null {
  try {
    const manifest = require_(`${pkg}/package.json`) as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}
