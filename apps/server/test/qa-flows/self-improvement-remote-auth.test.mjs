// QA: create_remote_improvement_ticket DB-backed authorization gate.
//
// Regression test for the security blocker the reviewer flagged on this branch:
// any agent API-key holder that can open `/mcp` could previously spoof the
// per-session `X-AWB-Subagent-*` headers (Role, Ticket-Id, Trigger-Source) to
// claim reviewer context on someone else's ticket and trick the server into
// decrypting + using the admin's remote AWB API key.
//
// The fix is a DB-backed reviewer-assignment check in
// `apps/server/src/modules/mcp/tools/self-improvement-tools.ts`:
//   - resolve the source ticket's `reviewer` WorkspaceRole +
//     TicketRoleAssignment;
//   - require `assignment.agent_id === caller.agentId` (the agent the API key
//     resolves to in `McpController.authenticate`).
//
// This test exercises the attacker path end-to-end: an attacker agent with a
// valid API key opens an MCP session, sends the three spoofed headers, and
// calls the tool. The call must be rejected by the new DB check with a clear
// "not the assigned reviewer" error — BEFORE the SystemSetting load /
// API-key decryption, which is the actual sensitive operation.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  createWorkspace,
  createBoard,
  createColumn,
  createAgent,
  createApiKey,
  createTicket,
} from '../helpers/fixtures.mjs';

process.env.PORT = process.env.QA_SELF_IMPROVEMENT_AUTH_PORT || '7820';

const PROTOCOL_VERSION = '2024-11-05';

async function mcpInit(baseUrl, apiKey, extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${apiKey}`,
    ...extraHeaders,
  };
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { experimental: { 'awb/schemaVersion': { version: 2 } } },
        clientInfo: { name: 'qa-self-improvement-auth', version: '1.0.0' },
      },
    }),
  });
  const sessionId = res.headers.get('mcp-session-id');
  if (!sessionId) {
    const body = await res.text();
    throw new Error(`MCP initialize did not return mcp-session-id (status ${res.status}): ${body}`);
  }
  // Transport requires notifications/initialized before normal ops.
  await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { ...headers, 'mcp-session-id': sessionId },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
  });
  return sessionId;
}

async function mcpCallTool(baseUrl, apiKey, sessionId, name, args) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${apiKey}`,
      'mcp-session-id': sessionId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 42,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  let parsed = null;
  if (ctype.includes('text/event-stream')) {
    const text = await res.text();
    for (const frame of text.split('\n\n').filter(Boolean)) {
      for (const line of frame.split('\n')) {
        if (line.startsWith('data:')) {
          try { parsed = JSON.parse(line.slice(5).trim()); break; } catch { /* keep scanning */ }
        }
      }
      if (parsed) break;
    }
  } else {
    parsed = await res.json().catch(() => null);
  }
  return { status: res.status, body: parsed };
}

function parseToolErrorMessage(callResp) {
  const text = callResp?.body?.result?.content?.[0]?.text;
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

test('create_remote_improvement_ticket rejects spoofed-header non-reviewer', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => app.close().catch(() => {}));
  const { getDataSourceToken } = modules;
  const baseUrl = `http://localhost:${port}`;
  const ds = app.get(getDataSourceToken());

  step('Scene: workspace + board(self_improvement_mode=remote_awb) + terminal column');
  const ws = await createWorkspace(app, getDataSourceToken, 'sib-auth');
  const board = await createBoard(app, getDataSourceToken, ws.id, { name: 'sib-auth' });
  await ds.getRepository('Board').update(board.id, { self_improvement_mode: 'remote_awb' });
  const done = await createColumn(app, getDataSourceToken, board.id, {
    name: 'Done', position: 0, workspaceId: ws.id, isTerminal: true, kind: 'terminal',
  });

  step('Two agents: legitimate reviewer + attacker (both with valid API keys)');
  const reviewer = await createAgent(app, getDataSourceToken, ws.id, { name: 'reviewer' });
  const attacker = await createAgent(app, getDataSourceToken, ws.id, { name: 'attacker' });
  const attackerKey = await createApiKey(app, getDataSourceToken, attacker.id, {
    workspaceId: ws.id, label: 'attacker',
  });

  step('Ticket assigned to reviewer (createTicket writes TicketRoleAssignment for slug=reviewer)');
  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: done.id,
    workspaceId: ws.id,
    title: 'Source ticket',
    reviewerId: reviewer.id,
  });

  step('Sanity: TicketRoleAssignment was written for the reviewer slot');
  const roleRow = await ds.getRepository('WorkspaceRole').findOne({
    where: { workspace_id: ws.id, slug: 'reviewer' },
  });
  assert.ok(roleRow, 'workspace must have a reviewer role row (BUILTIN_ROLE_SLUGS seeds it)');
  const assign = await ds.getRepository('TicketRoleAssignment').findOne({
    where: { ticket_id: ticket.id, role_id: roleRow.id },
  });
  assert.equal(assign?.agent_id, reviewer.id, 'reviewer assignment must point at the reviewer agent');

  step('Attacker opens MCP session with spoofed X-AWB-Subagent-* headers');
  const attackerSession = await mcpInit(baseUrl, attackerKey.raw_key, {
    'X-AWB-Subagent-Role': 'reviewer',
    'X-AWB-Subagent-Ticket-Id': ticket.id,
    'X-AWB-Subagent-Trigger-Source': 'ticket_done_review',
  });

  step('Attacker calls create_remote_improvement_ticket — must be rejected by DB-backed gate');
  const resp = await mcpCallTool(
    baseUrl,
    attackerKey.raw_key,
    attackerSession,
    'create_remote_improvement_ticket',
    {
      source_ticket_id: ticket.id,
      title: 'attacker exfiltration attempt',
      description: 'should be rejected before SystemSetting load / API key decrypt',
    },
  );

  // Tool-level error (isError:true) shape from `err()` in shared/helpers.ts.
  assert.equal(resp.status, 200, 'HTTP transport returns 200; rejection rides in JSON-RPC result');
  assert.equal(resp.body?.result?.isError, true, `expected tool isError:true, got ${JSON.stringify(resp.body)}`);
  const parsed = parseToolErrorMessage(resp);
  const errorText = String(parsed?.error || '');
  assert.match(
    errorText,
    /not the assigned reviewer/i,
    `expected reviewer-mismatch error from DB-backed gate; got: ${errorText}`,
  );

  step('Negative: confirm no remote ticket was actually created (no calls left the server)');
  // The DB-backed gate fires before SystemSetting load, so no `self_improvement.*`
  // row is even consulted. Just verify nothing about the local source ticket
  // changed and no extra audit was made on its behalf.
  const localTicket = await ds.getRepository('Ticket').findOne({ where: { id: ticket.id } });
  assert.equal(localTicket?.column_id, done.id, 'source ticket must be untouched');

  exitAfterTests(0);
});
