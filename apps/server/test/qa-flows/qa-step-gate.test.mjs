// QA flow: per-step gate on complete_qa_run.
//
// Root cause of "run=passed 인데 화면 % 가 <100%": completeRun trusted the QA
// agent's self-reported overall status verbatim, so a run could land as PASSED
// even when one of its recorded steps was `failed` (or never resolved past
// `pending`). The step gate now downgrades such a run to `failed` so a passed
// run guarantees every recorded step is passed/skipped.
//
// A non-visual (awb-mcp) scenario is used so the *evidence* gate stays exempt
// and we isolate the step gate. `skipped` is treated as a pass; `failed` and
// `pending` reject.
//
// Acceptance:
//   1. one recorded step `failed`  → complete(passed) downgraded to `failed`.
//   2. one recorded step `pending` → complete(passed) downgraded to `failed`.
//   3. one step `skipped` + rest `passed` → stays `passed` (skip allowed).
//   4. every step `passed`         → stays `passed` (no false-negative).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createAgent, createApiKey, setupKanbanScene } from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

process.env.PORT = process.env.QA_STEP_GATE_PORT || '7844';

async function makeScenario(mcp, seedKey, { ws, board, agent, seed }) {
  const [payload] = seed.buildScenarioCreatePayloads({
    workspace_id: ws.id,
    target_agent_id: agent.id,
    board_id: board.id,
    only: [seedKey],
  });
  assert.ok(payload, `seed catalogue has ${seedKey}`);
  const { _key, ...createArgs } = payload;
  const sc = await mcp.callTool('create_qa_scenario', createArgs);
  assert.ok(!sc?.isError, `create ${seedKey}: ${JSON.stringify(sc)}`);
  return sc;
}

// Record every step with `passed`, except the step at `failIdx` which gets
// `overrideStatus`. Returns nothing — caller completes the run afterwards.
async function recordSteps(mcp, ws, scenario, runId, overrideIdx, overrideStatus) {
  for (const s of scenario.steps) {
    await mcp.callTool('record_qa_step', {
      run_id: runId, workspace_id: ws.id, idx: s.idx,
      status: s.idx === overrideIdx ? overrideStatus : 'passed',
      log: 'ok',
    });
  }
}

test('QA step gate: a passed run with a failed/pending step is downgraded', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;
  const { pathToFileURL } = await import('node:url');
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const DIST = path.join(__dirname, '..', '..', 'dist');
  const seed = await import(pathToFileURL(path.join(DIST, 'modules', 'qa', 'qa-seed-scenarios.js')).href);

  const { ws, board } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'qa-step-gate' });
  const qaAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'qa-step-runner' });
  const qaKey = await createApiKey(app, getDataSourceToken, qaAgent.id, { workspaceId: ws.id, label: 'qa' });
  const mcp = new McpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: qaKey.raw_key });
  t.after(() => { void mcp.close().catch(() => {}); });

  const ctx = { ws, board, agent: qaAgent, seed };

  // awb-mcp scenario → evidence gate is exempt, isolating the step gate.
  const scenario = await makeScenario(mcp, 'ticket-lifecycle', ctx);
  assert.equal(scenario.qa_driver, 'awb-mcp', 'seed is the non-visual awb-mcp driver');
  assert.ok(scenario.steps.length >= 2, 'scenario has multiple steps to grade');
  const firstIdx = scenario.steps[0].idx;

  // ── 1. One step failed → run downgraded to failed ────────────────────────────
  step('one recorded step is failed; complete(passed) downgrades to failed');
  const r1 = await mcp.callTool('start_qa_run', { scenario_id: scenario.id });
  assert.ok(!r1?.isError && r1.run_id, `start#1: ${JSON.stringify(r1)}`);
  await recordSteps(mcp, ws, scenario, r1.run_id, firstIdx, 'failed');
  const done1 = await mcp.callTool('complete_qa_run', {
    run_id: r1.run_id, workspace_id: ws.id, status: 'passed', summary: 'agent claims all green',
  });
  assert.ok(!done1?.isError, `complete#1: ${JSON.stringify(done1)}`);
  assert.equal(done1.status, 'failed', 'passed with a failed step is downgraded');
  assert.ok(/step gate|step 불일치/.test(done1.summary), 'step-gate reason recorded in summary');
  assert.ok(done1.summary.includes('agent claims all green'), 'original summary preserved');

  // ── 2. One step still pending → run downgraded to failed ─────────────────────
  step('one recorded step is pending; complete(passed) downgrades to failed');
  const r2 = await mcp.callTool('start_qa_run', { scenario_id: scenario.id });
  assert.ok(!r2?.isError && r2.run_id, `start#2: ${JSON.stringify(r2)}`);
  await recordSteps(mcp, ws, scenario, r2.run_id, firstIdx, 'pending');
  const done2 = await mcp.callTool('complete_qa_run', {
    run_id: r2.run_id, workspace_id: ws.id, status: 'passed', summary: 'still working really',
  });
  assert.ok(!done2?.isError, `complete#2: ${JSON.stringify(done2)}`);
  assert.equal(done2.status, 'failed', 'passed with a pending (incomplete) step is downgraded');
  assert.ok(/pending/.test(done2.summary), 'pending reason recorded in summary');

  // ── 3. One step skipped + rest passed → stays passed (skip allowed) ──────────
  step('a skipped step is treated as a pass; run stays passed');
  const r3 = await mcp.callTool('start_qa_run', { scenario_id: scenario.id });
  assert.ok(!r3?.isError && r3.run_id, `start#3: ${JSON.stringify(r3)}`);
  await recordSteps(mcp, ws, scenario, r3.run_id, firstIdx, 'skipped');
  const done3 = await mcp.callTool('complete_qa_run', {
    run_id: r3.run_id, workspace_id: ws.id, status: 'passed', summary: 'one step n/a, rest pass',
  });
  assert.ok(!done3?.isError, `complete#3: ${JSON.stringify(done3)}`);
  assert.equal(done3.status, 'passed', 'skipped steps do not block passed');
  assert.equal(done3.summary, 'one step n/a, rest pass', 'summary untouched when gate passes');

  // ── 4. Every step passed → stays passed (no false-negative regression) ───────
  step('every step passed; run stays passed');
  const r4 = await mcp.callTool('start_qa_run', { scenario_id: scenario.id });
  assert.ok(!r4?.isError && r4.run_id, `start#4: ${JSON.stringify(r4)}`);
  await recordSteps(mcp, ws, scenario, r4.run_id, -1, 'passed');
  const done4 = await mcp.callTool('complete_qa_run', {
    run_id: r4.run_id, workspace_id: ws.id, status: 'passed', summary: 'genuine green',
  });
  assert.ok(!done4?.isError, `complete#4: ${JSON.stringify(done4)}`);
  assert.equal(done4.status, 'passed', 'all-passed run stays passed');
  assert.equal(done4.summary, 'genuine green', 'summary untouched when gate passes');
});

exitAfterTests();
