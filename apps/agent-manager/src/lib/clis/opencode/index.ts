// opencode CLI 모듈. 어댑터는 `cli-adapters/opencode.ts`.
//
// opencode 는 codex/claude 와 달리 **CLI 자신이 계정이 아니다** — 그 안의 provider
// (openai / github-copilot / anthropic …)마다 따로 로그인하고, 결과는 provider 가
// 무엇이든 auth.json 한 파일에 쌓인다. 그래서 파일형 credential 은 `opencode_auth`
// 하나다. 예외가 opencode 자신의 유료 플랜(OpenCode Go — CLI 는 "OpenCode Zen" 이라
// 부른다)이다: 그건 웹(https://opencode.ai/auth)에서 만든 API 키 한 줄이고, opencode 가
// `OPENCODE_API_KEY` env 로 곧장 읽는다(`opencode auth list` 가 "Environment · OpenCode
// Zen OPENCODE_API_KEY" 로 보여 준다, 1.18.32 실측) — codex_api_key → OPENAI_API_KEY 와
// 같은 모양의 `opencode_api_key` 로 둔다.

import { homedir } from 'node:os';
import { join } from 'node:path';

import { OpencodeCliAdapter } from '../../cli-adapters/opencode.js';
import { BYPASS_ONLY_PERMISSION_CAPABILITIES } from '../../permission-policy.js';
import { requestCapabilities } from '../../runtime/domain/capabilities.js';
import { defineCliModule } from '../cli-module.js';
import { oneshotCapabilities } from '../shared-capabilities.js';
import { opencodeLogin } from './login.js';
import { opencodeSessionStore } from './sessions.js';

// Opencode (`opencode`, https://opencode.ai) ships as a native binary plus an
// npm distribution — same install shapes as pi (npm global shim on Windows,
// well-known unix bin dirs + PATH lookup elsewhere).
function unixCandidates(home: string): string[] {
  return [
    join(home, '.npm-global/bin/opencode'),
    join(home, '.bun/bin/opencode'),
    join(home, '.local/bin/opencode'),
    join(home, '.volta/bin/opencode'),
    join(home, '.npm-packages/bin/opencode'),
    join(home, 'node_modules/.bin/opencode'),
    '/usr/local/bin/opencode',
    '/opt/homebrew/bin/opencode',
    '/usr/bin/opencode',
  ];
}

function windowsCandidates(home: string): string[] {
  const appdata = process.env.APPDATA || join(home, 'AppData', 'Roaming');
  return [
    join(appdata, 'npm', 'opencode.exe'),
    // Last-resort npm batch shim (pi precedent — selectBinary always prefers
    // a real .exe first, cross-spawn escapes the shim args).
    join(appdata, 'npm', 'opencode.cmd'),
  ];
}

export const opencodeModule = defineCliModule({
  id: 'opencode',
  label: 'OpenCode',
  transport: 'cli',
  capabilities: requestCapabilities(oneshotCapabilities(true, 'tokens-and-cost', BYPASS_ONLY_PERMISSION_CAPABILITIES.tiers)),
  createCliAdapter: () => new OpencodeCliAdapter(),

  binary: { name: 'opencode', unixCandidates, windowsCandidates },

  credentials: {
    prefix: 'opencode_',
    providers: [
      { id: 'opencode_auth', label: 'Opencode (Provider Auth)', fields: ['auth_json'], required: ['auth_json'] },
      { id: 'opencode_api_key', label: 'Opencode Go (API Key)', fields: ['api_key'], required: ['api_key'] },
    ],
  },

  login: opencodeLogin,

  sessions: {
    async detect(_env, findOnPath) {
      return !!(await findOnPath('opencode'));
    },
    async resolveAcpCommand(findOnPath) {
      // opencode 는 ACP 서버를 **자기 안에** 갖고 있다(`opencode acp`) — claude/codex 처럼
      // 별도 어댑터 패키지를 npx 로 끌어올 필요가 없고, 따라서 어댑터와 CLI 코어의 세대가
      // 어긋날 일도 없다.
      const found = await findOnPath('opencode');
      return { command: found ?? 'opencode', args: ['acp'] };
    },
    // opencode 의 홈은 CLI 홈 변수가 아니라 XDG(기본 `~/.local/share`) 다.
    operatorHome: (env) => env.HOME || homedir(),
    // 파일이 아니라 SQLite 로 기록을 들고 있고 그 파일이 데이터 디렉터리 안에 있으므로
    // 디렉터리째 링크한다 — 계정 격리는 이 디렉터리가 아니라 `OPENCODE_AUTH_CONTENT`
    // env 가 맡으므로(cli-adapters/opencode.ts) 기록을 공유해도 자격증명은 섞이지 않는다.
    storeSubdir: join('.local', 'share', 'opencode'),
    store: opencodeSessionStore,
  },

  effort: { keys: ['model'] },
});
