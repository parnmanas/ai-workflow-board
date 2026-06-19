// QA flow: on-ticket-done Action hook (ticket 16a6339c).
//
// Proves OnTicketDoneActionService dispatches the right Actions exactly once
// when a ticket lands on a terminal (Done) column, with the finished ticket
// injected into the prompt, and that the four guarantees hold:
//
//   1. method (b) board/label-scoped Action fires once on terminal entry, and
//      the prompt is rendered with {{ticket.*}} context.
//   2. idempotency — re-emitting the terminal `moved` activity for the SAME
//      entry does NOT dispatch a second time.
//   3. enabled=false Actions are skipped (hook honours the flag).
//   4. recursion guard — a ticket labelled `no-on-done-hook` fires nothing.
//   5. method (a) per-ticket `on_done_action_ids` fires even when the Action
//      itself has no on_ticket_done trigger.
//
// Scenarios are isolated by trigger_label so the board-scoped Actions in one
// scenario can't cross-fire on another scenario's ticket.

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

process.env.PORT = process.env.QA_ON_DONE_HOOK_PORT || '7842';

async function createAction(ds, fields) {
  const repo = ds.getRepository('Action');
  return repo.save(repo.create({
    workspace_id: fields.workspace_id,
    board_id: fields.board_id ?? null,
    name: fields.name,
    description: '',
    prompt: fields.prompt ?? '',
    target_agent_id: fields.target_agent_id,
    schedule_cron: '',
    trigger: fields.trigger ?? '',
    trigger_label: fields.trigger_label ?? '',
    enabled: fields.enabled !== false,
    max_runs: 10,
  }));
}

// Simulate a real terminal landing: the move path stamps terminal_entered_at on
// the non-terminal → terminal crossing, then logs a `moved` activity. We do the
// same so the service sees exactly what production emits.
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

async function runsFor(ds, actionId) {
  return ds.getRepository('ActionRun').find({ where: { action_id: actionId } });
}

// The listener is fire-and-forget (.catch); poll until the expected count lands
// or the deadline passes.
async function waitForRuns(ds, actionId, expected, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let rows = await runsFor(ds, actionId);
  while (rows.length < expected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    rows = await runsFor(ds, actionId);
  }
  return rows;
}

test('on-ticket-done hook dispatches bound Actions exactly once with ticket context', async (t) => {
  step('Boot NestJS app');
  const { app, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const ds = app.get(modules.getDataSourceToken());
  const activityService = app.get(modules.ActivityService);

  step('Seed workspace + board + Todo/Done columns + agent');
  const ws = await createWorkspace(app, modules.getDataSourceToken, 'on-done');
  const board = await createBoard(app, modules.getDataSourceToken, ws.id, { name: 'hookboard' });
  const todo = await createColumn(app, modules.getDataSourceToken, board.id, {
    name: 'Todo', position: 0, workspaceId: ws.id, kind: 'intake', roleRouting: ['assignee'],
  });
  const done = await createColumn(app, modules.getDataSourceToken, board.id, {
    name: 'Done', position: 1, workspaceId: ws.id, isTerminal: true, kind: 'terminal', roleRouting: [],
  });
  const agent = await createAgent(app, modules.getDataSourceToken, ws.id, { name: 'hook-target' });

  const newTicket = (title, labels) =>
    createTicket(app, modules.getDataSourceToken, {
      columnId: todo.id, workspaceId: ws.id, title, assigneeId: agent.id,
    }).then(async (tk) => {
      if (labels) {
        await ds.getRepository('Ticket').update(tk.id, { labels: JSON.stringify(labels) });
      }
      return tk;
    });

  // ── Scenario 1: method (b) + context + idempotency ──────────────────────
  step('S1: on_ticket_done Action (label-scoped) fires once with {{ticket.*}}');
  const a1 = await createAction(ds, {
    workspace_id: ws.id, board_id: board.id, name: 'S1 hook', target_agent_id: agent.id,
    trigger: 'on_ticket_done', trigger_label: 's1',
    prompt: 'Finished ticket {{ticket.id}} titled "{{ticket.title}}" on board {{ticket.board_id}}.',
  });
  const t1 = await newTicket('S1 feature ticket', ['s1']);
  await moveToDone(ds, activityService, t1.id, done.id);
  const s1Runs = await waitForRuns(ds, a1.id, 1);
  assert.equal(s1Runs.length, 1, 'S1: exactly one run dispatched on terminal entry');
  assert.match(s1Runs[0].prompt_rendered, new RegExp(t1.id), 'S1: {{ticket.id}} interpolated');
  assert.match(s1Runs[0].prompt_rendered, /S1 feature ticket/, 'S1: {{ticket.title}} interpolated');
  assert.match(s1Runs[0].prompt_rendered, new RegExp(board.id), 'S1: {{ticket.board_id}} interpolated');

  step('S1: re-emitting the same terminal move does NOT double-dispatch');
  await moveToDone(ds, activityService, t1.id, done.id, { restamp: false });
  await new Promise((r) => setTimeout(r, 400));
  const s1RunsAgain = await runsFor(ds, a1.id);
  assert.equal(s1RunsAgain.length, 1, 'S1: idempotent — still one run after re-emit');

  // ── Scenario 2: enabled=false is skipped ────────────────────────────────
  step('S2: enabled=false Action is skipped by the hook');
  const a2 = await createAction(ds, {
    workspace_id: ws.id, board_id: board.id, name: 'S2 disabled', target_agent_id: agent.id,
    trigger: 'on_ticket_done', trigger_label: 's2', enabled: false, prompt: 'should not run',
  });
  const t2 = await newTicket('S2 ticket', ['s2']);
  await moveToDone(ds, activityService, t2.id, done.id);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await runsFor(ds, a2.id)).length, 0, 'S2: disabled Action never dispatched');

  // ── Scenario 3: recursion guard label ───────────────────────────────────
  step('S3: ticket labelled no-on-done-hook fires nothing');
  const a3 = await createAction(ds, {
    workspace_id: ws.id, board_id: board.id, name: 'S3 hook', target_agent_id: agent.id,
    trigger: 'on_ticket_done', trigger_label: 's3', prompt: 'should not run',
  });
  const t3 = await newTicket('S3 hook-origin ticket', ['s3', 'no-on-done-hook']);
  await moveToDone(ds, activityService, t3.id, done.id);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await runsFor(ds, a3.id)).length, 0, 'S3: recursion guard blocked dispatch');

  // ── Scenario 4: method (a) per-ticket binding ───────────────────────────
  step('S4: per-ticket on_done_action_ids fires even without an on_ticket_done trigger');
  const a4 = await createAction(ds, {
    workspace_id: ws.id, board_id: board.id, name: 'S4 explicit', target_agent_id: agent.id,
    trigger: '', prompt: 'explicit binding for {{ticket.title}}',
  });
  const t4 = await newTicket('S4 ticket', []);
  await ds.getRepository('Ticket').update(t4.id, { on_done_action_ids: JSON.stringify([a4.id]) });
  await moveToDone(ds, activityService, t4.id, done.id);
  const s4Runs = await waitForRuns(ds, a4.id, 1);
  assert.equal(s4Runs.length, 1, 'S4: explicit per-ticket binding dispatched once');
  assert.match(s4Runs[0].prompt_rendered, /S4 ticket/, 'S4: ticket context injected');

  // ── Scenario 5: criteria (c) + (d) — no leak to "every ticket" ──────────
  // The headline regression for ticket 0d3a085e: a manual (trigger='') Action
  // that is NOT bound to a ticket and is NOT opted into the on_ticket_done
  // policy must fire NOTHING when an unrelated ticket reaches Done. This proves
  //   (c) an empty on_done_action_ids binding dispatches nothing, and
  //   (d) board-scoped Actions only participate via explicit policy
  //       (trigger='on_ticket_done') — they don't leak onto every completion.
  step('S5: manual Action + empty-binding ticket → zero dispatch (no every-ticket leak)');
  const a5 = await createAction(ds, {
    workspace_id: ws.id, board_id: board.id, name: 'S5 manual (unbound)', target_agent_id: agent.id,
    trigger: '', prompt: 'should never run from a Done event',
  });
  // Default on_done_action_ids is '[]' (empty binding) and no label, so neither
  // method (a) nor method (b) can pick this ticket up.
  const t5 = await newTicket('S5 unrelated ticket', []);
  assert.equal(
    (await ds.getRepository('Ticket').findOne({ where: { id: t5.id } })).on_done_action_ids,
    '[]',
    'S5: fixture ticket starts with an empty binding',
  );
  await moveToDone(ds, activityService, t5.id, done.id);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await runsFor(ds, a5.id)).length, 0, 'S5(d): manual Action did not leak onto a Done event');
  // Per-ticket isolation: t5 reaching Done must NOT re-fire the action bound
  // only to t4 (criterion a — a binding is scoped to its own ticket).
  assert.equal((await runsFor(ds, a4.id)).length, 1, 'S5(a): another ticket\'s Done did not fire t4\'s binding');

  // ── Scenario 6: criterion (c) — per-ticket binding dispatches in array order ─
  // The on_done_action_ids array order IS the dispatch order (the TicketPanel
  // picker lets the user reorder it). Bind three manual Actions in a NON-sorted
  // order and assert the hook dispatches them in exactly that order.
  step('S6: on_done_action_ids dispatch in saved array order');
  const mkOrdered = (n) => createAction(ds, {
    workspace_id: ws.id, board_id: board.id, name: `S6 ordered ${n}`, target_agent_id: agent.id,
    trigger: '', prompt: `ordered ${n}`,
  });
  const o1 = await mkOrdered(1);
  const o2 = await mkOrdered(2);
  const o3 = await mkOrdered(3);
  // Deliberately not the creation order: dispatch must follow THIS array.
  const order = [o3.id, o1.id, o2.id];
  const t6 = await newTicket('S6 ordered ticket', []);
  await ds.getRepository('Ticket').update(t6.id, { on_done_action_ids: JSON.stringify(order) });
  await moveToDone(ds, activityService, t6.id, done.id);
  // Wait until all three have a run, then compare dispatch order via created_at.
  for (const id of order) await waitForRuns(ds, id, 1);
  const orderedRuns = (await ds.getRepository('ActionRun')
    .find({ where: order.map((id) => ({ action_id: id })) }))
    .filter((r) => order.includes(r.action_id))
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  assert.deepEqual(
    orderedRuns.map((r) => r.action_id),
    order,
    'S6(c): actions dispatched in the saved on_done_action_ids array order',
  );
});

exitAfterTests();
