// Regression: the `<Manager>/<Agent>` display contract on the surfaces added
// after ticket 51b1519d — Orchestration mode and the two typing indicators.
//
// The rule (docs/agent-display-name.md, .claude/skills/awb-agent-display-name):
// EVERY user-visible agent name renders as `<Manager>/<Agent>`, resolved
// through utils/agent-name.ts on the server or utils/agentName.ts on the
// client. Never a bare `agent.name`, never a raw agent id.
//
// What broke before this test existed:
//   1. Orchestration team/mission projections read `agent.name` directly, so
//      the team roster, orchestrator label, step assignee, and the roster the
//      orchestrator sees in its OWN brief prompt were all bare leaf names.
//   2. `assignable-agents` did not return manager_name at all, so the team
//      pickers could not have rendered the full name even if they wanted to.
//   3. The ticket-panel typing indicator rendered the raw agent UUID: the
//      agent_typing SSE frame carried `actor_name: <agent_id>`.
//
// Imports the compiled server from dist/ (built by `npm run build`).

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { bootApp, exitAfterTests } from './helpers/boot.mjs';
import {
  createAgent,
  createApiKey,
  setupKanbanScene,
  createTicket,
} from './helpers/fixtures.mjs';
import { McpClient } from './helpers/mcp-client.mjs';
import { openSseStream } from './helpers/sse-listener.mjs';

const BASE_PORT = parseInt(process.env.QA_FULLNAME_ORCH_PORT || '7889', 10);

const { app, modules } = await bootApp({ port: BASE_PORT });
after(() => { void app.close().catch(() => {}); });
const { getDataSourceToken } = modules;
const ds = app.get(getDataSourceToken());

const DIST = path.join(process.cwd(), 'dist');
const { OrchestrationTeamService } = await import(
  'file://' + path.join(DIST, 'modules', 'orchestration', 'orchestration-team.service.js')
);
const { OrchestrationMissionService } = await import(
  'file://' + path.join(DIST, 'modules', 'orchestration', 'orchestration-mission.service.js')
);
const teams = app.get(OrchestrationTeamService);
const missions = app.get(OrchestrationMissionService);

// ── Scene ───────────────────────────────────────────────────────────────────
// Deliberately give the orchestrator and the member the SAME leaf name under
// DIFFERENT managers. That is the case a bare name cannot express, and it is
// why this contract exists: without the prefix the operator (and the
// orchestrator's own roster prompt) sees two identical entries.
const { ws, columns } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'orch-fullname' });

const mgrA = await createAgent(app, getDataSourceToken, ws.id, { name: 'MgrA', type: 'manager' });
const mgrB = await createAgent(app, getDataSourceToken, ws.id, { name: 'MgrB', type: 'manager' });

const orchestrator = await createAgent(app, getDataSourceToken, ws.id, { name: 'Lead', type: 'hermes', hosted: false });
const memberA = await createAgent(app, getDataSourceToken, ws.id, { name: 'Coder', type: 'hermes', hosted: false });
const memberB = await createAgent(app, getDataSourceToken, ws.id, { name: 'Coder', type: 'hermes', hosted: false });

const agentRepo = ds.getRepository('Agent');
await agentRepo.update({ id: orchestrator.id }, { manager_agent_id: mgrA.id });
await agentRepo.update({ id: memberA.id }, { manager_agent_id: mgrA.id });
await agentRepo.update({ id: memberB.id }, { manager_agent_id: mgrB.id });

const ORCH_DISPLAY = `${mgrA.name}/${orchestrator.name}`;
const MEMBER_A_DISPLAY = `${mgrA.name}/${memberA.name}`;
const MEMBER_B_DISPLAY = `${mgrB.name}/${memberB.name}`;

// ─── 1. The picker feed ──────────────────────────────────────────────────────
test('assignable-agents carries manager_name so the picker can render <Manager>/<Agent>', async () => {
  const rows = await teams.listAssignableAgents(ws.id);
  const a = rows.find((r) => r.id === memberA.id);
  const b = rows.find((r) => r.id === memberB.id);
  assert.ok(a && b, 'both managed agents must be assignable');

  assert.equal(a.manager_name, mgrA.name, 'manager_name must be resolved, not left null');
  assert.equal(b.manager_name, mgrB.name, 'manager_name must be resolved, not left null');

  // The whole point: two agents of the same role under different managers stay
  // distinguishable only because the prefix is there.
  assert.notEqual(
    `${a.manager_name}/${a.name}`,
    `${b.manager_name}/${b.name}`,
    'two same-named agents under different managers must render distinctly',
  );

  // A manager identity is never an assignable worker.
  assert.ok(!rows.some((r) => r.id === mgrA.id), 'manager identities must not appear in the picker');
});

// ─── 2. Team projection ──────────────────────────────────────────────────────
test('team view: orchestrator_name and member agent_name are <Manager>/<Agent>', async () => {
  const team = await teams.createTeam({
    workspace_id: ws.id,
    name: 'fullname-team',
    orchestrator_agent_id: orchestrator.id,
  });
  await teams.addMember(team.id, ws.id, { agent_id: memberA.id, role_label: 'impl' });
  await teams.addMember(team.id, ws.id, { agent_id: memberB.id, role_label: 'review' });

  const views = await teams.listTeams(ws.id);
  const view = views.find((t) => t.id === team.id);
  assert.ok(view, 'team must be listed');

  assert.equal(view.orchestrator_name, ORCH_DISPLAY,
    `orchestrator_name must be "${ORCH_DISPLAY}", got "${view.orchestrator_name}"`);

  const displays = view.members.map((m) => m.agent_name).sort();
  assert.deepEqual(displays, [MEMBER_A_DISPLAY, MEMBER_B_DISPLAY].sort(),
    `member agent_name must carry the manager prefix, got ${JSON.stringify(displays)}`);
  assert.ok(view.members.every((m) => m.agent_name.includes('/')),
    'every member label must carry the manager prefix');
});

// ─── 3. Mission timeline + step assignee ─────────────────────────────────────
test('mission: recordEvent canonicalizes an agent actor_name, and assignee_name is prefixed', async () => {
  const teamList = await teams.listTeams(ws.id);
  const team = teamList.find((t) => t.name === 'fullname-team');

  const mission = await missions.createMission({
    workspace_id: ws.id,
    team_id: team.id,
    title: 'fullname mission',
    objective: 'prove names',
    orchestrator_agent_id: orchestrator.id,
    created_by_type: 'user',
    created_by: 'tester',
  });

  // Write the timeline row with a deliberately BARE actor_name — recordEvent is
  // the choke point that must replace it with the canonical display.
  await missions.recordEvent(mission, {
    type: 'note',
    message: 'hello',
    actor_type: 'agent',
    actor_id: memberA.id,
    actor_name: 'Coder',
  });
  // A system actor has no agent id → its label must survive verbatim.
  await missions.recordEvent(mission, {
    type: 'note',
    message: 'system says',
    actor_type: 'system',
    actor_id: '',
    actor_name: 'OrchestrationReaper',
  });

  const rows = await ds.getRepository('OrchestrationEvent').find({ where: { mission_id: mission.id } });
  const agentRow = rows.find((r) => r.message === 'hello');
  const sysRow = rows.find((r) => r.message === 'system says');
  assert.equal(agentRow.actor_name, MEMBER_A_DISPLAY,
    `agent actor_name must be stored canonical, got "${agentRow.actor_name}"`);
  assert.equal(sysRow.actor_name, 'OrchestrationReaper',
    'non-agent actor label must survive verbatim');

  // Step assignee, as the mission detail / plan graph renders it.
  await ds.getRepository('OrchestrationStep').save(
    ds.getRepository('OrchestrationStep').create({
      mission_id: mission.id,
      workspace_id: ws.id,
      step_key: 's1',
      title: 'do the thing',
      instructions: '',
      acceptance_criteria: '',
      team_id: team.id,
      depends_on: [],
      assignee_agent_id: memberB.id,
      status: 'pending',
      position: 0,
      plan_version: mission.plan_version,
    }),
  );

  const detail = await missions.getMissionDetail(mission.id);
  assert.equal(detail.orchestrator_name, ORCH_DISPLAY, 'mission orchestrator_name must be prefixed');
  assert.equal(detail.steps[0].assignee_name, MEMBER_B_DISPLAY,
    `step assignee_name must be "${MEMBER_B_DISPLAY}", got "${detail.steps[0].assignee_name}"`);
});

// ─── 4. Ticket typing indicator (agent_typing SSE) ───────────────────────────
// This frame used to carry `actor_name: <agent uuid>`, so TicketPanel rendered
// "e9d0e8bc-… is typing". Drive set_typing through the real /mcp transport.
test('agent_typing SSE: actor_name is <Manager>/<Agent>, never the raw agent id', async () => {
  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: columns.todo.id,
    workspaceId: ws.id,
    title: 'typing target',
    assigneeId: memberA.id,
  });

  const subKey = await createApiKey(app, getDataSourceToken, mgrA.id, { workspaceId: ws.id, label: 'typing-sub' });
  const sse = await openSseStream(BASE_PORT, subKey.raw_key, {});
  after(() => sse.close());

  const callerKey = await createApiKey(app, getDataSourceToken, memberA.id, { workspaceId: ws.id, label: 'typing-caller' });
  const client = new McpClient({ baseUrl: `http://127.0.0.1:${BASE_PORT}`, apiKey: callerKey.raw_key });
  after(() => { void client.close().catch(() => {}); });

  const res = await client.callTool('set_typing', {
    agent_id: memberA.id,
    ticket_id: ticket.id,
    is_typing: true,
  });
  assert.ok(res && !res.isError, `set_typing must succeed, got ${JSON.stringify(res)}`);

  const frame = await sse.waitFor(
    'agent_typing',
    (d) => d.ticket_id === ticket.id && d.action === 'started',
    8000,
  );
  assert.equal(frame.data.actor_name, MEMBER_A_DISPLAY,
    `agent_typing.actor_name must be "${MEMBER_A_DISPLAY}", got "${frame.data.actor_name}"`);
  assert.notEqual(frame.data.actor_name, memberA.id, 'actor_name must never be the raw agent id');
  assert.ok(String(frame.data.actor_name).includes('/'), 'actor_name must carry the manager prefix');

  await client.callTool('set_typing', { agent_id: memberA.id, ticket_id: ticket.id, is_typing: false });
});

// ─── 5. Chat typing indicator (chat_room_typing) ─────────────────────────────
// The agent-manager posts this endpoint. It used to send the MANAGER's own
// agent_id (loadAgentInfo()), which resolves to a bare manager name — hence
// "<manager> is thinking". The server-side contract asserted here is that
// whatever agent_id arrives is re-resolved to the canonical display, and that
// the caller-supplied `agent_name` never overrides it.
test('chat_room_typing: server re-resolves agent_id, ignoring a bare caller-supplied name', async () => {
  const room = await ds.getRepository('ChatRoom').save(
    ds.getRepository('ChatRoom').create({
      workspace_id: ws.id,
      name: 'typing room',
      type: 'group',
      created_by_type: 'user',
      created_by: 'tester',
    }),
  );

  const subKey = await createApiKey(app, getDataSourceToken, mgrA.id, { workspaceId: ws.id, label: 'chat-typing-sub' });
  await ds.getRepository('ChatRoomParticipant').save(
    ds.getRepository('ChatRoomParticipant').create({
      room_id: room.id,
      participant_type: 'agent',
      participant_id: mgrA.id,
      joined_at: new Date(),
    }),
  );
  const sse = await openSseStream(BASE_PORT, subKey.raw_key, {});
  after(() => sse.close());

  const callerKey = await createApiKey(app, getDataSourceToken, memberA.id, { workspaceId: ws.id, label: 'chat-typing-caller' });
  const resp = await fetch(
    `http://127.0.0.1:${BASE_PORT}/api/agent/chat-rooms/${room.id}/typing`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': callerKey.raw_key },
      body: JSON.stringify({
        agent_id: memberA.id,
        agent_name: 'Coder',   // bare hint — must NOT win
        is_typing: true,
        status: 'thinking',
      }),
    },
  );
  assert.ok(resp.ok, `typing endpoint must accept the post, got ${resp.status}`);

  const frame = await sse.waitFor(
    'chat_room_typing',
    (d) => d.room_id === room.id && d.is_typing === true,
    8000,
  );
  assert.equal(frame.data.agent_name, MEMBER_A_DISPLAY,
    `chat_room_typing.agent_name must be "${MEMBER_A_DISPLAY}", got "${frame.data.agent_name}"`);
  assert.ok(String(frame.data.agent_name).includes('/'),
    'the chat typing label must carry the manager prefix, not the manager name alone');
  assert.equal(frame.data.agent_id, memberA.id,
    'the frame must be keyed by the ANSWERING agent — the client clears the indicator by this id');
});

exitAfterTests();
