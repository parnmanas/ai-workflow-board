// QA flow: on-ticket-done Action hook (ticket 16a6339c).
//
// Proves OnTicketDoneActionService dispatches the right Actions exactly once
// when a ticket enters status `done`, with the finished ticket injected into
// the prompt, and that the four guarantees hold:
//
//   1. method (b) tag-scoped Action fires once on entering done, and the
//      prompt is rendered with {{ticket.*}} context.
//   2. idempotency — re-emitting the `moved` → done activity for the SAME
//      entry does NOT dispatch a second time.
//   3. enabled=false Actions are skipped (hook honours the flag).
//   4. recursion guard — a ticket tagged `no-on-done-hook` fires nothing.
//   5. method (a) per-ticket `on_done_action_ids` fires even when the Action
//      itself has no on_ticket_done trigger.
//
// Scenarios are isolated by trigger_label so the Workspace Actions in one
// scenario can't cross-fire on another scenario's ticket.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  createWorkspace,
  createAgent,
  createTicket,
} from '../helpers/fixtures.mjs';
import { runtimeIdentityKey } from '../../dist/common/runtime-spec.js';
import { TicketService, SYSTEM_ACTOR } from '../../dist/modules/tickets/ticket.service.js';

process.env.PORT = process.env.QA_ON_DONE_HOOK_PORT || '0';

// P4c-4: dispatch 는 target_runtimes 스냅샷에서만 해소한다 — 직접 심는 행에도
// spec + 키를 함께 둔다 (target_agent_id 단독 행은 missing 취급).
async function createAction(ds, fields, spec = null) {
  const repo = ds.getRepository('Action');
  const key = spec ? runtimeIdentityKey(spec) : null;
  return repo.save(repo.create({
    workspace_id: fields.workspace_id,
    name: fields.name,
    description: '',
    prompt: fields.prompt ?? '',
    target_agent_id: key ?? fields.target_agent_id,
    target_agent_ids: key ? JSON.stringify([key]) : undefined,
    target_runtimes: spec ? [spec] : undefined,
    schedule_cron: '',
    trigger: fields.trigger ?? '',
    trigger_label: fields.trigger_label ?? '',
    enabled: fields.enabled !== false,
    max_runs: 10,
  }));
}

// A real terminal landing goes through TicketService.move — it stamps
// terminal_entered_at on entering `done` and logs the `moved` activity
// (field_changed 'status', new_value 'done') the hook listens for. The
// idempotency check re-emits that same activity WITHOUT a move, which is what
// a duplicate/reordered event looks like to the listener.
async function moveToDone(ds, activityService, ticketService, ticketId, { reemitOnly = false } = {}) {
  if (!reemitOnly) {
    await ticketService.move(ticketId, 'done', SYSTEM_ACTOR);
    return;
  }
  await activityService.logActivity({
    entity_type: 'ticket', entity_id: ticketId, action: 'moved',
    field_changed: 'status', old_value: 'todo', new_value: 'done', ticket_id: ticketId,
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
  const ticketService = app.get(TicketService);

  step('Seed workspace + agent');
  const ws = await createWorkspace(app, modules.getDataSourceToken, 'on-done');
  const agent = await createAgent(app, modules.getDataSourceToken, ws.id, { name: 'hook-target' });
  // P4c-4: hook dispatch 용 spec (아래 모든 createAction 에 전달).
  const HOOK_SPEC = {
    manager_agent_id: agent.manager_agent_id, cli: 'claude', model: null,
    working_dir: '/srv/hook', credential_id: null, label: 'hook-target', role_prompt: '',
    runtime_config: { strategy: 'single', permission_mode: 'strict' },
  };

  // Unassigned on purpose: the hook does not care who did the work, and an
  // assignee would only add queue/dispatch noise to the move.
  const newTicket = (title, tags) =>
    createTicket(app, modules.getDataSourceToken, {
      workspaceId: ws.id, title, status: 'in_progress', tags: tags || [],
    });

  // ── Scenario 1: method (b) + context + idempotency ──────────────────────
  step('S1: on_ticket_done Action (tag-scoped) fires once with {{ticket.*}}');
  const a1 = await createAction(ds, {
    workspace_id: ws.id, name: 'S1 hook', target_agent_id: agent.id,
    trigger: 'on_ticket_done', trigger_label: 's1',
    prompt: 'Finished ticket {{ticket.id}} titled "{{ticket.title}}" (status {{ticket.status}}, tags {{ticket.tags}}).',
  }, HOOK_SPEC);
  const t1 = await newTicket('S1 feature ticket', ['s1', 'feature']);
  await moveToDone(ds, activityService, ticketService, t1.id);
  const s1Runs = await waitForRuns(ds, a1.id, 1);
  assert.equal(s1Runs.length, 1, 'S1: exactly one run dispatched on entering done');
  assert.match(s1Runs[0].prompt_rendered, new RegExp(t1.id), 'S1: {{ticket.id}} interpolated');
  assert.match(s1Runs[0].prompt_rendered, /S1 feature ticket/, 'S1: {{ticket.title}} interpolated');
  assert.match(s1Runs[0].prompt_rendered, /status done/, 'S1: {{ticket.status}} interpolated');
  assert.match(s1Runs[0].prompt_rendered, /tags s1, feature/, 'S1: {{ticket.tags}} interpolated');

  step('S1: re-emitting the same done move does NOT double-dispatch');
  await moveToDone(ds, activityService, ticketService, t1.id, { reemitOnly: true });
  await new Promise((r) => setTimeout(r, 400));
  const s1RunsAgain = await runsFor(ds, a1.id);
  assert.equal(s1RunsAgain.length, 1, 'S1: idempotent — still one run after re-emit');

  // ── Scenario 2: enabled=false is skipped ────────────────────────────────
  step('S2: enabled=false Action is skipped by the hook');
  const a2 = await createAction(ds, {
    workspace_id: ws.id, name: 'S2 disabled', target_agent_id: agent.id,
    trigger: 'on_ticket_done', trigger_label: 's2', enabled: false, prompt: 'should not run',
  }, HOOK_SPEC);
  const t2 = await newTicket('S2 ticket', ['s2']);
  await moveToDone(ds, activityService, ticketService, t2.id);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await runsFor(ds, a2.id)).length, 0, 'S2: disabled Action never dispatched');

  // ── Scenario 3: recursion guard tag ─────────────────────────────────────
  step('S3: ticket tagged no-on-done-hook fires nothing');
  const a3 = await createAction(ds, {
    workspace_id: ws.id, name: 'S3 hook', target_agent_id: agent.id,
    trigger: 'on_ticket_done', trigger_label: 's3', prompt: 'should not run',
  }, HOOK_SPEC);
  const t3 = await newTicket('S3 hook-origin ticket', ['s3', 'no-on-done-hook']);
  await moveToDone(ds, activityService, ticketService, t3.id);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await runsFor(ds, a3.id)).length, 0, 'S3: recursion guard blocked dispatch');

  // ── Scenario 4: method (a) per-ticket binding ───────────────────────────
  step('S4: per-ticket on_done_action_ids fires even without an on_ticket_done trigger');
  const a4 = await createAction(ds, {
    workspace_id: ws.id, name: 'S4 explicit', target_agent_id: agent.id,
    trigger: '', prompt: 'explicit binding for {{ticket.title}}',
  }, HOOK_SPEC);
  const t4 = await newTicket('S4 ticket', []);
  await ds.getRepository('Ticket').update(t4.id, { on_done_action_ids: JSON.stringify([a4.id]) });
  await moveToDone(ds, activityService, ticketService, t4.id);
  const s4Runs = await waitForRuns(ds, a4.id, 1);
  assert.equal(s4Runs.length, 1, 'S4: explicit per-ticket binding dispatched once');
  assert.match(s4Runs[0].prompt_rendered, /S4 ticket/, 'S4: ticket context injected');

  // ── Scenario 5: criteria (c) + (d) — no leak to "every ticket" ──────────
  // The headline regression for ticket 0d3a085e: a manual (trigger='') Action
  // that is NOT bound to a ticket and is NOT opted into the on_ticket_done
  // policy must fire NOTHING when an unrelated ticket reaches Done. This proves
  //   (c) an empty on_done_action_ids binding dispatches nothing, and
  //   (d) Workspace Actions only participate via explicit policy
  //       (trigger='on_ticket_done') — they don't leak onto every completion.
  step('S5: manual Action + empty-binding ticket → zero dispatch (no every-ticket leak)');
  const a5 = await createAction(ds, {
    workspace_id: ws.id, name: 'S5 manual (unbound)', target_agent_id: agent.id,
    trigger: '', prompt: 'should never run from a Done event',
  }, HOOK_SPEC);
  // Default on_done_action_ids is '[]' (empty binding) and no tag, so neither
  // method (a) nor method (b) can pick this ticket up.
  const t5 = await newTicket('S5 unrelated ticket', []);
  assert.equal(
    (await ds.getRepository('Ticket').findOne({ where: { id: t5.id } })).on_done_action_ids,
    '[]',
    'S5: fixture ticket starts with an empty binding',
  );
  await moveToDone(ds, activityService, ticketService, t5.id);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await runsFor(ds, a5.id)).length, 0, 'S5(d): manual Action did not leak onto a Done event');
  // Per-ticket isolation: t5 reaching Done must NOT re-fire the action bound
  // only to t4 (criterion a — a binding is scoped to its own ticket).
  assert.equal((await runsFor(ds, a4.id)).length, 1, 'S5(a): another ticket\'s Done did not fire t4\'s binding');

  // ── Scenario 6: criterion (c) — per-ticket binding dispatches in array order ─
  // The on_done_action_ids array order IS the dispatch order (the TicketPanel
  // picker lets the user reorder it). Bind three manual Actions in a NON-sorted
  // order and assert the hook dispatches them in exactly that order.
  //
  // We observe order at the ActionsService.dispatch() boundary — the authoritative
  // source of dispatch sequence — rather than reconstructing it from ActionRun
  // created_at. The hook dispatches in one sequential `for...of` + `await` loop,
  // so all three runs share a millisecond (and sql.js timestamps are even coarser);
  // sorting runs by created_at then breaks ties via the DB/index row order, which
  // is non-deterministic and made this assertion flaky (ticket 909a30a6). The
  // product was already correct — only the test's order-recovery was lossy.
  step('S6: on_done_action_ids dispatch in saved array order');
  const mkOrdered = (n) => createAction(ds, {
    workspace_id: ws.id, name: `S6 ordered ${n}`, target_agent_id: agent.id,
    trigger: '', prompt: `ordered ${n}`,
  }, HOOK_SPEC);
  const o1 = await mkOrdered(1);
  const o2 = await mkOrdered(2);
  const o3 = await mkOrdered(3);
  // Deliberately not the creation order: dispatch must follow THIS array.
  const order = [o3.id, o1.id, o2.id];
  const t6 = await newTicket('S6 ordered ticket', []);
  await ds.getRepository('Ticket').update(t6.id, { on_done_action_ids: JSON.stringify(order) });

  // Record the exact order dispatch() is called in. Wrap (not replace) so the
  // real dispatch still runs — we only tap the call sequence. Restored after S6.
  const actionsService = app.get(modules.ActionsService);
  const dispatchOrder = [];
  const realDispatch = actionsService.dispatch.bind(actionsService);
  actionsService.dispatch = (dispatchArgs) => {
    if (order.includes(dispatchArgs.actionId)) dispatchOrder.push(dispatchArgs.actionId);
    return realDispatch(dispatchArgs);
  };
  t.after(() => { actionsService.dispatch = realDispatch; });

  await moveToDone(ds, activityService, ticketService, t6.id);
  // Wait until all three runs have landed, which means dispatch() returned for all
  // three — by then dispatchOrder holds the full sequence.
  for (const id of order) await waitForRuns(ds, id, 1);
  assert.deepEqual(
    dispatchOrder,
    order,
    'S6(c): actions dispatched in the saved on_done_action_ids array order',
  );
});

exitAfterTests();
