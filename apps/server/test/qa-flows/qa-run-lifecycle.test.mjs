// QA flow: scenario-QA run lifecycle (QaScenario / QaRun).
//
// The scenario-QA feature shipped with the full CRUD + run surface but no
// regression covering the actual run loop. This test exercises the loop a real
// QA agent walks, end to end over MCP HTTP:
//
//   create_qa_scenario → start_qa_run → record_qa_step (×N, + re-record) →
//   complete_qa_run → get_qa_run / list_qa_runs
//
// Plus two regression guards on the pieces the run depends on:
//   - the rendered run prompt (qa-prompt.ts) is deterministic and references
//     the run id, scenario name, every step, and the record/complete tools;
//   - step_results upsert by idx (no duplicate rows) and artifact ids
//     accumulate at the run level.
//
// Acceptance:
//   1. A scenario built from the seed catalogue (qa-seed-scenarios) is created
//      with its steps + key tag intact.
//   2. start_qa_run returns run_id + room_id + a prompt that renders the run id,
//      scenario name, and each step line.
//   3. record_qa_step accumulates per-step results; re-recording an idx
//      overwrites in place; artifact ids fold into the run-level list.
//   4. complete_qa_run stamps the final status + finished_at; get_qa_run and
//      list_qa_runs reflect it.
//   5. renderQaRunPrompt is byte-identical for identical inputs.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createAgent, createApiKey, setupKanbanScene } from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

process.env.PORT = process.env.QA_RUN_LIFECYCLE_PORT || '7842';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', '..', 'dist');

async function loadQaModules() {
  const seed = await import(pathToFileURL(path.join(DIST, 'modules', 'qa', 'qa-seed-scenarios.js')).href);
  const prompt = await import(pathToFileURL(path.join(DIST, 'modules', 'qa', 'qa-prompt.js')).href);
  return { seed, prompt };
}

test('QA scenario run lifecycle: create → start → record → complete', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => app.close().catch(() => {}));
  const { getDataSourceToken } = modules;
  const { seed, prompt } = await loadQaModules();

  const { ws, board } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'qa-run' });
  const qaAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'qa-runner' });
  const qaKey = await createApiKey(app, getDataSourceToken, qaAgent.id, { workspaceId: ws.id, label: 'qa' });

  const mcp = new McpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: qaKey.raw_key });
  t.after(() => mcp.close().catch(() => {}));

  // ── Catalogue sanity ──────────────────────────────────────────────────────
  step('Build a scenario payload from the seed catalogue');
  assert.ok(Array.isArray(seed.QA_SEED_SCENARIOS) && seed.QA_SEED_SCENARIOS.length >= 10,
    'seed catalogue should ship a meaningful set');
  const payloads = seed.buildScenarioCreatePayloads({
    workspace_id: ws.id,
    target_agent_id: qaAgent.id,
    board_id: board.id,
    only: ['ticket-lifecycle'],
  });
  assert.equal(payloads.length, 1, 'only-filter returns exactly the requested scenario');
  const { _key, ...createArgs } = payloads[0];
  assert.equal(_key, 'ticket-lifecycle');
  assert.ok(createArgs.tags.includes(seed.keyTag('ticket-lifecycle')), 'key tag is stamped for idempotent re-seed');

  // ── 1. create_qa_scenario ───────────────────────────────────────────────────
  step('create_qa_scenario over MCP');
  const scenario = await mcp.callTool('create_qa_scenario', createArgs);
  assert.ok(!scenario?.isError, `create_qa_scenario failed: ${JSON.stringify(scenario)}`);
  assert.ok(scenario.id, 'scenario has an id');
  assert.equal(scenario.steps.length, createArgs.steps.length, 'steps round-trip intact');
  assert.equal(scenario.target_agent_id, qaAgent.id);

  // ── prompt determinism (qa-prompt regression) ────────────────────────────────
  step('renderQaRunPrompt is deterministic for identical inputs');
  const fakeRunId = '00000000-0000-4000-8000-000000000000';
  const p1 = prompt.renderQaRunPrompt(scenario, fakeRunId);
  const p2 = prompt.renderQaRunPrompt(scenario, fakeRunId);
  assert.equal(p1, p2, 'prompt render must be a pure function');
  assert.ok(p1.includes(fakeRunId), 'prompt embeds the run id');
  assert.ok(p1.includes(scenario.name), 'prompt embeds the scenario name');
  assert.ok(p1.includes('record_qa_step') && p1.includes('complete_qa_run'),
    'prompt instructs the agent to record + complete');
  for (const s of scenario.steps) {
    assert.ok(p1.includes(s.action), `prompt lists step action: ${s.action}`);
  }

  // ── 2. start_qa_run ──────────────────────────────────────────────────────────
  step('start_qa_run creates a run + room and returns the rendered prompt');
  const started = await mcp.callTool('start_qa_run', { scenario_id: scenario.id });
  assert.ok(!started?.isError, `start_qa_run failed: ${JSON.stringify(started)}`);
  assert.ok(started.run_id && started.room_id, 'run_id + room_id returned');
  assert.ok(started.prompt.includes(started.run_id), 'returned prompt references the live run id');

  const runId = started.run_id;

  // The freshly started run is in `running` with empty results.
  let run = await mcp.callTool('get_qa_run', { run_id: runId, workspace_id: ws.id });
  assert.equal(run.status, 'running');
  assert.deepEqual(run.step_results, []);

  // ── 3. record_qa_step ────────────────────────────────────────────────────────
  step('record each step result with an artifact id');
  for (const s of scenario.steps) {
    const res = await mcp.callTool('record_qa_step', {
      run_id: runId,
      workspace_id: ws.id,
      idx: s.idx,
      status: 'passed',
      log: `step ${s.idx} ok`,
      artifact_resource_ids: [`artifact-${s.idx}`],
    });
    assert.ok(!res?.isError, `record_qa_step ${s.idx} failed: ${JSON.stringify(res)}`);
  }
  run = await mcp.callTool('get_qa_run', { run_id: runId, workspace_id: ws.id });
  assert.equal(run.step_results.length, scenario.steps.length, 'one result per step');
  assert.ok(run.step_results.every((r) => r.status === 'passed'));
  assert.equal(run.artifact_resource_ids.length, scenario.steps.length, 'artifacts accumulate at run level');

  step('re-recording an idx overwrites in place (no duplicate rows)');
  const before = run.step_results.length;
  const reRec = await mcp.callTool('record_qa_step', {
    run_id: runId,
    workspace_id: ws.id,
    idx: 0,
    status: 'failed',
    log: 're-recorded',
    artifact_resource_ids: ['artifact-0'],
  });
  assert.ok(!reRec?.isError);
  assert.equal(reRec.step_results.length, before, 'count unchanged after re-record');
  assert.equal(reRec.step_results.find((r) => r.idx === 0).status, 'failed', 'idx 0 overwritten');

  // ── 4. complete_qa_run ───────────────────────────────────────────────────────
  step('complete_qa_run stamps final status + finished_at');
  const done = await mcp.callTool('complete_qa_run', {
    run_id: runId,
    workspace_id: ws.id,
    status: 'failed',
    summary: 'QA lifecycle regression run',
  });
  assert.ok(!done?.isError, `complete_qa_run failed: ${JSON.stringify(done)}`);
  assert.equal(done.status, 'failed');
  assert.ok(done.finished_at, 'finished_at stamped');
  assert.equal(done.summary, 'QA lifecycle regression run');

  step('list_qa_runs / get_qa_run reflect the completed run');
  const runs = await mcp.callTool('list_qa_runs', { scenario_id: scenario.id, workspace_id: ws.id });
  assert.ok(Array.isArray(runs) && runs.some((r) => r.id === runId), 'run present in history');

  // ── 5. Breadth: 2 more representative scenarios through the whole loop ─────────
  // Together with ticket-lifecycle above this covers task 3's "대표 시나리오 2~3개를
  // start_qa_run → record_qa_step → complete_qa_run 루프로 실제 돌려" requirement.
  // Kept in this single test() block because the run-flows controller treats
  // one file = one test() = one result.
  step('Representative scenarios each run start → record → complete');
  const breadth = seed.buildScenarioCreatePayloads({
    workspace_id: ws.id,
    target_agent_id: qaAgent.id,
    board_id: board.id,
    only: ['chat-room-messaging', 'benchmark-lifecycle'],
  });
  assert.equal(breadth.length, 2, 'two more representative scenarios');

  for (const { _key, ...createArgs } of breadth) {
    const sc = await mcp.callTool('create_qa_scenario', createArgs);
    assert.ok(!sc?.isError, `create ${_key}: ${JSON.stringify(sc)}`);

    const run2 = await mcp.callTool('start_qa_run', { scenario_id: sc.id });
    assert.ok(!run2?.isError && run2.run_id, `start ${_key}: ${JSON.stringify(run2)}`);

    for (const s of sc.steps) {
      const res = await mcp.callTool('record_qa_step', {
        run_id: run2.run_id, workspace_id: ws.id, idx: s.idx, status: 'passed', log: 'ok',
      });
      assert.ok(!res?.isError, `record ${_key}#${s.idx}: ${JSON.stringify(res)}`);
    }

    const fin = await mcp.callTool('complete_qa_run', {
      run_id: run2.run_id, workspace_id: ws.id, status: 'passed', summary: `${_key} ok`,
    });
    assert.ok(!fin?.isError, `complete ${_key}: ${JSON.stringify(fin)}`);
    assert.equal(fin.status, 'passed');
    assert.equal(fin.step_results.length, sc.steps.length, `${_key}: all steps recorded`);
    assert.ok(fin.step_results.every((r) => r.status === 'passed'), `${_key}: all steps passed`);
  }
});

exitAfterTests();
