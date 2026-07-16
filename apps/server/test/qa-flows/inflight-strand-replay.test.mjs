// QA flow: transition-trigger preservation across strand completion
// (ticket 1bcb0899 — the recovery half of the c9622a40 in-flight-strand gate).
//
// The stranded-ticket bug
// ───────────────────────
// The in-flight-strand gate (ticket c9622a40) serializes same-(agent, ticket,
// role) strands: while a LIVE subagent holds a seat, a second trigger for that
// seat is DROPPED. That is correct for a re-fireable source (a comment / a
// supervisor tick fires again on its own). But a `column_move` — the trigger a
// Review→Merging move emits — is ONE-SHOT: nothing re-fires it. In the source
// incident a Review→Merging move emitted its column_move while the previous
// resumed strand was still marked in-flight; the gate dropped it as
// `agent_trigger_dropped_inflight_strand`, no merging strand was ever created,
// and the ticket stalled ~2.9h until an UNRELATED prerequisite waiter happened
// to re-dispatch its column.
//
// The fix (this ticket) makes the drop observable AND automatically recoverable:
// a dropped one-shot transition is QUEUED, keyed by the busy (agent, ticket,
// role) seat, and REPLAYED the instant that strand frees (the same `agent_idle`
// signal clearCurrentTask / the stale-sweep already emit). No new store, no
// polling — the replay rides the existing lifecycle.
//
// What this proves
//   1. A live assignee strand drops the Review→Merging column_move trigger AND
//      the drop audit row is stamped `queued_for_replay=true` (observable).
//   2. When the strand exits (agent_idle), the queued transition is replayed —
//      the assignee trigger finally emits (trigger_source=inflight_strand_replay)
//      and an `agent_trigger_replayed_inflight_strand` audit row is written
//      (automatically recoverable, and observable).
//   3. The queue is consumed once: a later strand exit does NOT double-replay
//      (loop-free — a re-drop by a fresh strand does not re-queue).
//   4. Deferred-then-recovered (ticket 1bcb0899 reviewer BLOCKER): if the
//      replay's FIRST emit is itself dropped by a fresh-state gate (here: the
//      board is paused between the drop and the strand exit), the recovery is
//      NOT falsely marked done — no `agent_trigger_replayed_inflight_strand`
//      row is written before a real emit, the queued entry is PRESERVED
//      (re-queued with a `agent_trigger_replay_deferred` row), and the NEXT
//      lifecycle signal (once the board resumes) finally lands the emit and
//      writes the success row. A gated emit must stay recoverable, not vanish.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  setupKanbanScene,
  createAgent,
  createApiKey,
  createColumn,
  createTicket,
  createUser,
} from '../helpers/fixtures.mjs';
import { VirtualAgent } from '../helpers/virtual-agent.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', '..', 'dist');

process.env.PORT = process.env.QA_INFLIGHT_REPLAY_PORT || '7861';

test('Transition-trigger preservation: a dropped column_move is replayed when the blocking strand exits', async (t) => {
  step('Boot NestJS app on test port');
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken, ActivityService } = modules;

  // Pull the live singletons + the real move core out of the running app so the
  // test drives the exact same in-memory strand map the gate reads and the same
  // `performColumnMove` the move_ticket MCP tool calls.
  const agentStatusModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'agent-status.service.js')
  );
  const agentStatus = app.get(agentStatusModule.AgentStatusService);
  const ticketMoveModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'mcp', 'shared', 'ticket-move.js')
  );
  const { performColumnMove } = ticketMoveModule;

  step('Seed scene; add a Merging column routing to assignee; worker holds all roles');
  const { ws, board, columns } = await setupKanbanScene(app, getDataSourceToken, {
    workspaceName: 'inflight-replay',
  });
  // The base scene has no Merging column; add one routing to assignee. kind
  // 'merging' does NOT require a base repo (only assignee+active does), so no
  // envRepo is needed for the assignee dispatch to land.
  const merging = await createColumn(app, getDataSourceToken, board.id, {
    name: 'Merging',
    position: 5,
    workspaceId: ws.id,
    kind: 'merging',
    roleRouting: ['assignee'],
  });
  const worker = await createAgent(app, getDataSourceToken, ws.id, { name: 'worker' });
  const workerKey = await createApiKey(app, getDataSourceToken, worker.id, {
    workspaceId: ws.id,
    label: 'worker',
  });
  // The mover is a user (not the worker) so the column_move fan-out targets the
  // assignee seat cleanly — the mover identity is incidental to this fix.
  const user = await createUser(app, getDataSourceToken, { name: 'mover' });

  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: columns.review.id,
    workspaceId: ws.id,
    title: 'Preserve-transition ticket',
    assigneeId: worker.id,
    reporterId: worker.id,
    reviewerId: worker.id,
  });

  const va = new VirtualAgent({
    name: 'worker',
    agentId: worker.id,
    apiKey: workerKey.raw_key,
    port,
  });
  await va.start();
  t.after(() => va.stop());
  await new Promise((r) => setTimeout(r, 200));

  const ds = app.get(getDataSourceToken());
  const activityService = app.get(ActivityService);
  const activityLogRepo = ds.getRepository('ActivityLog');
  const dropRows = async () =>
    activityLogRepo.find({
      where: { ticket_id: ticket.id, action: 'agent_trigger_dropped_inflight_strand' },
    });
  const replayRows = async () =>
    activityLogRepo.find({
      where: { ticket_id: ticket.id, action: 'agent_trigger_replayed_inflight_strand' },
    });

  // ── Phase 1: live assignee strand → Review→Merging move is DROPPED + QUEUED ─
  step('PHASE 1: a live assignee strand drops the Review→Merging column_move, queued for replay');
  await agentStatus.setCurrentTask(worker.id, ticket.id, 'assignee');
  // Fresh entity so performColumnMove shifts from the real current column.
  const freshTicket = await ds.getRepository('Ticket').findOne({ where: { id: ticket.id } });
  await performColumnMove(ds, activityService, {
    ticket: freshTicket,
    destColumnId: merging.id,
    actorId: user.id,
    actorName: user.name,
  });
  // Give the async dispatch path time to run and (correctly) NOT emit.
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(
    va.triggersFor(ticket.id).length,
    0,
    'phase1: the Merging trigger is dropped while an assignee strand is in flight',
  );
  const drops = await dropRows();
  assert.equal(drops.length, 1, 'phase1: exactly one inflight-strand drop audit row');
  assert.match(String(drops[0].new_value || ''), /role=assignee/, 'phase1: drop row records the assignee role');
  assert.match(
    String(drops[0].new_value || ''),
    /queued_for_replay=true/,
    'phase1: a one-shot column_move drop is flagged queued_for_replay (observable)',
  );
  assert.equal((await replayRows()).length, 0, 'phase1: no replay yet — the strand is still live');

  // ── Phase 2: strand exits → agent_idle → the queued transition is REPLAYED ──
  step('PHASE 2: the strand exits; the queued column_move is replayed and finally emits');
  agentStatus.clearCurrentTask(worker.id, ticket.id);
  const replayed = await va.waitForTrigger(
    (tr) => tr.ticket_id === ticket.id && tr.role === 'assignee',
    4000,
  );
  assert.equal(replayed.role, 'assignee', 'phase2: the replayed assignee trigger is received');
  assert.equal(
    replayed.trigger_source,
    'inflight_strand_replay',
    'phase2: the recovery emits with trigger_source=inflight_strand_replay',
  );
  assert.equal(va.triggersFor(ticket.id).length, 1, 'phase2: exactly one trigger — the replay');
  assert.equal(
    (await replayRows()).length,
    1,
    'phase2: one replay audit row — the automatic recovery is observable',
  );

  // ── Phase 3: the queue is consumed once — a later idle does NOT re-replay ───
  step('PHASE 3: queue drained; a further strand exit must not double-replay');
  await agentStatus.setCurrentTask(worker.id, ticket.id, 'assignee');
  agentStatus.clearCurrentTask(worker.id, ticket.id);
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(
    va.triggersFor(ticket.id).length,
    1,
    'phase3: no second replay — the queued entry was consumed exactly once (loop-free)',
  );
  assert.equal((await replayRows()).length, 1, 'phase3: still exactly one replay audit row');

  // ── Phase 4-6: reviewer BLOCKER — the replay's first emit is GATED, so the ─
  //    transition must DEFER (no false success audit) and recover on the next
  //    lifecycle signal, not vanish. A fresh ticket keeps the state isolated.
  const boardRepo = ds.getRepository('Board');
  // ticket1 now sits on Merging (non-terminal) and occupies the agent's single
  // default focus slot, which would drop ticket2's emit SILENTLY at the focus
  // gate (before the inflight-strand gate we are exercising). Widen the focus
  // window so both tickets are in play and the drop we assert on is the
  // inflight-strand one, not a focus-cap artefact.
  await boardRepo.update({ id: board.id }, { max_concurrent_tickets_per_agent: 5 });
  const ticket2 = await createTicket(app, getDataSourceToken, {
    columnId: columns.review.id,
    workspaceId: ws.id,
    title: 'Preserve-transition ticket (deferred path)',
    assigneeId: worker.id,
    reporterId: worker.id,
    reviewerId: worker.id,
  });
  const dropRows2 = async () =>
    activityLogRepo.find({
      where: { ticket_id: ticket2.id, action: 'agent_trigger_dropped_inflight_strand' },
    });
  const replayRows2 = async () =>
    activityLogRepo.find({
      where: { ticket_id: ticket2.id, action: 'agent_trigger_replayed_inflight_strand' },
    });
  const deferredRows2 = async () =>
    activityLogRepo.find({
      where: { ticket_id: ticket2.id, action: 'agent_trigger_replay_deferred' },
    });

  step('PHASE 4: a live assignee strand drops ticket2 Review→Merging column_move, queued for replay');
  await agentStatus.setCurrentTask(worker.id, ticket2.id, 'assignee');
  const freshTicket2 = await ds.getRepository('Ticket').findOne({ where: { id: ticket2.id } });
  await performColumnMove(ds, activityService, {
    ticket: freshTicket2,
    destColumnId: merging.id,
    actorId: user.id,
    actorName: user.name,
  });
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(va.triggersFor(ticket2.id).length, 0, 'phase4: Merging trigger dropped while strand in flight');
  assert.equal((await dropRows2()).length, 1, 'phase4: exactly one inflight-strand drop audit row for ticket2');
  assert.match(String((await dropRows2())[0].new_value || ''), /queued_for_replay=true/, 'phase4: queued for replay');

  step('PHASE 5: pause the board, then exit the strand — the replay emit is GATED and must DEFER');
  await boardRepo.update({ id: board.id }, { paused_at: new Date() });
  agentStatus.clearCurrentTask(worker.id, ticket2.id);
  // Let the drain run: it dequeues, attempts the emit, the pause gate returns
  // '' → the entry is re-queued and a deferred row is written. NO trigger, and
  // crucially NO success audit before a real emit.
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(
    va.triggersFor(ticket2.id).length,
    0,
    'phase5: the gated replay emits NO trigger while the board is paused',
  );
  assert.equal(
    (await replayRows2()).length,
    0,
    'phase5: NO agent_trigger_replayed_inflight_strand row — a success audit must never precede a real emit',
  );
  assert.ok(
    (await deferredRows2()).length >= 1,
    'phase5: a agent_trigger_replay_deferred row records the retry-in-progress (observable, recoverable)',
  );

  step('PHASE 6: resume the board; the next strand exit replays the PRESERVED transition to success');
  await boardRepo.update({ id: board.id }, { paused_at: null });
  await agentStatus.setCurrentTask(worker.id, ticket2.id, 'assignee');
  agentStatus.clearCurrentTask(worker.id, ticket2.id);
  const replayed2 = await va.waitForTrigger(
    (tr) => tr.ticket_id === ticket2.id && tr.role === 'assignee',
    4000,
  );
  assert.equal(
    replayed2.trigger_source,
    'inflight_strand_replay',
    'phase6: the deferred transition finally emits on the next lifecycle signal',
  );
  assert.equal(va.triggersFor(ticket2.id).length, 1, 'phase6: exactly one trigger — the recovered replay');
  assert.equal(
    (await replayRows2()).length,
    1,
    'phase6: the success audit is written ONLY now, after the real emit landed',
  );

  exitAfterTests(0);
});
