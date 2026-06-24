// QA flow: Review→Merging approval guard on move_ticket (ticket a3d25202 —
// proposal 2 of 86bfb8af).
//
// 86bfb8af's proposal 1 removed `assignee` from the Review column routing so an
// assignee strand can no longer be *woken* in Review to self-LGTM→self-merge.
// This guard is the defense-in-depth that closes the remaining manual / abnormal
// paths: crossing the review gate (a `review` column → a `merging` column) is
// refused unless a reviewer-authored comment (metadata.author_role==='reviewer')
// exists. An assignee self-LGTM does NOT count. force=true is the deliberate
// override.
//
// This test drives the real MCP move_ticket tool:
//
//   1. Review → Merging, no reviewer comment            → REJECTED (stays in Review)
//   2. + assignee self-LGTM comment, Review → Merging   → still REJECTED
//   3. + reviewer comment, Review → Merging             → ALLOWED (lands in Merging)
//   4. fresh ticket, Review → Merging, force=true       → ALLOWED (override, no comment)

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  setupKanbanScene,
  createColumn,
  createAgent,
  createApiKey,
  createTicket,
} from '../helpers/fixtures.mjs';
import { VirtualAgent } from '../helpers/virtual-agent.mjs';

process.env.PORT = process.env.QA_REVIEW_APPROVAL_PORT || '7849';

test('move_ticket rejects Review→Merging without a reviewer-authored comment unless force=true', async (t) => {
  step('Boot NestJS app on test port');
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  step('Seed kanban scene + add a Merging column (kind=merging)');
  const { ws, board, columns } = await setupKanbanScene(app, getDataSourceToken, {
    workspaceName: 'review-approval',
  });
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

  step('Create ticket in Review, worker holds all three roles (single-agent board)');
  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: columns.review.id,
    workspaceId: ws.id,
    title: 'Review-approval ticket',
    promptText: 'Try to self-merge past the review gate.',
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

  const ticketRepo = app.get(getDataSourceToken()).getRepository('Ticket');

  step('CASE 1: Review → Merging with NO reviewer comment — should be REJECTED');
  const noComment = await va.mcp.callTool('move_ticket', {
    ticket_id: ticket.id,
    target_column_name: 'Merging',
    board_id: board.id,
  });
  assert.equal(noComment?.isError, true, 'Review→Merging with no reviewer comment must be rejected');
  assert.match(
    JSON.stringify(noComment?.error ?? noComment),
    /review|reviewer/i,
    'Rejection message names the review-approval reason',
  );
  let row = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(row?.column_id, columns.review.id, 'Ticket STAYS in Review (case 1)');

  step('CASE 2: assignee self-LGTM comment, then Review → Merging — still REJECTED');
  const selfLgtm = await va.mcp.callTool('add_comment', {
    ticket_id: ticket.id,
    content: 'LGTM (self) — merging.',
    author_role: 'assignee',
  });
  assert.ok(!selfLgtm?.isError, `assignee comment must post, got: ${JSON.stringify(selfLgtm)}`);
  const afterSelf = await va.mcp.callTool('move_ticket', {
    ticket_id: ticket.id,
    target_column_name: 'Merging',
    board_id: board.id,
  });
  assert.equal(afterSelf?.isError, true, 'assignee self-LGTM must NOT satisfy the review gate');
  row = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(row?.column_id, columns.review.id, 'Ticket STAYS in Review (case 2)');

  step('CASE 3: reviewer comment, then Review → Merging — should be ALLOWED');
  const reviewerLgtm = await va.mcp.callTool('add_comment', {
    ticket_id: ticket.id,
    content: 'LGTM — reviewed independently.',
    author_role: 'reviewer',
  });
  assert.ok(!reviewerLgtm?.isError, `reviewer comment must post, got: ${JSON.stringify(reviewerLgtm)}`);
  const afterReviewer = await va.mcp.callTool('move_ticket', {
    ticket_id: ticket.id,
    target_column_name: 'Merging',
    board_id: board.id,
  });
  assert.ok(!afterReviewer?.isError, `reviewer comment must satisfy the gate, got: ${JSON.stringify(afterReviewer)}`);
  row = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(row?.column_id, merging.id, 'Ticket lands in Merging after a reviewer comment (case 3)');

  step('CASE 4: fresh ticket, Review → Merging with force=true, NO reviewer comment — ALLOWED');
  const ticket2 = await createTicket(app, getDataSourceToken, {
    columnId: columns.review.id,
    workspaceId: ws.id,
    title: 'Forced override ticket',
    assigneeId: worker.id,
    reporterId: worker.id,
    reviewerId: worker.id,
  });
  const forced = await va.mcp.callTool('move_ticket', {
    ticket_id: ticket2.id,
    target_column_name: 'Merging',
    board_id: board.id,
    force: true,
  });
  assert.ok(!forced?.isError, `force=true must override the review gate, got: ${JSON.stringify(forced)}`);
  const row2 = await ticketRepo.findOne({ where: { id: ticket2.id } });
  assert.equal(row2?.column_id, merging.id, 'force=true moved the ticket into Merging with no reviewer comment');

  exitAfterTests(0);
});
