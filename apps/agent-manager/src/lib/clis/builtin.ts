// 이 빌드가 아는 CLI 모듈 목록 — **새 CLI 는 여기 한 줄만 추가한다.**
//
// 순서가 곧 `KNOWN_CLI_IDS` 순서다(하트비트·로그·프로브 순서). 레지스트리 조립은
// `runtime/composition/builtin-plugins.ts` 가, 조회는 `clis/index.ts` 가 맡는다.
// 이 파일은 레지스트리를 import 하지 않는다 — 조립 쪽이 이 파일을 import 하므로
// 반대 방향 의존이 생기면 순환이다.

import { registerCliBinarySpec } from '../cli-resolver.js';
import { antigravityModule } from './antigravity/index.js';
import { claudeModule } from './claude/index.js';
import type { CliModule } from './cli-module.js';
import { codexModule } from './codex/index.js';
import { deepseekModule } from './deepseek/index.js';
import { hermesModule } from './hermes/index.js';
import { opencodeModule } from './opencode/index.js';
import { piModule } from './pi/index.js';

export const BUILTIN_CLI_MODULES: readonly CliModule[] = Object.freeze([
  claudeModule,
  deepseekModule,
  codexModule,
  antigravityModule,
  piModule,
  opencodeModule,
  hermesModule,
]);

// 바이너리 후보 표를 리졸버에 넘긴다. 리졸버는 CLI 이름을 모르고(순환 방지) 이
// 등록만 본다 — 모듈 목록이 로드되는 순간, 즉 레지스트리가 조립되기 전에 끝난다.
for (const module of BUILTIN_CLI_MODULES) {
  if (module.binary) registerCliBinarySpec(module.id, module.binary);
}
