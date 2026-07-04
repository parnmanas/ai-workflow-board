// QA flow: cross-board handoff pipeline (ticket ac21a745).
//
// Proves the HandoffService relay engine drives a multi-board ticket relay with
// zero human intervention, and that the reverse-rejection + pipeline-rollup
// surfaces work:
//
//   1. RELAY — a design-board ticket carrying a 2-hop handoff_spec reaches Done
//      → a follow-up is auto-created on the graphic board carrying the source's
//      deliverable context (deep link + latest comment + copied attachment), the
//      remaining hop inherited. That follow-up reaching Done → a client-board
//      follow-up with an EMPTY spec (relay self-terminates). (DoD 1)
//   2. IDEMPOTENCY — re-emitting the same terminal move does NOT double-relay.
//   3. REVERSE REJECTION — rejecting a follow-up files a [반려] defect ticket
//      back on the SOURCE board and re-blocks the follow-up on it as a prereq
//      (pending_on_tickets flips true). (DoD 2)
//   4. PIPELINE — get the rollup for the whole relay across all three boards.
//   5. NEGATIVE — a ticket with no handoff_spec reaching Done relays nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  createWorkspace,
  createBoard,
  createColumn,
  createAgent,
  createTicket,
} from '../helpers/fixtures.mjs';

process.env.PORT = process.env.QA_HANDOFF_PORT || '7861';

// Simulate a real terminal landing: the move path stamps terminal_entered_at on
// the non-terminal → terminal crossing, then logs a `moved` activity. We do the
// same so HandoffService sees exactly what production emits.
async function moveToDone(ds, activityService, ticketId, doneColId, { restamp = true } = {}) {
  const tRepo = ds.getRepository('Ticket');
  if (restamp) {
    await tRepo.update(ticketId, { column_id: doneColId, terminal_entered_at: new Date() });
  }
  await activityService.logActivity({
    entity_type: 'ticket', entity_id: ticketId, action: 'moved',
    field_changed: 'column', new_value: 'Done', ticket_id: ticketId,
    actor_id: 'test-user', actor_name: 'Tester',
  });
}

async function followupsOf(ds, sourceId) {
  return ds.getRepository('Ticket').find({ where: { handoff_source_ticket_id: sourceId } });
}

// The relay listener is fire-and-forget (.catch); poll until the expected count
// of follow-ups lands or the deadline passes.
async function waitForFollowups(ds, sourceId, expected, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  let rows = await followupsOf(ds, sourceId);
  while (rows.length < expected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    rows = await followupsOf(ds, sourceId);
  }
  return rows;
}

async function boardOf(ds, ticket) {
  const col = await ds.getRepository('BoardColumn').findOne({ where: { id: ticket.column_id } });
  return col ? col.board_id : '';
}

test('cross-board handoff relay + reverse rejection + pipeline rollup', async (t) => {
  step('Boot NestJS app');
  const { app, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const ds = app.get(modules.getDataSourceToken());
  const activityService = app.get(modules.ActivityService);
  const handoffService = app.get(modules.HandoffService);

  step('Seed workspace + 3 functional boards (design/graphic/client) + agent');
  const ws = await createWorkspace(app, modules.getDataSourceToken, 'handoff');
  const agent = await createAgent(app, modules.getDataSourceToken, ws.id, { name: 'relay-owner' });

  const mkBoard = async (name) => {
    const board = await createBoard(app, modules.getDataSourceToken, ws.id, { name });
    const todo = await createColumn(app, modules.getDataSourceToken, board.id, {
      name: 'Todo', position: 0, workspaceId: ws.id, kind: 'intake', roleRouting: ['assignee'],
    });
    const done = await createColumn(app, modules.getDataSourceToken, board.id, {
      name: 'Done', position: 1, workspaceId: ws.id, isTerminal: true, kind: 'terminal', roleRouting: [],
    });
    return { board, todo, done };
  };
  const design = await mkBoard('GameDesign');
  const graphic = await mkBoard('GameGraphic');
  const client = await mkBoard('GameClient');

  // ── Scenario 1: multi-board relay (DoD 1) ─────────────────────────────────
  step('S1: design ticket with a 2-hop spec (→graphic →client) reaches Done');
  const source = await createTicket(app, modules.getDataSourceToken, {
    columnId: design.todo.id, workspaceId: ws.id, title: '검룡 스킬 기획', assigneeId: agent.id,
  });
  // A deliverable summary comment (embedded into the follow-up body) + a carried
  // attachment (기획서). hop[0] carries all attachments.
  await ds.getRepository('Comment').save(ds.getRepository('Comment').create({
    ticket_id: source.id, author_type: 'agent', author_id: agent.id, author: 'relay-owner',
    content: '기획 확정: 검룡 스킬 3종 + 밸런스 표 v2', type: 'note',
  }));
  await ds.getRepository('TicketAttachment').save(ds.getRepository('TicketAttachment').create({
    workspace_id: ws.id, owner_type: 'ticket', owner_id: source.id, ticket_id: source.id,
    file_name: 'design-spec.md', file_mimetype: 'text/markdown',
    file_data: Buffer.from('# 검룡 스킬 기획서').toString('base64'), file_size: 20,
    uploaded_by_type: 'agent', uploaded_by_id: agent.id, uploaded_by: 'relay-owner',
  }));
  const spec = { hops: [
    { target_board_id: graphic.board.id, carry_attachments: true, title_template: '[에셋] {{source_title}}' },
    { target_board_id: client.board.id },
  ] };
  await ds.getRepository('Ticket').update(source.id, { handoff_spec: JSON.stringify(spec) });

  await moveToDone(ds, activityService, source.id, design.done.id);
  const s1 = await waitForFollowups(ds, source.id, 1);
  assert.equal(s1.length, 1, 'S1: exactly one follow-up created on relay');
  const graphicTicket = s1[0];
  assert.equal(await boardOf(ds, graphicTicket), graphic.board.id, 'S1: follow-up lands on the graphic board');
  assert.equal(graphicTicket.handoff_source_ticket_id, source.id, 'S1: follow-up back-points at the source');
  assert.equal(graphicTicket.assignee_id, agent.id, 'S1: source assignee carried onto the follow-up');
  assert.match(graphicTicket.title, /에셋.*검룡 스킬 기획/, 'S1: title_template applied with {{source_title}}');

  step('S1: follow-up inherits the REMAINING hop (→client), not the consumed one');
  const inherited = JSON.parse(graphicTicket.handoff_spec || '{}');
  assert.equal(inherited.hops?.length, 1, 'S1: exactly one hop remains');
  assert.equal(inherited.hops[0].target_board_id, client.board.id, 'S1: remaining hop targets client board');

  step('S1: follow-up body carries deep link + deliverable comment; attachment copied');
  assert.match(graphicTicket.description, new RegExp(source.id), 'S1: body deep-links the source ticket id');
  assert.match(graphicTicket.description, /검룡 스킬 3종/, 'S1: latest handoff comment embedded in body');
  const carried = await ds.getRepository('TicketAttachment').find({ where: { ticket_id: graphicTicket.id } });
  assert.equal(carried.length, 1, 'S1: one attachment carried onto the follow-up');
  assert.equal(carried[0].file_name, 'design-spec.md', 'S1: carried attachment is the design spec');
  assert.match(graphicTicket.labels || '', /handoff/, 'S1: follow-up carries the handoff label');

  step('S1: graphic follow-up reaches Done → client follow-up with EMPTY spec (relay terminates)');
  await moveToDone(ds, activityService, graphicTicket.id, graphic.done.id);
  const s1b = await waitForFollowups(ds, graphicTicket.id, 1);
  assert.equal(s1b.length, 1, 'S1: second-hop follow-up created on client board');
  const clientTicket = s1b[0];
  assert.equal(await boardOf(ds, clientTicket), client.board.id, 'S1: second follow-up lands on the client board');
  assert.equal(clientTicket.handoff_spec || '', '', 'S1: last hop consumed → follow-up carries no further handoff (self-terminating)');

  // ── Scenario 2: idempotency ───────────────────────────────────────────────
  step('S2: re-emitting the same terminal move does NOT double-relay');
  await moveToDone(ds, activityService, source.id, design.done.id, { restamp: false });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal((await followupsOf(ds, source.id)).length, 1, 'S2: still exactly one follow-up after re-emit');

  // ── Scenario 3: reverse rejection (DoD 2) ─────────────────────────────────
  step('S3: rejecting the graphic follow-up files a defect on the design board + re-blocks it');
  const rejectResult = await handoffService.rejectHandoff({
    followupTicketId: graphicTicket.id,
    reason: '기획서 밸런스 표 수치가 누락됨 — 에셋 작업 불가',
    actorName: 'Tester',
  });
  assert.equal(rejectResult.source_ticket_id, source.id, 'S3: rejection resolved the source ticket via lineage');
  assert.equal(rejectResult.defect_board_id, design.board.id, 'S3: defect ticket filed on the SOURCE board (design)');
  const defect = await ds.getRepository('Ticket').findOne({ where: { id: rejectResult.defect_ticket_id } });
  assert.ok(defect, 'S3: defect ticket exists');
  assert.equal(await boardOf(ds, defect), design.board.id, 'S3: defect lives on the design board');
  assert.match(defect.title, /반려/, 'S3: defect titled as a rejection');
  assert.match(defect.description, new RegExp(graphicTicket.id), 'S3: defect body references the rejecting follow-up');

  step('S3: the follow-up is re-blocked on the defect (pending_on_tickets + prereq link)');
  const reblocked = await ds.getRepository('Ticket').findOne({ where: { id: graphicTicket.id } });
  assert.equal(reblocked.pending_on_tickets, true, 'S3: follow-up parked pending the defect fix');
  const prereqs = await ds.getRepository('TicketPrerequisite').find({ where: { ticket_id: graphicTicket.id } });
  assert.ok(
    prereqs.some((p) => p.prerequisite_ticket_id === defect.id),
    'S3: defect wired as a prerequisite of the follow-up (auto-resumes on fix)',
  );

  // ── Scenario 4: pipeline rollup ───────────────────────────────────────────
  step('S4: get_handoff_pipeline rolls up every stage of the relay');
  const pipeline = await handoffService.getPipeline(clientTicket.id);
  assert.equal(pipeline.root_ticket_id, source.id, 'S4: rollup roots at the design source ticket');
  const ids = pipeline.stages.map((s) => s.ticket_id);
  assert.ok(ids.includes(source.id), 'S4: pipeline includes the design source');
  assert.ok(ids.includes(graphicTicket.id), 'S4: pipeline includes the graphic stage');
  assert.ok(ids.includes(clientTicket.id), 'S4: pipeline includes the client stage');
  const boards = new Set(pipeline.stages.map((s) => s.board_id));
  assert.ok(
    boards.has(design.board.id) && boards.has(graphic.board.id) && boards.has(client.board.id),
    'S4: rollup spans all three functional boards',
  );

  // ── Scenario 5: negative — no spec, no relay ──────────────────────────────
  step('S5: a ticket with no handoff_spec reaching Done relays nothing');
  const plain = await createTicket(app, modules.getDataSourceToken, {
    columnId: design.todo.id, workspaceId: ws.id, title: '핸드오프 없는 티켓', assigneeId: agent.id,
  });
  await moveToDone(ds, activityService, plain.id, design.done.id);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal((await followupsOf(ds, plain.id)).length, 0, 'S5: no follow-up for a ticket without a handoff_spec');
});

exitAfterTests();
