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
  const reaper = await import(
    pathToFileURL(path.join(DIST, 'modules', 'orchestration', 'orchestration-reaper.service.js')).href
  );
  return {
    OrchestrationTeamService: team.OrchestrationTeamService,
    OrchestrationMissionService: mission.OrchestrationMissionService,
    OrchestrationRunnerService: runner.OrchestrationRunnerService,
    OrchestrationReaperService: reaper.OrchestrationReaperService,
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

test('Orchestration: create_orchestration_mission — max_open_missions = 0 forbids self-created missions with a clean 409, not a TypeError', async (t) => {
  // Regression coverage for ticket d5a545c4: before the fix, `cap <= 0` fell
  // through to `openForTeam[openForTeam.length - 1]` on an EMPTY array
  // (openForTeam[-1] is undefined), so the very first agent-created-mission
  // attempt against a cap-0 team crashed with "Cannot read properties of
  // undefined (reading 'id')" instead of the clear 409 the cap is meant to
  // produce. There was no product path to set the value to 0 until this
  // ticket wired max_open_missions into createTeam/updateTeam, so this is
  // also the first test that can reach cap 0 at all.
  const { app, port, modules, services } = await sharedApp(t);
  const { getDataSourceToken } = modules;
  const { OrchestrationTeamService } = services;
  const teams = app.get(OrchestrationTeamService);

  const ws = await createWorkspace(app, getDataSourceToken, 'orch-cap-zero');
  const orch = await createAgent(app, getDataSourceToken, ws.id, { name: 'cap-zero-orch' });

  const key = await createApiKey(app, getDataSourceToken, orch.id, { workspaceId: ws.id, label: 'cap-zero-orch' });
  const orchMcp = new McpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: key.raw_key });
  t.after(() => { void orchMcp.close().catch(() => {}); });

  step('A team created with max_open_missions: 0 persists the deliberate zero, not the ?? 1 default');
  const team = await teams.createTeam({
    workspace_id: ws.id,
    name: 'Cap-zero squad',
    orchestrator_agent_id: orch.id,
    max_open_missions: 0,
    created_by: HUMAN.id,
  });
  assert.equal(team.max_open_missions, 0, 'createTeam must not silently promote an explicit 0 to the default 1');

  step('create_orchestration_mission on a cap-0 team returns a 409 naming the team, never a raw TypeError');
  const blocked = await orchMcp.callTool('create_orchestration_mission', {
    team_id: team.id, title: 'Should be blocked', objective: 'Should be blocked.',
  });
  assert.equal(blocked.isError, true);
  assert.equal(blocked.error.status, 409);
  assert.match(blocked.error.error, /does not allow agent-created missions/);
  assert.match(blocked.error.error, /max_open_missions = 0/);

  step('Raising the cap via updateTeam immediately un-blocks the same team');
  const raised = await teams.updateTeam(team.id, ws.id, { max_open_missions: 1 });
  assert.equal(raised.max_open_missions, 1);
  const allowed = await orchMcp.callTool('create_orchestration_mission', {
    team_id: team.id, title: 'Now allowed', objective: 'Now allowed.',
  });
  assert.ok(!allowed.isError, `create failed after raising the cap: ${JSON.stringify(allowed)}`);
});

test('Orchestration: create_orchestration_mission — max_open_missions = 2 allows two concurrent missions; a third names the OLDEST one', async (t) => {
  const { app, port, modules, services } = await sharedApp(t);
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const { OrchestrationTeamService } = services;
  const teams = app.get(OrchestrationTeamService);

  const ws = await createWorkspace(app, getDataSourceToken, 'orch-cap-two');
  const orch = await createAgent(app, getDataSourceToken, ws.id, { name: 'cap-two-orch' });

  const key = await createApiKey(app, getDataSourceToken, orch.id, { workspaceId: ws.id, label: 'cap-two-orch' });
  const orchMcp = new McpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: key.raw_key });
  t.after(() => { void orchMcp.close().catch(() => {}); });

  const team = await teams.createTeam({
    workspace_id: ws.id,
    name: 'Cap-two squad',
    orchestrator_agent_id: orch.id,
    max_open_missions: 2,
    created_by: HUMAN.id,
  });
  assert.equal(team.max_open_missions, 2);

  step('Two missions can be open at once under cap 2');
  const first = await orchMcp.callTool('create_orchestration_mission', {
    team_id: team.id, title: 'First (oldest)', objective: 'First.',
  });
  assert.ok(!first.isError, `first create failed: ${JSON.stringify(first)}`);
  const second = await orchMcp.callTool('create_orchestration_mission', {
    team_id: team.id, title: 'Second (newest)', objective: 'Second.',
  });
  assert.ok(!second.isError, `second create failed: ${JSON.stringify(second)}`);

  // Force a deterministic created_at ordering — two inserts a few
  // milliseconds apart are not a safe ordering signal on every DB backend,
  // and the whole point of this test is which one the cap guard names.
  const missionRepo = ds.getRepository('OrchestrationMission');
  await missionRepo.update({ id: first.mission_id }, { created_at: new Date(Date.now() - 60_000) });
  await missionRepo.update({ id: second.mission_id }, { created_at: new Date(Date.now() - 30_000) });

  step('A third attempt is rejected, naming the OLDEST open mission (openForTeam[length-1] under DESC order), not the newest');
  const third = await orchMcp.callTool('create_orchestration_mission', {
    team_id: team.id, title: 'Third (should be rejected)', objective: 'Third.',
  });
  assert.equal(third.isError, true);
  assert.equal(third.error.status, 409);
  assert.equal(third.error.existing_mission_id, first.mission_id, 'the oldest mission is named, not the most recent');
  assert.notEqual(third.error.existing_mission_id, second.mission_id);
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

// ticket 2dc3c62f — Mission 실행 계약: 완료 조건 게이트 + agent 작업공간 + post-action.
test('Orchestration: 완료 조건 게이트가 완료를 차단하고, step은 격리된 작업공간 폴더로 디스패치되며, 완료 시 post-action이 실행된다', async (t) => {
  const { app, port, modules, services } = await sharedApp(t);
  const { getDataSourceToken, ActionsService } = modules;
  const ds = app.get(getDataSourceToken());
  const actions = app.get(ActionsService);
  const { OrchestrationTeamService, OrchestrationMissionService, OrchestrationRunnerService } = services;
  const teams = app.get(OrchestrationTeamService);
  const missions = app.get(OrchestrationMissionService);
  const runner = app.get(OrchestrationRunnerService);

  const ws = await createWorkspace(app, getDataSourceToken, 'orch-contract');
  const orch = await createAgent(app, getDataSourceToken, ws.id, { name: 'contract-orch' });
  const member = await createAgent(app, getDataSourceToken, ws.id, { name: 'contract-member' });

  const mcpFor = async (agent, label) => {
    const key = await createApiKey(app, getDataSourceToken, agent.id, { workspaceId: ws.id, label });
    const client = new McpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: key.raw_key });
    t.after(() => { void client.close().catch(() => {}); });
    return client;
  };
  const orchMcp = await mcpFor(orch, 'contract-orch');
  const memberMcp = await mcpFor(member, 'contract-member');

  step('완료 후 실행될 실제 Action을 등록한다("always" 성공 케이스)');
  const notifyAction = await actions.create({
    workspace_id: ws.id,
    name: 'Notify on mission end',
    prompt: 'The mission ended — post a summary.',
    target_agent_id: member.id,
  });

  step('구조화된 완료 조건, 커스텀 workspace 루트, post_actions 2개(실재/댕글링)를 갖는 팀 + 미션');
  const team = await teams.createTeam({
    workspace_id: ws.id,
    name: 'Contract squad',
    orchestrator_agent_id: orch.id,
    created_by: HUMAN.id,
  });
  await teams.addMember(team.id, ws.id, { agent_id: member.id });

  const mission = await missions.createMission({
    workspace_id: ws.id,
    team_id: team.id,
    title: 'Contract-gated mission',
    objective: 'Ship one thing and prove the execution contract holds.',
    method: 'Keep it small — one step is enough to prove the contract.',
    completion_criteria: [{ key: 'verified', description: 'A human/orchestrator actually checked the result' }],
    post_actions: [
      { action_id: notifyAction.id, order: 1, condition: 'always' },
      { action_id: 'does-not-exist', order: 2, condition: 'always' },
    ],
    workspace_folder: 'custom-root',
    created_by_type: 'user',
    created_by: HUMAN.id,
  });
  assert.equal(mission.completion_criteria.length, 1);
  assert.equal(mission.completion_criteria[0].met, false, '갓 만든 criterion은 unmet 상태로 시작한다');

  await runner.startMission(mission.id, ws.id, HUMAN);

  step('Orchestrator가 단일 step을 제출한다');
  const plan = await orchMcp.callTool('submit_orchestration_plan', {
    mission_id: mission.id,
    steps: [{ step_key: 'only-step', title: 'Only step', instructions: 'Do the one thing.', assignee_agent_id: member.id }],
  });
  assert.ok(!plan?.isError, `plan 실패: ${JSON.stringify(plan)}`);
  assert.deepEqual(plan.dispatched_now, ['only-step']);

  step('디스패치된 step은 미션의 커스텀 workspace 루트 아래 자기만의 격리된 폴더에 고정된다');
  const afterPlan = await missions.getMissionDetail(mission.id, ws.id);
  const only = afterPlan.steps.find((s) => s.step_key === 'only-step');
  assert.equal(
    only.workspace_folder,
    '.awb/orch/custom-root/only-step',
    'getMissionDetail이 dispatchStep이 프로비저닝하는 것과 동일한 격리 leaf를 계산한다',
  );
  const stepMessages = await roomMessages(ds, only.room_id);
  assert.match(
    stepMessages[0].content,
    /\.awb\/orch\/custom-root\/only-step/,
    '렌더링된 작업 지시서가 agent-manager가 스폰 전에 프로비저닝할 정확한 폴더를 명시한다',
  );
  assert.match(stepMessages[0].content, /Keep it small/, 'mission.method도 step 프롬프트에 렌더링된다');

  step('step을 done으로 보고하는 것만으로는 완료가 풀리지 않는다 — 구조화된 criterion이 여전히 unmet이다');
  const reported = await memberMcp.callTool('report_orchestration_step', {
    step_id: only.id, status: 'done', summary: 'Did the one thing.',
  });
  assert.ok(!reported?.isError, `report 실패: ${JSON.stringify(reported)}`);

  const blocked = await orchMcp.callTool('complete_orchestration_mission', {
    mission_id: mission.id, status: 'completed', summary: 'Should be blocked.',
  });
  assert.equal(blocked.isError, true, '완료 조건이 unmet인 동안은 완료가 거부되어야 한다');
  assert.match(blocked.error.error, /verified/, '거부 메시지가 unmet인 criterion의 key를 명시한다');
  assert.match(blocked.error.error, /update_orchestration_criteria/, '거부 메시지가 자신의 해결책을 명시한다');

  step('orchestrator가 아니면 criteria를 뒤집을 수 없다');
  const deniedCriteria = await memberMcp.callTool('update_orchestration_criteria', {
    mission_id: mission.id, updates: [{ key: 'verified', met: true }],
  });
  assert.equal(deniedCriteria.isError, true, 'completion criteria는 orchestrator만 갱신할 수 있다');

  step('orchestrator가 note와 함께 criterion을 met으로 표시하면 이제 완료가 허용된다');
  const flipped = await orchMcp.callTool('update_orchestration_criteria', {
    mission_id: mission.id,
    updates: [{ key: 'verified', met: true, note: 'Checked the artifact myself.' }],
  });
  assert.ok(!flipped?.isError, `update_orchestration_criteria 실패: ${JSON.stringify(flipped)}`);
  assert.equal(flipped.completion_criteria[0].met, true);

  const completed = await orchMcp.callTool('complete_orchestration_mission', {
    mission_id: mission.id, status: 'completed', summary: 'Shipped it.',
  });
  assert.ok(!completed?.isError, `criteria가 met인데도 complete 실패: ${JSON.stringify(completed)}`);
  assert.equal(completed.status, 'completed');

  step('완료 시 post-action이 발화한다: 실재 Action은 추적 가능한 run으로 디스패치되고, 댕글링 쪽은 실패가 기록된다 — 어느 쪽도 미션 자체의 상태에는 영향 없음');
  const final = await missions.getMissionDetail(mission.id, ws.id);
  assert.equal(final.status, 'completed', 'post-action의 결과는 미션 상태를 절대 되돌리거나 바꾸지 않는다');
  const byActionId = Object.fromEntries(final.post_actions.map((p) => [p.action_id, p]));
  assert.equal(byActionId[notifyAction.id].status, 'dispatched');
  assert.ok(byActionId[notifyAction.id].run_id, '디스패치된 post-action은 감사/추적을 위해 run_id를 기록한다');
  const postActionRoom = await ds
    .getRepository('ChatRoom')
    .findOne({ where: { id: byActionId[notifyAction.id].room_id } });
  assert.ok(postActionRoom, '디스패치된 post-action Run이 실제로 room을 만들었다 — 상태만 조작된 게 아니다');

  assert.equal(byActionId['does-not-exist'].status, 'dispatch_failed');
  assert.match(byActionId['does-not-exist'].error, /not found/);

  const eventTypes = final.events.map((e) => e.type);
  assert.ok(eventTypes.includes('criteria_updated'));
  assert.ok(eventTypes.includes('post_action_dispatched'));
  assert.ok(eventTypes.includes('post_action_dispatch_failed'));
});

// 리뷰 지적 반영(티켓 2dc3c62f, P1) — post-action crash-window 복구.
test('Orchestration: post-action 크래시 복구 — reaper가 미처리 pending은 이어서 디스패치하고, 멈춰있는 in_flight는 재시도 없이 실패로 확정한다', async (t) => {
  const { app, port, modules, services } = await sharedApp(t);
  const { getDataSourceToken, ActionsService } = modules;
  const ds = app.get(getDataSourceToken());
  const actions = app.get(ActionsService);
  const { OrchestrationTeamService, OrchestrationMissionService, OrchestrationReaperService } = services;
  const teams = app.get(OrchestrationTeamService);
  const missions = app.get(OrchestrationMissionService);
  const reaper = app.get(OrchestrationReaperService);

  const ws = await createWorkspace(app, getDataSourceToken, 'orch-crash-recovery');
  const orch = await createAgent(app, getDataSourceToken, ws.id, { name: 'crash-orch' });
  const member = await createAgent(app, getDataSourceToken, ws.id, { name: 'crash-member' });

  step('실제로 디스패치 가능한 Action을 등록한다');
  const recoveryAction = await actions.create({
    workspace_id: ws.id,
    name: 'Crash-recovery notify',
    prompt: 'Recovered after a simulated crash.',
    target_agent_id: member.id,
  });

  const team = await teams.createTeam({
    workspace_id: ws.id,
    name: 'Crash-recovery squad',
    orchestrator_agent_id: orch.id,
    created_by: HUMAN.id,
  });
  await teams.addMember(team.id, ws.id, { agent_id: member.id });

  step('completeMission()이 terminal status를 저장한 직후 프로세스가 죽은 상황을 직접 시뮬레이션한다 — post_actions는 손대지 않은 채로 둔다');
  const mission = await missions.createMission({
    workspace_id: ws.id,
    team_id: team.id,
    title: 'Crash-window mission',
    objective: 'Prove post-actions survive a crash between terminal-status save and runPostActions.',
    created_by_type: 'user',
    created_by: HUMAN.id,
  });
  const staleDispatchedAt = new Date(Date.now() - 10 * 60_000).toISOString(); // 유예시간(2분)을 훌쩍 넘긴 시각
  const missionRepo = ds.getRepository('OrchestrationMission');
  await missionRepo.update(
    { id: mission.id },
    {
      status: 'completed',
      finished_at: new Date(),
      post_actions: [
        // 크래시 시나리오 A: completeMission()이 여기까지 오지도 못하고 죽어서 아직 아무 것도 시도되지 않은 항목.
        { action_id: recoveryAction.id, order: 1, condition: 'always', status: 'pending', run_id: null, room_id: null, error: '', dispatched_at: null },
        // 크래시 시나리오 B: dispatch() 호출 도중(또는 그 결과를 저장하기 전) 죽어서 in_flight로 멈춘 항목.
        { action_id: recoveryAction.id, order: 2, condition: 'always', status: 'in_flight', run_id: null, room_id: null, error: '', dispatched_at: staleDispatchedAt },
      ],
    },
  );

  step('reaper 스윕 한 번으로 두 항목 모두 복구된다');
  const swept = await reaper.runOnce();
  assert.equal(swept.post_actions_recovered, 1, 'crash 상태의 post_actions를 가진 미션 1건이 복구 대상으로 집계된다');

  const recovered = await missions.getMissionDetail(mission.id, ws.id);
  assert.equal(recovered.status, 'completed', '복구 스윕은 mission.status를 절대 건드리지 않는다');

  const pendingEntry = recovered.post_actions.find((p) => p.order === 1);
  assert.equal(pendingEntry.status, 'dispatched', '한 번도 시도되지 않았던 pending 항목은 처음으로 안전하게 디스패치된다');
  assert.ok(pendingEntry.run_id, '실제로 디스패치되어 run_id가 기록된다');

  const staleInFlightEntry = recovered.post_actions.find((p) => p.order === 2);
  assert.equal(staleInFlightEntry.status, 'dispatch_failed', '오래된 in_flight 항목은 재시도 없이 실패로 확정된다');
  assert.equal(staleInFlightEntry.run_id, null, 'run_id가 없다는 것은 dispatch()가 다시 호출되지 않았다는 뜻이다(중복 디스패치 방지 확인)');
  assert.match(staleInFlightEntry.error, /in_flight/, '에러 메시지가 "not found" 등 새로운 디스패치 시도의 결과가 아니라 in_flight 정체를 명시한다');

  step('같은 미션에 대한 두 번째 스윕은 아무것도 다시 건드리지 않는다(idempotent)');
  const secondSweep = await reaper.runOnce();
  assert.equal(secondSweep.post_actions_recovered, 0, '이미 확정된 항목만 남은 미션은 더 이상 복구 대상이 아니다');
});

exitAfterTests();
