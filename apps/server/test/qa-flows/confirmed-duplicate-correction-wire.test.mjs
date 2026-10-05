// MCP correct_confirmed_ticket_duplicate end to end (docs/tickets.md).
//
// Clearing a false-positive canonical link is an audited data correction
// (TicketDuplicateService.correctConfirmedLink — unit-tested in
// confirmed-duplicate-correction.test.mjs). Waking the assignee afterwards is
// TicketDispatchService.resumeTicket's job: an in_progress ticket is re-sent
// once over the real SSE wire; any other state clears the link but wakes
// nobody, and the result says why. The canonical ticket is never modified.
//
// The old per-role / dispatch-intent / live-strand / reconciler-race cases went
// away with roles and the trigger loop — a ticket has one assignee and one
// dispatcher now.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests } from '../helpers/boot.mjs';
import { createAgent, createApiKey, createTicket, createAccount, runtimeHostKeyForAgent } from '../helpers/fixtures.mjs';
import { VirtualAgent } from '../helpers/virtual-agent.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

process.env.PORT = process.env.QA_DUPLICATE_CORRECTION_PORT || '0';

async function waitForNoWire() {
  await new Promise(resolve => setTimeout(resolve, 700));
}

test('MCP duplicate correction re-sends an in_progress ticket exactly once and preserves canonical', async (t) => {
  const { app, port, modules } = await bootApp({ port: Number(process.env.PORT) });
  t.after(() => { void app.close().catch(() => {}); });
  const gdst = modules.getDataSourceToken;
  const ds = app.get(gdst());
  const ticketRepo = ds.getRepository('Ticket');
  const ws = await createAccount(app, gdst, 'duplicate-correction-wire');
  // The wire trigger is delivered to the assignee's Runtime Host stream; the VA
  // connects with that host's key.
  const assignee = await createAgent(app, gdst, ws.id, { name: 'worker', runtime: true });
  const operator = await createAgent(app, gdst, ws.id, { name: 'operator', runtime: true });
  const operatorKey = await createApiKey(app, gdst, operator.id, { accountId: ws.id, label: 'operator' });
  const va = new VirtualAgent({ name: 'worker', agentId: assignee.id, apiKey: runtimeHostKeyForAgent(assignee.id), port });
  await va.start();
  t.after(async () => va.stop());
  const mcp = new McpClient({ baseUrl: `http://localhost:${port}`, apiKey: operatorKey.raw_key });
  t.after(async () => mcp.close());

  const canonical = await createTicket(app, gdst, {
    accountId: ws.id, status: 'done', title: 'unrelated done ticket',
  });
  const seedCorrection = async ({ title, status = 'in_progress', assignee: holder = assignee }) => {
    const ticket = await createTicket(app, gdst, { accountId: ws.id, status, title, assignee: holder });
    await ticketRepo.update(ticket.id, { canonical_ticket_id: canonical.id });
    return ticket;
  };

  const report = await seedCorrection({ title: 'independent operation' });
  const result = await mcp.callTool('correct_confirmed_ticket_duplicate', { ticket_id: report.id });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(result.previous_canonical_ticket_id, canonical.id);
  assert.equal(result.ticket.canonical_ticket_id, null);
  assert.equal(result.dispatched, true);
  assert.equal(result.dispatch_skipped_reason, '');
  const trigger = await va.waitForTrigger(tr => tr.ticket_id === report.id, 4000);
  assert.equal(trigger.role, 'assignee');
  assert.equal(trigger.trigger_source, 'duplicate_correction');
  await waitForNoWire();
  assert.equal(va.triggersFor(report.id).length, 1, 'the correction wakes the assignee exactly once');
  const emitted = await ds.getRepository('ActivityLog').find({
    where: { ticket_id: report.id, action: 'trigger_emitted' },
  });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].field_changed, trigger.trigger_id, 'the correlation row carries the wire trigger id');
  assert.equal(emitted[0].trigger_source, 'duplicate_correction');
  const untouched = await ticketRepo.findOneByOrFail({ id: canonical.id });
  assert.equal(untouched.title, 'unrelated done ticket');
  assert.equal(untouched.status, 'done');

  // A second correction of the same ticket is rejected and wakes nobody.
  const again = await mcp.callTool('correct_confirmed_ticket_duplicate', { ticket_id: report.id });
  assert.equal(again.isError, true);
  assert.match(JSON.stringify(again), /no confirmed canonical link/);
  await waitForNoWire();
  assert.equal(va.triggersFor(report.id).length, 1);

  // 재dispatch 불가 상태 — 예전에는 전부 throw 였다(ticket 83c5e25c). 링크
  // 해제는 상태와 무관하게 항상 수행되고 dispatch 만 건너뛴다. 해제를 거부하면
  // backlog 에 놓인 오링크를 영원히 못 고친다는 것이 그 결함의 핵심이었으므로,
  // 여기서는 "해제됐다 + 아무도 깨우지 않았다" 를 함께 본다.
  const assertUnlinkedWithoutDispatch = async (ticket, label, expectedReason) => {
    const before = va.triggers.length;
    const res = await mcp.callTool('correct_confirmed_ticket_duplicate', { ticket_id: ticket.id });
    assert.notEqual(res.isError, true, `${label} 은 해제까지는 성공해야 한다: ${JSON.stringify(res)}`);
    assert.equal(res.dispatched, false, `${label} 은 dispatch 하지 않는다`);
    assert.equal(res.dispatch_skipped_reason, expectedReason, `${label} 의 건너뜀 사유`);
    await waitForNoWire();
    assert.equal(va.triggers.length, before, `${label} 은 wire payload 를 내지 않는다`);
    assert.equal(
      (await ticketRepo.findOneByOrFail({ id: ticket.id })).canonical_ticket_id,
      null,
      `${label} 도 오링크는 해제된다`,
    );
    assert.equal(await ds.getRepository('ActivityLog').count({
      where: { ticket_id: ticket.id, action: 'trigger_emitted' },
    }), 0, `${label} 은 trigger 를 기록하지 않는다`);
  };
  await assertUnlinkedWithoutDispatch(
    await seedCorrection({ title: 'unassigned correction', assignee: null }),
    'unassigned ticket',
    'unassigned',
  );
  await assertUnlinkedWithoutDispatch(
    await seedCorrection({ title: 'done correction', status: 'done' }),
    'done ticket',
    'status_done',
  );
  await assertUnlinkedWithoutDispatch(
    await seedCorrection({ title: 'backlog correction', status: 'backlog' }),
    'backlog ticket',
    'status_backlog',
  );
  await assertUnlinkedWithoutDispatch(
    await seedCorrection({ title: 'review correction', status: 'review' }),
    'review ticket',
    'status_review',
  );
  // Every pending flag parks a ticket — pending_ci_wait included (the old gate
  // only looked at two of them and could open a ghost dispatch).
  const pendingCorrection = await seedCorrection({ title: 'pending correction' });
  await ticketRepo.update(pendingCorrection.id, { pending_ci_wait: true });
  await assertUnlinkedWithoutDispatch(pendingCorrection, 'pending ticket', 'pending');
  // A todo ticket goes back to the queue: the assignee is still busy with the
  // in_progress ticket above (capacity 1), so it waits instead of starting.
  await assertUnlinkedWithoutDispatch(
    await seedCorrection({ title: 'queued correction', status: 'todo' }),
    'queued todo ticket',
    'queued',
  );
});

exitAfterTests();
