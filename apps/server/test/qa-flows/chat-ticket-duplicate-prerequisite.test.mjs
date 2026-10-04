// Chat-ticket duplicate intake (docs/tickets.md).
//
// A chat report that matches an open chat ticket with strong provenance (same
// source room / related ticket + same normalized title or overlapping tags) is
// auto-linked to it as a duplicate (`canonical_ticket_id`); medium-confidence
// matches park the report for a human decision. A linked duplicate must never
// be worked on its own — not when it is created, not when its prerequisites
// finish, not after an explicit link — and completing the canonical ticket
// resolves its duplicates without firing the duplicates' own done hooks.
//
// Board removal: tickets are created through the real REST intake
// (POST /api/workspaces/:wsId/tickets → TicketService.create) and dispatch is
// TicketDispatchService. The old role-assignment child checks went away with
// workspace roles.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createAgent, createTicket, createUser, createWorkspace, runtimeHostKeyForAgent } from '../helpers/fixtures.mjs';
import { VirtualAgent } from '../helpers/virtual-agent.mjs';

process.env.PORT = process.env.QA_CHAT_DUPLICATE_PORT || '0';

const { app, port, modules } = await bootApp({ port: Number(process.env.PORT) });
const gdst = modules.getDataSourceToken;
const ds = app.get(gdst());
const { TicketDispatchService } = await import('../../dist/modules/agents/ticket-dispatch.service.js');
const { TicketPrerequisitesService } = await import('../../dist/modules/tickets/ticket-prerequisites.service.js');
const { TicketDuplicateService } = await import('../../dist/modules/tickets/ticket-duplicate.service.js');
const { TicketService, SYSTEM_ACTOR } = await import('../../dist/modules/tickets/ticket.service.js');
const dispatcher = app.get(TicketDispatchService);
const prerequisites = app.get(TicketPrerequisitesService);
const duplicateService = app.get(TicketDuplicateService);
const ticketService = app.get(TicketService);
const ticketRepo = ds.getRepository('Ticket');
const decisionRepo = ds.getRepository('TicketDuplicateDecision');
const commentRepo = ds.getRepository('Comment');
const prereqRepo = ds.getRepository('TicketPrerequisite');

const operator = await createUser(app, gdst, { name: 'duplicate-intake-operator' });
const userToken = app.get(modules.AuthService).createSession(operator.id);

const vagents = [];
test.after(async () => {
  for (const va of vagents) await va.stop();
  await app.close();
});

const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

async function rest(method, path, wsId, body) {
  const response = await fetch(`http://localhost:${port}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}`, 'X-Workspace-Id': wsId },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, body: json };
}

/** Real REST intake (TicketService.create incl. duplicate assessment). */
async function intake(wsId, body) {
  const res = await rest('POST', `/workspaces/${wsId}/tickets`, wsId, body);
  if (res.status !== 201) assert.fail(`REST ticket intake failed (${res.status}): ${JSON.stringify(res.body)}`);
  return res.body;
}

/** A workspace + an assignee agent whose Runtime Host stream a VirtualAgent listens on. */
async function scene(name, { capacity = 10 } = {}) {
  const ws = await createWorkspace(app, gdst, name);
  // Capacity is raised so "the agent is busy" can never be why a duplicate
  // stayed quiet — the duplicate gate itself must be.
  await ds.getRepository('Workspace').update({ id: ws.id }, { max_concurrent_tickets_per_agent: capacity });
  const assignee = await createAgent(app, gdst, ws.id, { name: `${name}-assignee`, runtime: true });
  const va = new VirtualAgent({ name: assignee.name, agentId: assignee.id, apiKey: runtimeHostKeyForAgent(assignee.id), port });
  await va.start();
  vagents.push(va);
  return { ws, assignee, va };
}

const CHAT_REPORT = {
  title: 'Artifact pipeline regression',
  tags: ['artifact', 'pipeline'],
  source_kind: 'chat',
  source_chat_room_id: 'room-r',
};

test('chat intake auto-links an equivalent report to its canonical ticket and records the audit trail', async () => {
  const ws = await createWorkspace(app, gdst, 'chat-dedupe-intake');
  const prerequisite = await createTicket(app, gdst, { workspaceId: ws.id, status: 'backlog', title: 'Prerequisite' });

  step('Create canonical A through REST');
  // backlog keeps dispatch out of this test — it is about intake linking.
  const canonical = await intake(ws.id, { ...CHAT_REPORT, status: 'backlog', related_ticket_id: prerequisite.id });
  assert.equal(canonical.canonical_ticket_id, null);
  assert.deepEqual(canonical.duplicate_candidates, []);

  step('Create equivalent B through REST; intake must persist the link before anything else');
  const duplicate = await intake(ws.id, {
    ...CHAT_REPORT, title: '[Bug] Artifact pipeline regression', status: 'backlog', related_ticket_id: prerequisite.id,
  });
  assert.equal(duplicate.canonical_ticket_id, canonical.id);
  assert.equal(duplicate.pending_user_action, false, 'a confident auto-link needs no human decision');
  assert.equal((await ticketRepo.findOneByOrFail({ id: duplicate.id })).canonical_ticket_id, canonical.id);
  assert.equal(await decisionRepo.count({
    where: { report_ticket_id: duplicate.id, candidate_ticket_id: canonical.id, outcome: 'auto_linked' },
  }), 1, 'REST intake must persist the auto-link audit decision');
  assert.equal(await commentRepo.count({ where: { ticket_id: duplicate.id, author: 'Duplicate intake' } }), 1);
  assert.equal(await commentRepo.count({ where: { ticket_id: canonical.id, author: 'Duplicate intake' } }), 1);

  step('Strong provenance plus normalized title auto-links; room-only match stays ambiguous');
  const strong = await duplicateService.assess(ws.id, {
    title: '[BUG] Artifact pipeline regression',
    source_kind: 'chat',
    source_chat_room_id: 'room-r',
    related_ticket_id: prerequisite.id,
  });
  assert.equal(strong.canonical_ticket_id, canonical.id);
  assert.equal(strong.ambiguous, false);
  const ambiguous = await duplicateService.assess(ws.id, {
    title: 'Possibly related but different symptom',
    source_kind: 'chat',
    source_chat_room_id: 'room-r',
  });
  assert.equal(ambiguous.canonical_ticket_id, null);
  assert.equal(ambiguous.ambiguous, true, 'medium-confidence matches must require confirmation');

  step('Conflicting non-empty provenance anchors can never auto-link');
  const conflictingRelated = await duplicateService.assess(ws.id, {
    title: '[BUG] Artifact pipeline regression',
    source_kind: 'chat',
    source_chat_room_id: 'room-r',
    related_ticket_id: duplicate.id,
  });
  assert.equal(conflictingRelated.canonical_ticket_id, null);
  assert.ok(conflictingRelated.candidates.find(c => c.ticket_id === canonical.id)?.matched_signals.includes('conflicting_related_ticket'));
  const conflictingRoom = await duplicateService.assess(ws.id, {
    title: '[BUG] Artifact pipeline regression',
    source_kind: 'chat',
    source_chat_room_id: 'different-room',
    related_ticket_id: prerequisite.id,
  });
  assert.equal(conflictingRoom.canonical_ticket_id, null);
  assert.ok(conflictingRoom.candidates.find(c => c.ticket_id === canonical.id)?.matched_signals.includes('conflicting_source_room'));

  step('Completing a prerequisite flips the linked duplicate\'s pending flag exactly once');
  await ticketRepo.update(duplicate.id, { pending_on_tickets: true });
  await prereqRepo.save(prereqRepo.create({
    ticket_id: duplicate.id, prerequisite_ticket_id: prerequisite.id, workspace_id: ws.id,
  }));
  await ticketRepo.update(prerequisite.id, { status: 'done', terminal_entered_at: new Date() });
  assert.deepEqual(await prerequisites.onPrerequisiteReached(prerequisite.id), [duplicate.id]);
  assert.equal((await ticketRepo.findOneByOrFail({ id: duplicate.id })).pending_on_tickets, false);
  assert.deepEqual(await prerequisites.onPrerequisiteReached(prerequisite.id), [],
    'repeating prerequisite completion remains idempotent');
});

// A confirmed duplicate is worked through its canonical ticket: the queue
// never starts it and dispatch() refuses it ('duplicate').
test('a linked duplicate is never dispatched on its own', async () => {
  const { ws, assignee, va } = await scene('chat-dedupe-dispatch');

  step('Canonical A is a normal ticket: it starts once');
  const canonical = await intake(ws.id, { ...CHAT_REPORT, assignee: assignee.runtime_spec });
  const start = await va.waitForTrigger((tr) => tr.ticket_id === canonical.id, 5000);
  assert.equal(start.trigger_source, 'start');

  step('Duplicate B is queued like work but must stay quiet');
  const duplicate = await intake(ws.id, { ...CHAT_REPORT, title: '[Bug] Artifact pipeline regression', assignee: assignee.runtime_spec });
  assert.equal(duplicate.canonical_ticket_id, canonical.id);
  await settle();
  assert.equal(va.triggersFor(duplicate.id).length, 0, 'duplicate create must not emit an independent trigger');
  assert.equal((await ticketRepo.findOneByOrFail({ id: duplicate.id })).status, 'todo',
    'the queue must not start a linked duplicate');

  step('Prerequisite completion / an explicit re-wake must not dispatch it either');
  await ticketRepo.update(duplicate.id, { status: 'in_progress' });
  const resumed = await dispatcher.resumeTicket(duplicate.id, 'prerequisite_resolved');
  assert.equal(resumed.dispatched, false);
  await settle();
  assert.equal(va.triggersFor(duplicate.id).length, 0, 'duplicate must never wake an assignee');
});

// TicketDispatchService.onDone closes every open duplicate of a finished
// canonical ticket ('resolved_from_canonical'); the duplicates' own done hooks
// (next ticket, dependents) stay silent.
test('completing the canonical ticket resolves its duplicates exactly once without their done hooks', async () => {
  const ws = await createWorkspace(app, gdst, 'chat-dedupe-resolve');
  const nextTicket = await createTicket(app, gdst, { workspaceId: ws.id, status: 'backlog', title: 'Must not wake after duplicate resolution' });
  const canonical = await intake(ws.id, { ...CHAT_REPORT, status: 'backlog' });
  const duplicate = await intake(ws.id, {
    ...CHAT_REPORT, title: '[Bug] Artifact pipeline regression', status: 'backlog', next_ticket_id: nextTicket.id,
  });
  assert.equal(duplicate.canonical_ticket_id, canonical.id);

  await ticketService.move(canonical.id, 'done', SYSTEM_ACTOR);
  await settle(500);
  const resolved = await ticketRepo.findOneByOrFail({ id: duplicate.id });
  assert.equal(resolved.status, 'done', 'canonical completion resolves the duplicate');
  assert.ok(resolved.terminal_entered_at);
  assert.equal(await decisionRepo.count({
    where: { report_ticket_id: duplicate.id, outcome: 'resolved_from_canonical' },
  }), 1, 'canonical completion resolves the duplicate exactly once');

  step('Re-entering done does not resolve it twice');
  await ticketService.move(canonical.id, 'review', SYSTEM_ACTOR);
  await ticketService.move(canonical.id, 'done', SYSTEM_ACTOR);
  await settle(500);
  assert.equal(await decisionRepo.count({
    where: { report_ticket_id: duplicate.id, outcome: 'resolved_from_canonical' },
  }), 1);
  assert.equal((await ticketRepo.findOneByOrFail({ id: nextTicket.id })).status, 'backlog',
    'a resolved duplicate\'s next_ticket must stay silent');
});

test('ambiguous decisions only link offered candidates, pending projection is cause-exact, keep-independent dispatches once', async () => {
  const { ws, assignee, va } = await scene('chat-dedupe-decisions');
  // Two chat roots in the same room with unrelated titles — a report from that
  // room matches both at medium confidence.
  const rootOne = await intake(ws.id, { title: 'Upload button broken', source_kind: 'chat', source_chat_room_id: 'room-r', status: 'backlog' });
  const rootTwo = await intake(ws.id, { title: 'Login page slow', source_kind: 'chat', source_chat_room_id: 'room-r', status: 'backlog' });
  const unrelated = await createTicket(app, gdst, { workspaceId: ws.id, status: 'backlog', title: 'Not a candidate' });

  step('Ambiguous decisions only link offered candidates');
  const linkAssessment = await duplicateService.assess(ws.id, {
    title: 'Different symptom one', source_kind: 'chat', source_chat_room_id: 'room-r',
  });
  assert.ok(linkAssessment.candidates.length >= 2, 'ambiguous report must expose multiple medium-confidence roots');
  assert.equal(linkAssessment.ambiguous, true);
  const ambiguousLink = await createTicket(app, gdst, {
    workspaceId: ws.id, status: 'in_progress', title: 'Different symptom one', assignee,
  });
  await ticketRepo.update(ambiguousLink.id, {
    source_kind: 'chat', source_chat_room_id: 'room-r', pending_user_action: true,
    pending_set_by: 'duplicate_decision_guard',
  });
  await duplicateService.record(await ticketRepo.findOneByOrFail({ id: ambiguousLink.id }), linkAssessment, 'qa', 'qa');
  const reopened = await rest('GET', `/tickets/${ambiguousLink.id}`, ws.id);
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.duplicate_decision_pending, true,
    '실제 duplicate pending은 원인 플래그를 명시해야 한다');
  assert.ok(reopened.body.duplicate_candidates.length >= 2,
    'reopened ticket reads must project every persisted ambiguous candidate');
  await assert.rejects(
    duplicateService.confirm(ambiguousLink.id, unrelated.id, 'qa', 'qa'),
    /not offered/,
    'shared confirmation mutation must reject arbitrary workspace tickets',
  );
  const linked = await duplicateService.confirm(ambiguousLink.id, rootOne.id, 'qa', 'qa');
  assert.equal(linked.canonical_ticket_id, rootOne.id);
  assert.equal(linked.pending_user_action, false);
  assert.equal(await decisionRepo.count({ where: { report_ticket_id: ambiguousLink.id, outcome: 'ambiguous_pending' } }), 0,
    'confirming closes every ambiguous candidate row');

  step('Seed a second ambiguous report to keep independent');
  const keepAssessment = await duplicateService.assess(ws.id, {
    title: 'Different symptom two', source_kind: 'chat', source_chat_room_id: 'room-r',
  });
  assert.ok(keepAssessment.candidates.some(c => c.ticket_id === rootTwo.id));
  const independent = await createTicket(app, gdst, {
    workspaceId: ws.id, status: 'in_progress', title: 'Different symptom two', assignee,
  });
  await ticketRepo.update(independent.id, {
    source_kind: 'chat', source_chat_room_id: 'room-r', pending_user_action: true,
    pending_set_by: 'duplicate_decision_guard',
  });
  await duplicateService.record(await ticketRepo.findOneByOrFail({ id: independent.id }), keepAssessment, 'qa', 'qa');

  const projection = async () => (await rest('GET', `/tickets/${independent.id}`, ws.id)).body;

  step('stale ambiguous 행은 supervisor pending 원인을 덮어쓸 수 없다');
  await ticketRepo.update(independent.id, {
    pending_user_action: true,
    pending_reason: 'The assignee stopped 3 times without finishing or reporting progress.',
    pending_set_by: 'AWB',
  });
  const supervisorParked = await projection();
  assert.equal(supervisorParked.duplicate_decision_pending, false,
    'stale ambiguous 행이 있어도 supervisor pending은 duplicate 결정 상태가 아니다');
  assert.deepEqual(supervisorParked.duplicate_candidates, [],
    'stale ambiguous 후보를 다른 원인의 pending UI에 투영하면 안 된다');
  await assert.rejects(
    duplicateService.confirm(independent.id, null, 'qa', 'qa'),
    /no duplicate decision pending/,
    'duplicate confirm이 다른 원인의 pending을 해제하면 안 된다',
  );
  const stillParked = await ticketRepo.findOneByOrFail({ id: independent.id });
  assert.equal(stillParked.pending_user_action, true);
  assert.equal(stillParked.pending_set_by, 'AWB');

  step('레거시 생성자명이 저장된 duplicate pending도 조회하고 결정할 수 있다');
  await ticketRepo.update(independent.id, {
    pending_reason: 'Confirm whether this chat report duplicates one of the suggested tickets.',
    pending_set_by: 'Outreach',
  });
  const legacy = await projection();
  assert.equal(legacy.duplicate_decision_pending, true,
    'ambiguous 후보가 남은 레거시 생성자명 pending은 duplicate 결정 상태다');
  assert.ok(legacy.duplicate_candidates.length > 0,
    '레거시 duplicate pending도 후보를 다시 노출해야 한다');

  step('stale 후보와 생성자명이 있어도 일반 사용자 Pending은 duplicate가 아니다');
  await ticketRepo.update(independent.id, {
    pending_reason: '배포 결과를 확인해 주세요.',
    pending_set_by: 'Release Operator',
  });
  const userPending = await projection();
  assert.equal(userPending.duplicate_decision_pending, false,
    '레거시 안내가 아닌 임의 Pending은 stale 후보만으로 duplicate가 되면 안 된다');
  assert.deepEqual(userPending.duplicate_candidates, []);
  await assert.rejects(
    duplicateService.confirm(independent.id, null, 'qa', 'qa'),
    /no duplicate decision pending/,
    'duplicate confirm이 일반 사용자 Pending을 해제하면 안 된다',
  );
  const stillUserPending = await ticketRepo.findOneByOrFail({ id: independent.id });
  assert.equal(stillUserPending.pending_user_action, true);
  assert.equal(stillUserPending.pending_set_by, 'Release Operator');

  step('Explicit keep-independent (REST) emits exactly one normal dispatch');
  await ticketRepo.update(independent.id, {
    pending_reason: 'Confirm whether this chat report duplicates one of the suggested tickets.',
    pending_set_by: 'Outreach',
  });
  const kept = await rest('POST', `/tickets/${independent.id}/duplicate-decision`, ws.id, { action: 'keep_independent' });
  assert.ok(kept.status === 200 || kept.status === 201, JSON.stringify(kept.body));
  assert.equal(kept.body.canonical_ticket_id, null);
  assert.equal(kept.body.pending_user_action, false);
  const wake = await va.waitForTrigger((tr) => tr.ticket_id === independent.id, 5000);
  assert.equal(wake.trigger_source, 'duplicate_rejected');
  await settle();
  assert.equal(va.triggersFor(independent.id).length, 1, 'keep-independent wakes the assignee exactly once');

  step('결정 뒤 다른 pending 원인이 생겨도 duplicate 원인으로 분류하면 안 된다');
  await ticketRepo.update(independent.id, {
    pending_user_action: true,
    pending_reason: 'The assignee stopped 3 times without finishing or reporting progress.',
    pending_set_by: 'AWB',
  });
  const afterDecision = await projection();
  assert.equal(afterDecision.duplicate_decision_pending, false);
  assert.deepEqual(afterDecision.duplicate_candidates, [],
    'Keep independent는 과거 ambiguous 후보를 종료해야 한다');
});

test.after(() => exitAfterTests(0));
