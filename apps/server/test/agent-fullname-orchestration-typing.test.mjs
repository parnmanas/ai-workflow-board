// Regression: the `<Manager>/<Agent>` display contract on the surfaces added
// after ticket 51b1519d — Orchestration mode and the two typing indicators.
//
// The rule (docs/runbooks/agent-display-name.md):
// EVERY user-visible agent name renders as `<Manager>/<Agent>`, resolved
// through utils/agent-name.ts on the server or utils/agentName.ts on the
// client. Never a bare `agent.name`, never a raw agent id.
//
// What broke before this test existed:
//   1. Orchestration team/mission projections read `agent.name` directly, so
//      the team roster, orchestrator label, step assignee, and the roster the
//      orchestrator sees in its OWN brief prompt were all bare leaf names.
//   2. The team picker feed did not return manager_name at all, so the team
//      pickers could not have rendered the full name even if they wanted to.
//      That feed is now `runtime-hosts` (a roster slot names a MACHINE, not a
//      pre-existing agent) — so the assertion moved to the thing that replaced
//      it, plus the identities the roster itself provisions.
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

// 부팅 포트는 OS 가 배정한다(0). 특정 번호에 붙어야 할 때만 env 로 고정한다.
const REQUESTED_PORT = parseInt(process.env.QA_FULLNAME_ORCH_PORT || '0', 10);

const { app, port, modules } = await bootApp({ port: REQUESTED_PORT });
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

const MEMBER_A_DISPLAY = `${mgrA.name}/${memberA.name}`;
const MEMBER_B_DISPLAY = `${mgrB.name}/${memberB.name}`;

// ─── 1. The slot picker feed ─────────────────────────────────────────────────
// A roster slot names a Runtime Host, so the feed the pickers read is the host
// catalogue. The display-name contract applies to it verbatim: a host is an
// Agent row too, and its name is what every slot label is prefixed with.
test('runtime-hosts feed names every paired Runtime Host and never offers a worker as one', async () => {
  const hosts = await teams.listRuntimeHosts(ws.id);
  const a = hosts.find((h) => h.manager_agent_id === mgrA.id);
  const b = hosts.find((h) => h.manager_agent_id === mgrB.id);
  assert.ok(a && b, 'both paired managers must be offered as Runtime Hosts');

  assert.equal(a.manager_name, mgrA.name, 'manager_name must be resolved, not left blank');
  assert.equal(b.manager_name, mgrB.name, 'manager_name must be resolved, not left blank');

  // The inverse of the old assertion: a worker identity is never a HOST.
  assert.ok(
    !hosts.some((h) => h.manager_agent_id === memberA.id || h.manager_agent_id === orchestrator.id),
    'executable agents must not appear as Runtime Hosts',
  );

  // The working-folder picker is seeded from the folders already in use on that
  // host — this is what makes "share a folder with a teammate" a click.
  assert.ok(Array.isArray(a.working_dirs), 'a host must report a working-folder candidate list');
});

// ─── 2. Team projection ──────────────────────────────────────────────────────
// The roster now PROVISIONS its identities from a spec, so this covers both
// halves of the contract: the provisioned names are prefixed, and two slots
// with the same role on different hosts stay distinguishable — which is exactly
// the ambiguity the prefix exists to remove, and which a roster spread over
// several machines produces by default.
const SLOT_SPEC = (managerId, extra = {}) => ({
  manager_agent_id: managerId,
  cli: 'hermes',
  working_dir: '/srv/work/app',
  runtime_config: { strategy: 'single', permission_mode: 'strict' },
  ...extra,
});

test('team view: orchestrator_name and member agent_name are <Manager>/<Agent>', async () => {
  const team = await teams.createTeam({
    workspace_id: ws.id,
    name: 'fullname-team',
    orchestrator: SLOT_SPEC(mgrA.id),
  });
  await teams.addMember(team.id, ws.id, { runtime: SLOT_SPEC(mgrA.id), role_label: 'impl' });
  await teams.addMember(team.id, ws.id, { runtime: SLOT_SPEC(mgrB.id), role_label: 'impl' });

  const views = await teams.listTeams(ws.id);
  const view = views.find((t) => t.id === team.id);
  assert.ok(view, 'team must be listed');

  assert.ok(view.orchestrator_name.startsWith(`${mgrA.name}/`),
    `orchestrator_name must carry the manager prefix, got "${view.orchestrator_name}"`);

  assert.equal(view.members.length, 2, 'both members must be on the roster');
  assert.ok(view.members.every((m) => m.agent_name.includes('/')),
    'every member label must carry the manager prefix');

  const onA = view.members.find((m) => m.runtime?.manager_agent_id === mgrA.id);
  const onB = view.members.find((m) => m.runtime?.manager_agent_id === mgrB.id);
  assert.ok(onA && onB, 'each member must report the host its slot named');
  assert.ok(onA.agent_name.startsWith(`${mgrA.name}/`), 'member on MgrA is prefixed with MgrA');
  assert.ok(onB.agent_name.startsWith(`${mgrB.name}/`), 'member on MgrB is prefixed with MgrB');
  assert.notEqual(onA.agent_name, onB.agent_name,
    'two identically-configured members on different hosts must render distinctly');
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
    orchestrator_agent_id: team.orchestrator_agent_id,
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
  assert.equal(detail.orchestrator_name, team.orchestrator_name,
    'mission orchestrator_name must match the team projection (both go through resolveAgentDisplayName)');
  assert.ok(detail.orchestrator_name.startsWith(`${mgrA.name}/`),
    'mission orchestrator_name must be prefixed');
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
  const sse = await openSseStream(port, subKey.raw_key, {});
  after(() => sse.close());

  const callerKey = await createApiKey(app, getDataSourceToken, memberA.id, { workspaceId: ws.id, label: 'typing-caller' });
  const client = new McpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: callerKey.raw_key });
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
  const sse = await openSseStream(port, subKey.raw_key, {});
  after(() => sse.close());

  const callerKey = await createApiKey(app, getDataSourceToken, memberA.id, { workspaceId: ws.id, label: 'chat-typing-caller' });
  const resp = await fetch(
    `http://127.0.0.1:${port}/api/agent/chat-rooms/${room.id}/typing`,
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

// ─── 6. Chat session-status badge (chat_room_session_status, ticket e18be8ff) ──
// Same re-resolution contract as chat_room_typing above, on the new
// keep-alive/background-task-count endpoint the agent-manager posts from
// ChatSessionManager#_onSessionStatusChanged.
test('chat_room_session_status: server re-resolves agent_id and forwards keep-alive/background-task fields', async () => {
  const room = await ds.getRepository('ChatRoom').save(
    ds.getRepository('ChatRoom').create({
      workspace_id: ws.id,
      name: 'session-status room',
      type: 'group',
      created_by_type: 'user',
      created_by: 'tester',
    }),
  );

  const subKey = await createApiKey(app, getDataSourceToken, mgrA.id, { workspaceId: ws.id, label: 'chat-status-sub' });
  await ds.getRepository('ChatRoomParticipant').save(
    ds.getRepository('ChatRoomParticipant').create({
      room_id: room.id,
      participant_type: 'agent',
      participant_id: mgrA.id,
      joined_at: new Date(),
    }),
  );
  const sse = await openSseStream(port, subKey.raw_key, {});
  after(() => sse.close());

  const callerKey = await createApiKey(app, getDataSourceToken, memberA.id, { workspaceId: ws.id, label: 'chat-status-caller' });
  const keepAliveUntilMs = Date.now() + 8 * 60_000;
  const resp = await fetch(
    `http://127.0.0.1:${port}/api/agent/chat-rooms/${room.id}/session-status`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': callerKey.raw_key },
      body: JSON.stringify({
        agent_id: memberA.id,
        keep_alive_until_ms: keepAliveUntilMs,
        background_task_count: 2,
      }),
    },
  );
  assert.ok(resp.ok, `session-status endpoint must accept the post, got ${resp.status}`);

  const frame = await sse.waitFor(
    'chat_room_session_status',
    (d) => d.room_id === room.id,
    8000,
  );
  assert.equal(frame.data.agent_name, MEMBER_A_DISPLAY,
    `chat_room_session_status.agent_name must be "${MEMBER_A_DISPLAY}", got "${frame.data.agent_name}"`);
  assert.ok(String(frame.data.agent_name).includes('/'),
    'the session-status label must carry the manager prefix, not a bare name');
  assert.equal(frame.data.agent_id, memberA.id,
    'the frame must be keyed by the ANSWERING agent, not the manager');
  assert.equal(frame.data.keep_alive_until_ms, keepAliveUntilMs,
    'keep_alive_until_ms must be forwarded verbatim (absolute deadline, not pre-computed remaining minutes)');
  assert.equal(frame.data.background_task_count, 2,
    'background_task_count must be forwarded verbatim');
});

exitAfterTests();
