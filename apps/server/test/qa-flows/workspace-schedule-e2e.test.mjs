// Workspace scheduler E2E (ticket 4dca7de7) — the live due → fresh room →
// task_prompt → spawn-trigger path, end to end, against a booted server with a
// real DB + the real RoomMessagingService (NOT the stubbed repos that
// workspace-schedule-behavior.test.mjs uses, and NOT the run_now-only round-trip
// that workspace-schedule-mcp.test.mjs covers).
//
// What "spawn" means here: agent-manager spawns a subagent when a
// `chat_room_message` SSE frame arrives in a room one of its managed agents is
// seated in (event-registry.ts roomMemberFilter → agent_member_ids; the same
// chat→agent route QA/Security run dispatch rides). The OS-level agent-manager
// process can't run inside this in-process test, so we stand in for it exactly
// as it behaves: open the authenticated SSE stream AS the target agent and
// assert the spawn-triggering frame lands. That frame IS the spawn signal — once
// it's on the wire with the agent in agent_member_ids, the live agent-manager
// path takes over (already exercised by the QA executor E2E, fe297886).
//
// Drives the real scheduler sweep via WorkspaceScheduleService.runOnce(now) — the
// background tick body itself — rather than run_now, so this is the automatic
// due→dispatch path, including the pre-advance idempotency guard under a second
// sweep at the same `now`.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { setupKanbanScene, createAgent, createApiKey } from '../helpers/fixtures.mjs';
import { openSseStream } from '../helpers/sse-listener.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', '..', 'dist');

// Silence the background auto-tick so ONLY our explicit runOnce(now) drives the
// sweep — otherwise a 30s interval timer could fire mid-assertion and make the
// idempotency / duplicate-room checks racy. The CRUD + runOnce methods work
// regardless of the tick being planted.
process.env.WORKSPACE_SCHEDULER_ENABLED = 'false';
process.env.PORT = process.env.WS_SCHED_E2E_PORT || '7844';

const TASK_PROMPT = 'E2E: run the scheduled task.';

test('Workspace schedule E2E: scheduler tick → fresh room → task_prompt → spawn-trigger SSE (idempotent)', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  const { WorkspaceScheduleService } = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'workspace-schedule', 'workspace-schedule.service.js')
  );
  const svc = app.get(WorkspaceScheduleService);
  const ds = app.get(getDataSourceToken());

  const { ws } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'ws-sched-e2e' });
  // The schedule dispatches to this agent; we also subscribe to SSE as it.
  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'scheduled-worker' });
  const key = await createApiKey(app, getDataSourceToken, agent.id, { workspaceId: ws.id, label: 'sched-e2e' });

  // Stand in for the agent-manager: subscribe to the live event stream AS the
  // target agent. A chat_room_message landing here is the spawn trigger.
  const sse = await openSseStream(port, key.raw_key);
  t.after(() => sse.close());

  step('create an interval schedule (workspace-scoped, board_id=null)');
  const schedule = await svc.create({
    workspaceId: ws.id,
    name: 'e2e nightly task',
    targetAgentId: agent.id,
    taskPrompt: TASK_PROMPT,
    intervalMs: 30 * 60_000,
    createdBy: 'e2e',
  });
  assert.ok(schedule.id, 'schedule created');
  assert.ok(schedule.next_run_at, 'next_run_at precomputed on create');

  step('drive the scheduler tick at a `now` past next_run_at — the real due→dispatch sweep');
  const fireAt = new Date(new Date(schedule.next_run_at).getTime() + 1_000);
  const { dispatched } = await svc.runOnce(fireAt);
  assert.deepEqual(dispatched, [schedule.id], 'the due schedule is dispatched by the tick');

  step('the spawn-triggering chat_room_message SSE reaches the target-agent subscriber');
  const evt = await sse.waitFor(
    'chat_room_message',
    (d) => d.sender_id === 'system' && d.content === TASK_PROMPT,
    8_000,
  );
  // The exact shape agent-manager spawns on: a user/system-sent message in a room
  // the agent is seated in.
  assert.equal(evt.data.sender_type, 'user', 'sent from a user/system sender — the spawn-triggering shape');
  assert.ok(
    Array.isArray(evt.data.agent_member_ids) && evt.data.agent_member_ids.includes(agent.id),
    'target agent is in agent_member_ids → agent-manager picks it to respond',
  );
  const roomId = evt.data.room_id;
  assert.ok(roomId, 'event carries the fresh room id');

  step('DB reflects a fresh room + agent/system participants + the persisted task_prompt');
  const room = await ds.getRepository('ChatRoom').findOne({ where: { id: roomId } });
  assert.ok(room, 'room row persisted');
  assert.equal(room.name, `Schedule: ${schedule.name}`, 'room named after the schedule');
  assert.equal(room.workspace_id, ws.id, 'room scoped to the workspace');

  const seats = (await ds.getRepository('ChatRoomParticipant').find({ where: { room_id: roomId } }))
    .map((p) => `${p.participant_type}:${p.participant_id}`)
    .sort();
  assert.deepEqual(seats, [`agent:${agent.id}`, 'user:system'].sort(), 'agent + synthetic system user seated');

  const msgs = await ds.getRepository('ChatRoomMessage').find({ where: { room_id: roomId } });
  assert.ok(msgs.find((m) => m.content === TASK_PROMPT), 'task_prompt persisted as a real chat message');

  step('schedule cursor: last_room_id/last_run_at stamped, next_run_at advanced past the firing');
  const after = await svc.get(schedule.id, ws.id);
  assert.equal(after.last_room_id, roomId, 'last_room_id stamped to the fresh room');
  assert.ok(after.last_run_at, 'last_run_at stamped');
  assert.ok(
    new Date(after.next_run_at).getTime() > fireAt.getTime(),
    'next_run_at advanced past the firing instant (the pre-advance idempotency guard)',
  );

  step('idempotency: a second tick at the SAME `now` dispatches nothing — no duplicate room/spawn');
  const second = await svc.runOnce(fireAt);
  assert.deepEqual(second.dispatched, [], 'cursor already advanced → re-entrant sweep no-ops');
  const dupFrames = await sse.drainOfType('chat_room_message', 700);
  assert.equal(dupFrames.length, 0, 'no second spawn-triggering message emitted');
  const scheduledRooms = (await ds.getRepository('ChatRoom').find({ where: { workspace_id: ws.id } }))
    .filter((r) => r.name === `Schedule: ${schedule.name}`);
  assert.equal(scheduledRooms.length, 1, 'still exactly one scheduled room — no duplicate dispatch');

  sse.close();
  exitAfterTests(0);
});
