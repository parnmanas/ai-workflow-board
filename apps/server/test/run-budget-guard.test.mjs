// Run-creation-rate guard — runtime tests (ticket a51ec6d9), against a REAL
// sql.js DataSource driven through the app's own buildDataSourceOptions()
// (so `synchronize` actually creates Workspace.hard_budget_config + the
// qa_runs/action_runs/orchestration_missions tables the guard queries — the
// dual-DB migration-free config-column convention; see hard-budget-guard.test.mjs
// for the same pattern applied to the per-ticket ceilings this module's
// sibling).
//
// Central behaviors this file pins:
//   - the WORKSPACE is the only scope axis (no board layer — QaRun has a
//     board_id but v1 deliberately does not count off it, ActionRun/
//     OrchestrationMission have none at all; see hard-budget-config.ts's (d)
//     doc and docs/catalog-scopes.md)
//   - each run KIND (qa/action/orchestration) is counted independently, so
//     one type's storm cannot starve another
//   - the ceiling is aROLLING WINDOW (creations in the last N minutes), not
//     an open-count cap — a run that ages out of the window self-heals the
//     ceiling with no reaper dependency, which matters because Action has no
//     stuck-run reaper at all and Orchestration has a mission-level blind
//     spot (ticket 954259e6)
//   - a confirmed breach always throws `RunBudgetExceededError` (429) with
//     the self-escape material the ticket a51ec6d9 plan requires: kind,
//     workspace, count/limit, window minutes, and the earliest retry time
//
// Runs against compiled dist/ (requires `npm run build`, satisfied by the
// test script). Uses an isolated SQLJS_DB_PATH temp file so it never touches
// the shared dev database/data.db.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-run-budget-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'run-budget-test.db');
process.env.NODE_ENV = 'test';

const { buildDataSourceOptions } = await import('file://' + path.join(DIST, 'db.js'));
const { DataSource } = await import('typeorm');
const { Workspace } = await import('file://' + path.join(DIST, 'entities', 'Workspace.js'));
const { QaRun } = await import('file://' + path.join(DIST, 'entities', 'QaRun.js'));
const { ActionRun } = await import('file://' + path.join(DIST, 'entities', 'ActionRun.js'));
const { OrchestrationMission } = await import('file://' + path.join(DIST, 'entities', 'OrchestrationMission.js'));
const { hardBudgetDefaultsFromEnv } = await import('file://' + path.join(DIST, 'common', 'hard-budget-config.js'));
const {
  resolveHardBudgetForWorkspace,
  countRunsInWindow,
  enforceRunBudget,
  RunBudgetExceededError,
} = await import('file://' + path.join(DIST, 'common', 'run-budget-guard.js'));

const ds = new DataSource(buildDataSourceOptions());
await ds.initialize();

const logStub = { warn() {}, info() {}, error() {}, debug() {} };
const deps = { dataSource: ds, logger: logStub };

const wsRepo = ds.getRepository(Workspace);
const qaRunRepo = ds.getRepository(QaRun);
const actionRunRepo = ds.getRepository(ActionRun);
const missionRepo = ds.getRepository(OrchestrationMission);

async function makeWorkspace(hardBudgetConfig) {
  return wsRepo.save(wsRepo.create({ name: 'W', hard_budget_config: hardBudgetConfig ?? null }));
}
async function makeQaRun(workspaceId, overrides = {}) {
  return qaRunRepo.save(qaRunRepo.create({ scenario_id: 's1', workspace_id: workspaceId, ...overrides }));
}
async function makeActionRun(workspaceId, overrides = {}) {
  return actionRunRepo.save(actionRunRepo.create({ action_id: 'a1', workspace_id: workspaceId, room_id: 'r1', ...overrides }));
}
async function makeMission(workspaceId, overrides = {}) {
  return missionRepo.save(missionRepo.create({ workspace_id: workspaceId, team_id: 't1', title: 'M', ...overrides }));
}

after(async () => {
  await ds.destroy();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── resolveHardBudgetForWorkspace ───────────────────────────────────────────
test('resolveHardBudgetForWorkspace: no row / null config inherits the env baseline verbatim', async () => {
  const base = hardBudgetDefaultsFromEnv({});
  assert.deepEqual(await resolveHardBudgetForWorkspace(ds, 'nonexistent-ws'), base);
  const ws = await makeWorkspace(null);
  assert.deepEqual(await resolveHardBudgetForWorkspace(ds, ws.id), base);
});

test('resolveHardBudgetForWorkspace: a workspace override applies', async () => {
  const ws = await makeWorkspace(JSON.stringify({ max_runs_per_window: 2, window_minutes: 15 }));
  const resolved = await resolveHardBudgetForWorkspace(ds, ws.id);
  assert.equal(resolved.maxRunsPerWindow, 2);
  assert.equal(resolved.windowMs, 15 * 60_000);
});

// ── countRunsInWindow ────────────────────────────────────────────────────────
test('countRunsInWindow: counts only the given kind + workspace at/after since', async () => {
  const ws1 = await makeWorkspace(null);
  const ws2 = await makeWorkspace(null);
  const since = new Date(Date.now() - 1000);
  await makeQaRun(ws1.id);
  await makeQaRun(ws1.id);
  await makeQaRun(ws2.id); // different workspace — must not count toward ws1
  await makeActionRun(ws1.id); // different kind, same workspace — must not count toward 'qa'
  assert.equal(await countRunsInWindow(ds, 'qa', ws1.id, since), 2);
  assert.equal(await countRunsInWindow(ds, 'action', ws1.id, since), 1);
  assert.equal(await countRunsInWindow(ds, 'qa', ws2.id, since), 1);
});

test('countRunsInWindow: a future `since` sees nothing yet', async () => {
  const ws = await makeWorkspace(null);
  await makeQaRun(ws.id);
  assert.equal(await countRunsInWindow(ds, 'qa', ws.id, new Date(Date.now() + 60_000)), 0);
});

test('countRunsInWindow: the orchestration kind counts OrchestrationMission rows', async () => {
  const ws = await makeWorkspace(null);
  const since = new Date(Date.now() - 1000);
  await makeMission(ws.id);
  assert.equal(await countRunsInWindow(ds, 'orchestration', ws.id, since), 1);
});

// ── enforceRunBudget ─────────────────────────────────────────────────────────
test('enforceRunBudget: under the cap does not throw', async () => {
  const ws = await makeWorkspace(JSON.stringify({ max_runs_per_window: 5, notify: false }));
  await makeQaRun(ws.id);
  await assert.doesNotReject(() => enforceRunBudget(deps, 'qa', ws.id));
});

test('enforceRunBudget: at the cap throws RunBudgetExceededError carrying kind/workspace/count/limit/window (self-escape material)', async () => {
  const ws = await makeWorkspace(JSON.stringify({ max_runs_per_window: 2, window_minutes: 30, notify: false }));
  await makeQaRun(ws.id);
  await makeQaRun(ws.id);
  await assert.rejects(
    () => enforceRunBudget(deps, 'qa', ws.id),
    (err) => {
      assert.ok(err instanceof RunBudgetExceededError);
      assert.equal(err.status, 429);
      assert.equal(err.kind, 'qa');
      assert.equal(err.workspaceId, ws.id);
      assert.equal(err.count, 2);
      assert.equal(err.limit, 2);
      assert.equal(err.windowMinutes, 30);
      assert.ok(err.retryAt instanceof Date, 'must carry an earliest-retry timestamp');
      return true;
    },
  );
});

test('enforceRunBudget: retryAt is the oldest counted run\'s created_at plus the window length', async () => {
  const ws = await makeWorkspace(JSON.stringify({ max_runs_per_window: 1, window_minutes: 30, notify: false }));
  const run = await makeQaRun(ws.id);
  let caught = null;
  try {
    await enforceRunBudget(deps, 'qa', ws.id);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, 'must throw once at the cap');
  const expected = new Date(run.created_at).getTime() + 30 * 60_000;
  assert.equal(caught.retryAt.getTime(), expected, 'retryAt must be exactly when the oldest counted run ages out of the window');
});

test('enforceRunBudget: a run outside the window ages out automatically — no reaper dependency', async () => {
  const ws = await makeWorkspace(JSON.stringify({ max_runs_per_window: 1, window_minutes: 1, notify: false }));
  await makeQaRun(ws.id, { created_at: new Date(Date.now() - 5 * 60_000) }); // 5 min old, window is 1 min
  await assert.doesNotReject(
    () => enforceRunBudget(deps, 'qa', ws.id),
    'the old run fell outside the 1-minute window, so the ceiling self-healed and a new run is allowed',
  );
});

test('enforceRunBudget: run kinds are counted independently — a QA storm does not block Action in the same workspace', async () => {
  const ws = await makeWorkspace(JSON.stringify({ max_runs_per_window: 1, notify: false }));
  await makeQaRun(ws.id);
  await assert.rejects(() => enforceRunBudget(deps, 'qa', ws.id));
  await assert.doesNotReject(() => enforceRunBudget(deps, 'action', ws.id), 'action has its own independent counter');
  await assert.doesNotReject(() => enforceRunBudget(deps, 'orchestration', ws.id), 'orchestration has its own independent counter');
});

test('enforceRunBudget: enabled=false never throws regardless of count', async () => {
  const ws = await makeWorkspace(JSON.stringify({ max_runs_per_window: 1, enabled: false }));
  await makeQaRun(ws.id);
  await makeQaRun(ws.id);
  await assert.doesNotReject(() => enforceRunBudget(deps, 'qa', ws.id));
});

test('enforceRunBudget: an unconfigured workspace (no row) fails open against the env baseline', async () => {
  await assert.doesNotReject(() => enforceRunBudget(deps, 'qa', 'nonexistent-ws'));
});
