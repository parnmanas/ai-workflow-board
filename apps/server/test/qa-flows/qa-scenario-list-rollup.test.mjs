// QA flow: scenario list last-run rollup (QaService.list).
//
// The QA dashboard renders scenarios as a status table — each row needs its
// last-run time + result + pass-rate without an N+1 fetch-runs-per-scenario.
// QaService.list folds that rollup in with a single qa_runs query. This test
// guards the fold logic across the cases the table depends on:
//
//   - latest run wins (runs ordered created_at DESC; a later `running` run
//     supersedes an earlier finished one as last_run_status);
//   - a scenario with zero runs reports null last_run_* + run_count 0;
//   - name-ASC ordering and the disabled flag survive the enrichment.
//
// (The cumulative pass_rate field was removed — the UI no longer surfaces a
// pass-rate %, so the rollup only carries last_run_* + run_count now.)
//
// Setup writes QaScenario/QaRun rows directly via the data source (no dispatch
// machinery) and backdates created_at so "latest" is deterministic, then calls
// QaService.list and asserts the attached fields.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bootApp, step, exitAfterTests } from '../helpers/boot.mjs';

process.env.PORT = process.env.QA_LIST_ROLLUP_PORT || '7843';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', '..', 'dist');

test('QA scenario list attaches last-run rollup', async (t) => {
  const { app } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });

  const { QaService } = await import(pathToFileURL(path.join(DIST, 'modules', 'qa', 'qa.service.js')).href);
  const { getDataSourceToken } = await import('@nestjs/typeorm');
  const ds = app.get(getDataSourceToken());
  const qaService = app.get(QaService);
  const scenarioRepo = ds.getRepository('QaScenario');
  const runRepo = ds.getRepository('QaRun');

  const ws = randomUUID();
  const agentId = randomUUID();

  step('Seed three scenarios (name-ASC: A disabled, B, C no-runs)');
  const mkScenario = async (name, enabled) => scenarioRepo.save(scenarioRepo.create({
    workspace_id: ws, board_id: null, name, description: '', steps: [],
    target_agent_id: agentId, qa_driver: 'browser', qa_driver_config: null,
    enabled, tags: [], created_by: '', max_runs: 20,
  }));
  const sB = await mkScenario('B-with-history', true);
  const sA = await mkScenario('A-single-error', false);
  const sC = await mkScenario('C-no-runs', true);

  step('Seed runs with backdated created_at for deterministic latest');
  const mkRun = async (scenarioId, status, ageMs, { started = true, finished } = {}) => {
    const at = new Date(Date.now() - ageMs);
    const run = await runRepo.save(runRepo.create({
      id: randomUUID(), scenario_id: scenarioId, workspace_id: ws, board_id: null,
      status, room_id: '', step_results: [], artifact_resource_ids: [], summary: '',
      triggered_by_type: 'user', triggered_by_id: '',
      started_at: started ? at : null,
      finished_at: finished ? new Date(at.getTime() + 1000) : null,
    }));
    // CreateDateColumn auto-stamps now() on insert; backdate it explicitly.
    await runRepo.update(run.id, { created_at: at });
    return run;
  };
  // B: passed (oldest) → failed → running (newest). Latest = running.
  await mkRun(sB.id, 'passed', 30_000, { finished: true });
  await mkRun(sB.id, 'failed', 20_000, { finished: true });
  await mkRun(sB.id, 'running', 10_000, { finished: false });
  // A: a single error run.
  await mkRun(sA.id, 'error', 15_000, { finished: true });

  step('QaService.list folds the rollup in');
  const list = await qaService.list(ws, undefined);
  assert.equal(list.length, 3, 'all three scenarios returned');
  assert.deepEqual(list.map((s) => s.name), ['A-single-error', 'B-with-history', 'C-no-runs'],
    'name-ASC ordering preserved');

  const [a, b, c] = list;

  step('A: single error run → status error, run_count 1');
  assert.equal(a.enabled, false, 'disabled flag survives enrichment');
  assert.equal(a.last_run_status, 'error');
  assert.ok(a.last_run_at, 'last_run_at present');
  assert.equal(a.pass_rate, undefined, 'pass_rate field removed from the rollup');
  assert.equal(a.run_count, 1);

  step('B: latest is the running run; run_count counts all retained runs');
  assert.equal(b.last_run_status, 'running', 'newest run wins as last_run_status');
  assert.equal(b.run_count, 3, 'all retained runs counted');

  step('C: no runs → null rollup, run_count 0');
  assert.equal(c.last_run_status, null);
  assert.equal(c.last_run_at, null);
  assert.equal(c.run_count, 0);

  step('last_run_at is a valid ISO string');
  assert.ok(!Number.isNaN(Date.parse(b.last_run_at)), 'ISO-parseable last_run_at');

  exitAfterTests();
});
