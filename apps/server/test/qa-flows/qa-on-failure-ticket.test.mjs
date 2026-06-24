// QA flow: on-failure auto-ticket (ticket 52a93654).
//
// When a QaScenario opts into on_failure_ticket, a QaRun that finalizes as
// failed/error must auto-file a fix ticket carrying the failure evidence. This
// test drives the full path over MCP HTTP and asserts the four Verify cases
// from the ticket:
//
//   1. failed run → fix ticket created, in the active column, evidence in body
//      (failed step log + artifact raw link + QA detail deep link), labels +
//      priority from config, run.auto_ticket_id linked.
//   2. re-finalizing the SAME run does NOT double-file (run-level idempotency).
//   3. a passed run files nothing (negative case).
//   4. dedupe='per_open_ticket' → a second failure of the same scenario appends
//      a recurrence comment to the still-open ticket instead of a new ticket.
//   + a scenario WITHOUT on_failure_ticket files nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createAgent, createApiKey, setupKanbanScene } from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

process.env.PORT = process.env.QA_ON_FAILURE_PORT || '7849';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('QA on-failure auto-ticket: create / idempotency / passed-noop / per_open dedupe', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());

  const { ws, board, columns } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'qa-onfail' });
  const qaAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'qa-runner' });
  const qaKey = await createApiKey(app, getDataSourceToken, qaAgent.id, { workspaceId: ws.id, label: 'qa' });

  const mcp = new McpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: qaKey.raw_key });
  t.after(() => { void mcp.close().catch(() => {}); });

  const steps = [
    { idx: 0, action: 'navigate to dashboard', expect: 'dashboard renders' },
    { idx: 1, action: 'click the broken button', expect: 'no error toast' },
  ];

  // Count tickets carrying a scenario's dedupe marker label (DB-agnostic LIKE).
  const ticketsForScenario = async (scenarioId) =>
    ds.query(`SELECT id, column_id, labels, priority, title, description FROM tickets WHERE labels LIKE '%qa-scenario:${scenarioId}%'`);
  const commentsForTicket = async (ticketId) =>
    ds.query(`SELECT content FROM comments WHERE ticket_id = '${ticketId}'`);

  const runOnce = async (scenarioId, status, { artifact } = {}) => {
    const started = await mcp.callTool('start_qa_run', { scenario_id: scenarioId });
    assert.ok(!started?.isError && started.run_id, `start_qa_run: ${JSON.stringify(started)}`);
    const failedStep = status === 'passed' ? 'passed' : 'failed';
    await mcp.callTool('record_qa_step', {
      run_id: started.run_id, workspace_id: ws.id, idx: 0, status: failedStep,
      log: `step 0 ${failedStep} — evidence here`,
      artifact_resource_ids: artifact ? [artifact] : [],
    });
    const done = await mcp.callTool('complete_qa_run', {
      run_id: started.run_id, workspace_id: ws.id, status, summary: `run finalized ${status}`,
    });
    assert.ok(!done?.isError, `complete_qa_run: ${JSON.stringify(done)}`);
    return done;
  };

  // ── 1. failed run → fix ticket with evidence ────────────────────────────────
  step('CASE 1: failed run files a fix ticket with evidence');
  const sc1 = await mcp.callTool('create_qa_scenario', {
    workspace_id: ws.id, board_id: board.id, name: 'Login flow QA', target_agent_id: qaAgent.id,
    qa_driver: 'browser', steps,
    on_failure_ticket: {
      enabled: true, column_name: 'Todo', priority: 'high', assignee_id: qaAgent.id,
      dedupe: 'per_run', labels: ['qa-failure', 'auto'],
    },
  });
  assert.ok(!sc1?.isError && sc1.id, `create sc1: ${JSON.stringify(sc1)}`);
  assert.ok(sc1.on_failure_ticket?.enabled, 'on_failure_ticket round-trips on the scenario');

  const done1 = await runOnce(sc1.id, 'failed', { artifact: 'art-shot-0' });
  assert.ok(done1.auto_ticket_id, 'completed failed run carries auto_ticket_id');

  const rows1 = await ticketsForScenario(sc1.id);
  assert.equal(rows1.length, 1, 'exactly one fix ticket filed');
  assert.equal(rows1[0].id, done1.auto_ticket_id, 'run.auto_ticket_id points at the filed ticket');
  assert.equal(rows1[0].column_id, columns.todo.id, 'ticket lands in the active Todo column');
  assert.equal(rows1[0].priority, 'high', 'priority from config');

  const full1 = await mcp.callTool('get_ticket', { ticket_id: done1.auto_ticket_id });
  assert.ok(!full1?.isError, `get_ticket: ${JSON.stringify(full1)}`);
  assert.match(full1.title, /^QA 실패: Login flow QA/, 'title carries the scenario name');
  for (const l of ['qa-failure', 'auto', `qa-scenario:${sc1.id}`]) {
    assert.ok(full1.labels.includes(l), `label present: ${l}`);
  }
  assert.equal(full1.assignee_id, qaAgent.id, 'assignee = configured agent');
  assert.equal(full1.reviewer_id, qaAgent.id, 'reviewer mirrored');
  assert.ok(full1.description.includes(done1.id ?? ''), 'body references the run id');
  assert.ok(full1.description.includes('step 0 failed — evidence here'), 'body includes the failed step log');
  assert.ok(full1.description.includes('/api/resources/art-shot-0/raw'), 'body links the artifact raw stream');
  assert.ok(full1.description.includes(`/ws/${ws.id}/boards/${board.id}/qa`), 'body has the QA detail deep link');

  // ── 2. re-finalize the same run → no double-file ────────────────────────────
  step('CASE 2: re-finalizing the same run does not double-file');
  const refinal = await mcp.callTool('complete_qa_run', {
    run_id: done1.id, workspace_id: ws.id, status: 'failed', summary: 'idempotency re-finalize',
  });
  assert.ok(!refinal?.isError);
  assert.equal(refinal.auto_ticket_id, done1.auto_ticket_id, 'auto_ticket_id unchanged on re-finalize');
  const rows1b = await ticketsForScenario(sc1.id);
  assert.equal(rows1b.length, 1, 'still exactly one ticket after re-finalize (run-level idempotency)');

  // ── 3. passed run → nothing filed ───────────────────────────────────────────
  step('CASE 3: a passed run of the same scenario files nothing');
  const donePass = await runOnce(sc1.id, 'passed', { artifact: 'art-shot-pass' });
  assert.equal(donePass.auto_ticket_id ?? null, null, 'passed run has no auto_ticket_id');
  const rows1c = await ticketsForScenario(sc1.id);
  assert.equal(rows1c.length, 1, 'passed run did not add a ticket');

  // ── 4. per_open_ticket dedupe → recurrence comment, no new ticket ───────────
  step('CASE 4: per_open_ticket appends a recurrence comment instead of a new ticket');
  const sc2 = await mcp.callTool('create_qa_scenario', {
    workspace_id: ws.id, board_id: board.id, name: 'Checkout QA', target_agent_id: qaAgent.id,
    qa_driver: 'browser', steps,
    on_failure_ticket: { enabled: true, column_name: 'Todo', dedupe: 'per_open_ticket' },
  });
  assert.ok(!sc2?.isError && sc2.id, `create sc2: ${JSON.stringify(sc2)}`);

  const d2a = await runOnce(sc2.id, 'failed', { artifact: 'art-co-0' });
  const rows2a = await ticketsForScenario(sc2.id);
  assert.equal(rows2a.length, 1, 'first failure files one ticket');
  const ticket2 = rows2a[0].id;
  assert.equal(d2a.auto_ticket_id, ticket2);

  const d2b = await runOnce(sc2.id, 'error', { artifact: 'art-co-1' });
  const rows2b = await ticketsForScenario(sc2.id);
  assert.equal(rows2b.length, 1, 'second failure does NOT file a new ticket (per_open dedupe)');
  assert.equal(d2b.auto_ticket_id, ticket2, 'second run reuses the existing open ticket');
  const comments2 = await commentsForTicket(ticket2);
  assert.ok(comments2.some((c) => c.content.includes('QA 재실패')), 'recurrence comment appended to the open ticket');

  // ── 5. scenario WITHOUT on_failure_ticket → nothing filed ───────────────────
  step('CASE 5: a scenario without on_failure_ticket files nothing on failure');
  const sc3 = await mcp.callTool('create_qa_scenario', {
    workspace_id: ws.id, board_id: board.id, name: 'No-hook QA', target_agent_id: qaAgent.id,
    qa_driver: 'browser', steps,
  });
  assert.ok(!sc3?.isError && sc3.id);
  assert.equal(sc3.on_failure_ticket ?? null, null, 'no policy persisted');
  const d3 = await runOnce(sc3.id, 'failed', { artifact: 'art-x' });
  assert.equal(d3.auto_ticket_id ?? null, null, 'no ticket without a policy');
  const rows3 = await ticketsForScenario(sc3.id);
  assert.equal(rows3.length, 0, 'opt-out scenario files nothing');
});

exitAfterTests();
