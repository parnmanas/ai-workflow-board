import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests } from '../helpers/boot.mjs';
import { setupKanbanScene, createAgent, createApiKey, createTicket } from '../helpers/fixtures.mjs';
import { VirtualAgent } from '../helpers/virtual-agent.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.PORT = process.env.QA_DUPLICATE_CORRECTION_PORT || '7854';
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');

async function waitForNoWire() {
  await new Promise(resolve => setTimeout(resolve, 700));
}

test('MCP duplicate correction emits exactly one selected-role wire trigger and preserves canonical', async (t) => {
  const { app, port, modules } = await bootApp({ port: Number(process.env.PORT) });
  t.after(() => { void app.close().catch(() => {}); });
  const ds = app.get(modules.getDataSourceToken());
  const { ws, columns } = await setupKanbanScene(app, modules.getDataSourceToken, {
    workspaceName: 'duplicate-correction-wire', envRepo: true, maxConcurrent: 5,
  });
  const assignee = await createAgent(app, modules.getDataSourceToken, ws.id, { name: 'worker' });
  const assigneeKey = await createApiKey(app, modules.getDataSourceToken, assignee.id, { workspaceId: ws.id });
  const operator = await createAgent(app, modules.getDataSourceToken, ws.id, { name: 'operator' });
  const operatorKey = await createApiKey(app, modules.getDataSourceToken, operator.id, { workspaceId: ws.id });
  const reviewer = await createAgent(app, modules.getDataSourceToken, ws.id, { name: 'reviewer' });
  const reviewerKey = await createApiKey(app, modules.getDataSourceToken, reviewer.id, { workspaceId: ws.id });
  const va = new VirtualAgent({ name: 'worker', agentId: assignee.id, apiKey: assigneeKey.raw_key, port });
  const reviewerVa = new VirtualAgent({ name: 'reviewer', agentId: reviewer.id, apiKey: reviewerKey.raw_key, port });
  await va.start();
  await reviewerVa.start();
  t.after(async () => va.stop());
  t.after(async () => reviewerVa.stop());
  const mcp = new McpClient({ baseUrl: `http://localhost:${port}`, apiKey: operatorKey.raw_key });
  t.after(async () => mcp.close());

  const canonical = await createTicket(app, modules.getDataSourceToken, {
    columnId: columns.done.id, workspaceId: ws.id, title: 'unrelated done ticket',
  });
  const report = await createTicket(app, modules.getDataSourceToken, {
    columnId: columns.inProgress.id, workspaceId: ws.id, title: 'independent operation', assigneeId: assignee.id,
  });
  await ds.getRepository('Ticket').update(report.id, { canonical_ticket_id: canonical.id });
  await ds.getRepository('DispatchIntent').save({
    workspace_id: ws.id, board_id: columns.inProgress.board_id, ticket_id: report.id,
    role: 'assignee', agent_id: assignee.id, trigger_source: 'old', status: 'in_flight',
    attempts: 209, dispatch_generation: 209, next_attempt_at: new Date(),
  });

  const result = await mcp.callTool('correct_confirmed_ticket_duplicate', {
    ticket_id: report.id, role: 'assignee',
  });
  assert.equal(result.dispatch_attempted, 1);
  assert.equal(result.dispatch_landed, 1);
  assert.equal(result.dispatch_trigger_ids.length, 1);
  const trigger = await va.waitForTrigger(tr => tr.ticket_id === report.id, 4000);
  assert.equal(trigger.role, 'assignee');
  assert.equal(va.triggers.filter(tr => tr.ticket_id === report.id).length, 1);
  const intent = await ds.getRepository('DispatchIntent').findOneByOrFail({
    ticket_id: report.id, role: 'assignee', status: 'in_flight',
  });
  assert.equal(intent.last_trigger_id, trigger.trigger_id);
  assert.equal(intent.dispatch_generation, 1);
  assert.equal(result.dispatch_generation, 1);
  const { DispatchIntentService } = await import(
    'file://' + path.join(DIST, 'modules', 'agents', 'dispatch-intent.service.js')
  );
  const ack = await app.get(DispatchIntentService).applyManagerAck({
    ticketId: report.id, role: 'assignee', triggerId: trigger.trigger_id, outcome: 'processed',
  });
  assert.equal(ack.matched, true);
  assert.equal(ack.applied, true);
  assert.equal((await ds.getRepository('DispatchIntent').findOneByOrFail({ id: intent.id })).last_ack_kind, 'processed');
  assert.equal((await ds.getRepository('Ticket').findOneByOrFail({ id: canonical.id })).title, 'unrelated done ticket');
  assert.equal((await ds.getRepository('Ticket').findOneByOrFail({ id: canonical.id })).column_id, columns.done.id);

  const seedCorrection = async ({ title, columnId = columns.inProgress.id, assigneeId = assignee.id, reviewerId = '' }) => {
    const ticket = await createTicket(app, modules.getDataSourceToken, {
      columnId, workspaceId: ws.id, title, assigneeId, reviewerId,
    });
    await ds.getRepository('Ticket').update(ticket.id, { canonical_ticket_id: canonical.id });
    await ds.getRepository('DispatchIntent').save({
      workspace_id: ws.id, board_id: columns.inProgress.board_id, ticket_id: ticket.id,
      role: 'assignee', agent_id: assigneeId, trigger_source: 'old', status: 'in_flight',
      attempts: 209, dispatch_generation: 209, next_attempt_at: new Date(),
    });
    return ticket;
  };

  const { TriggerLoopService } = await import(
    'file://' + path.join(DIST, 'modules', 'agents', 'trigger-loop.service.js')
  );
  const triggerLoop = app.get(TriggerLoopService);
  const live = await seedCorrection({ title: 'live strand correction' });
  await triggerLoop.agentStatus.setCurrentTask(assignee.id, live.id, 'assignee', 'live-correction');
  const beforeLiveTriggers = va.triggers.length;
  const liveResult = await mcp.callTool('correct_confirmed_ticket_duplicate', { ticket_id: live.id, role: 'assignee' });
  await waitForNoWire();
  assert.equal(liveResult.dispatch_attempted, 1);
  assert.equal(liveResult.dispatch_landed, 0);
  assert.equal(va.triggers.length, beforeLiveTriggers, 'live strand must suppress the wire payload');
  const liveIntents = await ds.getRepository('DispatchIntent').find({
    where: { ticket_id: live.id, role: 'assignee' },
  });
  const liveOpenIntents = liveIntents.filter(row => ['pending', 'in_flight'].includes(row.status));
  assert.equal(liveOpenIntents.length, 1, 'live strand keeps exactly one fresh open intent');
  assert.equal(liveOpenIntents[0].dispatch_generation, 1);
  triggerLoop.agentStatus.clearCurrentTask(assignee.id, live.id, 'live-correction');

  const assertRejectedWithoutMutation = async (ticket, label) => {
    const before = va.triggers.length;
    const result = await mcp.callTool('correct_confirmed_ticket_duplicate', { ticket_id: ticket.id, role: 'assignee' });
    assert.equal(result.isError, true, `${label} must fail closed`);
    await waitForNoWire();
    assert.equal(va.triggers.length, before, `${label} must not emit a wire payload`);
    assert.equal((await ds.getRepository('Ticket').findOneByOrFail({ id: ticket.id })).canonical_ticket_id, canonical.id);
    const intents = await ds.getRepository('DispatchIntent').find({ where: { ticket_id: ticket.id } });
    assert.equal(intents.length, 1, `${label} must not create an intent`);
    assert.equal(intents[0].status, 'in_flight', `${label} must leave the stale intent untouched`);
    assert.equal(intents[0].dispatch_generation, 209, `${label} must leave its generation untouched`);
  };
  await assertRejectedWithoutMutation(
    await seedCorrection({ title: 'unassigned correction', assigneeId: '' }),
    'unassigned ticket',
  );
  await assertRejectedWithoutMutation(
    await seedCorrection({ title: 'terminal correction', columnId: columns.done.id }),
    'terminal column',
  );
  await assertRejectedWithoutMutation(
    await seedCorrection({ title: 'non-routed correction', columnId: columns.todo.id }),
    'non-routed column',
  );

  await ds.getRepository('BoardColumn').update(columns.inProgress.id, {
    role_routing: JSON.stringify(['assignee', 'reviewer']),
  });
  const multiRouted = await seedCorrection({
    title: 'selected role correction', reviewerId: reviewer.id,
  });
  const beforeReviewerTriggers = reviewerVa.triggers.length;
  const selectedResult = await mcp.callTool('correct_confirmed_ticket_duplicate', {
    ticket_id: multiRouted.id, role: 'assignee',
  });
  assert.equal(selectedResult.dispatch_landed, 1);
  await va.waitForTrigger(tr => tr.ticket_id === multiRouted.id, 4000);
  await waitForNoWire();
  assert.equal(reviewerVa.triggers.length, beforeReviewerTriggers, 'non-selected routed role must not emit');
  assert.equal(await ds.getRepository('DispatchIntent').count({
    where: { ticket_id: multiRouted.id, role: 'reviewer' },
  }), 0, 'non-selected routed role must not open an intent');

  // Deterministic MCP-vs-reconciler race: stop the direct path after the
  // correction transaction committed its claimed intent but before wire emit,
  // then sweep at a time where retry is due but the first-owner lease is live.
  const racing = await seedCorrection({ title: 'atomic first-dispatch ownership' });
  const originalEmit = triggerLoop.emitAgentTrigger.bind(triggerLoop);
  let releaseEmit;
  const emitBarrier = new Promise(resolve => { releaseEmit = resolve; });
  let reachedBarrier;
  const barrierReached = new Promise(resolve => { reachedBarrier = resolve; });
  triggerLoop.emitAgentTrigger = async (...args) => {
    if (args[0]?.id === racing.id) {
      reachedBarrier();
      await emitBarrier;
    }
    return originalEmit(...args);
  };
  const racingCall = mcp.callTool('correct_confirmed_ticket_duplicate', {
    ticket_id: racing.id, role: 'assignee',
  });
  await barrierReached;
  const claimed = await ds.getRepository('DispatchIntent').findOneByOrFail({
    ticket_id: racing.id, role: 'assignee', status: 'in_flight',
  });
  assert.equal(claimed.dispatch_generation, 1);
  assert.match(claimed.lease_owner, /^duplicate-correction:/);
  const { DispatchReconcilerService } = await import(
    'file://' + path.join(DIST, 'modules', 'agents', 'dispatch-reconciler.service.js')
  );
  const reconciler = app.get(DispatchReconcilerService);
  await reconciler.reconcile(new Date(new Date(claimed.next_attempt_at).getTime() + 1));
  releaseEmit();
  const racingResult = await racingCall;
  triggerLoop.emitAgentTrigger = originalEmit;
  const racingTrigger = await va.waitForTrigger(tr => tr.ticket_id === racing.id, 4000);
  assert.equal(va.triggers.filter(tr => tr.ticket_id === racing.id).length, 1);
  assert.equal(racingResult.dispatch_generation, 1);
  assert.deepEqual(racingResult.dispatch_trigger_ids, [racingTrigger.trigger_id]);
  const racedIntent = await ds.getRepository('DispatchIntent').findOneByOrFail({ id: claimed.id });
  assert.equal(racedIntent.dispatch_generation, 1);
  assert.equal(racedIntent.last_trigger_id, racingTrigger.trigger_id);
  const racedAck = await app.get(DispatchIntentService).applyManagerAck({
    ticketId: racing.id, role: 'assignee', triggerId: racingTrigger.trigger_id, outcome: 'processed',
  });
  assert.equal(racedAck.matched, true);
  assert.equal(racedAck.applied, true);
});

exitAfterTests();
