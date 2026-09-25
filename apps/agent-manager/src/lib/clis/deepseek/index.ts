// DeepSeek — Claude Code 바이너리로 DeepSeek 의 Anthropic 호환 엔드포인트를 친다.
// 어댑터는 `cli-adapters/deepseek.ts`(ClaudeCliAdapter 상속).
//
// 바이너리를 claude 에서 빌려 쓰므로(`borrowsFrom`) 설치/업데이트/최신 버전은 claude
// 기준 하나로 접히고, effort preset 도 `claude` 슬라이스를 읽는다. Agent Session 은
// 없다(서버도 deepseek 를 claude 로 흡수한다).

import { DeepSeekCliAdapter } from '../../cli-adapters/deepseek.js';
import { requestCapabilities } from '../../runtime/domain/capabilities.js';
import { CLAUDE_FAMILY_CAPABILITIES } from '../claude/index.js';
import { defineCliModule } from '../cli-module.js';

export const deepseekModule = defineCliModule({
  id: 'deepseek',
  label: 'DeepSeek',
  transport: 'cli',
  capabilities: requestCapabilities({ ...CLAUDE_FAMILY_CAPABILITIES }),
  createCliAdapter: () => new DeepSeekCliAdapter(),

  binary: { name: 'claude', borrowsFrom: 'claude' },

  credentials: {
    prefix: 'deepseek_',
    providers: [
      // api_key 는 DeepSeek bearer 토큰(ANTHROPIC_AUTH_TOKEN 으로 export); model/base_url 은 선택 override.
      { id: 'deepseek_api_key', label: 'DeepSeek (API Key)', fields: ['api_key', 'model', 'base_url'], required: ['api_key'] },
    ],
  },

  effort: { sliceKey: 'claude', keys: ['model', 'effort', 'ultracode'] },
});
