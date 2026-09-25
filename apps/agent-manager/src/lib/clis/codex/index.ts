// Codex CLI 모듈. 어댑터는 `cli-adapters/codex.ts`.

import { homedir } from 'node:os';
import { join } from 'node:path';

import { CodexCliAdapter } from '../../cli-adapters/codex.js';
import { TIER_FLAG_PERMISSION_CAPABILITIES } from '../../permission-policy.js';
import { requestCapabilities } from '../../runtime/domain/capabilities.js';
import { defineCliModule } from '../cli-module.js';
import { oneshotCapabilities } from '../shared-capabilities.js';
import { codexLogin } from './login.js';
import { codexSessionStore } from './sessions.js';

export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME?.trim() || join(homedir(), '.codex');
}

function unixCandidates(home: string): string[] {
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

function windowsCandidates(home: string): string[] {
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

export const codexModule = defineCliModule({
  id: 'codex',
  label: 'Codex',
  transport: 'cli',
  capabilities: requestCapabilities(oneshotCapabilities(true, 'tokens', TIER_FLAG_PERMISSION_CAPABILITIES.tiers), { streaming: true }),
  createCliAdapter: () => new CodexCliAdapter(),

  binary: {
    name: 'codex',
    unixCandidates,
    windowsCandidates,
    delegationKey: 'codexBin',
    bootVersionProbe: true,
  },

  credentials: {
    prefix: 'codex_',
    providers: [
      { id: 'codex_subscription', label: 'Codex (Subscription)', fields: ['auth_json', 'config_toml'], required: ['auth_json'] },
      { id: 'codex_api_key', label: 'Codex (API Key)', fields: ['api_key'], required: ['api_key'] },
    ],
  },

  login: codexLogin,

  sessions: {
    async detect(_env, findOnPath) {
      return !!(await findOnPath('codex-acp')) || !!(await findOnPath('codex'));
    },
    async resolveAcpCommand(findOnPath) {
      // `@agentclientprotocol/codex-acp` 가 유지되는 어댑터다 — 설치된 codex CLI 와 같은
      // 세대의 코어를 번들해 최신 모델을 쓴다. zed-industries 것은 2026-07 에 archive 됐고
      // 옛 코어라 새 모델을 "requires a newer version of Codex" 로 거부한다.
      const found = await findOnPath('codex-acp');
      return found ? { command: found, args: [] } : { command: 'npx', args: ['--yes', '@agentclientprotocol/codex-acp'] };
    },
    operatorHome: resolveCodexHome,
    storeSubdir: 'sessions',
    adjustEnv(env) {
      // codex-acp: 매니저 프로세스에는 브라우저가 없다 — ChatGPT 브라우저 로그인 auth
      // method 를 숨겨 어댑터가 장비의 codex 로그인(auth.json)이나 API 키만 쓰게 한다.
      if (env.NO_BROWSER === undefined) env.NO_BROWSER = '1';
    },
    store: codexSessionStore,
  },

  effort: { keys: ['model'] },

  dispatch: {
    // codex 는 AWB MCP 를 오직 네이티브 config.toml 로만 붙인다 — 그 파일을 못 만들면
    // 조용히 망가지므로 등록 실패로 승격한다.
    cliHomePrepFatal: true,
  },
});
