// QA flow: Review-stage same-role strand serialization (ticket c9622a40 —
// the residual fix for 890a9af7 problem 2, beyond 86bfb8af proposal 1 and
// a3d25202 proposal 2).
//
// The reviewer-vs-reviewer self-LGTM race
// ───────────────────────────────────────
// The focus selector caps an agent to ONE focus ticket per (board, role), and
// proposal 2's review-approval-guard refuses a Review→Merging move without a
// reviewer-authored comment. NEITHER stops a SECOND trigger for the SAME
// (ticket, reviewer) — fired by a distinct event (column_move + comment_mention
// + supervisor / unpend / ticket_update tick) — from spawning a redundant
// racing reviewer strand: both triggers pass the focus gate (same ticket id),
// and proposal 2 sees author_role:reviewer on both, so a fast strand can
// LGTM→Merging→Done before the slow strand's independent BLOCKER review lands,
// discarding the careful verdict as a post-merge no-op (86bfb8af live repro).
//
// The fix (this ticket) serializes strands at the _emitTrigger chokepoint:
// while a LIVE (non-stale) subagent is registered for this exact (agent,
// ticket, role) — via AgentStatusService.active_tasks, the existing
// set_current_task / clear_current_task / agent_idle / stale-TTL lifecycle —
// a second same-(ticket, role) emit is DROPPED. One strand per seat at a time;
// the live one finishes (clear_current_task) and the next trigger re-fires.
//
// What this proves
//   1. First reviewer trigger emits (no live strand yet).
//   2. With a live reviewer strand registered, a second reviewer trigger is
//      DROPPED (no new SSE trigger) + an `agent_trigger_dropped_inflight_strand`
//      audit row is written. => only ONE strand alive => only ONE verdict/move.
//   3. After the strand clears, a fresh reviewer trigger emits again.
//   4. Role discrimination: a live ASSIGNEE strand does NOT block a REVIEWER
//      trigger (legitimately distinct seats on a single-agent multi-role board).

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

process.env.PORT = process.env.QA_REVIEW_STRAND_PORT || '7853';

// Fire a comment-created activity authored by `user` (NOT the worker, so the
// self-trigger guard doesn't short-circuit) on the Review ticket. That routes
// an agent_trigger at the Review column's reviewer roleholder.
async function fireReviewerComment(app, ActivityService, ticketId, user, n) {
  await app.get(ActivityService).logActivity({
    entity_type: 'comment',
    entity_id: `cmt-${n}`,
    action: 'created',
    ticket_id: ticketId,
    actor_id: user.id,
    actor_name: user.name,
  });
}

test('Review same-role strand serialization: a live reviewer strand drops a second reviewer trigger', async (t) => {
  step('Boot NestJS app on test port');
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken, ActivityService } = modules;

  // Pull the singleton AgentStatusService from the running app so the test can
  // drive the same in-memory active_tasks the trigger loop's gate reads.
  const agentStatusServiceModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'agent-status.service.js')
  );
  const agentStatus = app.get(agentStatusServiceModule.AgentStatusService);

  step('Seed kanban scene; worker holds all roles (single-agent board), ticket in Review');
  const { ws, columns } = await setupKanbanScene(app, getDataSourceToken, {
    workspaceName: 'review-strand',
  });
  const worker = await createAgent(app, getDataSourceToken, ws.id, { name: 'worker' });
  const workerKey = await createApiKey(app, getDataSourceToken, worker.id, {
    workspaceId: ws.id,
    label: 'worker',
  });
  const user = await createUser(app, getDataSourceToken, { name: 'commenter' });

  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: columns.review.id,
    workspaceId: ws.id,
    title: 'Strand-serialization ticket',
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

  const activityLogRepo = app.get(getDataSourceToken()).getRepository('ActivityLog');
  const dropRows = async () =>
    activityLogRepo.find({
      where: { ticket_id: ticket.id, action: 'agent_trigger_dropped_inflight_strand' },
    });

  // ── Phase 1: no live strand → first reviewer trigger emits ────────────────
  step('PHASE 1: first reviewer trigger emits (no live strand)');
  await fireReviewerComment(app, ActivityService, ticket.id, user, 1);
  const t1 = await va.waitForTrigger(
    (tr) => tr.ticket_id === ticket.id && tr.role === 'reviewer',
    4000,
  );
  assert.equal(t1.role, 'reviewer', 'phase1: reviewer trigger received');
  assert.equal(va.triggersFor(ticket.id).length, 1, 'phase1: exactly one reviewer trigger so far');
  assert.equal((await dropRows()).length, 0, 'phase1: no in-flight drop yet');

  // ── Phase 2: live reviewer strand → second reviewer trigger is DROPPED ────
  step('PHASE 2: register a live reviewer strand, then a second reviewer trigger MUST be dropped');
  await agentStatus.setCurrentTask(worker.id, ticket.id, 'reviewer');
  await fireReviewerComment(app, ActivityService, ticket.id, user, 2);
  // Give the dispatch path time to run and (correctly) NOT emit.
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(
    va.triggersFor(ticket.id).length,
    1,
    'phase2: second reviewer trigger must be DROPPED while a reviewer strand is in flight',
  );
  const drops = await dropRows();
  assert.equal(drops.length, 1, 'phase2: exactly one agent_trigger_dropped_inflight_strand audit row');
  assert.match(
    String(drops[0].new_value || ''),
    /role=reviewer/,
    'phase2: drop audit row records the reviewer role',
  );

  // ── Phase 3: strand clears → reviewer trigger emits again ─────────────────
  step('PHASE 3: clear the strand, a fresh reviewer trigger emits again');
  agentStatus.clearCurrentTask(worker.id, ticket.id);
  await fireReviewerComment(app, ActivityService, ticket.id, user, 3);
  await va.waitForTrigger(
    (tr) => tr.ticket_id === ticket.id && tr.role === 'reviewer' && va.triggersFor(ticket.id).length >= 2,
    4000,
  );
  assert.equal(
    va.triggersFor(ticket.id).length,
    2,
    'phase3: emit resumes once the live strand exits',
  );

  // ── Phase 4: a live ASSIGNEE strand must NOT block a REVIEWER trigger ─────
  step('PHASE 4: live assignee strand does NOT block a reviewer trigger (role discrimination)');
  await agentStatus.setCurrentTask(worker.id, ticket.id, 'assignee');
  await fireReviewerComment(app, ActivityService, ticket.id, user, 4);
  await va.waitForTrigger(
    (tr) => tr.ticket_id === ticket.id && tr.role === 'reviewer' && va.triggersFor(ticket.id).length >= 3,
    4000,
  );
  assert.equal(
    va.triggersFor(ticket.id).length,
    3,
    'phase4: a different-role (assignee) live strand must not gate the reviewer seat',
  );
  // No additional in-flight drop row beyond phase 2's.
  assert.equal((await dropRows()).length, 1, 'phase4: assignee strand produced no reviewer drop');

  exitAfterTests(0);
});
