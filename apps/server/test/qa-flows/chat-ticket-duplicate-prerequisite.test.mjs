import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { setupKanbanScene, createAgent, createApiKey, createTicket, createUser } from '../helpers/fixtures.mjs';
import { VirtualAgent } from '../helpers/virtual-agent.mjs';

process.env.PORT = process.env.QA_CHAT_DUPLICATE_PORT || '7861';

test('prerequisite completion cannot redispatch a linked chat duplicate', async (t) => {
  const { app, port, modules } = await bootApp({ port: Number(process.env.PORT) });
  t.after(() => { void app.close().catch(() => {}); });
  const ds = app.get(modules.getDataSourceToken());
  const dist = path.resolve('dist/modules');
  const { TriggerLoopService } = await import(pathToFileURL(path.join(dist, 'agents/trigger-loop.service.js')));
  const { TicketPrerequisitesService } = await import(pathToFileURL(path.join(dist, 'tickets/ticket-prerequisites.service.js')));
  const { TicketDuplicateService } = await import(pathToFileURL(path.join(dist, 'tickets/ticket-duplicate.service.js')));
  const triggerLoop = app.get(TriggerLoopService);
  const prerequisites = app.get(TicketPrerequisitesService);
  const duplicateService = app.get(TicketDuplicateService);

  step('Seed prerequisite C and lifecycle sentinels');
  const { ws, columns } = await setupKanbanScene(app, modules.getDataSourceToken, { workspaceName: 'chat-dedupe-prereq' });
  const assignee = await createAgent(app, modules.getDataSourceToken, ws.id, { name: 'duplicate-assignee' });
  const key = await createApiKey(app, modules.getDataSourceToken, assignee.id, { workspaceId: ws.id });
  const operator = await createUser(app, modules.getDataSourceToken, { name: 'duplicate-intake-operator' });
  const userToken = app.get(modules.AuthService).createSession(operator.id);
  const prerequisite = await createTicket(app, modules.getDataSourceToken, {
    columnId: columns.inProgress.id, workspaceId: ws.id, title: 'Prerequisite', assigneeId: assignee.id,
  });
  const nextTicket = await createTicket(app, modules.getDataSourceToken, {
    columnId: columns.inProgress.id, workspaceId: ws.id, title: 'Must not wake after duplicate resolution', assigneeId: assignee.id,
  });
  const dependent = await createTicket(app, modules.getDataSourceToken, {
    columnId: columns.inProgress.id, workspaceId: ws.id, title: 'Must not resume from duplicate resolution', assigneeId: assignee.id,
  });
  const ticketRepo = ds.getRepository('Ticket');
  const va = new VirtualAgent({ name: assignee.name, agentId: assignee.id, apiKey: key.raw_key, port });
  await va.start();
  t.after(() => va.stop());
  const createRestTicket = async (body) => {
    const response = await fetch(`http://localhost:${port}/api/columns/${columns.inProgress.id}/tickets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userToken}`,
        'X-Workspace-Id': ws.id,
      },
      body: JSON.stringify({ assignee_id: assignee.id, ...body }),
    });
    if (response.status !== 201) {
      assert.fail(`REST ticket intake failed (${response.status}): ${await response.text()}`);
    }
    return response.json();
  };
  const consumeCreatedActivity = async (ticketId) => {
    const activity = await ds.getRepository('ActivityLog').findOne({
      where: { ticket_id: ticketId, entity_type: 'ticket', action: 'created' },
      order: { created_at: 'DESC' },
    });
    assert.ok(activity, 'real intake must persist a created activity');
    return triggerLoop.dispatchCurrentColumn(ticketId, 'ticket_created', activity.actor_id || 'qa');
  };

  step('Create canonical A through REST and observe exactly one initial assignee trigger');
  const canonical = await createRestTicket({
    title: 'Artifact pipeline regression',
    labels: ['artifact', 'pipeline'],
    source_kind: 'chat',
    source_chat_room_id: 'room-r',
    related_ticket_id: prerequisite.id,
  });
  assert.deepEqual(await consumeCreatedActivity(canonical.id), { emitted: 1 });

  step('Create equivalent B through REST; intake must persist and suppress it before dispatch');
  const duplicate = await createRestTicket({
    title: '[Bug] Artifact pipeline regression',
    labels: ['artifact', 'pipeline'],
    source_kind: 'chat',
    source_chat_room_id: 'room-r',
    related_ticket_id: prerequisite.id,
    next_ticket_id: nextTicket.id,
  });
  assert.equal(duplicate.canonical_ticket_id, canonical.id);
  assert.equal(duplicate.pending_user_action, false);
  const persistedDuplicate = await ticketRepo.findOne({ where: { id: duplicate.id } });
  assert.equal(persistedDuplicate.canonical_ticket_id, canonical.id);
  const decisionRepo = ds.getRepository('TicketDuplicateDecision');
  assert.equal(await decisionRepo.count({
    where: { report_ticket_id: duplicate.id, candidate_ticket_id: canonical.id, outcome: 'auto_linked' },
  }), 1, 'REST intake must persist the auto-link audit decision');
  const commentRepo = ds.getRepository('Comment');
  assert.equal(await commentRepo.count({ where: { ticket_id: duplicate.id, author: 'Duplicate intake' } }), 1);
  assert.equal(await commentRepo.count({ where: { ticket_id: canonical.id, author: 'Duplicate intake' } }), 1);
  assert.deepEqual(await consumeCreatedActivity(duplicate.id), { emitted: 0 });
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(va.triggersFor(duplicate.id).length, 0, 'duplicate create activity must not emit an independent trigger');

  await ticketRepo.update(duplicate.id, { pending_on_tickets: true });
  const prereqRepo = ds.getRepository('TicketPrerequisite');
  await prereqRepo.save(prereqRepo.create({
    ticket_id: duplicate.id,
    prerequisite_ticket_id: prerequisite.id,
    workspace_id: ws.id,
  }));
  await prereqRepo.save(prereqRepo.create({
    ticket_id: dependent.id,
    prerequisite_ticket_id: duplicate.id,
    workspace_id: ws.id,
  }));

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

  step('The root dispatch gate suppresses the duplicate before prerequisite completion');
  assert.deepEqual(await triggerLoop.dispatchCurrentColumn(duplicate.id, 'ticket_created', 'qa'), { emitted: 0 });

  step('Complete C and exercise the real prerequisite auto-resume callback');
  await ticketRepo.update(prerequisite.id, { column_id: columns.done.id, terminal_entered_at: new Date() });
  const unblocked = await prerequisites.onPrerequisiteReached(prerequisite.id);
  assert.deepEqual(unblocked, [duplicate.id]);
  const after = await ticketRepo.findOne({ where: { id: duplicate.id } });
  assert.equal(after.pending_on_tickets, false);
  assert.deepEqual(await triggerLoop.dispatchCurrentColumn(duplicate.id, 'prerequisite_resolved', 'qa'), { emitted: 0 });
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(va.triggersFor(duplicate.id).length, 0, 'duplicate must never wake an assignee or reviewer');

  step('Repeating prerequisite completion remains idempotent and silent');
  assert.deepEqual(await prerequisites.onPrerequisiteReached(prerequisite.id), []);
  assert.deepEqual(await triggerLoop.dispatchCurrentColumn(duplicate.id, 'prerequisite_resolved', 'qa'), { emitted: 0 });
  assert.equal(va.triggersFor(duplicate.id).length, 0);

  step('Complete canonical A; B resolves exactly once without duplicate terminal hooks');
  const terminalCalls = { next: [], dependents: [], review: [] };
  const originalNext = triggerLoop._dispatchNextTicket.bind(triggerLoop);
  const originalDependents = triggerLoop._resumePrerequisiteDependents.bind(triggerLoop);
  const originalReview = triggerLoop._dispatchPostDoneReview.bind(triggerLoop);
  triggerLoop._dispatchNextTicket = async (ticket, ...args) => {
    terminalCalls.next.push(ticket.id);
    return originalNext(ticket, ...args);
  };
  triggerLoop._resumePrerequisiteDependents = async (ticketId, ...args) => {
    terminalCalls.dependents.push(ticketId);
    return originalDependents(ticketId, ...args);
  };
  triggerLoop._dispatchPostDoneReview = async (ticket, ...args) => {
    terminalCalls.review.push(ticket.id);
    return originalReview(ticket, ...args);
  };
  await ticketRepo.update(canonical.id, {
    column_id: columns.done.id,
    status: 'done',
    terminal_entered_at: new Date(),
  });
  const completedCanonical = await ticketRepo.findOne({ where: { id: canonical.id } });
  await triggerLoop._resolveCanonicalDuplicates(completedCanonical, columns.done, 'qa');
  await triggerLoop._resolveCanonicalDuplicates(completedCanonical, columns.done, 'qa');
  const resolved = await ticketRepo.findOne({ where: { id: duplicate.id } });
  assert.equal(resolved.column_id, columns.done.id);
  assert.equal(await decisionRepo.count({
    where: { report_ticket_id: duplicate.id, outcome: 'resolved_from_canonical' },
  }), 1, 'canonical completion resolves the duplicate exactly once');
  await triggerLoop._handleActivity({
    ticket_id: duplicate.id,
    entity_type: 'ticket',
    entity_id: duplicate.id,
    action: 'moved',
    actor_id: 'qa-replayed-actor',
    field_changed: 'resolved_from_canonical',
  });
  assert.ok(!terminalCalls.next.includes(duplicate.id), 'duplicate next_ticket must stay silent');
  assert.ok(!terminalCalls.dependents.includes(duplicate.id), 'duplicate prerequisite dependents must stay silent');
  assert.ok(!terminalCalls.review.includes(duplicate.id), 'duplicate reviewer/on-done/QA path must stay silent');
  assert.equal(va.triggersFor(nextTicket.id).length, 0);
  assert.equal(va.triggersFor(dependent.id).length, 0);

  step('Ambiguous decisions only link offered candidates; explicit link remains silent');
  await ticketRepo.update(nextTicket.id, {
    source_kind: 'chat', source_chat_room_id: 'room-r',
  });
  const linkAssessment = await duplicateService.assess(ws.id, {
    title: 'Different symptom one', source_kind: 'chat', source_chat_room_id: 'room-r',
  });
  assert.ok(linkAssessment.candidates.length >= 2, 'ambiguous report must expose multiple medium-confidence roots');
  const ambiguousLink = await createTicket(app, modules.getDataSourceToken, {
    columnId: columns.inProgress.id, workspaceId: ws.id, title: 'Different symptom one', assigneeId: assignee.id,
  });
  await ticketRepo.update(ambiguousLink.id, {
    source_kind: 'chat', source_chat_room_id: 'room-r', pending_user_action: true,
    pending_set_by: 'duplicate_decision_guard',
  });
  const linkReport = await ticketRepo.findOne({ where: { id: ambiguousLink.id } });
  await duplicateService.record(linkReport, linkAssessment, 'qa', 'qa');
  const reopenedResponse = await fetch(`http://localhost:${port}/api/tickets/${ambiguousLink.id}`, {
    headers: { Authorization: `Bearer ${userToken}`, 'X-Workspace-Id': ws.id },
  });
  assert.equal(reopenedResponse.status, 200);
  const reopenedReport = await reopenedResponse.json();
  assert.equal(reopenedReport.duplicate_decision_pending, true,
    '실제 duplicate pending은 원인 플래그를 명시해야 한다');
  assert.ok(reopenedReport.duplicate_candidates.length >= 2,
    'reopened ticket reads must project every persisted ambiguous candidate');
  await assert.rejects(
    duplicateService.confirm(ambiguousLink.id, dependent.id, 'qa', 'qa'),
    /not offered/,
    'shared confirmation mutation must reject arbitrary workspace tickets',
  );
  const linked = await duplicateService.confirm(ambiguousLink.id, canonical.id, 'qa', 'qa');
  assert.equal(linked.canonical_ticket_id, canonical.id);
  assert.deepEqual(await triggerLoop.dispatchCurrentColumn(linked.id, 'duplicate_confirmed', 'qa'), { emitted: 0 });
  assert.equal(va.triggersFor(linked.id).length, 0);

  step('Explicit keep-independent emits exactly one normal dispatch');
  const keepAssessment = await duplicateService.assess(ws.id, {
    title: 'Different symptom two', source_kind: 'chat', source_chat_room_id: 'room-r',
  });
  const independent = await createTicket(app, modules.getDataSourceToken, {
    columnId: columns.inProgress.id, workspaceId: ws.id, title: 'Different symptom two', assigneeId: assignee.id,
  });
  await ticketRepo.update(independent.id, {
    source_kind: 'chat', source_chat_room_id: 'room-r', pending_user_action: true,
    pending_set_by: 'duplicate_decision_guard',
  });
  const keepReport = await ticketRepo.findOne({ where: { id: independent.id } });
  await duplicateService.record(keepReport, keepAssessment, 'qa', 'qa');

  step('stale ambiguous 행은 hard-budget pending 원인을 덮어쓸 수 없다');
  await ticketRepo.update(independent.id, {
    pending_user_action: true,
    pending_reason: '실제 dispatch 실행 횟수가 hard budget을 초과했습니다.',
    pending_set_by: 'hard_budget_dispatch_guard',
  });
  const staleHardBudgetResponse = await fetch(`http://localhost:${port}/api/tickets/${independent.id}`, {
    headers: { Authorization: `Bearer ${userToken}`, 'X-Workspace-Id': ws.id },
  });
  assert.equal(staleHardBudgetResponse.status, 200);
  const staleHardBudgetReport = await staleHardBudgetResponse.json();
  assert.equal(staleHardBudgetReport.duplicate_decision_pending, false,
    'stale ambiguous 행이 있어도 hard-budget pending은 duplicate 결정 상태가 아니다');
  assert.deepEqual(staleHardBudgetReport.duplicate_candidates, [],
    'stale ambiguous 후보를 hard-budget pending UI에 투영하면 안 된다');
  await assert.rejects(
    duplicateService.confirm(independent.id, null, 'qa', 'qa'),
    /no duplicate decision pending/,
    'duplicate confirm이 hard-budget pending을 해제하면 안 된다',
  );
  const stillHardBudgetPending = await ticketRepo.findOne({ where: { id: independent.id } });
  assert.equal(stillHardBudgetPending.pending_user_action, true);
  assert.equal(stillHardBudgetPending.pending_set_by, 'hard_budget_dispatch_guard');

  await ticketRepo.update(independent.id, {
    pending_reason: 'Confirm whether this chat report duplicates one of the suggested tickets.',
    pending_set_by: 'duplicate_decision_guard',
  });
  const kept = await duplicateService.confirm(independent.id, null, 'qa', 'qa');
  assert.equal(kept.canonical_ticket_id, null);
  await ticketRepo.update(independent.id, {
    pending_user_action: true,
    pending_reason: '실제 dispatch 실행 횟수가 hard budget을 초과했습니다.',
    pending_set_by: 'hard_budget_dispatch_guard',
  });
  const hardBudgetResponse = await fetch(`http://localhost:${port}/api/tickets/${independent.id}`, {
    headers: { Authorization: `Bearer ${userToken}`, 'X-Workspace-Id': ws.id },
  });
  assert.equal(hardBudgetResponse.status, 200);
  const hardBudgetReport = await hardBudgetResponse.json();
  assert.equal(hardBudgetReport.duplicate_decision_pending, false,
    '결정 뒤 다른 pending 원인이 생겨도 duplicate 원인으로 분류하면 안 된다');
  assert.deepEqual(hardBudgetReport.duplicate_candidates, [],
    'Keep independent는 과거 ambiguous 후보를 종료해야 한다');
  await ticketRepo.update(independent.id, {
    pending_user_action: false, pending_reason: '', pending_set_by: '', pending_set_at: null,
  });
  assert.deepEqual(await triggerLoop.dispatchCurrentColumn(kept.id, 'duplicate_rejected', 'qa'), { emitted: 1 });

  exitAfterTests(0);
});
