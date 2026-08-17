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

test('Orchestration: list_orchestration_teams / list_orchestration_missions scope strictly to the caller', async (t) => {
  const { app, port, modules, services } = await sharedApp(t);
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const { OrchestrationTeamService, OrchestrationMissionService } = services;
  const teams = app.get(OrchestrationTeamService);
  const missions = app.get(OrchestrationMissionService);

  const ws = await createWorkspace(app, getDataSourceToken, 'orch-discovery');
  const orch = await createAgent(app, getDataSourceToken, ws.id, { name: 'discovery-orch' });
  const member = await createAgent(app, getDataSourceToken, ws.id, { name: 'discovery-member' });
  const stranger = await createAgent(app, getDataSourceToken, ws.id, { name: 'discovery-stranger' });

  const mcpFor = async (agent, label) => {
    const key = await createApiKey(app, getDataSourceToken, agent.id, { workspaceId: ws.id, label });
    const client = new McpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: key.raw_key });
    t.after(() => { void client.close().catch(() => {}); });
    return client;
  };
  const orchMcp = await mcpFor(orch, 'discovery-orch');
  const memberMcp = await mcpFor(member, 'discovery-member');
  const strangerMcp = await mcpFor(stranger, 'discovery-stranger');

  step('list_orchestration_teams is empty before any team exists');
  const beforeTeams = await orchMcp.callTool('list_orchestration_teams', {});
  assert.deepEqual(beforeTeams.teams, []);

  step('Create a team; orchestrator and roster member both see it, a stranger does not');
  const team = await teams.createTeam({
    workspace_id: ws.id,
    name: 'Discovery squad',
    orchestrator_agent_id: orch.id,
    created_by: HUMAN.id,
  });
  await teams.addMember(team.id, ws.id, { agent_id: member.id });

  const orchTeams = await orchMcp.callTool('list_orchestration_teams', {});
  assert.equal(orchTeams.teams.length, 1);
  assert.equal(orchTeams.teams[0].id, team.id);

  const memberTeams = await memberMcp.callTool('list_orchestration_teams', {});
  assert.equal(memberTeams.teams.length, 1, 'a roster member sees the team too, not just the orchestrator');

  const strangerTeamsResult = await strangerMcp.callTool('list_orchestration_teams', {});
  assert.deepEqual(strangerTeamsResult.teams, [], 'an agent on no team sees nothing');

  step('Create a mission; only the orchestrator/member see it via list_orchestration_missions');
  const mission = await missions.createMission({
    workspace_id: ws.id,
    team_id: team.id,
    title: 'Discovery mission',
    objective: 'Prove discovery tools are scoped correctly.',
    created_by_type: 'user',
    created_by: HUMAN.id,
  });

  const orchMissions = await orchMcp.callTool('list_orchestration_missions', {});
  assert.equal(orchMissions.missions.length, 1);
  assert.equal(orchMissions.missions[0].id, mission.id);

  const memberMissions = await memberMcp.callTool('list_orchestration_missions', {});
  assert.equal(memberMissions.missions.length, 1, 'a roster member sees the mission too');

  const strangerMissionsResult = await strangerMcp.callTool('list_orchestration_missions', {});
  assert.deepEqual(strangerMissionsResult.missions, [], 'a non-member sees nothing, even in the same workspace');

  step('Finished missions are hidden by default and shown with include_finished');
  await ds.getRepository('OrchestrationMission').update({ id: mission.id }, { status: 'completed' });

  const activeOnly = await orchMcp.callTool('list_orchestration_missions', {});
  assert.deepEqual(activeOnly.missions, [], 'a completed mission is hidden by default');

  const withFinished = await orchMcp.callTool('list_orchestration_missions', { include_finished: true });
  assert.equal(withFinished.missions.length, 1);
  assert.equal(withFinished.missions[0].status, 'completed');
});

test('Orchestration: create_orchestration_mission — ownership, caps, recursion guard, and the reaper-blind-spot recovery', async (t) => {
  const { app, port, modules, services } = await sharedApp(t);
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const { OrchestrationTeamService, OrchestrationMissionService } = services;
  const teams = app.get(OrchestrationTeamService);
  const missions = app.get(OrchestrationMissionService);

  const ws = await createWorkspace(app, getDataSourceToken, 'orch-create');
  const orch = await createAgent(app, getDataSourceToken, ws.id, { name: 'create-orch' });
  const member = await createAgent(app, getDataSourceToken, ws.id, { name: 'create-member' });
  const stranger = await createAgent(app, getDataSourceToken, ws.id, { name: 'create-stranger' });
  const otherOrch = await createAgent(app, getDataSourceToken, ws.id, { name: 'create-other-orch' });

  const mcpFor = async (agent, label) => {
    const key = await createApiKey(app, getDataSourceToken, agent.id, { workspaceId: ws.id, label });
    const client = new McpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: key.raw_key });
    t.after(() => { void client.close().catch(() => {}); });
    return client;
  };
  const orchMcp = await mcpFor(orch, 'create-orch');
  const memberMcp = await mcpFor(member, 'create-member');
  const strangerMcp = await mcpFor(stranger, 'create-stranger');

  const team = await teams.createTeam({
    workspace_id: ws.id,
    name: 'Create-mission squad',
    orchestrator_agent_id: orch.id,
    created_by: HUMAN.id,
  });
  await teams.addMember(team.id, ws.id, { agent_id: member.id });
  const otherTeam = await teams.createTeam({
    workspace_id: ws.id,
    name: 'A team orch does not run',
    orchestrator_agent_id: otherOrch.id,
    created_by: HUMAN.id,
  });

  step('A roster member (not the orchestrator) cannot create a mission for the team');
  const memberAttempt = await memberMcp.callTool('create_orchestration_mission', {
    team_id: team.id, title: 'nope', objective: 'nope',
  });
  assert.equal(memberAttempt.isError, true);
  assert.match(memberAttempt.error.error, /not the orchestrator/);

  step('A stranger with no relationship to the team cannot either');
  const strangerAttempt = await strangerMcp.callTool('create_orchestration_mission', {
    team_id: team.id, title: 'nope', objective: 'nope',
  });
  assert.equal(strangerAttempt.isError, true);

  step('Being an orchestrator SOMEWHERE does not grant rights over a team you do not run');
  const wrongTeamAttempt = await orchMcp.callTool('create_orchestration_mission', {
    team_id: otherTeam.id, title: 'nope', objective: 'nope',
  });
  assert.equal(wrongTeamAttempt.isError, true);
  assert.match(wrongTeamAttempt.error.error, /not the orchestrator/);

  step('A disabled team refuses creation');
  await ds.getRepository('OrchestrationTeam').update({ id: team.id }, { enabled: 0 });
  const disabledAttempt = await orchMcp.callTool('create_orchestration_mission', {
    team_id: team.id, title: 'nope', objective: 'nope',
  });
  assert.equal(disabledAttempt.isError, true);
  assert.match(disabledAttempt.error.error, /disabled/);
  await ds.getRepository('OrchestrationTeam').update({ id: team.id }, { enabled: 1 });

  step('Orchestrator creates a mission; explicit max_steps/max_parallel_steps are clamped to the agent ceiling');
  const created = await orchMcp.callTool('create_orchestration_mission', {
    team_id: team.id,
    title: 'Agent-created mission',
    objective: 'Prove the self-service creation path works end to end.',
    max_steps: 999,
    max_parallel_steps: 999,
  });
  assert.ok(!created.isError, `create failed: ${JSON.stringify(created)}`);
  assert.equal(created.status, 'planning', 'start:true (default) briefs immediately');
  const missionId = created.mission_id;

  const detail = await missions.getMissionDetail(missionId, ws.id);
  assert.equal(detail.max_steps, 20, 'clamped down from 999 to the agent-path ceiling, not just defaulted');
  assert.equal(detail.max_parallel_steps, 3, 'clamped to min(team.max_parallel_steps=3, agent ceiling=4)');

  step('The returned mission_id works immediately with submit_orchestration_plan');
  const plan = await orchMcp.callTool('submit_orchestration_plan', {
    mission_id: missionId,
    steps: [{ step_key: 'only-step', title: 'Only step', instructions: 'do it', assignee_agent_id: member.id }],
  });
  assert.ok(!plan?.isError, `plan failed: ${JSON.stringify(plan)}`);
  assert.equal(plan.dispatched_now.length, 1);

  step('A second creation attempt for the same team is rejected — one open mission at a time');
  const capped = await orchMcp.callTool('create_orchestration_mission', {
    team_id: team.id, title: 'Should not be created', objective: 'Should not be created.',
  });
  assert.equal(capped.isError, true);
  assert.equal(capped.error.existing_mission_id, missionId);
  assert.equal(capped.error.existing_mission_status, 'running', 'submit_orchestration_plan already advanced it past planning');
  assert.equal(capped.error.open_step_count, 1, 'the just-dispatched step counts as in flight');

  step('The reaper-blind-spot edge case self-recovers: running + 0 in-flight steps names its own escape hatch');
  // Neither reaper branch covers this: reapStuckSteps only looks at in-flight
  // steps (there are none once the last one finishes) and reapStalledPlanning
  // only looks at status:'planning' (this mission already advanced past it).
  await ds.getRepository('OrchestrationStep').update({ mission_id: missionId }, { status: 'done' });
  await ds.getRepository('OrchestrationMission').update({ id: missionId }, { status: 'running' });

  const stuckAttempt = await orchMcp.callTool('create_orchestration_mission', {
    team_id: team.id, title: 'Retry after unwedging', objective: 'Retry after unwedging.',
  });
  assert.equal(stuckAttempt.isError, true);
  assert.equal(stuckAttempt.error.existing_mission_status, 'running');
  assert.equal(stuckAttempt.error.open_step_count, 0, 'every step already finished — this is the wedge');
  assert.match(stuckAttempt.error.error, /complete_orchestration_mission/, 'the 409 names its own escape hatch');

  const closed = await orchMcp.callTool('complete_orchestration_mission', {
    mission_id: missionId, status: 'completed', summary: 'Closing the wedged mission so the team can create a new one.',
  });
  assert.ok(!closed?.isError, `complete failed: ${JSON.stringify(closed)}`);

  const retried = await orchMcp.callTool('create_orchestration_mission', {
    team_id: team.id, title: 'Retry after unwedging', objective: 'Retry after unwedging.',
  });
  assert.ok(!retried.isError, `retry after unwedge failed: ${JSON.stringify(retried)}`);
  assert.notEqual(retried.mission_id, missionId);

  step('The recursion guard: an agent with an in-flight step elsewhere cannot also start a new mission');
  // A different team orch also orchestrates — proves the guard is keyed on the
  // AGENT holding in-flight work, not on the target team's own open-mission cap
  // (team3 has zero open missions of its own, so only guard (b) can be firing).
  const team3 = await teams.createTeam({
    workspace_id: ws.id,
    name: 'Second team orch also runs',
    orchestrator_agent_id: orch.id,
    created_by: HUMAN.id,
  });
  await ds.getRepository('OrchestrationStep').save(
    ds.getRepository('OrchestrationStep').create({
      mission_id: retried.mission_id,
      workspace_id: ws.id,
      team_id: team.id,
      step_key: 'busy-work',
      title: 'Busy work',
      assignee_agent_id: orch.id,
      status: 'dispatched',
    }),
  );
  const recursionAttempt = await orchMcp.callTool('create_orchestration_mission', {
    team_id: team3.id, title: 'Should be blocked by recursion guard', objective: 'Should be blocked.',
  });
  assert.equal(recursionAttempt.isError, true);
  assert.match(recursionAttempt.error.error, /in flight/);
});

test('Orchestration: an orchestrator who is also a roster member can self-assign a step (regression guard)', async (t) => {
  // Not a hypothetical: ticket b7127aae's own smoke mission assigns its rollup
  // step to the orchestrator itself. createTeam/addMember allow the duplicate
  // by design (decision thread on b7127aae) — this locks in that a plan step
  // assigned to the orchestrator actually dispatches, not just that adding the
  // member doesn't throw.
  const { app, port, modules, services } = await sharedApp(t);
  const { getDataSourceToken } = modules;
  const { OrchestrationTeamService, OrchestrationMissionService, OrchestrationRunnerService } = services;
  const teams = app.get(OrchestrationTeamService);
  const missions = app.get(OrchestrationMissionService);
  const runner = app.get(OrchestrationRunnerService);

  const ws = await createWorkspace(app, getDataSourceToken, 'orch-self-assign');
  const orch = await createAgent(app, getDataSourceToken, ws.id, { name: 'self-assign-orch' });
  const helper = await createAgent(app, getDataSourceToken, ws.id, { name: 'self-assign-helper' });

  const mcpFor = async (agent, label) => {
    const key = await createApiKey(app, getDataSourceToken, agent.id, { workspaceId: ws.id, label });
    const client = new McpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: key.raw_key });
    t.after(() => { void client.close().catch(() => {}); });
    return client;
  };
  const orchMcp = await mcpFor(orch, 'self-assign-orch');

  step('Team roster includes the orchestrator itself, mirroring a rollup-style mission');
  const team = await teams.createTeam({
    workspace_id: ws.id,
    name: 'Self-assign squad',
    orchestrator_agent_id: orch.id,
    created_by: HUMAN.id,
  });
  await teams.addMember(team.id, ws.id, { agent_id: helper.id });
  await teams.addMember(team.id, ws.id, { agent_id: orch.id });

  const mission = await missions.createMission({
    workspace_id: ws.id,
    team_id: team.id,
    title: 'Fan out then roll up',
    objective: 'A helper reports, the orchestrator rolls the result up itself.',
    created_by_type: 'user',
    created_by: HUMAN.id,
  });
  await runner.startMission(mission.id, ws.id, HUMAN);

  step('A plan step assigned to the orchestrator (who is also a member) is accepted, not "not a member"');
  const plan = await orchMcp.callTool('submit_orchestration_plan', {
    mission_id: mission.id,
    steps: [
      { step_key: 'gather', title: 'Gather', instructions: 'Report a fact.', assignee_agent_id: helper.id },
      {
        step_key: 'rollup',
        title: 'Roll up',
        instructions: 'Summarize.',
        depends_on: ['gather'],
        assignee_agent_id: orch.id,
      },
    ],
  });
  assert.ok(!plan?.isError, `plan failed: ${JSON.stringify(plan)}`);
  assert.deepEqual(plan.dispatched_now, ['gather'], 'rollup only waits on its dependency — it was accepted, not rejected');

  step('Once gather reports, the orchestrator-assigned rollup step dispatches to the orchestrator itself');
  const afterPlan = await missions.getMissionDetail(mission.id, ws.id);
  const gather = afterPlan.steps.find((s) => s.step_key === 'gather');
  const reported = await orchMcp.callTool('report_orchestration_step', {
    step_id: gather.id,
    status: 'done',
    summary: 'Gathered the fact.',
  });
  assert.ok(!reported?.isError, `report failed: ${JSON.stringify(reported)}`);
  assert.deepEqual(
    reported.next_steps_dispatched,
    ['rollup'],
    'the orchestrator-assigned step dispatches like any other assignee\'s',
  );

  const final = await missions.getMissionDetail(mission.id, ws.id);
  const rollup = final.steps.find((s) => s.step_key === 'rollup');
  assert.equal(rollup.status, 'dispatched');
  assert.equal(rollup.assignee_agent_id, orch.id);
  assert.ok(rollup.room_id, 'the orchestrator gets a real work-order room for its own step, like any assignee');
});

test('Orchestration: a draft mission is never an unrecoverable wedge (review round 2)', async (t) => {
  // Before this fix, createMission always left orchestrator_agent_id=null —
  // only startMission ever stamped it, and it is never called for
  // start:false (or skipped when startMission itself throws, e.g. an empty
  // roster). requireOrchestrator's `!== callerAgentId` check then 403s EVERY
  // caller on a null orchestrator_agent_id, including the real orchestrator —
  // so the draft permanently occupied the team's one-open-mission slot with
  // no MCP escape hatch: not even complete_orchestration_mission could reach
  // it. create_orchestration_mission now stamps the orchestrator at creation.
  const { app, port, modules, services } = await sharedApp(t);
  const { getDataSourceToken } = modules;
  const { OrchestrationTeamService } = services;
  const teams = app.get(OrchestrationTeamService);

  const ws = await createWorkspace(app, getDataSourceToken, 'orch-draft-wedge');
  const orch = await createAgent(app, getDataSourceToken, ws.id, { name: 'draft-wedge-orch' });

  const mcpFor = async (agent, label) => {
    const key = await createApiKey(app, getDataSourceToken, agent.id, { workspaceId: ws.id, label });
    const client = new McpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: key.raw_key });
    t.after(() => { void client.close().catch(() => {}); });
    return client;
  };
  const orchMcp = await mcpFor(orch, 'draft-wedge-orch');

  const team = await teams.createTeam({
    workspace_id: ws.id,
    name: 'Draft-wedge squad',
    orchestrator_agent_id: orch.id,
    created_by: HUMAN.id,
  });

  step('start:false leaves a draft mission the orchestrator can still read');
  const created = await orchMcp.callTool('create_orchestration_mission', {
    team_id: team.id, title: 'Never started', objective: 'Stay a draft on purpose.', start: false,
  });
  assert.ok(!created.isError, `create failed: ${JSON.stringify(created)}`);
  assert.equal(created.status, 'draft');
  const draftId = created.mission_id;

  const readBack = await orchMcp.callTool('get_orchestration_mission', { mission_id: draftId });
  assert.ok(!readBack?.isError, `orchestrator could not read its own draft: ${JSON.stringify(readBack)}`);
  assert.equal(readBack.status, 'draft');

  step('A second attempt for the same team is rejected — the draft counts against the cap');
  const capped = await orchMcp.callTool('create_orchestration_mission', {
    team_id: team.id, title: 'Should not be created', objective: 'Should not be created.',
  });
  assert.equal(capped.isError, true);
  assert.equal(capped.error.status, 409);
  assert.equal(capped.error.existing_mission_id, draftId);
  assert.equal(capped.error.existing_mission_status, 'draft');
  assert.equal(capped.error.open_step_count, 0);

  step('The escape hatch the 409 names actually works: the orchestrator can close its own draft');
  const closed = await orchMcp.callTool('complete_orchestration_mission', {
    mission_id: draftId, status: 'failed', summary: 'Closing the unstarted draft to free the team slot.',
  });
  assert.ok(!closed?.isError, `complete failed: ${JSON.stringify(closed)}`);
  assert.equal(closed.status, 'failed');

  step('Creation succeeds again once the draft is closed');
  const retried = await orchMcp.callTool('create_orchestration_mission', {
    team_id: team.id, title: 'Retry after closing the draft', objective: 'Retry after closing the draft.',
  });
  assert.ok(!retried.isError, `retry after closing the draft failed: ${JSON.stringify(retried)}`);
  assert.notEqual(retried.mission_id, draftId);
});

exitAfterTests();
