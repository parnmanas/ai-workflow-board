// QA flow: Orchestration mode end-to-end — the autonomous delegation loop.
//
// This walks the exact path a real team takes, over MCP HTTP for everything an
// agent does (so the tool authz gate, session identity resolution and JSON
// schemas are all exercised) and over the services for what a human does:
//
//   team + members → mission → start (orchestrator briefed in its room) →
//   submit_orchestration_plan → server auto-dispatches wave 1 →
//   report_orchestration_step ×N → server auto-dispatches wave 2 →
//   complete_orchestration_mission
//
// Acceptance:
//   1. Starting a mission creates the orchestrator's room, posts a brief that
//      names the mission id and the roster, and moves it to `planning`.
//   2. A submitted plan is validated, persisted, and every dependency-free step
//      is dispatched IMMEDIATELY (in parallel, into one room per step) without
//      the orchestrator dispatching anything itself.
//   3. A dependent step stays `pending` until ALL its dependencies report, then
//      dispatches on its own.
//   4. A step's report reaches its dependents as prompt context (the point of
//      result_summary), and only the assignee/orchestrator may report it.
//   5. A failed step blocks its dependents and wakes the orchestrator.
//   6. The mission does NOT end implicitly — only complete_orchestration_mission
//      ends it, and it refuses to "complete" with work still in flight.
//   7. Parallelism is capped by the mission's max_parallel_steps.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createAgent, createApiKey, createWorkspace } from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

process.env.PORT = process.env.ORCHESTRATION_LIFECYCLE_PORT || '7871';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', '..', 'dist');

async function loadOrchestrationServices() {
  const team = await import(
    pathToFileURL(path.join(DIST, 'modules', 'orchestration', 'orchestration-team.service.js')).href
  );
  const mission = await import(
    pathToFileURL(path.join(DIST, 'modules', 'orchestration', 'orchestration-mission.service.js')).href
  );
  const runner = await import(
    pathToFileURL(path.join(DIST, 'modules', 'orchestration', 'orchestration-runner.service.js')).href
  );
  return {
    OrchestrationTeamService: team.OrchestrationTeamService,
    OrchestrationMissionService: mission.OrchestrationMissionService,
    OrchestrationRunnerService: runner.OrchestrationRunnerService,
  };
}

/** Every message the server posted into a room, oldest first. */
async function roomMessages(ds, roomId) {
  return ds.getRepository('ChatRoomMessage').find({ where: { room_id: roomId }, order: { created_at: 'ASC' } });
}

const HUMAN = { type: 'user', id: 'qa-operator', name: 'QA Operator' };

// ONE app for the whole file. bootApp() pins SQLJS_DB_PATH on its first call,
// so a second boot in the same process would attach a second DataSource to the
// same sql.js file — the tests below isolate themselves by workspace instead.
let shared = null;
async function sharedApp(t) {
  if (!shared) {
    shared = await bootApp({ port: parseInt(process.env.PORT, 10) });
    const { app } = shared;
    shared.services = await loadOrchestrationServices();
    process.on('exit', () => { void app.close().catch(() => {}); });
  }
  return shared;
}

test('Orchestration: team → mission → plan → parallel dispatch → reports → completion', async (t) => {
  const { app, port, modules, services } = await sharedApp(t);
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const { OrchestrationTeamService, OrchestrationMissionService, OrchestrationRunnerService } = services;
  const teams = app.get(OrchestrationTeamService);
  const missions = app.get(OrchestrationMissionService);
  const runner = app.get(OrchestrationRunnerService);

  const ws = await createWorkspace(app, getDataSourceToken, 'orchestration');
  const lead = await createAgent(app, getDataSourceToken, ws.id, { name: 'lead' });
  const backend = await createAgent(app, getDataSourceToken, ws.id, { name: 'backend' });
  const frontend = await createAgent(app, getDataSourceToken, ws.id, { name: 'frontend' });

  const mcpFor = async (agent, label) => {
    const key = await createApiKey(app, getDataSourceToken, agent.id, { workspaceId: ws.id, label });
    const client = new McpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: key.raw_key });
    t.after(() => { void client.close().catch(() => {}); });
    return client;
  };
  const leadMcp = await mcpFor(lead, 'lead');
  const backendMcp = await mcpFor(backend, 'backend');
  const frontendMcp = await mcpFor(frontend, 'frontend');

  // ── 1. Team ───────────────────────────────────────────────────────────────
  step('Create a team with an orchestrator and two members');
  const team = await teams.createTeam({
    workspace_id: ws.id,
    name: 'Platform squad',
    orchestrator_agent_id: lead.id,
    orchestrator_prompt: 'Always ask for tests.',
    max_parallel_steps: 2,
    created_by: HUMAN.id,
  });
  await teams.addMember(team.id, ws.id, {
    agent_id: backend.id,
    role_label: 'backend',
    capabilities: 'NestJS + TypeORM, owns apps/server',
  });
  await teams.addMember(team.id, ws.id, {
    agent_id: frontend.id,
    role_label: 'frontend',
    capabilities: 'React + Vite, owns apps/client',
  });

  await assert.rejects(
    () => teams.addMember(team.id, ws.id, { agent_id: backend.id }),
    /already a member/,
    'the same agent cannot be added twice',
  );

  // ── 2. Mission + start ────────────────────────────────────────────────────
  step('Create a mission and brief the orchestrator');
  const created = await missions.createMission({
    workspace_id: ws.id,
    team_id: team.id,
    title: 'Ship the billing export',
    objective: 'Add a CSV export of monthly invoices behind the existing feature flag.',
    acceptance_criteria: 'Export downloads and matches the invoice ledger.',
    max_parallel_steps: 2,
    created_by_type: 'user',
    created_by: HUMAN.id,
  });
  assert.equal(created.status, 'draft', 'a fresh mission is a draft until started');

  const started = await runner.startMission(created.id, ws.id, HUMAN);
  assert.equal(started.status, 'planning');
  assert.equal(started.orchestrator_agent_id, lead.id, 'the orchestrator is snapshotted at start');
  assert.ok(started.room_id, 'a mission room was created');

  const brief = await roomMessages(ds, started.room_id);
  assert.equal(brief.length, 1, 'exactly one brief was posted');
  assert.match(brief[0].content, new RegExp(created.id), 'the brief carries the mission id the tools need');
  assert.match(brief[0].content, /submit_orchestration_plan/, 'the brief names the tool that submits the plan');
  assert.match(brief[0].content, new RegExp(backend.name), 'the roster is rendered into the brief');
  assert.match(brief[0].content, /Always ask for tests\./, 'team standing instructions are appended');

  const missionRoom = await ds.getRepository('ChatRoom').findOne({ where: { id: started.room_id } });
  assert.equal(missionRoom.orchestration_mission_id, created.id, 'the room is stamped so the chat list hides it');

  await assert.rejects(
    () => runner.startMission(created.id, ws.id, HUMAN),
    /already planning/,
    'a mission cannot be briefed twice',
  );

  // ── 3. Plan submission + automatic wave-1 dispatch ────────────────────────
  step('Orchestrator reads the mission over MCP');
  const readBack = await leadMcp.callTool('get_orchestration_mission', { mission_id: created.id });
  assert.ok(!readBack?.isError, `get_orchestration_mission failed: ${JSON.stringify(readBack)}`);
  assert.equal(readBack.status, 'planning');
  assert.equal(readBack.steps.length, 0, 'no plan yet');

  step('A non-member agent cannot read the plan');
  const stranger = await createAgent(app, getDataSourceToken, ws.id, { name: 'stranger' });
  const strangerMcp = await mcpFor(stranger, 'stranger');
  const denied = await strangerMcp.callTool('get_orchestration_mission', { mission_id: created.id });
  assert.ok(denied?.isError, 'an unrelated agent must not read a mission');

  step('Orchestrator submits a plan: two parallel steps + one that joins them');
  const planResult = await leadMcp.callTool('submit_orchestration_plan', {
    mission_id: created.id,
    summary: 'API and UI in parallel, then wire them together.',
    steps: [
      {
        step_key: 'ship',
        title: 'Wire the export button to the endpoint',
        instructions: 'Connect the UI button to the API route and verify the download.',
        depends_on: ['api', 'ui'],
        assignee_agent_id: frontend.id,
      },
      {
        step_key: 'api',
        title: 'Add the CSV endpoint',
        instructions: 'Add GET /api/billing/export returning CSV.',
        assignee_agent_id: backend.id,
      },
      {
        step_key: 'ui',
        title: 'Add the export button',
        instructions: 'Add an Export button to the billing page.',
        assignee_agent_id: frontend.id,
      },
    ],
  });
  assert.ok(!planResult?.isError, `submit_orchestration_plan failed: ${JSON.stringify(planResult)}`);
  assert.equal(planResult.plan_version, 1);
  assert.equal(planResult.status, 'running', 'an accepted plan moves the mission to running');
  assert.deepEqual(planResult.dispatched_now.sort(), ['api', 'ui'], 'both dependency-free steps go out at once');

  const afterPlan = await missions.getMissionDetail(created.id, ws.id);
  const byKey = Object.fromEntries(afterPlan.steps.map((s) => [s.step_key, s]));
  assert.equal(byKey.api.status, 'dispatched');
  assert.equal(byKey.ui.status, 'dispatched');
  assert.equal(byKey.ship.status, 'pending', 'the joining step waits for both dependencies');
  assert.ok(byKey.api.room_id && byKey.ui.room_id, 'each dispatched step gets its own room');
  assert.notEqual(byKey.api.room_id, byKey.ui.room_id);
  assert.equal(byKey.ship.room_id, null, 'an undispatched step has no room');

  const apiOrder = await roomMessages(ds, byKey.api.room_id);
  assert.equal(apiOrder.length, 1);
  assert.match(apiOrder[0].content, new RegExp(byKey.api.id), 'the work order carries the step id to report against');
  assert.match(apiOrder[0].content, /report_orchestration_step/, 'the work order names the reporting tool');
  assert.match(
    apiOrder[0].content,
    /CSV export of monthly invoices/,
    'the mission objective travels with the step — the assignee never sees the brief',
  );

  // ── 4. Authorization on reporting ─────────────────────────────────────────
  step('A member cannot report on a step assigned to someone else');
  const wrongReporter = await frontendMcp.callTool('report_orchestration_step', {
    step_id: byKey.api.id,
    status: 'done',
    summary: 'not mine',
  });
  assert.ok(wrongReporter?.isError, 'a foreign step report must be rejected');
  const stillOpen = await missions.requireStep(byKey.api.id);
  assert.equal(stillOpen.status, 'dispatched', 'the rejected report changed nothing');

  // ── 5. Progress + first report ────────────────────────────────────────────
  step('Backend heartbeats, then reports its step done');
  const progress = await backendMcp.callTool('report_orchestration_progress', {
    step_id: byKey.api.id,
    message: 'endpoint scaffolded, writing the serializer',
  });
  assert.ok(!progress?.isError, `report_orchestration_progress failed: ${JSON.stringify(progress)}`);
  assert.equal(progress.status, 'running', 'a heartbeat moves dispatched → running');

  const apiReport = await backendMcp.callTool('report_orchestration_step', {
    step_id: byKey.api.id,
    status: 'done',
    summary: 'GET /api/billing/export ships CSV. Route name: billing.export.',
    artifacts: [{ kind: 'pr', ref: 'https://example.test/pr/1', label: 'CSV endpoint' }],
  });
  assert.ok(!apiReport?.isError, `report failed: ${JSON.stringify(apiReport)}`);
  assert.deepEqual(apiReport.next_steps_dispatched, [], 'ship still waits on ui');

  step('Reporting the same step twice is rejected');
  const doubleReport = await backendMcp.callTool('report_orchestration_step', {
    step_id: byKey.api.id,
    status: 'done',
    summary: 'again',
  });
  assert.ok(doubleReport?.isError, 'a terminal step cannot be re-reported');

  // ── 6. Second report unlocks the dependent step ───────────────────────────
  step('Frontend reports its step, which unlocks the joining step');
  const uiReport = await frontendMcp.callTool('report_orchestration_step', {
    step_id: byKey.ui.id,
    status: 'done',
    summary: 'Export button added at BillingPage.tsx:210.',
  });
  assert.ok(!uiReport?.isError, `report failed: ${JSON.stringify(uiReport)}`);
  assert.deepEqual(uiReport.next_steps_dispatched, ['ship'], 'the dependent dispatches automatically');

  const afterWave = await missions.getMissionDetail(created.id, ws.id);
  const ship = afterWave.steps.find((s) => s.step_key === 'ship');
  assert.equal(ship.status, 'dispatched');

  step('Both upstream results are handed to the dependent as context');
  const shipOrder = await roomMessages(ds, ship.room_id);
  assert.match(shipOrder[0].content, /billing\.export/, 'the API result summary reaches the dependent verbatim');
  assert.match(shipOrder[0].content, /BillingPage\.tsx:210/, 'the UI result summary reaches it too');
  assert.match(shipOrder[0].content, /https:\/\/example\.test\/pr\/1/, 'artifacts travel with the context');

  // ── 7. The mission does not end on its own ────────────────────────────────
  step('Completing with work still in flight is refused');
  const prematureComplete = await leadMcp.callTool('complete_orchestration_mission', {
    mission_id: created.id,
    status: 'completed',
    summary: 'done early',
  });
  assert.ok(prematureComplete?.isError, 'an in-flight step must block completion');
  const stillRunning = await missions.requireMission(created.id);
  assert.equal(stillRunning.status, 'running');

  step('Last step reports; the orchestrator is woken rather than the mission auto-finishing');
  const shipReport = await frontendMcp.callTool('report_orchestration_step', {
    step_id: ship.id,
    status: 'done',
    summary: 'Button wired, download verified against the ledger.',
  });
  assert.ok(!shipReport?.isError);
  assert.equal(shipReport.orchestrator_notified, true, 'the orchestrator gets the final wake-up');

  const allDone = await missions.requireMission(created.id);
  assert.equal(allDone.status, 'running', 'every step done does NOT implicitly complete the mission');

  const missionThread = await roomMessages(ds, started.room_id);
  assert.ok(missionThread.length >= 2, 'a wake-up was posted into the mission room');
  assert.match(
    missionThread[missionThread.length - 1].content,
    /complete_orchestration_mission/,
    'the wake-up tells the orchestrator how to finish',
  );

  // ── 8. Completion ─────────────────────────────────────────────────────────
  step('Only the orchestrator may complete the mission');
  const memberComplete = await backendMcp.callTool('complete_orchestration_mission', {
    mission_id: created.id,
    status: 'completed',
    summary: 'I say it is done',
  });
  assert.ok(memberComplete?.isError, 'a member cannot end the mission');

  const completed = await leadMcp.callTool('complete_orchestration_mission', {
    mission_id: created.id,
    status: 'completed',
    summary: 'CSV export shipped behind the flag; verified against the ledger.',
  });
  assert.ok(!completed?.isError, `complete failed: ${JSON.stringify(completed)}`);
  assert.equal(completed.status, 'completed');

  const final = await missions.getMissionDetail(created.id, ws.id);
  assert.equal(final.counts.total, 3);
  assert.equal(final.counts.done, 3);
  assert.equal(final.counts.failed, 0);
  assert.match(final.result_summary, /CSV export shipped/);
  assert.ok(final.events.length >= 8, 'the timeline recorded the whole run');
  const eventTypes = final.events.map((e) => e.type);
  for (const expected of ['mission_started', 'plan_submitted', 'step_dispatched', 'step_completed', 'mission_completed']) {
    assert.ok(eventTypes.includes(expected), `timeline should contain ${expected}`);
  }
});

test('Orchestration: a failed step blocks its dependents and wakes the orchestrator', async (t) => {
  const { app, port, modules, services } = await sharedApp(t);
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const { OrchestrationTeamService, OrchestrationMissionService, OrchestrationRunnerService } = services;
  const teams = app.get(OrchestrationTeamService);
  const missions = app.get(OrchestrationMissionService);
  const runner = app.get(OrchestrationRunnerService);

  const ws = await createWorkspace(app, getDataSourceToken, 'orchestration-fail');
  const lead = await createAgent(app, getDataSourceToken, ws.id, { name: 'lead' });
  const worker = await createAgent(app, getDataSourceToken, ws.id, { name: 'worker' });

  const mcpFor = async (agent, label) => {
    const key = await createApiKey(app, getDataSourceToken, agent.id, { workspaceId: ws.id, label });
    const client = new McpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: key.raw_key });
    t.after(() => { void client.close().catch(() => {}); });
    return client;
  };
  const leadMcp = await mcpFor(lead, 'lead');
  const workerMcp = await mcpFor(worker, 'worker');

  const team = await teams.createTeam({
    workspace_id: ws.id,
    name: 'Solo squad',
    orchestrator_agent_id: lead.id,
    max_parallel_steps: 3,
  });
  await teams.addMember(team.id, ws.id, { agent_id: worker.id, capabilities: 'does everything' });

  const mission = await missions.createMission({
    workspace_id: ws.id,
    team_id: team.id,
    title: 'Migrate the ledger',
    objective: 'Move the ledger to the new schema.',
  });
  await runner.startMission(mission.id, ws.id, HUMAN);

  step('Plan a three-step chain');
  const plan = await leadMcp.callTool('submit_orchestration_plan', {
    mission_id: mission.id,
    steps: [
      { step_key: 'migrate', title: 'Write the migration', instructions: 'Write it.', assignee_agent_id: worker.id },
      {
        step_key: 'backfill',
        title: 'Backfill',
        instructions: 'Backfill rows.',
        depends_on: ['migrate'],
        assignee_agent_id: worker.id,
      },
      {
        step_key: 'verify',
        title: 'Verify',
        instructions: 'Verify totals.',
        depends_on: ['backfill'],
        assignee_agent_id: worker.id,
      },
    ],
  });
  assert.ok(!plan?.isError, `plan failed: ${JSON.stringify(plan)}`);
  assert.deepEqual(plan.dispatched_now, ['migrate'], 'only the head of the chain can start');

  const detail = await missions.getMissionDetail(mission.id, ws.id);
  const migrate = detail.steps.find((s) => s.step_key === 'migrate');

  step('The head step fails');
  const failure = await workerMcp.callTool('report_orchestration_step', {
    step_id: migrate.id,
    status: 'failed',
    summary: 'The new schema rejects the legacy currency column.',
  });
  assert.ok(!failure?.isError, `report failed: ${JSON.stringify(failure)}`);
  assert.equal(failure.orchestrator_notified, true, 'a failure always wakes the orchestrator immediately');

  const afterFailure = await missions.getMissionDetail(mission.id, ws.id);
  const statuses = Object.fromEntries(afterFailure.steps.map((s) => [s.step_key, s.status]));
  assert.equal(statuses.migrate, 'failed');
  assert.equal(statuses.backfill, 'blocked', 'the direct dependent is blocked, not left pending forever');
  assert.equal(afterFailure.status, 'running', 'the mission stays open for the orchestrator to decide');

  const wake = await roomMessages(ds, afterFailure.room_id);
  assert.match(wake[wake.length - 1].content, /legacy currency column/, 'the failure reason reaches the orchestrator');

  step('The orchestrator retries the failed step, which re-dispatches into a FRESH room');
  const retry = await leadMcp.callTool('update_orchestration_step', {
    step_id: migrate.id,
    action: 'retry',
    instructions: 'Write the migration, casting the legacy currency column to text first.',
    reason: 'schema mismatch on the first attempt',
  });
  assert.ok(!retry?.isError, `retry failed: ${JSON.stringify(retry)}`);
  assert.deepEqual(retry.dispatched_now, ['migrate']);
  assert.equal(retry.attempt, 2, 'the attempt counter advanced');

  const afterRetry = await missions.requireStep(migrate.id);
  assert.equal(afterRetry.status, 'dispatched');
  assert.notEqual(afterRetry.room_id, migrate.room_id, 'a retry gets a clean room, not the failed attempt s history');
  const retryOrder = await roomMessages(ds, afterRetry.room_id);
  assert.match(retryOrder[0].content, /RETRY/, 'the assignee is told this is a retry');
  assert.match(retryOrder[0].content, /casting the legacy currency column/, 'amended instructions are used');

  step('Attempts are capped — a second failure cannot be retried forever');
  await workerMcp.callTool('report_orchestration_step', {
    step_id: migrate.id,
    status: 'failed',
    summary: 'still failing',
  });
  const overRetry = await leadMcp.callTool('update_orchestration_step', { step_id: migrate.id, action: 'retry' });
  assert.ok(overRetry?.isError, 'the retry budget is enforced');

  step('A cancelled mission stops collecting results');
  await runner.cancelMission(mission.id, ws.id, HUMAN, 'giving up');
  const cancelled = await missions.getMissionDetail(mission.id, ws.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(
    cancelled.steps.every((s) => ['failed', 'blocked', 'cancelled'].includes(s.status)),
    'no step is left open on a cancelled mission',
  );
});

test('Orchestration: parallelism is capped by the mission setting', async (t) => {
  const { app, port, modules, services } = await sharedApp(t);
  const { getDataSourceToken } = modules;
  const { OrchestrationTeamService, OrchestrationMissionService, OrchestrationRunnerService } = services;
  const teams = app.get(OrchestrationTeamService);
  const missions = app.get(OrchestrationMissionService);
  const runner = app.get(OrchestrationRunnerService);

  const ws = await createWorkspace(app, getDataSourceToken, 'orchestration-parallel');
  const lead = await createAgent(app, getDataSourceToken, ws.id, { name: 'lead' });
  const a = await createAgent(app, getDataSourceToken, ws.id, { name: 'a' });
  const b = await createAgent(app, getDataSourceToken, ws.id, { name: 'b' });
  const c = await createAgent(app, getDataSourceToken, ws.id, { name: 'c' });

  const key = await createApiKey(app, getDataSourceToken, lead.id, { workspaceId: ws.id, label: 'lead' });
  const leadMcp = new McpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: key.raw_key });
  t.after(() => { void leadMcp.close().catch(() => {}); });

  const team = await teams.createTeam({
    workspace_id: ws.id,
    name: 'Wide squad',
    orchestrator_agent_id: lead.id,
    max_parallel_steps: 2,
  });
  for (const agent of [a, b, c]) {
    await teams.addMember(team.id, ws.id, { agent_id: agent.id, capabilities: 'generalist' });
  }

  const mission = await missions.createMission({
    workspace_id: ws.id,
    team_id: team.id,
    title: 'Three independent chores',
    objective: 'Do three unrelated things.',
    max_parallel_steps: 2,
  });
  await runner.startMission(mission.id, ws.id, HUMAN);

  const plan = await leadMcp.callTool('submit_orchestration_plan', {
    mission_id: mission.id,
    steps: [a, b, c].map((agent, i) => ({
      step_key: `chore-${i}`,
      title: `Chore ${i}`,
      instructions: 'Do it.',
      assignee_agent_id: agent.id,
    })),
  });
  assert.ok(!plan?.isError, `plan failed: ${JSON.stringify(plan)}`);
  assert.equal(
    plan.dispatched_now.length,
    2,
    `three independent steps but max_parallel_steps=2, got ${JSON.stringify(plan.dispatched_now)}`,
  );

  const detail = await missions.getMissionDetail(mission.id, ws.id);
  const inFlight = detail.steps.filter((s) => ['dispatched', 'running'].includes(s.status));
  assert.equal(inFlight.length, 2);
  assert.equal(detail.counts.pending, 1, 'the third waits for a free slot, not for a dependency');
});

exitAfterTests();
