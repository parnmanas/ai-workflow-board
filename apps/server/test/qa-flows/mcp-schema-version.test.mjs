// QA: MCP initialize must reject clients that don't declare
// experimental['awb/schemaVersion'] = { version: 2 }.
//
// This guard ensures stale proxy.mjs installs stop working cleanly (with a
// readable error message pointing at the upgrade) rather than silently
// receiving malformed events.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  setupKanbanScene,
  createAgent,
  createApiKey,
} from '../helpers/fixtures.mjs';

process.env.PORT = process.env.QA_MCP_SCHEMA_PORT || '0';

test('MCP initialize without experimental.awb/schemaVersion is rejected with code -32000', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  const { ws } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'schema' });
  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'schema-tester' });
  const key = await createApiKey(app, getDataSourceToken, agent.id, {
    workspaceId: ws.id,
    label: 'schema-tester',
  });

  step('POST /mcp initialize WITHOUT experimental.awb/schemaVersion capability');
  const res = await fetch(`http://localhost:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${key.raw_key}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'rogue-client', version: '0.0.0' },
      },
    }),
  });
  const payload = await res.json();
  assert.ok(payload.error, 'Top-level error on initialize without schemaVersion');
  assert.match(payload.error.message || '', /schemaVersion/i);

  // CLI 네이티브 MCP 클라이언트는 AWB 확장 capability 를 모른다 — X-AWB-Client-Type 으로 면제된다.
  // 'agent-session'(Agent Session 에 주입하는 AWB MCP 서버)이 빠져 있던 동안 codex 세션마다
  // `mcp__awb__startup` 이 failed 로 떴다. 한 번 빠지면 조용히 다시 빠질 수 있으므로 전부 고정한다.
  const initialize = (clientType) => fetch(`http://localhost:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${key.raw_key}`,
      ...(clientType ? { 'X-AWB-Client-Type': clientType } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cli-native', version: '0.0.0' } },
    }),
  }).then((r) => r.json());

  for (const clientType of ['agent-session', 'subagent', 'managed-subagent', 'runtime-child']) {
    step(`POST /mcp initialize as X-AWB-Client-Type: ${clientType} (no schemaVersion capability)`);
    const body = await initialize(clientType);
    assert.equal(
      body.error?.message?.includes('schemaVersion'),
      undefined,
      `${clientType} must be exempt from the schemaVersion gate — it is a CLI-native MCP client: ${JSON.stringify(body.error ?? {})}`,
    );
    assert.ok(body.result, `${clientType} initialize succeeds: ${JSON.stringify(body).slice(0, 200)}`);
  }

  step('POST /mcp initialize with an unknown client type is still gated');
  const unknown = await initialize('some-other-client');
  assert.match(unknown.error?.message || '', /schemaVersion/i);

  exitAfterTests(0);
});
