// QA flow: on-failure auto-ticket (ticket 52a93654) + scenario-dedupe & on-pass
// auto-close (ticket 64b9cbaf).
//
// When a QaScenario opts into on_failure_ticket, a QaRun that finalizes as
// failed/error must auto-file a fix ticket carrying the failure evidence. This
// test drives the full path over MCP HTTP and asserts:
//
//   1. failed run → fix ticket created, in the active column, evidence in body
//      (failed step log + artifact raw link + QA detail deep link), labels +
//      priority from config, run.auto_ticket_id linked.
//   2. re-finalizing the SAME run does NOT double-file (run-level idempotency).
//   3. a passed run files nothing (negative case).
//   4. explicit dedupe='per_open_ticket' → a second failure of the same scenario
//      appends a recurrence comment to the still-open ticket instead of a new one.
//   + a scenario WITHOUT on_failure_ticket files nothing.
//
//   ── ticket 64b9cbaf ──
//   6. dedupe DEFAULTS to per_open_ticket (no `dedupe` key set) → a flaky
//      scenario converges to ONE ticket; the recurrence comment carries a
//      running fail count ("누적 N회").
//   7. a passing run auto-closes EVERY open sibling fix ticket (per_run cluster)
//      to the terminal Done column with a resolved comment, stamps
//      qa_rerun_dispatched_at so QaRerunOnFixService can't fire, and (rerun_on_fix
//      on) files NO extra rerun off the synthetic Done moves.
//   8. scope guard — a non-auto ticket that merely carries the scenario label is
//      NOT auto-closed.

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
  // A browser (visual-driver) PASS must clear the evidence gate — insert a real
  // image Resource so complete_qa_run(passed) isn't downgraded to failed. The run
  // just references the id via record_qa_step's artifact_resource_ids.
  const makeImageResource = async (id, name = 'shot.png') => {
    const repo = ds.getRepository('Resource');
    await repo.save(repo.create({
      id, workspace_id: ws.id, name, type: 'file',
      file_name: name, file_mimetype: 'image/png', file_data: '',
    }));
    return id;
  };
  const runsForScenario = async (scenarioId) =>
    ds.getRepository('QaRun').find({ where: { scenario_id: scenarioId } });

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
  // Real image evidence so the browser-driver PASS clears the evidence gate
  // (otherwise it downgrades to failed and files a per_run ticket).
  await makeImageResource('art-shot-pass');
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

  // ── 6. dedupe DEFAULTS to per_open_ticket (ticket 64b9cbaf) ─────────────────
  step('CASE 6: dedupe defaults to per_open_ticket — flaky scenario converges to one ticket');
  const sc6 = await mcp.callTool('create_qa_scenario', {
    workspace_id: ws.id, board_id: board.id, name: 'Default dedupe QA', target_agent_id: qaAgent.id,
    qa_driver: 'browser', steps,
    on_failure_ticket: { enabled: true, column_name: 'Todo' },   // NO dedupe key → default
  });
  assert.ok(!sc6?.isError && sc6.id, `create sc6: ${JSON.stringify(sc6)}`);

  const d6a = await runOnce(sc6.id, 'failed', { artifact: 'art-6a' });
  assert.equal((await ticketsForScenario(sc6.id)).length, 1, 'first failure files one ticket');
  const ticket6 = d6a.auto_ticket_id;
  assert.ok(ticket6, 'first failure carries auto_ticket_id');

  const d6b = await runOnce(sc6.id, 'failed', { artifact: 'art-6b' });
  const rows6b = await ticketsForScenario(sc6.id);
  assert.equal(rows6b.length, 1, 'default dedupe: second failure does NOT file a new ticket');
  assert.equal(d6b.auto_ticket_id, ticket6, 'second run reuses the existing open ticket by default');
  const comments6 = await commentsForTicket(ticket6);
  assert.ok(comments6.some((c) => c.content.includes('QA 재실패')), 'recurrence comment appended by default');
  assert.ok(comments6.some((c) => c.content.includes('누적 2회')), 'recurrence comment carries a running fail count');

  // ── 7. a passing run auto-closes all open sibling fix tickets (ticket 64b9cbaf) ──
  step('CASE 7: a passing run auto-closes every open sibling + suppresses rerun-on-fix');
  const sc7 = await mcp.callTool('create_qa_scenario', {
    workspace_id: ws.id, board_id: board.id, name: 'Auto-close QA', target_agent_id: qaAgent.id,
    qa_driver: 'browser', steps,
    // per_run so we build a 2-ticket sibling cluster; rerun_on_fix so the close
    // would fire a rerun UNLESS the qa_rerun_dispatched_at stamp suppresses it.
    on_failure_ticket: {
      enabled: true, column_name: 'Todo', dedupe: 'per_run',
      rerun_on_fix: true, max_rerun_attempts: 3, rerun_delay_seconds: 0,
    },
  });
  assert.ok(!sc7?.isError && sc7.id, `create sc7: ${JSON.stringify(sc7)}`);

  const d7a = await runOnce(sc7.id, 'failed', { artifact: 'art-7a' });
  const d7b = await runOnce(sc7.id, 'failed', { artifact: 'art-7b' });
  const rows7 = await ticketsForScenario(sc7.id);
  assert.equal(rows7.length, 2, 'per_run: two failures file two sibling tickets');
  assert.notEqual(d7a.auto_ticket_id, d7b.auto_ticket_id, 'two distinct sibling tickets');
  for (const r of rows7) assert.equal(r.column_id, columns.todo.id, 'each sibling sits in the active Todo column');
  assert.equal((await runsForScenario(sc7.id)).length, 2, 'two runs so far');

  await makeImageResource('art-7-pass');
  const d7pass = await runOnce(sc7.id, 'passed', { artifact: 'art-7-pass' });
  assert.equal(d7pass.auto_ticket_id ?? null, null, 'the passing run itself files no ticket');

  const rows7b = await ticketsForScenario(sc7.id);
  assert.equal(rows7b.length, 2, 'auto-close moves the siblings, never deletes or adds');
  for (const r of rows7b) {
    assert.equal(r.column_id, columns.done.id, 'each sibling auto-moved to the terminal Done column');
    const cs = await commentsForTicket(r.id);
    assert.ok(cs.some((c) => c.content.includes('QA 시나리오 재통과 — 자동 종결')), 'resolved comment on each closed sibling');
  }
  // Rerun suppression: qa_rerun_dispatched_at stamped >= terminal_entered_at so
  // QaRerunOnFixService's `qa_rerun_dispatched_at < terminal_entered_at` can't fire.
  const stamps7 = await ds.query(
    `SELECT qa_rerun_dispatched_at, terminal_entered_at FROM tickets WHERE labels LIKE '%qa-scenario:${sc7.id}%'`,
  );
  for (const s of stamps7) {
    assert.ok(s.qa_rerun_dispatched_at, 'qa_rerun_dispatched_at stamped on auto-close');
    assert.ok(s.terminal_entered_at, 'terminal_entered_at stamped on auto-close');
    assert.ok(
      new Date(s.qa_rerun_dispatched_at).getTime() >= new Date(s.terminal_entered_at).getTime(),
      'rerun stamp >= terminal entry → edge-claim cannot fire',
    );
  }
  // End-to-end: the rerun-on-fix listener is fire-and-forget; give it time and
  // assert NO extra run was dispatched off the synthetic Done moves.
  await new Promise((r) => setTimeout(r, 700));
  assert.equal((await runsForScenario(sc7.id)).length, 3, 'no rerun fired — only the 2 fails + 1 pass exist');

  // ── 8. auto-close scope guard (ticket 64b9cbaf) ─────────────────────────────
  step('CASE 8: a non-auto ticket carrying only the scenario label is NOT auto-closed');
  const sc8 = await mcp.callTool('create_qa_scenario', {
    workspace_id: ws.id, board_id: board.id, name: 'Scope guard QA', target_agent_id: qaAgent.id,
    qa_driver: 'browser', steps,
    on_failure_ticket: { enabled: true, column_name: 'Todo', dedupe: 'per_run' },
  });
  assert.ok(!sc8?.isError && sc8.id, `create sc8: ${JSON.stringify(sc8)}`);

  const d8a = await runOnce(sc8.id, 'failed', { artifact: 'art-8a' });
  assert.ok(d8a.auto_ticket_id, 'auto fix ticket filed');
  // A human ticket that references the scenario but is NOT a QA auto fix ticket
  // (carries only the scenario marker — no qa-failure/auto).
  const tRepo = ds.getRepository('Ticket');
  const humanTicket = await tRepo.save(tRepo.create({
    column_id: columns.todo.id, workspace_id: ws.id, title: 'human ticket referencing the scenario',
    labels: JSON.stringify([`qa-scenario:${sc8.id}`]), status: 'todo', position: 99,
  }));

  await makeImageResource('art-8-pass');
  await runOnce(sc8.id, 'passed', { artifact: 'art-8-pass' });

  const autoRow8 = (await ticketsForScenario(sc8.id)).find((r) => r.id === d8a.auto_ticket_id);
  assert.equal(autoRow8.column_id, columns.done.id, 'the auto fix ticket is auto-closed to Done');
  const humanRow = await ds.query(`SELECT column_id FROM tickets WHERE id = '${humanTicket.id}'`);
  assert.equal(humanRow[0].column_id, columns.todo.id, 'the non-auto scenario-labelled ticket is left untouched');
});

exitAfterTests();
