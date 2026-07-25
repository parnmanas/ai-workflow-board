import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { setupKanbanScene, createAgent, createApiKey, createTicket } from '../helpers/fixtures.mjs';
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

  step('Seed canonical A, linked duplicate B, and prerequisite C');
  const { ws, columns } = await setupKanbanScene(app, modules.getDataSourceToken, { workspaceName: 'chat-dedupe-prereq' });
  const assignee = await createAgent(app, modules.getDataSourceToken, ws.id, { name: 'duplicate-assignee' });
  const key = await createApiKey(app, modules.getDataSourceToken, assignee.id, { workspaceId: ws.id });
  const canonical = await createTicket(app, modules.getDataSourceToken, {
    columnId: columns.inProgress.id, workspaceId: ws.id, title: 'Artifact pipeline regression', assigneeId: assignee.id,
  });
  const duplicate = await createTicket(app, modules.getDataSourceToken, {
    columnId: columns.inProgress.id, workspaceId: ws.id, title: '[Bug] Artifact pipeline regression', assigneeId: assignee.id,
  });
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
  await ticketRepo.update(canonical.id, {
    source_kind: 'chat', source_chat_room_id: 'room-r', related_ticket_id: prerequisite.id,
  });
  await ticketRepo.update(duplicate.id, {
    source_kind: 'chat',
    source_chat_room_id: 'room-r',
    related_ticket_id: prerequisite.id,
    canonical_ticket_id: canonical.id,
    pending_on_tickets: true,
    next_ticket_id: nextTicket.id,
  });
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

  const va = new VirtualAgent({ name: assignee.name, agentId: assignee.id, apiKey: key.raw_key, port });
  await va.start();
  t.after(() => va.stop());
  await new Promise(resolve => setTimeout(resolve, 200));

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
  const decisionRepo = ds.getRepository('TicketDuplicateDecision');
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
  });
  const linkReport = await ticketRepo.findOne({ where: { id: ambiguousLink.id } });
  await duplicateService.record(linkReport, linkAssessment, 'qa', 'qa');
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
  });
  const keepReport = await ticketRepo.findOne({ where: { id: independent.id } });
  await duplicateService.record(keepReport, keepAssessment, 'qa', 'qa');
  const kept = await duplicateService.confirm(independent.id, null, 'qa', 'qa');
  assert.equal(kept.canonical_ticket_id, null);
  assert.deepEqual(await triggerLoop.dispatchCurrentColumn(kept.id, 'duplicate_rejected', 'qa'), { emitted: 1 });

  exitAfterTests(0);
});
