// Regression test — ticket 35b43ee9.
//
// A follow-up/correction ticket (related_ticket_id set) created directly in a
// terminal column landed with status still 'todo': column said "done", status
// said "not done", and the ticket was invisible to every dispatch path (push
// trigger, focus-ticket polling, reconciler seed all exclude terminal columns
// by design) — it never started. Root cause: create_ticket (MCP + REST +
// legacy agent-api) trusted the caller-supplied destination column with no
// terminal-aware validation, and Ticket.status was never derived from the
// column's terminal/non-terminal meaning at create OR move time.
//
// This covers: (1) the unsafe combination is rejected at create time, (2) the
// pre-existing legitimate direct-to-terminal create (no related_ticket_id)
// still works and now gets a consistent status, (3) the everyday
// related_ticket_id-into-a-non-terminal-column case is unaffected, (4) the
// new safe column default when column_id/column_name are omitted, (5) status
// stays in sync with the column across move_ticket in both directions, (6) a
// move that does NOT cross the terminal boundary (reorder within Done) still
// re-derives status — closing the gap a review pass found in the first
// version of this fix, (7) the one-time migration heals rows that drifted
// out of sync before any of this shipped, and (8) a ticket created into a
// non-terminal column is actually live for dispatch — not just
// database-consistent — proven through the REAL producer→dispatcher chain:
// create_ticket (producer, writes only a 'created' ActivityLog — there is no
// synchronous dispatch call in that path) → DispatchReconcilerService's
// seed-then-dispatch backstop (the actual first-dispatch mechanism for a
// brand-new ticket; same service production wires to a setInterval sweep,
// driven here deterministically via its public reconcile(now) entrypoint,
// exactly like qa-flows/dispatch-reconciler-loop.test.mjs) → a connected
// VirtualAgent's real SSE stream. A prior version of this scenario called
// TriggerLoopService.dispatchCurrentColumn directly, which bypasses
// create_ticket's producer step entirely (a review finding on this ticket).

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests } from './helpers/boot.mjs';
import { setupKanbanScene, createAgent, createApiKey, createTicket } from './helpers/fixtures.mjs';
import { McpClient } from './helpers/mcp-client.mjs';
import { VirtualAgent } from './helpers/virtual-agent.mjs';
import { DispatchReconcilerService } from '../dist/modules/agents/dispatch-reconciler.service.js';
import { DISPATCH_RECONCILER_DEFAULTS } from '../dist/modules/agents/dispatch-intent.service.js';
import { BackfillRootTicketStatusFromColumn1760000000075 } from '../dist/database/migrations/1760000000075-BackfillRootTicketStatusFromColumn.js';

process.env.PORT = process.env.TEST_SERVER_PORT || '7859';

test('terminal-column ticket create/move keeps status consistent with the column', async (t) => {
  const { app, port, modules } = await bootApp({ port: Number(process.env.PORT) });
  t.after(() => { void app.close().catch(() => {}); });
  const ds = app.get(modules.getDataSourceToken());
  const ticketRepo = ds.getRepository('Ticket');
  const activityLogRepo = ds.getRepository('ActivityLog');

  // envRepo: true — scenario 8 dispatches an assignee onto an 'active' column,
  // which the base-repo-binding guard (ticket 8c3befa8) pends closed unless
  // the board declares a resolvable repository.
  const { ws, board, columns } = await setupKanbanScene(app, modules.getDataSourceToken, {
    workspaceName: 'terminal-status', envRepo: true,
  });
  const agent = await createAgent(app, modules.getDataSourceToken, ws.id, { name: 'assignee' });
  const key = await createApiKey(app, modules.getDataSourceToken, agent.id, { workspaceId: ws.id });
  const mcp = new McpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: key.raw_key });
  t.after(() => mcp.close());

  const related = await createTicket(app, modules.getDataSourceToken, {
    columnId: columns.todo.id, workspaceId: ws.id, title: 'original ticket being corrected',
  });

  // 1. The exact repro: a follow-up ticket (related_ticket_id set) explicitly
  // targeting the terminal column must be rejected, not silently created.
  const rejected = await mcp.callTool('create_ticket', {
    title: 'follow-up correction', board_id: board.id, column_name: 'Done',
    related_ticket_id: related.id,
  });
  assert.equal(rejected?.isError, true, JSON.stringify(rejected));
  assert.match(rejected.error?.error || '', /terminal column/);
  assert.equal(
    await ticketRepo.count({ where: { title: 'follow-up correction' } }),
    0,
    'the rejected follow-up must not be persisted',
  );

  // 2. Regression guard: legitimate direct-to-terminal creation WITHOUT
  // related_ticket_id (e.g. an operator filing a retroactive/already-done
  // record) must keep working, now with a status that matches the column.
  const retroactive = await mcp.callTool('create_ticket', {
    title: 'retroactive record', board_id: board.id, column_name: 'Done',
  });
  assert.ok(retroactive?.id, JSON.stringify(retroactive));
  const retroactiveRow = await ticketRepo.findOneByOrFail({ id: retroactive.id });
  assert.equal(retroactiveRow.column_id, columns.done.id);
  assert.equal(retroactiveRow.status, 'done');
  assert.ok(retroactiveRow.terminal_entered_at, 'terminal_entered_at must still be stamped');

  // 3. Regression guard: the everyday case — a follow-up ticket into a
  // non-terminal column — is unaffected by the new guard.
  const normalFollowUp = await mcp.callTool('create_ticket', {
    title: 'normal follow-up', board_id: board.id, column_name: 'Todo',
    related_ticket_id: related.id,
  });
  assert.ok(normalFollowUp?.id, JSON.stringify(normalFollowUp));
  const normalFollowUpRow = await ticketRepo.findOneByOrFail({ id: normalFollowUp.id });
  assert.equal(normalFollowUpRow.column_id, columns.todo.id);
  assert.equal(normalFollowUpRow.status, 'todo');

  // 4. New safe default: omitting column_id/column_name (board_id alone)
  // lands on the board's first non-terminal column instead of erroring.
  const defaulted = await mcp.callTool('create_ticket', {
    title: 'no column specified', board_id: board.id,
  });
  assert.ok(defaulted?.id, JSON.stringify(defaulted));
  const defaultedRow = await ticketRepo.findOneByOrFail({ id: defaulted.id });
  assert.equal(defaultedRow.column_id, columns.todo.id);
  assert.equal(defaultedRow.status, 'todo');

  // 5. move_ticket keeps status in sync across the terminal boundary in both
  // directions — not just at creation.
  const lifecycle = await createTicket(app, modules.getDataSourceToken, {
    columnId: columns.todo.id, workspaceId: ws.id, title: 'lifecycle status sync',
  });
  const movedIn = await mcp.callTool('move_ticket', { ticket_id: lifecycle.id, target_column_id: columns.done.id });
  assert.ok(!movedIn?.isError, JSON.stringify(movedIn));
  assert.equal((await ticketRepo.findOneByOrFail({ id: lifecycle.id })).status, 'done');

  const movedOut = await mcp.callTool('move_ticket', {
    ticket_id: lifecycle.id, target_column_id: columns.todo.id, force: true,
  });
  assert.ok(!movedOut?.isError, JSON.stringify(movedOut));
  assert.equal((await ticketRepo.findOneByOrFail({ id: lifecycle.id })).status, 'todo');

  // 6. Review follow-up: a move that does NOT cross the terminal boundary
  // (reorder within Done) must still re-derive status. Before this fix,
  // `applyTerminalEnteredAtForMove` short-circuited on `wasTerminal ===
  // isTerminal` and skipped the status write entirely — a row that was
  // ALREADY drifted (terminal column, stale non-terminal status — exactly
  // the reported repro's residual state) stayed wrong forever unless it
  // happened to cross the boundary again. Force that drift directly (bypass
  // every guarded write path, the same way real pre-fix data would have
  // gotten here), then reorder within Done and confirm it self-heals.
  const staleInDone = await createTicket(app, modules.getDataSourceToken, {
    columnId: columns.done.id, workspaceId: ws.id, title: 'drifted status pre-existing in Done',
  });
  await ticketRepo.update(staleInDone.id, { status: 'todo' });
  assert.equal(
    (await ticketRepo.findOneByOrFail({ id: staleInDone.id })).status, 'todo',
    'precondition: simulated pre-fix drift — terminal column, stale non-terminal status',
  );
  const reordered = await mcp.callTool('move_ticket', {
    ticket_id: staleInDone.id, target_column_id: columns.done.id, position: 0,
  });
  assert.ok(!reordered?.isError, JSON.stringify(reordered));
  assert.equal(
    (await ticketRepo.findOneByOrFail({ id: staleInDone.id })).status, 'done',
    'reorder within the SAME terminal column (no boundary crossing) must still re-derive status',
  );

  // 7. The one-time migration heals rows that drifted out of sync before any
  // of this shipped and never move again (so #6's self-heal-on-next-move
  // never reaches them) — e.g. the ticket that originally surfaced this bug.
  // Reproduce that residual state directly (status drifted, no further move)
  // in both directions, then run the migration's up() and confirm both heal.
  const staleDoneForMigration = await createTicket(app, modules.getDataSourceToken, {
    columnId: columns.done.id, workspaceId: ws.id, title: 'migration: stale todo in terminal column',
  });
  await ticketRepo.update(staleDoneForMigration.id, { status: 'todo' });
  const staleTodoForMigration = await createTicket(app, modules.getDataSourceToken, {
    columnId: columns.todo.id, workspaceId: ws.id, title: 'migration: stale done in non-terminal column',
  });
  await ticketRepo.update(staleTodoForMigration.id, { status: 'done' });

  const qr = ds.createQueryRunner();
  try {
    await new BackfillRootTicketStatusFromColumn1760000000075().up(qr);
  } finally {
    await qr.release();
  }

  assert.equal(
    (await ticketRepo.findOneByOrFail({ id: staleDoneForMigration.id })).status, 'done',
    'migration must heal a terminal-column row stuck on status=todo',
  );
  assert.equal(
    (await ticketRepo.findOneByOrFail({ id: staleTodoForMigration.id })).status, 'todo',
    'migration must heal a non-terminal-column row stuck on status=done',
  );

  // 8. Completion criterion 3 — "non-terminal 생성 직후 trigger/dispatch가 정상
  // 발생한다" — proven through the REAL producer→dispatcher chain (see file
  // header), not by calling TriggerLoopService.dispatchCurrentColumn
  // directly. A connected VirtualAgent (real SSE subscriber, exactly how a
  // live subagent driver observes dispatch) proves the trigger actually
  // reaches the agent, waiting with a bounded/fail-closed timeout.
  const virtualAgent = new VirtualAgent({
    name: 'assignee', agentId: agent.id, apiKey: key.raw_key, port, boardId: board.id,
  });
  await virtualAgent.start();
  t.after(() => virtualAgent.stop());
  // Let the SSE subscription settle before the create below — avoids a race
  // between "stream open" and "server emits" (same pattern as the existing
  // comment-trigger QA flow).
  await new Promise((r) => setTimeout(r, 200));

  const dispatchable = await mcp.callTool('create_ticket', {
    title: 'dispatch-eligible non-terminal create', board_id: board.id, column_name: 'In Progress',
    assignee_id: agent.id,
  });
  assert.ok(dispatchable?.id, JSON.stringify(dispatchable));

  // The producer step alone must not fabricate a dispatch — create_ticket
  // logs only 'created' synchronously, matching the reported repro ("생성
  // 직후 활동 로그에는 created만 있었다"). The trigger below must come from
  // the reconciler backstop we drive next, not from create_ticket itself.
  assert.equal(
    await activityLogRepo.count({ where: { action: 'trigger_emitted', ticket_id: dispatchable.id } }),
    0,
    'create_ticket alone must not synchronously fabricate a trigger_emitted row',
  );

  // Drive the REAL DispatchReconcilerService (the service production wires
  // to a setInterval sweep) through its public reconcile(now) entrypoint —
  // only `now` is synthetic, matching qa-flows/dispatch-reconciler-loop
  // .test.mjs scenarios 5/7/9. First pass: seed a durable intent for the
  // routed-but-idle ticket (idle baseline is created_at, so `now` must clear
  // seedAfterMs). Second pass: dispatch the freshly-seeded intent — this is
  // the call that reaches TriggerLoopService's real emit chokepoint.
  const reconciler = app.get(DispatchReconcilerService);
  const seedAt = new Date(Date.now() + DISPATCH_RECONCILER_DEFAULTS.seedAfterMs + 1_000);
  await reconciler.reconcile(seedAt);
  await reconciler.reconcile(new Date(seedAt.getTime() + 1_000));

  const trigger = await virtualAgent.waitForTrigger((tr) => tr.ticket_id === dispatchable.id, 5_000);
  assert.equal(trigger.role, 'assignee', 'the live SSE trigger routed to the assignee role');
  const triggerRow = await activityLogRepo.findOne({
    where: { action: 'trigger_emitted', ticket_id: dispatchable.id },
  });
  assert.ok(triggerRow, 'expected a trigger_emitted audit row once the real reconciler dispatch phase ran');

  // Contrast: the terminal-column ticket (scenario 2's `retroactive`, already
  // status='done') is never even a seed candidate — BoardColumn.kind='terminal'
  // is structurally excluded from the reconciler's candidate scan — so the
  // SAME sweep that just dispatched the routed ticket above proves terminal
  // exclusion holds through the real chain too, not just an explicit check
  // inside dispatchCurrentColumn.
  await reconciler.reconcile(new Date(seedAt.getTime() + 2_000));
  assert.equal(
    await activityLogRepo.count({ where: { action: 'trigger_emitted', ticket_id: retroactive.id } }),
    0,
    'a terminal-column ticket must never be seeded/dispatched by the reconciler backstop',
  );
});

test.after(() => exitAfterTests());
