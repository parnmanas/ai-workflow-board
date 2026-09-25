// Pi (`@earendil-works/pi-coding-agent`) CLI 모듈. 어댑터는 `cli-adapters/pi.ts`.
//
// pi 는 credential 개념이 아예 없다(운영자 홈의 auth.json 을 그대로 물려받는다) —
// `credentials` 슬라이스가 없는 것이 그 선언이다. 또 stock pi 에는 MCP 클라이언트가
// 없어 티켓을 읽거나 add_comment/move_ticket 감사 기록을 남길 수 없으므로 티켓
// dispatch 는 막고 pend 시킨다(chat 은 stdout 수확으로 계속 지원).

import { join } from 'node:path';

import { PiCliAdapter } from '../../cli-adapters/pi.js';
import { BYPASS_ONLY_PERMISSION_CAPABILITIES } from '../../permission-policy.js';
import { requestCapabilities } from '../../runtime/domain/capabilities.js';
import { defineCliModule } from '../cli-module.js';
import { oneshotCapabilities } from '../shared-capabilities.js';

// Pi is a pure TypeScript/Node CLI, not a compiled binary like codex —
// `npm install -g` and the `pi.dev/install.sh` curl installer both drop a JS
// entrypoint, so unlike codex there is no sibling `.exe` to prefer on Windows,
// only the npm batch shim.
function unixCandidates(home: string): string[] {
  return [
    join(home, '.npm-global/bin/pi'),
    join(home, '.bun/bin/pi'),
    join(home, '.local/bin/pi'),
    join(home, '.volta/bin/pi'),
    join(home, '.npm-packages/bin/pi'),
    join(home, 'node_modules/.bin/pi'),
    '/usr/local/bin/pi',
    '/opt/homebrew/bin/pi',
    '/usr/bin/pi',
  ];
}

function windowsCandidates(home: string): string[] {
  const appdata = process.env.APPDATA || join(home, 'AppData', 'Roaming');
  return [join(appdata, 'npm', 'pi.cmd')];
}

export const piModule = defineCliModule({
  id: 'pi',
  label: 'PI',
  transport: 'cli',
  capabilities: requestCapabilities(oneshotCapabilities(true, 'tokens', BYPASS_ONLY_PERMISSION_CAPABILITIES.tiers)),
  createCliAdapter: () => new PiCliAdapter(),

  binary: { name: 'pi', unixCandidates, windowsCandidates },

  effort: { keys: ['model'] },

  dispatch: { ticketDispatch: 'blocked', scanStderrForTools: true },
});
