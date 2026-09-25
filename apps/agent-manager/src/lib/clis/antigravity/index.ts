// Antigravity (`agy`) CLI 모듈. 어댑터는 `cli-adapters/antigravity.ts`.

import { join } from 'node:path';

import { AntigravityCliAdapter } from '../../cli-adapters/antigravity.js';
import { BYPASS_ONLY_PERMISSION_CAPABILITIES } from '../../permission-policy.js';
import { requestCapabilities } from '../../runtime/domain/capabilities.js';
import { defineCliModule } from '../cli-module.js';
import { oneshotCapabilities } from '../shared-capabilities.js';

function unixCandidates(home: string): string[] {
  return [
    join(home, '.local/bin/agy'),
    join(home, '.npm-global/bin/agy'),
    join(home, '.bun/bin/agy'),
    join(home, '.volta/bin/agy'),
    join(home, '.npm-packages/bin/agy'),
    join(home, 'node_modules/.bin/agy'),
    '/usr/local/bin/agy',
    '/opt/homebrew/bin/agy',
    '/usr/bin/agy',
  ];
}

function windowsCandidates(home: string): string[] {
  const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  return [
    join(localAppData, 'Antigravity', 'agy.exe'),
    join(localAppData, 'Programs', 'google', 'antigravity', 'agy.exe'),
  ];
}

export const antigravityModule = defineCliModule({
  id: 'antigravity',
  label: 'Antigravity',
  transport: 'cli',
  capabilities: requestCapabilities(oneshotCapabilities(false, 'none', BYPASS_ONLY_PERMISSION_CAPABILITIES.tiers)),
  createCliAdapter: () => new AntigravityCliAdapter(),

  binary: { name: 'agy', unixCandidates, windowsCandidates },

  credentials: {
    prefix: 'antigravity_',
    providers: [
      { id: 'antigravity_subscription', label: 'Antigravity (Subscription)', fields: ['oauth_creds_json'], required: ['oauth_creds_json'] },
      { id: 'antigravity_api_key', label: 'Antigravity (API Key)', fields: ['api_key'], required: ['api_key'] },
    ],
  },

  effort: { keys: ['model'] },
});
