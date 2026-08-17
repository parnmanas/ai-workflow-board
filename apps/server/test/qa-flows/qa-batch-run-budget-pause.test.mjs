// QA batch dispatch × workspace run-budget guard — review a51ec6d9 blocking #1.
//
// _dispatchBatchIndex's walk-forward exists for a PERMANENT failure (a
// scenario deleted/disabled since the batch was built): burn the index as
// `errored` and try the next one. RunBudgetExceededError is the opposite — a
// TRANSIENT rejection whose own escape hatch is "wait for the rolling window
// to clear" — but nothing in the loop ever shrinks the count, so before the
// fix a single breach at index k walked every remaining index off the same
// cliff (100% reproducible, not a race) and finalized the batch `done` with
// the whole tail burned as `errored`, with no documented recovery path for a
// batch (unlike a ticket, which the ticket-scoped guard auto-pends instead of
// destroying).
//
// This test drives a real 2-scenario batch over MCP HTTP, using a workspace
// run-budget tight enough that scenario 0's own run consumes the window's
// only slot (same technique as action-run-budget-exhaustion.test.mjs), so
// completing run 0 and advancing to scenario 1 trips the guard. It pins the
// two acceptance points the review asked for:
//   1. The remaining index (1) is NOT burned as `errored`.
//   2. The batch is NOT finalized `done`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createAgent, createApiKey, setupKanbanScene } from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

process.env.PORT = process.env.QA_BATCH_RUN_BUDGET_PORT || '7913';

function scenarioPayload(wsId, agentId, name) {
  return {
    workspace_id: wsId,
    target_agent_id: agentId,
    name,
    qa_driver: 'http-api',
    steps: [{ idx: 0, action: `noop for ${name}`, expect: 'ok' }],
  };
}

test('QA batch: a run-budget breach on the next index leaves the batch running, not done/errored', async (t) => {
  step('Boot app + MCP');
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());

  const { ws, board } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'qa-batch-budget' });
  // Tight run-creation-rate ceiling — scenario 0's own run consumes the
  // window's only slot, so dispatching scenario 1 trips the guard.
  await ds.getRepository('Workspace').update(ws.id, {
    hard_budget_config: JSON.stringify({ max_runs_per_window: 1, window_minutes: 60, notify: false }),
  });

  const qaAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'qa-batch-budget-runner' });
  const qaKey = await createApiKey(app, getDataSourceToken, qaAgent.id, { workspaceId: ws.id, label: 'qa' });

  const mcp = new McpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: qaKey.raw_key });
  t.after(() => { void mcp.close().catch(() => {}); });

  step('Create 2 QA scenarios for the batch');
  const s0 = await mcp.callTool('create_qa_scenario', scenarioPayload(ws.id, qaAgent.id, 'budget-s0'));
  const s1 = await mcp.callTool('create_qa_scenario', scenarioPayload(ws.id, qaAgent.id, 'budget-s1'));
  assert.ok(!s0?.isError && s0.id, `create s0 failed: ${JSON.stringify(s0)}`);
  assert.ok(!s1?.isError && s1.id, `create s1 failed: ${JSON.stringify(s1)}`);

  step('start_qa_batch — scenario 0 dispatches and consumes the only run-budget slot');
  const batch0 = await mcp.callTool('start_qa_batch', {
    workspace_id: ws.id,
    board_id: board.id,
    scenario_ids: [s0.id, s1.id],
  });
  assert.ok(!batch0?.isError && batch0.id, `start_qa_batch failed: ${JSON.stringify(batch0)}`);
  assert.equal(batch0.run_ids.length, 1, 'only scenario 0 dispatched');
  const run0 = batch0.run_ids[0];

  step('complete run 0 → advance attempts to dispatch scenario 1, which the run-budget guard rejects');
  const c0 = await mcp.callTool('complete_qa_run', { run_id: run0, workspace_id: ws.id, status: 'passed', summary: 's0 ok' });
  assert.ok(!c0?.isError, `complete run0: ${JSON.stringify(c0)}`);

  const batch = await mcp.callTool('get_qa_batch', { batch_id: batch0.id, workspace_id: ws.id });
  assert.equal(batch.status, 'running', 'batch must NOT be finalized done off a transient budget rejection');
  assert.equal(batch.errored, 0, 'the budget-rejected index must NOT be burned as errored');
  assert.equal(batch.current_index, 1, 'cursor parked at the index that hit the budget, ready to resume');
  assert.equal(batch.run_ids.length, 1, 'no run/phantom entry recorded for the rejected index');
  assert.ok(!batch.finished_at, 'finished_at must stay unset — the batch is not terminal');

  const s1Runs = await mcp.callTool('list_qa_runs', { scenario_id: s1.id, workspace_id: ws.id });
  assert.equal((Array.isArray(s1Runs) ? s1Runs : []).length, 0, 'scenario 1 has no run — rejected before creation, not a failed one');

  exitAfterTests(0);
});
