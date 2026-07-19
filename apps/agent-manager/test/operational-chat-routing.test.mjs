import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CodexCliAdapter } from '../dist/lib/cli-adapters/codex.js';
import { ADAPTER_CAPABILITIES } from '../dist/lib/cli-adapters/base.js';
import {
  ensureOperationalFallbackTicket,
  operationalDedupeKey,
  parseOperationalFallback,
} from '../dist/lib/operational-chat-fallback.js';

const config = { url: 'https://awb.invalid', apiKey: 'key', workspace_id: 'workspace-1' };
const marker = (operation = 'deploy awb') =>
  `진행 수단을 확인했습니다.\nAWB_OPERATIONAL_FALLBACK: ${JSON.stringify({ operation, missing_capability: 'awb deploy mcp', original_request: 'AWB 올려줘' })}`;

test('persistent chat derives native MCP routing from the selected adapter', () => {
  assert.equal(new CodexCliAdapter().has(ADAPTER_CAPABILITIES.NATIVE_MCP), true);
});

test('non-native missing MCP output creates one capability ticket through REST boundary', async () => {
  const request = parseOperationalFallback(marker());
  assert.ok(request);
  const calls = [];
  const result = await ensureOperationalFallbackTicket(config, request, { room_id: 'room-1', message_id: 'msg-1' }, async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: 'ticket-1', title: '[운영 자동화] deploy awb', reused: false }), { status: 201 });
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.room_id, 'room-1');
  assert.equal(result.id, 'ticket-1');
});

test('same and rephrased requests share the server dedupe key when normalized operation matches', () => {
  const first = parseOperationalFallback(marker('Deploy   AWB'));
  const rephrased = parseOperationalFallback(marker('deploy awb'));
  assert.ok(first && rephrased);
  assert.equal(operationalDedupeKey('workspace-1', first), operationalDedupeKey('workspace-1', rephrased));
});

test('a later Action result emits no fallback marker and therefore runs without another ticket', () => {
  assert.equal(parseOperationalFallback('Action 재검색 결과 action-7을 찾았고 run-9를 1회 실행했습니다.'), null);
});

test('fallback failure is observable to the caller', async () => {
  const request = parseOperationalFallback(marker());
  assert.ok(request);
  await assert.rejects(
    ensureOperationalFallbackTicket(config, request, { room_id: 'room-1', message_id: 'msg-1' }, async () =>
      new Response('database unavailable', { status: 503 })),
    /operational fallback ticket failed: 503 database unavailable/,
  );
});
