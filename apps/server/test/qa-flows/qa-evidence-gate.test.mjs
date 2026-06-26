// QA flow: evidence gate on complete_qa_run.
//
// Root cause of "증거 없는 PASSED": completeRun saved the QA agent's
// self-reported status verbatim, so a visual-driver (browser / game-client)
// run with zero image/video artifacts could land as PASSED. The gate now
// downgrades such a run to `failed` while leaving genuinely-evidenced visual
// runs and non-visual (awb-mcp / http) runs untouched.
//
// Acceptance:
//   1. browser scenario + complete(passed) with NO visual artifacts
//      → downgraded to `failed`, summary carries the 증거 누락 reason.
//   2. browser scenario + a real image/png Resource attached
//      → stays `passed` (no false-negative regression).
//   3. awb-mcp (non-visual) scenario + complete(passed) with no artifacts
//      → stays `passed` (gate is exempt for screenless drivers).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createAgent, createApiKey, setupKanbanScene } from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

process.env.PORT = process.env.QA_EVIDENCE_GATE_PORT || '7843';

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

test('QA evidence gate: visual PASSED without image/video artifacts is downgraded', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;
  const { pathToFileURL } = await import('node:url');
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const DIST = path.join(__dirname, '..', '..', 'dist');
  const seed = await import(pathToFileURL(path.join(DIST, 'modules', 'qa', 'qa-seed-scenarios.js')).href);

  const { ws, board } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'qa-evidence' });
  const qaAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'qa-evidence-runner' });
  const qaKey = await createApiKey(app, getDataSourceToken, qaAgent.id, { workspaceId: ws.id, label: 'qa' });
  const mcp = new McpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: qaKey.raw_key });
  t.after(() => { void mcp.close().catch(() => {}); });

  const ctx = { ws, board, agent: qaAgent, seed };

  // ── 1. Visual run, no visual evidence → must be downgraded to failed ─────────
  step('browser scenario reports passed with zero image/video artifacts');
  const visual = await makeScenario(mcp, 'visual-core-screens', ctx);
  assert.equal(visual.qa_driver, 'browser', 'seed is the browser driver');

  const r1 = await mcp.callTool('start_qa_run', { scenario_id: visual.id });
  assert.ok(!r1?.isError && r1.run_id, `start: ${JSON.stringify(r1)}`);
  // Record steps with non-resource artifact ids — these are NOT real Resource
  // rows, so the gate sees no image/video evidence even though the list is
  // non-empty. This is the exact "증거 없는 PASSED" shape.
  for (const s of visual.steps) {
    await mcp.callTool('record_qa_step', {
      run_id: r1.run_id, workspace_id: ws.id, idx: s.idx, status: 'passed',
      log: 'ok', artifact_resource_ids: [`not-a-resource-${s.idx}`],
    });
  }
  const done1 = await mcp.callTool('complete_qa_run', {
    run_id: r1.run_id, workspace_id: ws.id, status: 'passed', summary: 'all green (agent self-report)',
  });
  assert.ok(!done1?.isError, `complete: ${JSON.stringify(done1)}`);
  assert.equal(done1.status, 'failed', 'visual PASSED with no image/video evidence is downgraded');
  assert.ok(/증거 누락|evidence gate/.test(done1.summary), 'downgrade reason recorded in summary');
  assert.ok(done1.summary.includes('all green (agent self-report)'), 'original summary preserved');

  // ── 2. Visual run WITH a real image artifact → stays passed (no regression) ──
  step('browser scenario with a real image/png Resource stays passed');
  const ds = app.get(getDataSourceToken());
  const resourceRepo = ds.getRepository('Resource');
  const shot = await resourceRepo.save(resourceRepo.create({
    workspace_id: ws.id, board_id: board.id, name: 'login.png', type: 'image',
    file_name: 'login.png', file_mimetype: 'image/png', file_data: 'ZmFrZQ==',
  }));

  const r2 = await mcp.callTool('start_qa_run', { scenario_id: visual.id });
  assert.ok(!r2?.isError && r2.run_id, `start#2: ${JSON.stringify(r2)}`);
  for (const s of visual.steps) {
    await mcp.callTool('record_qa_step', {
      run_id: r2.run_id, workspace_id: ws.id, idx: s.idx, status: 'passed', log: 'ok',
    });
  }
  // Attach the real image at the run level.
  const att = await mcp.callTool('attach_qa_artifact', {
    run_id: r2.run_id, workspace_id: ws.id, resource_ids: [shot.id],
  });
  assert.ok(!att?.isError, `attach: ${JSON.stringify(att)}`);
  const done2 = await mcp.callTool('complete_qa_run', {
    run_id: r2.run_id, workspace_id: ws.id, status: 'passed', summary: 'evidenced run',
  });
  assert.ok(!done2?.isError, `complete#2: ${JSON.stringify(done2)}`);
  assert.equal(done2.status, 'passed', 'visual run with real image evidence stays passed');
  assert.equal(done2.summary, 'evidenced run', 'summary untouched when gate passes');

  // ── 3. Non-visual (awb-mcp) run → gate is exempt, stays passed ───────────────
  step('awb-mcp scenario with no artifacts stays passed (screenless driver exempt)');
  const mcpScenario = await makeScenario(mcp, 'ticket-lifecycle', ctx);
  assert.equal(mcpScenario.qa_driver, 'awb-mcp', 'seed is the awb-mcp driver');

  const r3 = await mcp.callTool('start_qa_run', { scenario_id: mcpScenario.id });
  assert.ok(!r3?.isError && r3.run_id, `start#3: ${JSON.stringify(r3)}`);
  for (const s of mcpScenario.steps) {
    await mcp.callTool('record_qa_step', {
      run_id: r3.run_id, workspace_id: ws.id, idx: s.idx, status: 'passed', log: 'ok',
    });
  }
  const done3 = await mcp.callTool('complete_qa_run', {
    run_id: r3.run_id, workspace_id: ws.id, status: 'passed', summary: 'mcp run ok',
  });
  assert.ok(!done3?.isError, `complete#3: ${JSON.stringify(done3)}`);
  assert.equal(done3.status, 'passed', 'non-visual run is exempt from the evidence gate');
  assert.equal(done3.summary, 'mcp run ok', 'summary untouched for exempt drivers');
});

exitAfterTests();
