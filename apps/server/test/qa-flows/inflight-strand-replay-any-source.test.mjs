// QA flow: in-flight-strand drop replay queue widened to EVERY trigger
// source (ticket d35b8ac8), not just the one-shot transition sources
// (column_move / next_ticket / prerequisite_resolved) ticket 1bcb0899 fixed.
//
// The gap this closes
// ────────────────────
// The in-flight-strand gate (ticket c9622a40) drops a SECOND trigger for a
// (agent, ticket, role) seat that is already live. Ticket 1bcb0899 queued the
// drop for replay ONLY for one-shot sources, on the theory that every other
// source "self-corrects" (a supervisor tick re-fires in ~60s, a comment
// re-fires on the next edit). Three live incidents (see ticket d35b8ac8)
// showed that assumption failing: several consecutive supervisor re-pushes
// landed back-to-back while the SAME blocking strand stayed alive, none of
// them were queued, and recovery depended on an unrelated sweep noticing the
// ticket idle afterward — observed gaps of up to ~10 minutes with the seat
// sitting free the whole time. This flow proves:
//   1. A live strand drops a 'supervisor'-sourced trigger — the drop audit
//      row is now stamped queued_for_replay=true (previously false).
//   2. The durable dispatch-intent recovery pointer carries the blocking
//      strand's start time (strand_live_since) — the plumbing ticket
//      d35b8ac8 requirement #3's escalation message depends on.
//   3. The strand exits (agent_idle) → the queued 'supervisor' drop replays
//      automatically — no reliance on the next organic supervisor tick.
//   4. The one deliberate exception survives the refactor: an emit whose OWN
//      triggerSource is 'inflight_strand_replay' hitting the same gate is
//      NOT re-queued (loop-freedom guard), and the drop event says so
//      explicitly instead of leaving queued_for_replay=false unexplained.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { setupKanbanScene, createAgent, createTicket } from '../helpers/fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', '..', 'dist');

process.env.PORT = process.env.QA_INFLIGHT_REPLAY_ANY_SOURCE_PORT || '7862';

/** Bounded poll for an ActivityLog row matching `where` — mirrors the
 *  VirtualAgent._waitOnBuffer pattern (tick + deadline), just against the DB
 *  instead of an in-memory SSE buffer. */
async function waitForActivity(activityRepo, where, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await activityRepo.find({ where });
    if (rows.length > 0) return rows;
    if (Date.now() > deadline) {
      throw new Error(`Timeout (${timeoutMs}ms) waiting for activity ${JSON.stringify(where)}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('In-flight-strand drop: every trigger source is queued for replay (except the loop-guard source)', async (t) => {
  step('Boot NestJS app on test port');
  const { app, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());

  const agentStatusModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'agent-status.service.js')
  );
  const agentStatus = app.get(agentStatusModule.AgentStatusService);
  const triggerLoopModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'trigger-loop.service.js')
  );
  const triggerLoop = app.get(triggerLoopModule.TriggerLoopService);
  const dispatchIntentModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'dispatch-intent.service.js')
  );
  const intents = app.get(dispatchIntentModule.DispatchIntentService);

  step('Seed scene (env repo so the assignee+active dispatch can actually land) + worker + ticket');
  const { ws, columns } = await setupKanbanScene(app, getDataSourceToken, {
    workspaceName: 'inflight-replay-any-source', envRepo: true,
  });
  const worker = await createAgent(app, getDataSourceToken, ws.id, { name: 'worker' });
  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: columns.inProgress.id, workspaceId: ws.id, title: 'any-source replay probe',
    assigneeId: worker.id, reporterId: worker.id,
  });

  const activityLogRepo = ds.getRepository('ActivityLog');
  const subagentRepo = ds.getRepository('Subagent');
  const dropRows = () => activityLogRepo.find({
    where: { ticket_id: ticket.id, action: 'agent_trigger_dropped_inflight_strand' },
  });

  // ── Phase 1: a live strand drops a 'supervisor' trigger — now QUEUED ──────
  step('PHASE 1: live assignee strand drops a supervisor-sourced trigger, queued for replay');
  await agentStatus.setCurrentTask(worker.id, ticket.id, 'assignee');
  // Real Subagent row backing the live strand (review blocker, ticket
  // d35b8ac8) — this is what proves the end-to-end strand-identifier lookup
  // in trigger-loop.service.ts's drop path actually resolves a row, not just
  // the AgentStatusService seat this test otherwise drives directly.
  const blockingSubagentId = 'sub-inflight-replay-probe-1';
  await subagentRepo.save(subagentRepo.create({
    subagent_id: blockingSubagentId, agent_id: worker.id, workspace_id: ws.id, kind: 'ticket',
    session_key: `${ticket.id}:assignee`, pid: 424242, started_at: new Date(), ticket_id: ticket.id,
    ticket_title: ticket.title, role: 'assignee', ended_at: null,
  }));
  const dropped = await triggerLoop.emitAgentTrigger(ticket, worker.id, 'assignee', 'supervisor', 'system');
  assert.equal(dropped, '', 'phase1: the supervisor trigger is gated while the strand is in flight');

  const drops = await dropRows();
  assert.equal(drops.length, 1, 'phase1: exactly one inflight-strand drop audit row');
  assert.match(String(drops[0].new_value || ''), /source=supervisor/, 'phase1: drop row records the supervisor source');
  assert.match(
    String(drops[0].new_value || ''),
    /queued_for_replay=true/,
    'phase1: a supervisor-sourced drop is now queued for replay (was false before ticket d35b8ac8)',
  );
  assert.match(
    String(drops[0].new_value || ''),
    new RegExp(`strand_id=${blockingSubagentId}`),
    'phase1: drop row records the blocking strand identifier (review blocker, ticket d35b8ac8)',
  );

  step("PHASE 1b: the durable recovery pointer carries the blocking strand's identifier + live-since timestamp");
  const intent = await intents.findOpenForTicketRole(ticket.id, 'assignee');
  assert.ok(intent, 'a durable dispatch intent was recorded for the gated dispatch');
  assert.match(intent.last_reason, /inflight_strand_serialization/, 'reason records the in-flight-strand cause');
  assert.match(
    intent.last_reason,
    new RegExp(`strand_id=${blockingSubagentId}`),
    'reason carries the blocking strand identifier (review blocker, ticket d35b8ac8)',
  );
  assert.match(
    intent.last_reason,
    /strand_live_since=\d{4}-\d{2}-\d{2}T/,
    "reason carries the blocking strand's ISO-8601 start time (ticket d35b8ac8 requirement #3 plumbing)",
  );

  // ── Phase 2: strand exits → the queued supervisor drop is REPLAYED ────────
  step('PHASE 2: the strand exits; the queued supervisor-sourced drop is replayed automatically');
  agentStatus.clearCurrentTask(worker.id, ticket.id);
  const replayed = await waitForActivity(activityLogRepo, {
    ticket_id: ticket.id, action: 'agent_trigger_replayed_inflight_strand',
  });
  assert.equal(replayed.length, 1, 'phase2: exactly one replay audit row');
  assert.match(
    String(replayed[0].new_value || ''),
    /dropped_source=supervisor/,
    'phase2: the replay audit ties back to the originally-dropped supervisor source',
  );

  // ── Phase 3: loop-guard survives the refactor ──────────────────────────
  // An emit whose OWN triggerSource is 'inflight_strand_replay' must NOT be
  // queued when it hits the same gate — otherwise a permanently-busy seat
  // would loop the drain forever re-queuing its own replay.
  step('PHASE 3: an inflight_strand_replay-sourced emit hitting the gate is NOT queued (loop-guard)');
  await agentStatus.setCurrentTask(worker.id, ticket.id, 'assignee');
  const replayDropped = await triggerLoop.emitAgentTrigger(
    ticket, worker.id, 'assignee', 'inflight_strand_replay', 'system',
  );
  assert.equal(replayDropped, '', 'phase3: still gated while the strand is in flight');
  const dropsAfterPhase3 = await dropRows();
  assert.equal(dropsAfterPhase3.length, 2, 'phase3: a second drop audit row was written');
  const phase3Drop = dropsAfterPhase3[dropsAfterPhase3.length - 1];
  assert.match(
    String(phase3Drop.new_value || ''),
    /source=inflight_strand_replay/,
    'phase3: the drop row records the replay source',
  );
  assert.match(
    String(phase3Drop.new_value || ''),
    /queued_for_replay=false/,
    'phase3: a replay-of-a-replay is NOT queued (the one deliberate exception)',
  );
  assert.match(
    String(phase3Drop.new_value || ''),
    /reason=replay_of_replay_loop_guard/,
    'phase3: the exception reason is explicit on the event, not silent (ticket d35b8ac8 requirement #2)',
  );
  const replayKey = triggerLoop._transitionReplayKey(worker.id, ticket.id, 'assignee');
  assert.ok(
    !triggerLoop._pendingTransitionReplays.has(replayKey),
    'phase3: nothing was queued for this seat by the replay-sourced drop',
  );

  agentStatus.clearCurrentTask(worker.id, ticket.id);
  exitAfterTests(0);
});

test.after?.(() => exitAfterTests(0));
process.on('beforeExit', () => exitAfterTests(0));
