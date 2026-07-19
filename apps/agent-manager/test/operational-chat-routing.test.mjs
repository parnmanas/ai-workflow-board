import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { CodexCliAdapter } from '../dist/lib/cli-adapters/codex.js';
import { ADAPTER_CAPABILITIES } from '../dist/lib/cli-adapters/base.js';

const source = new URL('../src/lib/chat-session-manager.ts', import.meta.url);

test('persistent chat derives native MCP routing from the selected adapter', async () => {
  const text = await readFile(source, 'utf8');
  assert.ok(
    text.includes('createAdapter(spec.agentContext?.cli).has(ADAPTER_CAPABILITIES.NATIVE_MCP)'),
    'persistent routing must not hard-code native MCP availability',
  );
  assert.equal(new CodexCliAdapter().has(ADAPTER_CAPABILITIES.NATIVE_MCP), true);
});

test('every persistent follow-up appends the operational and dedupe policy', async () => {
  const text = await readFile(source, 'utf8');
  assert.ok(text.includes("'Turn policy:'"));
  assert.ok(text.includes('chatFollowupPolicy(!!spec.isActionRoom)'));
});
