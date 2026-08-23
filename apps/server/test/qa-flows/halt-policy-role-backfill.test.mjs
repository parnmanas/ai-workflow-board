// QA flow: halt-policy column entry auto-backfill from board
// default_role_assignments, and visibility when no default exists
// (ticket 1e002acb).
//
// Incident this closes: a ticket entering an active `unassigned_policy=halt`
// column (Review / Merging) with its routed role seat vacant used to sit
// SILENT — `_flagPolicyHalt` wrote one `logService.warn` + one ActivityLog
// row and nothing else. The only vacant-role rescue path
// (`BacklogPromotionService._maybeBackfillVacantRole`) was intake-only and
// 30min-delayed, so an active-column halt never got backfilled at all. The
// real incident (ticket c3b767c6) sat halted in Review for 3h05m even though
// the board's `default_role_assignments.reviewer` was already configured.
//
// Fix: `_flagPolicyHalt`'s call site now tries an IMMEDIATE board-default
// backfill first (no sweep ever revisits an edge-triggered halt, so there is
// no "wait and retry" option) and resumes dispatch in place on success.
// Only when the board has no default for the vacant slug does it fall
// through to a genuine halt — which now also leaves a ticket comment naming
// the empty seat, deduped via `metadata.dedupe_key` so a repeated halt on
// the same (column, slug) doesn't spam a fresh row every time.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  createWorkspace,
  createBoard,
  createColumn,
  createAgentTrio,
  createTicket,
} from '../helpers/fixtures.mjs';

process.env.PORT = process.env.QA_HALT_POLICY_BACKFILL_PORT || '7946';

// Give the async activityEvents listener a beat to run — same pattern as the
// sibling auto-advance-*.test.mjs flows (no synchronous point to assert at).
async function settle(ms = 800) {
  await new Promise((r) => setTimeout(r, ms));
}

test('halt-policy column entry backfills from board default, or leaves a visible comment when none exists', async (t) => {
  const { app, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken, ActivityService } = modules;
  const ds = app.get(getDataSourceToken());
  const activity = app.get(ActivityService);

  const ws = await createWorkspace(app, getDataSourceToken, 'halt-policy-backfill');
  const trio = await createAgentTrio(app, getDataSourceToken, ws.id);

  const boardRepo = ds.getRepository('Board');
  const activityLogRepo = ds.getRepository('ActivityLog');
  const assignRepo = ds.getRepository('TicketRoleAssignment');
  const roleRepo = ds.getRepository('WorkspaceRole');
  const commentRepo = ds.getRepository('Comment');
  const ticketRepo = ds.getRepository('Ticket');
  const reviewerRole = await roleRepo.findOne({ where: { workspace_id: ws.id, slug: 'reviewer' } });

  async function makeBoard(name) {
    const board = await createBoard(app, getDataSourceToken, ws.id, { name });
    const todo = await createColumn(app, getDataSourceToken, board.id, {
      name: 'To Do', position: 0, workspaceId: ws.id, kind: 'active', roleRouting: ['assignee'], unassignedPolicy: 'skip',
    });
    // unassignedPolicy defaults to 'halt' — the exact Review-gate shape from
    // the incident this ticket describes.
    const review = await createColumn(app, getDataSourceToken, board.id, {
      name: 'Review', position: 1, workspaceId: ws.id, kind: 'review', roleRouting: ['reviewer'],
    });
    const done = await createColumn(app, getDataSourceToken, board.id, {
      name: 'Done', position: 2, workspaceId: ws.id, isTerminal: true, kind: 'terminal', roleRouting: ['reporter'],
    });
    return { board, todo, review, done };
  }

  // ---------------------------------------------------------------------
  // Case 1 — board HAS a default for the vacant 'reviewer' slug: the seat
  // is backfilled immediately and dispatch resumes in place instead of
  // halting.
  // ---------------------------------------------------------------------
  step('Case 1 — board default configured: halt-column entry backfills the vacant seat immediately');
  const c1 = await makeBoard('halt-backfill-has-default');
  await boardRepo.update(c1.board.id, {
    default_role_assignments: JSON.stringify({ reviewer: [{ agent_id: trio.reviewer.agent.id }] }),
  });
  const t1 = await createTicket(app, getDataSourceToken, {
    columnId: c1.review.id,
    workspaceId: ws.id,
    title: 'staffed assignee, vacant reviewer — board default exists',
    assigneeId: trio.assignee.agent.id,
    reporterId: trio.reporter.agent.id,
    // reviewerId deliberately unset — the vacant routed slug under test.
  });

  step('  emit "moved" onto the halt column with the routed seat vacant');
  await activity.logActivity({
    entity_type: 'ticket', entity_id: t1.id, action: 'moved',
    field_changed: 'column', old_value: 'To Do', new_value: 'Review',
    ticket_id: t1.id, actor_id: 'test-user', actor_name: 'tester',
  });
  await settle();

  step('  seat backfilled from board default, ticket stayed in Review, no halt flag');
  const t1Reviewer = (await assignRepo.find({ where: { ticket_id: t1.id } }))
    .find((a) => a.role_id === reviewerRole.id);
  assert.ok(t1Reviewer, 'reviewer role must now have a holder written by the backfill');
  assert.equal(t1Reviewer.agent_id, trio.reviewer.agent.id, 'backfilled holder must be the board default agent');

  const t1Row = await ticketRepo.findOne({ where: { id: t1.id } });
  assert.equal(t1Row.column_id, c1.review.id, 'backfill fills the seat in place — does not move the ticket');

  const t1Logs = await activityLogRepo.find({ where: { ticket_id: t1.id } });
  const backfillRow = t1Logs.find((l) => l.action === 'halt_policy_role_backfilled');
  assert.ok(
    backfillRow,
    `expected a halt_policy_role_backfilled row; got ${JSON.stringify(t1Logs.map((l) => l.action))}`,
  );
  assert.equal(backfillRow.role, 'reviewer', 'backfill row must carry the filled slug on the role column');
  assert.match(backfillRow.new_value || '', /slugs=reviewer/, 'backfill row must name the filled slug');
  assert.ok(
    !t1Logs.some((l) => l.action === 'auto_advance_halted_policy'),
    'a successful backfill must NOT also leave a genuine-halt flag',
  );
  // Dispatch actually resumed in place — the newly-backfilled reviewer got a
  // real trigger_emitted row, not just a DB write. (The ticket also carries
  // the pre-existing "Ticket moved" system comment and an AgentAutostart
  // "dispatch 보류" comment because the QA fixture's runtime host is offline —
  // both unrelated to this fix, so the halt-visibility check below is scoped
  // to the specific dedupe_key this fix introduces, not comment count.)
  const t1Emit = t1Logs.find((l) => l.action === 'trigger_emitted' && l.role === 'reviewer');
  assert.ok(t1Emit, 'the backfilled reviewer seat must actually receive a trigger_emitted dispatch');
  assert.equal(
    JSON.parse(t1Emit.new_value || '{}').target_agent_id,
    trio.reviewer.agent.id,
    'the dispatch target must be the board-default agent that was just backfilled in',
  );
  const t1HaltComments = (await commentRepo.find({ where: { ticket_id: t1.id } }))
    .filter((c) => JSON.parse(c.metadata || '{}').dedupe_key?.startsWith('halt_policy:'));
  assert.equal(
    t1HaltComments.length,
    0,
    'a successful backfill needs no halt-visibility comment — nothing stayed silent',
  );

  // ---------------------------------------------------------------------
  // Case 2 — board has NO default for the vacant slug: genuine halt. A
  // ticket comment must name the empty seat (ticket 1e002acb point 2) —
  // previously this was a single ActivityLog line nobody was watching.
  // ---------------------------------------------------------------------
  step('Case 2 — no board default: genuine halt leaves a visible ticket comment naming the empty seat');
  const c2 = await makeBoard('halt-backfill-no-default');
  // default_role_assignments deliberately left unset (null) on this board.
  const t2 = await createTicket(app, getDataSourceToken, {
    columnId: c2.review.id,
    workspaceId: ws.id,
    title: 'staffed assignee, vacant reviewer — no board default',
    assigneeId: trio.assignee.agent.id,
    reporterId: trio.reporter.agent.id,
  });

  step('  emit "moved" onto the halt column with the routed seat vacant');
  await activity.logActivity({
    entity_type: 'ticket', entity_id: t2.id, action: 'moved',
    field_changed: 'column', old_value: 'To Do', new_value: 'Review',
    ticket_id: t2.id, actor_id: 'test-user', actor_name: 'tester',
  });
  await settle();

  step('  no backfill possible — genuine halt flag + visible comment naming the vacant slug');
  assert.equal(
    (await assignRepo.find({ where: { ticket_id: t2.id, role_id: reviewerRole.id } })).length,
    0,
    'reviewer role must remain genuinely vacant — no board default to guess from',
  );
  const t2Logs = await activityLogRepo.find({ where: { ticket_id: t2.id } });
  assert.ok(
    !t2Logs.some((l) => l.action === 'halt_policy_role_backfilled'),
    'no board default for this slug — must never write a backfill row',
  );
  const haltRow = t2Logs.find((l) => l.action === 'auto_advance_halted_policy');
  assert.ok(
    haltRow,
    `expected an auto_advance_halted_policy row; got ${JSON.stringify(t2Logs.map((l) => l.action))}`,
  );
  assert.equal(haltRow.role, 'reviewer', 'halt row must carry the vacant slug on the role column');
  assert.match(haltRow.new_value || '', /vacant_slugs=reviewer/, 'halt row must name the vacant slug');

  // Scoped to this fix's own dedupe_key — the ticket also carries the
  // pre-existing, unrelated "Ticket moved" system comment (posted for every
  // column_move regardless of halt outcome), so raw comment count isn't the
  // right signal here.
  async function haltVisibilityComments(ticketId) {
    return (await commentRepo.find({ where: { ticket_id: ticketId }, order: { created_at: 'ASC' } }))
      .filter((c) => JSON.parse(c.metadata || '{}').dedupe_key?.startsWith('halt_policy:'));
  }

  const t2HaltComments = await haltVisibilityComments(t2.id);
  assert.equal(t2HaltComments.length, 1, 'a genuine halt must leave exactly one visible halt comment');
  assert.equal(t2HaltComments[0].author_type, 'system');
  assert.equal(t2HaltComments[0].type, 'system');
  assert.match(t2HaltComments[0].content, /Review/, 'comment must name the halted column');
  assert.match(t2HaltComments[0].content, /reviewer/, 'comment must name the vacant routed slug');

  step('  re-entering the same halt (e.g. the ticket bounces back in) suppresses the repeat, bumps the counter');
  await activity.logActivity({
    entity_type: 'ticket', entity_id: t2.id, action: 'moved',
    field_changed: 'column', old_value: 'To Do', new_value: 'Review',
    ticket_id: t2.id, actor_id: 'test-user', actor_name: 'tester',
  });
  await settle();
  const t2HaltCommentsAfter = await haltVisibilityComments(t2.id);
  assert.equal(t2HaltCommentsAfter.length, 1, 'the SAME vacant-slug halt must not spam a second comment');
  assert.equal(t2HaltCommentsAfter[0].id, t2HaltComments[0].id, 'the existing comment row is reused, not replaced');
  assert.equal(t2HaltCommentsAfter[0].repeat_count, 2, 'repeat_count bumps on a re-entered identical halt');

  exitAfterTests(0);
});
