// Integration test — Hermes error-log wire path (ticket 7a4b14b4).
//
// apps/agent-manager/test/error-log-uploader.test.mjs already proves classify()
// tags a "Hermes ... dispatch failed closed: ..." log line as
// { level: 'error', category: 'hermes' }. Nothing previously proved that entry
// actually survives the real wire path: POST /api/agent/error-logs (what
// error-log-uploader.ts's uploadIfNewErrors() calls) → AgentErrorLog row →
// filtered GET back out. This file closes that gap end-to-end against a real
// booted server + DB, covering both read surfaces an operator or automation
// script would use: the agent-key GET (apps/agent/error-logs) and the admin
// Agent Logs viewer's GET (api/admin/agent-logs).

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp } from './helpers/boot.mjs';
import { createWorkspace, createAgent, createApiKey, createUser } from './helpers/fixtures.mjs';

process.env.PORT = process.env.TEST_SERVER_PORT || '7794';

test('Hermes error-log entry survives POST /api/agent/error-logs → GET (agent-key) and GET (admin), filtered by level=error&category=hermes', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken, AuthService } = modules;
  const base = `http://localhost:${port}`;

  const ws = await createWorkspace(app, getDataSourceToken, 'agent-error-logs');
  // type='manager' models the real caller: agent-manager uploads error-log
  // entries under its OWN (Runtime Host) identity, not the managed Hermes
  // agent's — see apps/agent-manager/src/lib/error-log-uploader.ts.
  const hermesHost = await createAgent(app, getDataSourceToken, ws.id, { name: 'hermes-host', type: 'manager' });
  const hostKey = await createApiKey(app, getDataSourceToken, hermesHost.id, { workspaceId: ws.id, label: 'hermes-host' });
  const admin = await createUser(app, getDataSourceToken, { name: 'admin' });
  const adminToken = app.get(AuthService).createSession(admin.id);

  // Mirrors the exact wire shape uploadIfNewErrors() POSTs for an entry
  // classify() produced from a real event-dispatcher.ts failure log line.
  const occurredAt = new Date().toISOString();
  const message = 'Hermes chat dispatch failed closed: hermes_empty_reply session session-1 ended with end_turn but produced no reply text';
  const uploadRes = await fetch(`${base}/api/agent/error-logs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Key': hostKey.raw_key },
    body: JSON.stringify({
      agent_id: hermesHost.id,
      workspace_id: ws.id,
      plugin_version: 'test-1.0.0',
      entries: [{
        occurred_at: occurredAt,
        level: 'error',
        category: 'hermes',
        message,
        raw_line: `[${occurredAt}] [pid=1] ${message}`,
        pid: '1',
      }],
    }),
  });
  const uploadBody = await uploadRes.text();
  assert.equal(uploadRes.status, 201, `error-log upload should 201: ${uploadBody}`);
  assert.equal(JSON.parse(uploadBody).accepted, 1);

  // Read side 1 — agent-key auth (what an external automation script realistically holds).
  const agentReadRes = await fetch(
    `${base}/api/agent/error-logs?level=error&category=hermes&agent_id=${hermesHost.id}`,
    { headers: { 'X-Agent-Key': hostKey.raw_key } },
  );
  assert.equal(agentReadRes.status, 200);
  const agentRows = await agentReadRes.json();
  assert.equal(agentRows.length, 1, 'agent-key GET must return exactly the uploaded hermes error row');
  assert.equal(agentRows[0].level, 'error');
  assert.equal(agentRows[0].category, 'hermes');
  assert.match(agentRows[0].message, /hermes_empty_reply/);

  // Read side 2 — admin session auth (the Admin Agent Logs viewer's surface).
  const adminReadRes = await fetch(
    `${base}/api/admin/agent-logs?level=error&category=hermes&agent_id=${hermesHost.id}`,
    { headers: { Authorization: `Bearer ${adminToken}` } },
  );
  assert.equal(adminReadRes.status, 200);
  const adminRows = await adminReadRes.json();
  assert.equal(adminRows.length, 1, 'admin GET must return exactly the uploaded hermes error row');
  assert.equal(adminRows[0].category, 'hermes');

  // Negative control — a different category must NOT match, proving this is a
  // real filter rather than an accidental return-everything.
  const otherRes = await fetch(
    `${base}/api/admin/agent-logs?level=error&category=crash&agent_id=${hermesHost.id}`,
    { headers: { Authorization: `Bearer ${adminToken}` } },
  );
  const otherRows = await otherRes.json();
  assert.equal(otherRows.length, 0, 'a differently-categorized query must not see the hermes row');
});
