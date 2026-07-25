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
  });
  const prereqRepo = ds.getRepository('TicketPrerequisite');
  await prereqRepo.save(prereqRepo.create({
    ticket_id: duplicate.id,
    prerequisite_ticket_id: prerequisite.id,
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

  exitAfterTests(0);
});
