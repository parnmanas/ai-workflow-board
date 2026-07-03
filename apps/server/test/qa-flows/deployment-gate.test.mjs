// QA flow: deployment-FACT gate for rerun-on-fix (ticket 8ce72b18, DoD item 3).
//
// "Merged ≠ deployed" is the recurring false-negative: a fix ticket hits Done and
// the QA rerun fires INSTANTLY, but the environment auto-deploys AFTER main merges
// — so the rerun validates the pre-fix code. The fix replaces the brittle
// `rerun_delay_seconds` TIME guess with a fact: when the scenario opts into
// `on_failure_ticket.deployment_gate` and has a `target_environment`, the rerun
// WAITS until that environment's live deployment actually INCLUDES the fix commit,
// firing the instant a matching `report_deployment` lands. No hardcoded time.
//
// This test drives the gate end-to-end and asserts the DoD Verify cases:
//   1. fix Done with deployment_gate ON but NO deployment yet → rerun does NOT
//      fire (it is deferred, not dropped).
//   2. a deployment that does NOT include the fix commit → still no rerun.
//   3. the deployment that INCLUDES the fix (via ancestor_shas) → the rerun fires
//      the moment it lands (generation 1, server-triggered) — and the new run's
//      server-authoritative `tested_commit`/`tested_environment` record the exact
//      deployed commit it validated (DoD item 4 evidence).
//   4. freshness fallback: with NO `fix-commit:` label, a deployment whose
//      `deployed_at` is at/after the fix's Done un-gates the rerun (deploy-ordering).
//
// Like qa-rerun-on-fix.test.mjs we simulate the terminal landing directly (stamp
// terminal_entered_at + log a `moved` activity) so the service sees exactly what
// the production move path emits.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createAgent, createApiKey, setupKanbanScene } from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

process.env.PORT = process.env.DEPLOYMENT_GATE_PORT || '7853';

// A commit that plays the role of "the fix commit" (40-hex, matched exactly).
const FIX_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
// The environment HEAD that CONTAINS the fix as an ancestor (real-world deploy).
const DEPLOY_HEAD = '0f1e2d3c4b5a69788796a5b4c3d2e1f000112233';
// A HEAD that does NOT contain the fix (no matching ancestor).
const UNRELATED_HEAD = 'ffffffffffffffffffffffffffffffffffffffff';

async function moveToDone(ds, activityService, ticketId, doneColId, { restamp = true } = {}) {
  const tRepo = ds.getRepository('Ticket');
  if (restamp) {
    await tRepo.update(ticketId, { column_id: doneColId, terminal_entered_at: new Date() });
  }
  await activityService.logActivity({
    entity_type: 'ticket', entity_id: ticketId, action: 'moved',
    field_changed: 'column', new_value: 'Done', ticket_id: ticketId,
    actor_id: 'test-user', actor_name: 'Tester',
  });
}

async function runsForScenario(ds, scenarioId) {
  return ds.getRepository('QaRun').find({ where: { scenario_id: scenarioId }, order: { created_at: 'ASC' } });
}

// The rerun listener is fire-and-forget (.catch); poll until the run count lands.
async function waitForRunCount(ds, scenarioId, expected, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  let rows = await runsForScenario(ds, scenarioId);
  while (rows.length < expected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    rows = await runsForScenario(ds, scenarioId);
  }
  return rows;
}

// Append a label to a ticket without dropping the marker labels the gate needs.
async function addLabel(ds, ticketId, label) {
  const tRepo = ds.getRepository('Ticket');
  const row = await tRepo.findOne({ where: { id: ticketId } });
  const labels = JSON.parse(row.labels || '[]');
  if (!labels.includes(label)) labels.push(label);
  await tRepo.update(ticketId, { labels: JSON.stringify(labels) });
}

test('deployment gate: rerun waits for the deploy that includes the fix, then fires', async (t) => {
  step('Boot NestJS app + scene');
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const activityService = app.get(modules.ActivityService);

  const { ws, board, columns } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'deploy-gate' });
  const qaAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'qa-runner' });
  const qaKey = await createApiKey(app, getDataSourceToken, qaAgent.id, { workspaceId: ws.id, label: 'qa' });

  const mcp = new McpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: qaKey.raw_key });
  t.after(() => { void mcp.close().catch(() => {}); });

  const steps = [{ idx: 0, action: 'open the page', expect: 'no error' }];

  const completeLatest = async (scenarioId, status) => {
    const runs = await runsForScenario(ds, scenarioId);
    const latest = runs[runs.length - 1];
    await mcp.callTool('record_qa_step', {
      run_id: latest.id, workspace_id: ws.id, idx: 0,
      status: status === 'passed' ? 'passed' : 'failed', log: `step 0 ${status}`,
    });
    const done = await mcp.callTool('complete_qa_run', {
      run_id: latest.id, workspace_id: ws.id, status, summary: `run ${status}`,
    });
    assert.ok(!done?.isError, `complete_qa_run: ${JSON.stringify(done)}`);
    return done;
  };

  // ── Setup: an env-bound scenario with the deployment gate ON, NO time delay ──
  step('Create scenario: deployment_gate ON, target_environment=gate-env, rerun_delay_seconds=0');
  const sc = await mcp.callTool('create_qa_scenario', {
    workspace_id: ws.id, board_id: board.id, name: 'Gated QA', target_agent_id: qaAgent.id,
    qa_driver: 'browser', steps, target_environment: 'gate-env',
    on_failure_ticket: {
      enabled: true, column_name: 'Todo', dedupe: 'per_open_ticket',
      rerun_on_fix: true, max_rerun_attempts: 5, rerun_delay_seconds: 0, deployment_gate: true,
    },
  });
  assert.ok(!sc?.isError && sc.id, `create scenario: ${JSON.stringify(sc)}`);
  assert.equal(sc.target_environment, 'gate-env', 'target_environment round-trips');
  assert.equal(sc.on_failure_ticket?.deployment_gate, true, 'deployment_gate round-trips');

  // ── CASE 1: fix Done with the gate ON but NO deployment → rerun is DEFERRED ───
  step('CASE 1: fail run → fix ticket; label it fix-commit:<sha>; Done fires NO rerun (no deploy yet)');
  const r0 = await mcp.callTool('start_qa_run', { scenario_id: sc.id });
  assert.ok(!r0?.isError && r0.run_id, `start run: ${JSON.stringify(r0)}`);
  const done0 = await completeLatest(sc.id, 'failed');
  assert.ok(done0.auto_ticket_id, 'failure files a fix ticket');
  const fixTicket = done0.auto_ticket_id;

  await addLabel(ds, fixTicket, `fix-commit:${FIX_SHA}`);
  await moveToDone(ds, activityService, fixTicket, columns.done.id);
  // Settle: assert the gate held (no rerun without a deployment).
  await new Promise((r) => setTimeout(r, 600));
  assert.equal((await runsForScenario(ds, sc.id)).length, 1, 'gate holds — no rerun before deploy');

  // ── CASE 2: a deployment that does NOT include the fix → still deferred ───────
  step('CASE 2: report a deploy WITHOUT the fix commit → rerun still deferred');
  const dep2 = await mcp.callTool('report_deployment', {
    workspace_id: ws.id, environment: 'gate-env',
    deployed_commit_sha: UNRELATED_HEAD, ancestor_shas: [], source: 'webhook',
  });
  assert.ok(!dep2?.isError, `report_deployment: ${JSON.stringify(dep2)}`);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal((await runsForScenario(ds, sc.id)).length, 1, 'non-including deploy does not un-gate');

  // ── CASE 3: the deployment that INCLUDES the fix → rerun FIRES immediately ────
  step('CASE 3: report a deploy whose ancestry INCLUDES the fix → rerun fires now');
  const dep3 = await mcp.callTool('report_deployment', {
    workspace_id: ws.id, environment: 'gate-env',
    deployed_commit_sha: DEPLOY_HEAD, ancestor_shas: [FIX_SHA, UNRELATED_HEAD], source: 'webhook',
  });
  assert.ok(!dep3?.isError, `report_deployment: ${JSON.stringify(dep3)}`);
  const allRuns = await waitForRunCount(ds, sc.id, 2);
  assert.equal(allRuns.length, 2, 'the fix-including deploy un-gated the rerun');
  const rerun = allRuns[1];
  assert.equal(rerun.rerun_generation, 1, 'rerun is generation 1');
  assert.equal(rerun.triggered_by_id, 'qa-rerun-on-fix', 'rerun is server-triggered by the gate');
  // DoD item 4: the run records the exact deployed commit it validated.
  assert.equal(rerun.tested_commit, DEPLOY_HEAD, 'tested_commit = the live deployed commit at dispatch');
  assert.equal(rerun.tested_environment, 'gate-env', 'tested_environment recorded');

  // ── CASE 4: freshness fallback — no fix-commit label, deploy-ordering un-gates ─
  step('CASE 4: freshness fallback — no fix-commit label; a deploy at/after Done un-gates');
  const scF = await mcp.callTool('create_qa_scenario', {
    workspace_id: ws.id, board_id: board.id, name: 'Freshness QA', target_agent_id: qaAgent.id,
    qa_driver: 'browser', steps, target_environment: 'fresh-env',
    on_failure_ticket: {
      enabled: true, column_name: 'Todo', dedupe: 'per_open_ticket',
      rerun_on_fix: true, max_rerun_attempts: 5, rerun_delay_seconds: 0, deployment_gate: true,
    },
  });
  assert.ok(!scF?.isError && scF.id);
  await mcp.callTool('start_qa_run', { scenario_id: scF.id });
  const doneF = await completeLatest(scF.id, 'failed');
  assert.ok(doneF.auto_ticket_id, 'freshness scenario files a fix ticket');
  // NO fix-commit label this time → the gate uses deployed_at >= Done ordering.
  await moveToDone(ds, activityService, doneF.auto_ticket_id, columns.done.id);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await runsForScenario(ds, scF.id)).length, 1, 'freshness gate holds before any deploy');

  const depF = await mcp.callTool('report_deployment', {
    workspace_id: ws.id, environment: 'fresh-env',
    deployed_commit_sha: DEPLOY_HEAD, source: 'webhook',
    deployed_at: new Date(Date.now() + 2000).toISOString(),
  });
  assert.ok(!depF?.isError, `report_deployment: ${JSON.stringify(depF)}`);
  const freshRuns = await waitForRunCount(ds, scF.id, 2);
  assert.equal(freshRuns.length, 2, 'a deploy at/after the fix Done un-gated the freshness rerun');
  assert.equal(freshRuns[1].rerun_generation, 1, 'freshness rerun is generation 1');
});

exitAfterTests();
