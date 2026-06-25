// QA: security on-failure auto-ticket (severity-gated, evidence, idempotent).
//
// Ticket 86b8fadc. Exercises SecurityFailureTicketService through the real
// completeRun choke point over MCP:
//   • high finding + failed run → fix ticket auto-filed, with evidence (finding
//     list + commit range + artifact link) and the security-profile:<id> back-ref
//     label, landing in a non-terminal (To Do) column.
//   • run-level idempotency: re-finalizing the SAME run does not double-file.
//   • NEGATIVE 1 — passed run never files.
//   • NEGATIVE 2 — failed run whose worst finding is below the gate (medium with
//     min_severity=high) never files.
//   • per_open_ticket dedupe — a second failing run appends a recurrence comment
//     to the existing open ticket instead of filing a new one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { setupKanbanScene, createAgent, createApiKey } from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

process.env.PORT = process.env.QA_SECURITY_FAIL_PORT || '7837';

const SHA_BASE = 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0';
const SHA_HEAD = 'c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1';

async function countTicketsForProfile(ds, wsId, profileId) {
  const rows = await ds.getRepository('Ticket').createQueryBuilder('t')
    .where('t.workspace_id = :ws', { ws: wsId })
    .andWhere('t.labels LIKE :marker', { marker: `%security-profile:${profileId}%` })
    .getMany();
  return rows;
}

test('security on-failure auto-ticket: severity gate + evidence + idempotency + dedupe', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());

  const { ws, board } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'sec-fail' });
  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'inspector' });
  const key = await createApiKey(app, getDataSourceToken, agent.id, { workspaceId: ws.id, label: 'inspector' });

  const mcp = new McpClient({ baseUrl: `http://localhost:${port}`, apiKey: key.raw_key });
  await mcp.initialize();

  step('create_security_profile WITH on_failure_ticket (enabled, min_severity=high, per_open_ticket)');
  const profile = await mcp.callTool('create_security_profile', {
    workspace_id: ws.id,
    name: 'self code-review',
    target_agent_id: agent.id,
    scan_driver: 'code-review',
    scope_mode: 'incremental',
    board_id: board.id,
    checklist: [{ id: 'authz', title: 'Broken access control', category: 'authz', severity_hint: 'high' }],
    on_failure_ticket: {
      enabled: true,
      board_id: board.id,
      column_name: 'Todo',
      priority: 'high',
      min_severity: 'high',
      dedupe: 'per_open_ticket',
    },
  });
  assert.ok(!profile.isError, `create failed: ${JSON.stringify(profile)}`);
  assert.equal(profile.on_failure_ticket?.enabled, true, 'config round-trips on the profile');
  assert.equal(profile.on_failure_ticket?.min_severity, 'high');
  assert.equal(profile.on_failure_ticket?.dedupe, 'per_open_ticket');

  // ── NEGATIVE 2: failed run, but worst finding is medium < gate(high) ────────
  step('run A — failed with only a MEDIUM finding → below gate → NO ticket');
  const startA = await mcp.callTool('start_security_run', { profile_id: profile.id });
  await mcp.callTool('record_security_finding', {
    run_id: startA.run_id, workspace_id: ws.id,
    finding: { id: 'm1', severity: 'medium', title: 'minor input issue', category: 'input-validation' },
  });
  const doneA = await mcp.callTool('complete_security_run', {
    run_id: startA.run_id, workspace_id: ws.id, status: 'failed', scanned_commit: SHA_HEAD, scope_used: 'full',
    summary: '1 medium',
  });
  assert.equal(doneA.status, 'failed');
  assert.equal(doneA.auto_ticket_id, null, 'medium-only failed run files no ticket (severity gate)');
  assert.equal((await countTicketsForProfile(ds, ws.id, profile.id)).length, 0, 'no security ticket exists yet');

  // ── NEGATIVE 1: passed run never files ──────────────────────────────────────
  step('run B — passed → NO ticket');
  const startB = await mcp.callTool('start_security_run', { profile_id: profile.id });
  const doneB = await mcp.callTool('complete_security_run', {
    run_id: startB.run_id, workspace_id: ws.id, status: 'passed', scanned_commit: SHA_BASE, scope_used: 'full',
    summary: '0 critical/high',
  });
  assert.equal(doneB.status, 'passed');
  assert.equal(doneB.auto_ticket_id, null, 'passed run files no ticket');
  assert.equal((await countTicketsForProfile(ds, ws.id, profile.id)).length, 0, 'still no security ticket');

  // ── POSITIVE: failed run with a HIGH finding → ticket with evidence ─────────
  step('run C — failed with a HIGH finding → ticket auto-filed with evidence');
  const startC = await mcp.callTool('start_security_run', { profile_id: profile.id });
  // baseline advanced by run B's PASS → run C is incremental from SHA_BASE.
  assert.equal(startC && !startC.isError, true);
  await mcp.callTool('attach_security_artifact', {
    run_id: startC.run_id, workspace_id: ws.id, resource_ids: ['res-evidence-1'],
  });
  await mcp.callTool('record_security_finding', {
    run_id: startC.run_id, workspace_id: ws.id,
    finding: { id: 'h1', severity: 'high', title: 'Missing workspace scope check', category: 'authz',
      file: 'apps/server/src/modules/foo/foo.controller.ts', line: 42,
      evidence: 'findOne({ where: { id } }) with no workspace_id', remediation: 'add workspace_id to the where clause',
      checklist_item_id: 'authz' },
  });
  await mcp.callTool('record_security_finding', {
    run_id: startC.run_id, workspace_id: ws.id,
    finding: { id: 'lo1', severity: 'low', title: 'verbose log', category: 'data-exposure' },
  });
  const doneC = await mcp.callTool('complete_security_run', {
    run_id: startC.run_id, workspace_id: ws.id, status: 'failed', scanned_commit: SHA_HEAD, scope_used: 'incremental',
    summary: '1 high, 1 low',
  });
  assert.equal(doneC.status, 'failed');
  assert.ok(doneC.auto_ticket_id, 'high finding filed a ticket; auto_ticket_id stamped on the run');

  const tickets = await countTicketsForProfile(ds, ws.id, profile.id);
  assert.equal(tickets.length, 1, 'exactly one security ticket filed');
  const ticket = tickets[0];
  assert.equal(ticket.id, doneC.auto_ticket_id, 'run.auto_ticket_id points at the filed ticket');

  // Lands in the configured non-terminal column.
  assert.equal(ticket.column_id, board && (await ds.getRepository('BoardColumn').findOne({ where: { board_id: board.id, name: 'Todo' } })).id, 'filed into the Todo column');

  // Labels carry the back-ref marker.
  const labels = JSON.parse(ticket.labels || '[]');
  assert.ok(labels.includes(`security-profile:${profile.id}`), 'back-ref label present');

  // Body has the evidence: finding, commit range, artifact link, gate.
  const body = ticket.description || '';
  assert.match(body, /Missing workspace scope check/, 'body lists the high finding');
  assert.match(body, /foo\.controller\.ts:42/, 'body has file:line');
  assert.match(body, /add workspace_id to the where clause/, 'body has remediation');
  assert.match(body, new RegExp(SHA_HEAD), 'body has the scanned commit');
  assert.match(body, new RegExp(SHA_BASE), 'body has the baseline commit (incremental scope)');
  assert.match(body, /res-evidence-1/, 'body links the run artifact');
  assert.match(body, />= high/, 'body states the severity gate');
  // The below-gate low finding is shown as reference, not in the gated section header.
  assert.match(body, /게이트 미만/, 'below-gate findings shown for reference');
  assert.equal(ticket.priority, 'high', 'priority from config');

  // ── IDEMPOTENCY: re-finalize the SAME run → no second ticket ────────────────
  step('re-finalize run C → idempotent (no duplicate)');
  const reDoneC = await mcp.callTool('complete_security_run', {
    run_id: startC.run_id, workspace_id: ws.id, status: 'failed', scanned_commit: SHA_HEAD, scope_used: 'incremental',
    summary: 're-finalize',
  });
  assert.equal(reDoneC.auto_ticket_id, ticket.id, 're-finalize returns the same ticket id');
  assert.equal((await countTicketsForProfile(ds, ws.id, profile.id)).length, 1, 'still exactly one ticket after re-finalize');

  // ── DEDUPE: a NEW failing run with a high finding → recurrence comment ──────
  step('run D — new failing run, high finding → per_open_ticket recurrence comment (no new ticket)');
  const startD = await mcp.callTool('start_security_run', { profile_id: profile.id });
  await mcp.callTool('record_security_finding', {
    run_id: startD.run_id, workspace_id: ws.id,
    finding: { id: 'h2', severity: 'critical', title: 'SQL injection in filter', category: 'injection' },
  });
  const doneD = await mcp.callTool('complete_security_run', {
    run_id: startD.run_id, workspace_id: ws.id, status: 'failed', scanned_commit: SHA_HEAD, scope_used: 'incremental',
    summary: '1 critical',
  });
  assert.equal(doneD.auto_ticket_id, ticket.id, 'recurrence reuses the existing open ticket');
  assert.equal((await countTicketsForProfile(ds, ws.id, profile.id)).length, 1, 'no new ticket — dedupe held');

  const comments = await ds.getRepository('Comment').find({ where: { ticket_id: ticket.id } });
  const recurrence = comments.find((c) => /보안 점검 재실패/.test(c.content || ''));
  assert.ok(recurrence, 'a recurrence comment was appended to the existing ticket');
  assert.match(recurrence.content, /SQL injection in filter/, 'recurrence comment carries the new finding');

  await mcp.close();
  exitAfterTests(0);
});
