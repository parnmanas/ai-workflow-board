// QA flow — pend_ticket MCP 도구의 Action 게이트 end-to-end (티켓 524bb434).
//
// 실 MCP 프로토콜(인증된 에이전트 → /mcp → pend_ticket)로 "강제하는 정책/흐름"을
// 도구 경계에서 직접 증명한다:
//   • Action 이 없으면 → pend 성공(대조군).
//   • enabled Action 등록 후 → 맨 pend 는 거부(isError) + 메시지에 Action 이름/절차,
//     그리고 티켓은 park 되지 않는다.
//   • no_action_reason 을 주면 → pend 성공 + pend_no_action_reason 감사 로그 기록.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  createWorkspace,
  createAgent,
  createBoard,
  createColumn,
  createTicket,
  createApiKey,
} from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

process.env.PORT = process.env.QA_PEND_GATE_MCP_PORT || '7906';

test('pend_ticket MCP tool: blocked while a runnable Action exists, allowed with no_action_reason', async (t) => {
  step('Boot app + MCP');
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => {
    void app.close().catch(() => {});
  });
  const { getDataSourceToken } = modules;

  const ws = await createWorkspace(app, getDataSourceToken, 'pendgate');
  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'worker' });
  const board = await createBoard(app, getDataSourceToken, ws.id, { name: 'b' });
  const col = await createColumn(app, getDataSourceToken, board.id, {
    name: 'In Progress',
    position: 1,
    workspaceId: ws.id,
  });

  const key = await createApiKey(app, getDataSourceToken, agent.id, {
    workspaceId: ws.id,
    scope: 'full',
  });
  const mcp = new McpClient({ baseUrl: `http://localhost:${port}`, apiKey: key.raw_key });
  await mcp.initialize();

  // ── Control: no Actions in scope → pend succeeds ──────────────────
  step('Control — no Actions in scope: pend succeeds');
  const t0 = await createTicket(app, getDataSourceToken, {
    columnId: col.id,
    workspaceId: ws.id,
    title: 'no-action blocker',
  });
  const okNoActions = await mcp.callTool('pend_ticket', {
    ticket_id: t0.id,
    reason: 'need a human decision',
  });
  assert.ok(!okNoActions.isError, 'pend with zero runnable Actions must succeed');
  assert.equal(okNoActions.pending_user_action, true, 'ticket is parked');

  // ── Register an enabled Action → the gate must now fire ───────────
  step('Register an enabled Action, then pend a fresh ticket');
  const saved = await mcp.callTool('save_action', {
    workspace_id: ws.id,
    name: 'Deploy prod',
    prompt: 'deploy',
    target_agent_id: agent.id,
  });
  assert.ok(!saved.isError, 'save_action succeeds');
  const t1 = await createTicket(app, getDataSourceToken, {
    columnId: col.id,
    workspaceId: ws.id,
    title: 'deploy blocker',
  });

  step('Gate fires — a bare pend is REJECTED and names the Action');
  const blocked = await mcp.callTool('pend_ticket', {
    ticket_id: t1.id,
    reason: 'deploy needed',
  });
  assert.equal(blocked.isError, true, 'pend must be rejected while a runnable Action exists');
  assert.match(blocked.error.error, /Deploy prod/, 'rejection names the candidate Action');
  assert.match(blocked.error.error, /no_action_reason/, 'rejection tells the agent how to proceed');
  // The ticket must NOT have been parked by a rejected pend.
  const stillOpen = await mcp.callTool('get_ticket', { ticket_id: t1.id });
  assert.equal(stillOpen.pending_user_action, false, 'a blocked pend must not park the ticket');

  step('Escape hatch — pend with no_action_reason succeeds and is audited');
  const allowed = await mcp.callTool('pend_ticket', {
    ticket_id: t1.id,
    reason: 'deploy needs a human approver',
    no_action_reason: 'prod sign-off requires a human — no Action grants it',
  });
  assert.ok(!allowed.isError, 'pend proceeds once no_action_reason is supplied');
  assert.equal(allowed.pending_user_action, true, 'ticket is now parked');

  // Audit: a pend_no_action_reason activity row is written (scope-6 기록).
  const ds = app.get(getDataSourceToken());
  const acts = await ds.getRepository('ActivityLog').find({
    where: { ticket_id: t1.id, field_changed: 'pend_no_action_reason' },
  });
  assert.ok(acts.length >= 1, 'the no_action_reason justification is recorded on the audit trail');
  assert.match(acts[0].new_value, /human/, 'audit row carries the reason text');

  await mcp.close();
  exitAfterTests(0);
});
