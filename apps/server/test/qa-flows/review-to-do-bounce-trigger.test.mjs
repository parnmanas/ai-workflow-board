// QA flow: Review → To Do 반송 직후 assignee 트리거가 즉시 land 하는지 (ticket
// ea4adc71 — output-liveness가 세션 종료 시 evict 되지 않아 방금 종료한 seat이
// 최대 15분간 "live"로 오판되던 문제).
//
// The bug end-to-end
// ──────────────────
// hasLiveRoleStrand's path-2 (ticket e9c8e1d6) treats a fresh per-(agent,ticket,
// role) output-liveness stamp within CURRENT_TASK_STALE_MS (15 min) as a live
// strand. Before the fix, output-liveness had NO clear signal on session end —
// only the 6h+ TTL sweep dropped it. So for up to 15 min AFTER the assignee
// strand exited, its output-liveness lingered and _emitTrigger's in-flight-strand
// gate (trigger-loop.service.ts:1944) still saw the seat as live:
//   Reviewer bounces Review → To Do → the column_move fires an assignee trigger
//   → the gate drops it (`agent_trigger_dropped_inflight_strand`). Because the
//   strand had already exited, no future agent_idle arrives to replay a Case-A
//   drop, so only the ~15-min supervisor poll eventually recovered == the
//   observed "즉시 트리거되지 않음".
//
// The fix (ticket ea4adc71): clearCurrentTask — the manager's reliable subagent-
// EXIT signal — now evicts output-liveness for the exited seat (before its
// active_tasks early-returns, and before it emits agent_idle). The vacated seat
// is dead on BOTH gate paths the instant the strand exits.
//
// What this proves (drives the REAL performColumnMove + the live singletons the
// gate reads — same core the move_ticket MCP tool calls):
//   PHASE A — immediate trigger (Case A, already-exited): after clearCurrentTask
//     evicts output-liveness, a Review → To Do move emits the assignee trigger
//     AT ONCE (VirtualAgent receipt + trigger_emitted audit, no drop row).
//   PHASE B — fallback replay (Case B, bounce-while-live): a Review → To Do move
//     that lands WHILE the assignee strand is still producing output is correctly
//     dropped + queued (path-2 gate), then REPLAYED the instant the strand exits
//     — the same clearCurrentTask eviction lets the agent_idle drain's re-check
//     pass instead of re-dropping on stale output-liveness.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  setupKanbanScene,
  createAgent,
  createApiKey,
  createTicket,
  createUser,
} from '../helpers/fixtures.mjs';
import { VirtualAgent } from '../helpers/virtual-agent.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', '..', 'dist');

process.env.PORT = process.env.QA_REVIEW_TODO_BOUNCE_PORT || '7869';

test('Review→To Do bounce: exit-evicted output-liveness lets the assignee trigger land (immediate + replay)', async (t) => {
  step('Boot NestJS app on test port');
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken, ActivityService } = modules;

  // Live singletons + the real move core, so the test drives the exact in-memory
  // strand/output-liveness maps the gate reads and the same performColumnMove the
  // move_ticket MCP tool calls.
  const agentStatusModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'agent-status.service.js')
  );
  const agentStatus = app.get(agentStatusModule.AgentStatusService);
  const { performColumnMove } = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'mcp', 'shared', 'ticket-move.js')
  );

  step('Seed scene WITH an env repo (so the assignee dispatch resolves a base repo and emits, not pends)');
  const { ws, columns } = await setupKanbanScene(app, getDataSourceToken, {
    workspaceName: 'review-todo-bounce',
    envRepo: true,
    // Two tickets share the one worker; keep the focus window wide enough that
    // neither is silently dropped by the per-(board,role) focus cap (that drop
    // is audit-less — it would look like the gate, but isn't).
    maxConcurrent: 5,
  });
  const ds = app.get(getDataSourceToken());

  // Model the real AWB board's To Do: an active (branch-work) column routing to
  // assignee. The scene's default `todo` is intake/no-routing, so promote it —
  // Review → To Do then fires a real assignee column_move trigger.
  await ds.getRepository('BoardColumn').update(columns.todo.id, {
    kind: 'active',
    role_routing: JSON.stringify(['assignee']),
  });

  const worker = await createAgent(app, getDataSourceToken, ws.id, { name: 'worker' });
  const workerKey = await createApiKey(app, getDataSourceToken, worker.id, {
    workspaceId: ws.id,
    label: 'worker',
  });
  // The mover is a user (not the worker) so the column_move fan-out targets the
  // assignee seat cleanly (the self-trigger guard doesn't short-circuit).
  const reviewer = await createUser(app, getDataSourceToken, { name: 'reviewer-user' });

  const mkTicket = (title) =>
    createTicket(app, getDataSourceToken, {
      columnId: columns.review.id,
      workspaceId: ws.id,
      title,
      assigneeId: worker.id,
      reporterId: worker.id,
      reviewerId: worker.id,
    });
  const ticketA = await mkTicket('bounce-immediate');
  const ticketB = await mkTicket('bounce-replay');

  const va = new VirtualAgent({ name: 'worker', agentId: worker.id, apiKey: workerKey.raw_key, port });
  await va.start();
  t.after(() => va.stop());
  await new Promise((r) => setTimeout(r, 200));

  const activityService = app.get(ActivityService);
  const activityLogRepo = ds.getRepository('ActivityLog');
  const rowsFor = (ticketId, action) => activityLogRepo.find({ where: { ticket_id: ticketId, action } });
  const assigneeTriggers = (ticketId) => va.triggersFor(ticketId).filter((tr) => tr.role === 'assignee');
  const bounceToTodo = async (ticket) => {
    const fresh = await ds.getRepository('Ticket').findOne({ where: { id: ticket.id } });
    await performColumnMove(ds, activityService, {
      ticket: fresh,
      destColumnId: columns.todo.id,
      actorId: reviewer.id,
      actorName: reviewer.name,
    });
  };

  // ── PHASE A: immediate trigger (Case A — the strand already exited) ─────────
  step('PHASE A: assignee strand runs+produces output, then EXITS; the Review→To Do bounce must emit at once');
  await agentStatus.setCurrentTask(worker.id, ticketA.id, 'assignee');
  agentStatus.recordOutputLiveness(worker.id, ticketA.id, 'assignee');
  assert.equal(
    agentStatus.hasLiveRoleStrand(worker.id, ticketA.id, 'assignee'),
    true,
    'A.pre: while the strand runs, the gate reports the seat live (a trigger now would be gated)',
  );

  // Strand exits → manager fires clear_current_task(agent, ticket). THE FIX:
  // output-liveness is evicted here, so the seat is dead on both gate paths.
  agentStatus.clearCurrentTask(worker.id, ticketA.id);
  assert.equal(
    agentStatus.getOutputLivenessAt(worker.id, ticketA.id, 'assignee'),
    undefined,
    'A.fix: clearCurrentTask evicted the exited seat’s output-liveness',
  );
  assert.equal(
    agentStatus.hasLiveRoleStrand(worker.id, ticketA.id, 'assignee'),
    false,
    'A.fix: the just-exited seat is no longer live → the bounce trigger will pass the in-flight gate',
  );

  await bounceToTodo(ticketA);
  const emittedA = await va.waitForTrigger(
    (tr) => tr.ticket_id === ticketA.id && tr.role === 'assignee',
    4000,
  );
  assert.equal(emittedA.role, 'assignee', 'A: the Review→To Do bounce emits the assignee trigger immediately');
  assert.equal(assigneeTriggers(ticketA.id).length, 1, 'A: exactly one assignee trigger (the immediate emit)');
  assert.equal(
    (await rowsFor(ticketA.id, 'agent_trigger_dropped_inflight_strand')).length,
    0,
    'A: no in-flight-strand drop — the exited seat did not gate the bounce',
  );
  assert.equal(
    (await rowsFor(ticketA.id, 'trigger_emitted')).length,
    1,
    'A: exactly one trigger_emitted audit row (dispatch passed every gate)',
  );

  // ── PHASE B: fallback replay (Case B — bounce lands while the strand is live) ─
  step('PHASE B: a Review→To Do bounce that lands WHILE the strand produces output is dropped+queued, then replayed on exit');
  await agentStatus.setCurrentTask(worker.id, ticketB.id, 'assignee');
  agentStatus.recordOutputLiveness(worker.id, ticketB.id, 'assignee');

  await bounceToTodo(ticketB);
  await new Promise((r) => setTimeout(r, 700)); // let the dispatch path run and (correctly) NOT emit
  assert.equal(assigneeTriggers(ticketB.id).length, 0, 'B: the bounce is dropped while the strand is live');
  const dropsB = await rowsFor(ticketB.id, 'agent_trigger_dropped_inflight_strand');
  assert.equal(dropsB.length, 1, 'B: exactly one in-flight-strand drop audit row');
  assert.match(String(dropsB[0].new_value || ''), /role=assignee/, 'B: drop row records the assignee role');
  assert.match(
    String(dropsB[0].new_value || ''),
    /queued_for_replay=true/,
    'B: the one-shot column_move drop is queued for replay (observable)',
  );

  // Strand exits → the fix evicts output-liveness BEFORE agent_idle, so the drain
  // re-checks hasLiveRoleStrand (now false) and replays instead of re-dropping on
  // stale output-liveness.
  agentStatus.clearCurrentTask(worker.id, ticketB.id);
  const replayedB = await va.waitForTrigger(
    (tr) => tr.ticket_id === ticketB.id && tr.role === 'assignee',
    4000,
  );
  assert.equal(replayedB.role, 'assignee', 'B: the queued bounce is replayed once the strand exits');
  assert.equal(
    replayedB.trigger_source,
    'inflight_strand_replay',
    'B: the recovery emits with trigger_source=inflight_strand_replay',
  );
  assert.equal(assigneeTriggers(ticketB.id).length, 1, 'B: exactly one assignee trigger — the replay');

  exitAfterTests(0);
});
