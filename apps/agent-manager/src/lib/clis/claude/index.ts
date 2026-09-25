// Claude Code — 참조 구현. 새 CLI 모듈을 만들 때 이 파일을 본보기로 삼는다.
//
// 어댑터(spawn/parse)는 그대로 `cli-adapters/claude.ts` 에 있고, 여기는 그 외의
// 관심사 — 바이너리 후보, 자격증명 provider, device-auth 로그인, Agent Session,
// effort preset, 디스패치 게이트 — 를 한 곳에 모은다.

import { homedir } from 'node:os';
import { join } from 'node:path';

import { ClaudeCliAdapter } from '../../cli-adapters/claude.js';
import { TIER_FLAG_PERMISSION_CAPABILITIES } from '../../permission-policy.js';
import { requestCapabilities } from '../../runtime/domain/capabilities.js';
import type { RuntimeCapabilities } from '../../runtime/runtime-types.js';
import { defineCliModule } from '../cli-module.js';
import { claudeLogin } from './login.js';
import { claudeSessionStore } from './sessions.js';

/** claude 계열(claude/deepseek)이 공유하는 런타임 capability. */
export const CLAUDE_FAMILY_CAPABILITIES: RuntimeCapabilities = {
  protocol: 'stream-json',
  session: 'persistent',
  native_mcp: true,
  native_approvals: false,
  steering: true,
  cancellation: true,
  usage: 'tokens-and-cost',
  collaboration: [],
  skill_delivery: ['prompt', 'filesystem'],
  permission_tiers: TIER_FLAG_PERMISSION_CAPABILITIES.tiers,
};

export function resolveClaudeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
}

function unixCandidates(home: string): string[] {
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

function windowsCandidates(home: string): string[] {
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

export const claudeModule = defineCliModule({
  id: 'claude',
  label: 'Claude Code',
  transport: 'cli',
  capabilities: requestCapabilities(CLAUDE_FAMILY_CAPABILITIES, { effort: true }),
  createCliAdapter: () => new ClaudeCliAdapter(),

  binary: {
    name: 'claude',
    unixCandidates,
    windowsCandidates,
    // 레거시 proxy 용 — 부모 프로세스가 claude 면 그 실행 파일을 쓴다.
    parentExePattern: /claude/i,
    delegationKey: 'claudeBin',
    bootVersionProbe: true,
  },

  credentials: {
    prefix: 'claude_',
    providers: [
      { id: 'claude_subscription', label: 'Claude (Subscription)', fields: ['credentials_json'], required: ['credentials_json'] },
      { id: 'claude_api_key', label: 'Claude (API Key)', fields: ['api_key'], required: ['api_key'] },
      // `claude setup-token` 출력 — 회전하지 않는 1년짜리 OAuth 토큰. env 로만 주입되고
      // (.credentials.json 을 쓰지 않음) 만료 파일이 없으므로 하트비트 분류는 api_key.
      { id: 'claude_oauth_token', label: 'Claude (OAuth Token)', fields: ['oauth_token'], required: ['oauth_token'], kind: 'api_key' },
    ],
  },

  login: claudeLogin,

  sessions: {
    async detect(_env, findOnPath) {
      return !!(await findOnPath('claude-agent-acp')) || !!(await findOnPath('claude'));
    },
    async resolveAcpCommand(findOnPath) {
      const found = await findOnPath('claude-agent-acp');
      return found ? { command: found, args: [] } : { command: 'npx', args: ['--yes', '@agentclientprotocol/claude-agent-acp'] };
    },
    operatorHome: resolveClaudeHome,
    storeSubdir: 'projects',
    supportsBackendProfile: true,
    store: claudeSessionStore,
  },

  effort: { keys: ['model', 'effort', 'ultracode'] },

  dispatch: {
    inlineImages: true,
    pluginUpdates: true,
    runtimeProfile: true,
  },
});
