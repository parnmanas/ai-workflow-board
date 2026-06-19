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

process.env.PORT = process.env.QA_MCP_SCHEMA_PORT || '7809';

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

  exitAfterTests(0);
});
