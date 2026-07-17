// QA flow: durable dispatch outbox — the full closed loop (ticket e7c87517).
//
// Root cause this proves the fix for: an `agent_trigger` is a fire-and-forget
// in-process emit with NO ack and NO persistence. A gate drop (focus / in-flight
// strand), a manager-side spawn abort (worktree pool_exhausted / missing repo),
// an SSE gap, or a process crash between commit and emit made the trigger
// evaporate — the exact TerrainSystem 30603ce6 25h-in-To-Do stall. The durable
// dispatch outbox records every owed dispatch and a background reconciler
// re-derives it from committed DB state until the ticket makes REAL forward
// progress or reaches a terminal/parked/unstaffed state.
//
// Subtests (each seeds its own ticket; assertions are per-intent so a shared
// sweep touching other tickets can't perturb them):
//   1. a landed emit records a durable in_flight intent (chokepoint wiring).
//   2. a focus/capacity gate drop records a durable pending intent (recovery
//      pointer — no silent starvation drop).
//   3. processed ack extends grace but NEVER resolves (spawn ≠ progress).
//   4. stale-ack guard: an ack for a superseded trigger_id is ignored.
//   5. pool_exhausted nack → backoff defer → reconciler re-dispatch → resolve on
//      real forward progress. The full capacity-saturation recovery.
//   6. multi-instance CAS: two reconciler instances race one intent → one wins.
//   7. crash/restart: a fresh sweep re-derives an open intent from the DB alone.
//   8. resolve on terminal / parked / unstaffed.
//   9. seed: a routed-but-idle ticket with NO intent (lost emit) is seeded then
//      dispatched — the self-healing backstop.
//  10. HTTP ack endpoint: manager → server nack over the wire flips the intent.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  setupKanbanScene, createAgent, createTicket, createApiKey,
} from '../helpers/fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', '..', 'dist');

process.env.PORT = process.env.QA_DISPATCH_PORT || '7835';
process.env.STUCK_DETECTOR_ENABLED = 'false';       // isolate the dispatch loop
process.env.DISPATCH_RECONCILER_ENABLED = 'true';
process.env.DISPATCH_RECONCILER_SWEEP_MS = '300000'; // 5min — the auto-timer never fires in-test
process.env.DISPATCH_RECONCILER_PROCESSING_GRACE_MS = '300000'; // 5min grace (>> backoff, so idle siblings defer)
process.env.DISPATCH_RECONCILER_BASE_BACKOFF_MS = '60000';      // 1min
process.env.DISPATCH_RECONCILER_MAX_BACKOFF_MS = '120000';      // 2min
process.env.DISPATCH_RECONCILER_SEED_AFTER_MS = '60000';        // 1min idle → seed
process.env.DISPATCH_RECONCILER_LEASE_MS = '120000';

const HOUR = 3_600_000;

test('Durable dispatch outbox — full closed loop', async (t) => {
  step('Boot NestJS app on test port');
  const port = parseInt(process.env.PORT, 10);
  const { app, modules } = await bootApp({ port });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());

  const load = async (rel, name) =>
    app.get((await import('file://' + path.join(DIST_ROOT, 'modules', 'agents', rel))) [name]);
  const intents = await load('dispatch-intent.service.js', 'DispatchIntentService');
  const reconciler = await load('dispatch-reconciler.service.js', 'DispatchReconcilerService');
  const triggerLoop = await load('trigger-loop.service.js', 'TriggerLoopService');

  step('Seed a CODE board (env repo so assignee+active dispatches land) + agent');
  const { ws, board, columns } = await setupKanbanScene(app, getDataSourceToken, {
    workspaceName: 'dispatch', maxConcurrent: 50, envRepo: true,
  });
  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'ralf' });

  const intentRepo = ds.getRepository('DispatchIntent');
  const ticketRepo = ds.getRepository('Ticket');
  const commentRepo = ds.getRepository('Comment');

  const mkTicket = (title, columnId = columns.inProgress.id) =>
    createTicket(app, getDataSourceToken, { columnId, workspaceId: ws.id, title, assigneeId: agent.id });

  await t.test('1: a landed emit records a durable in_flight intent', async () => {
    const ticket = await mkTicket('emit wiring');
    const tid = await triggerLoop.emitAgentTrigger(ticket, agent.id, 'assignee', 'column_move', 'system');
    assert.ok(tid, 'emit landed (returned a trigger_id)');
    const intent = await intents.findOpenForTicketRole(ticket.id, 'assignee');
    assert.ok(intent, 'the chokepoint recorded a durable intent for the landed dispatch');
    assert.equal(intent.status, 'in_flight', 'a landed dispatch is in_flight — NOT resolved (spawn ≠ progress)');
    assert.equal(intent.last_trigger_id, tid, 'intent carries the emitted trigger_id (ack-match key)');
  });

  await t.test('2: a focus/capacity gate drop records a durable pending intent', async () => {
    // maxConcurrent=1 board so a second ticket outside the focus window drops.
    const scene = await setupKanbanScene(app, getDataSourceToken, {
      workspaceName: 'starve', maxConcurrent: 1, envRepo: true,
    });
    const a2 = await createAgent(app, getDataSourceToken, scene.ws.id, { name: 'busy' });
    const mk = (title, priority) => createTicket(app, getDataSourceToken, {
      columnId: scene.columns.inProgress.id, workspaceId: scene.ws.id, title, assigneeId: a2.id, priority,
    });
    // Two active tickets, cap=1 → exactly one is inside the focus window.
    // Distinct priorities make the focus ranking deterministic (high outranks
    // low), so `held` lands and `starved` is the one that gets capacity-dropped.
    const held = await mk('focus holder', 'high');
    const starved = await mk('focus starved', 'low');
    await triggerLoop.emitAgentTrigger(held, a2.id, 'assignee', 'column_move', 'system');
    const droppedId = await triggerLoop.emitAgentTrigger(starved, a2.id, 'assignee', 'column_move', 'system');
    // One of the two is outside the window and dropped (''); find whichever owed a pending intent.
    const iHeld = await intents.findOpenForTicketRole(held.id, 'assignee');
    const iStarved = await intents.findOpenForTicketRole(starved.id, 'assignee');
    const pendings = [iHeld, iStarved].filter(i => i && i.status === 'pending');
    assert.equal(pendings.length, 1, 'exactly one ticket was focus-dropped and left a durable pending intent');
    assert.match(pendings[0].last_reason, /focus_window_capacity/, 'the recovery pointer records the capacity gate reason');
    assert.equal(droppedId, '', 'the second emit was gated (returned empty)');
  });

  await t.test('3: processed ack extends grace but NEVER resolves', async () => {
    const ticket = await mkTicket('processed not resolved');
    const tid = await triggerLoop.emitAgentTrigger(ticket, agent.id, 'assignee', 'column_move', 'system');
    const ack = await intents.applyManagerAck({ ticketId: ticket.id, role: 'assignee', triggerId: tid, outcome: 'processed' });
    assert.equal(ack.applied, true);
    assert.equal(ack.matched, true);
    const intent = await intents.findOpenForTicketRole(ticket.id, 'assignee');
    assert.equal(intent.status, 'in_flight', 'processed keeps the intent OPEN — a spawned-but-silent strand is still owed');
    assert.equal(intent.last_ack_kind, 'processed');
  });

  await t.test('4: stale-ack guard — ack for a superseded trigger_id is ignored', async () => {
    const ticket = await mkTicket('stale ack');
    const tid = await triggerLoop.emitAgentTrigger(ticket, agent.id, 'assignee', 'column_move', 'system');
    const stale = await intents.applyManagerAck({ ticketId: ticket.id, role: 'assignee', triggerId: 'stale-' + tid, outcome: 'nack', reason: 'x' });
    assert.equal(stale.matched, false, 'a nack whose trigger_id ≠ the current dispatch is not applied');
    let intent = await intents.findOpenForTicketRole(ticket.id, 'assignee');
    assert.equal(intent.status, 'in_flight', 'the stale nack did not re-open the intent');
    const fresh = await intents.applyManagerAck({ ticketId: ticket.id, role: 'assignee', triggerId: tid, outcome: 'nack', reason: 'pool_exhausted' });
    assert.equal(fresh.applied, true, 'the matching-trigger_id nack applies');
    intent = await intents.findOpenForTicketRole(ticket.id, 'assignee');
    assert.equal(intent.status, 'pending', 'a matching nack re-opens for retry');
    assert.match(intent.last_reason, /pool_exhausted/);
  });

  await t.test('5: pool_exhausted nack → backoff defer → re-dispatch → resolve on progress', async () => {
    const ticket = await mkTicket('pool exhausted recovery');
    const tid = await triggerLoop.emitAgentTrigger(ticket, agent.id, 'assignee', 'column_move', 'system');
    let intent = await intents.findOpenForTicketRole(ticket.id, 'assignee');
    // Backdate created_at to 1h ago (real time) so a later "now" progress comment
    // is unambiguously after it (no second-precision ties).
    await intentRepo.update(intent.id, { created_at: new Date(Date.now() - HOUR) });

    // Manager aborts the spawn: worktree pool exhausted.
    await intents.applyManagerAck({ ticketId: ticket.id, role: 'assignee', triggerId: tid, outcome: 'nack', reason: 'pool_exhausted' });
    intent = await intentRepo.findOne({ where: { id: intent.id } });
    assert.equal(intent.status, 'pending', 'nack re-opened as pending');
    const attemptsAfterNack = intent.attempts;
    const nextAttempt = new Date(intent.next_attempt_at).getTime();

    // Reconcile WITHIN backoff → the intent stays pending (deferred, no new attempt).
    await reconciler.reconcile(new Date(nextAttempt - 1000));
    intent = await intentRepo.findOne({ where: { id: intent.id } });
    assert.equal(intent.status, 'pending', 'within backoff → deferred, not re-dispatched');
    assert.equal(intent.attempts, attemptsAfterNack, 'no new dispatch attempt while deferred');

    // Reconcile PAST backoff → the reconciler re-dispatches (pool has since freed).
    await reconciler.reconcile(new Date(nextAttempt + 1000));
    intent = await intentRepo.findOne({ where: { id: intent.id } });
    assert.equal(intent.status, 'in_flight', 'past backoff → re-dispatched (in_flight again)');
    assert.ok(intent.attempts > attemptsAfterNack, 'a fresh dispatch attempt was made');

    // The strand finally makes REAL forward progress (a genuine comment).
    await commentRepo.save(commentRepo.create({
      ticket_id: ticket.id, workspace_id: ws.id, author_type: 'agent', author: 'ralf',
      content: 'branch pushed, opening review', type: 'note',
    }));
    await reconciler.reconcile(new Date());
    intent = await intentRepo.findOne({ where: { id: intent.id } });
    assert.equal(intent.status, 'resolved', 'observed forward progress resolves the intent');
    assert.equal(intent.last_reason, 'progressed', 'resolution reason is real progress — not the spawn');
  });

  await t.test('6: multi-instance CAS — two instances race one intent, exactly one wins', async () => {
    const ticket = await mkTicket('cas race');
    await triggerLoop.emitAgentTrigger(ticket, agent.id, 'assignee', 'column_move', 'system');
    let intent = await intents.findOpenForTicketRole(ticket.id, 'assignee');
    // Make it a dispatchable pending intent with a free lease.
    await intentRepo.update(intent.id, {
      status: 'pending', next_attempt_at: new Date(Date.now() - 1000),
      lease_owner: '', lease_expires_at: null,
    });
    intent = await intentRepo.findOne({ where: { id: intent.id } });
    const now = new Date();
    const [a, b] = await Promise.all([
      intents.claimForDispatch(intent, { instanceId: 'inst-A', now, force: false }),
      intents.claimForDispatch(intent, { instanceId: 'inst-B', now, force: false }),
    ]);
    assert.equal([a, b].filter(r => r.claimed).length, 1, 'exactly one instance claims the dispatch — no double-spawn');
  });

  await t.test('7: crash/restart — a fresh sweep re-derives an open intent from the DB alone', async () => {
    const ticket = await mkTicket('restart rederive');
    await triggerLoop.emitAgentTrigger(ticket, agent.id, 'assignee', 'column_move', 'system');
    const intent = await intents.findOpenForTicketRole(ticket.id, 'assignee');
    // Simulate a restart: the only surviving state is the committed DB row. Make
    // it dispatchable and old enough that no false-progress signal exists.
    await intentRepo.update(intent.id, {
      status: 'pending', next_attempt_at: new Date(Date.now() - 1000),
      created_at: new Date(Date.now() - HOUR),
    });
    await reconciler.reconcile(new Date());
    const after = await intentRepo.findOne({ where: { id: intent.id } });
    assert.equal(after.status, 'in_flight', 'a fresh sweep rediscovered the owed intent from committed DB state and re-dispatched it');
    assert.ok(after.attempts >= 1);
  });

  await t.test('8: resolve on terminal / parked / unstaffed', async () => {
    // terminal
    const t1 = await mkTicket('lands terminal');
    await triggerLoop.emitAgentTrigger(t1, agent.id, 'assignee', 'column_move', 'system');
    const i1 = await intents.findOpenForTicketRole(t1.id, 'assignee');
    await ticketRepo.update(t1.id, { column_id: columns.done.id });
    await reconciler.reconcile(new Date());
    assert.equal((await intentRepo.findOne({ where: { id: i1.id } })).status, 'resolved', 'terminal column resolves the intent');
    assert.equal((await intentRepo.findOne({ where: { id: i1.id } })).last_reason, 'terminal_or_unrouted');

    // parked
    const t2 = await mkTicket('parked on human');
    await triggerLoop.emitAgentTrigger(t2, agent.id, 'assignee', 'column_move', 'system');
    const i2 = await intents.findOpenForTicketRole(t2.id, 'assignee');
    await ticketRepo.update(t2.id, { pending_user_action: true });
    await reconciler.reconcile(new Date());
    assert.equal((await intentRepo.findOne({ where: { id: i2.id } })).last_reason, 'parked', 'a parked ticket resolves the intent (re-records on resume)');

    // unstaffed (no holder, owed with empty agent_id)
    const t3 = await createTicket(app, getDataSourceToken, { columnId: columns.inProgress.id, workspaceId: ws.id, title: 'unstaffed' });
    await intents.recordOwed({ workspaceId: ws.id, boardId: board.id, ticketId: t3.id, role: 'assignee', agentId: '', triggerSource: 'column_move', reason: 'test' });
    const i3 = await intents.findOpenForTicketRole(t3.id, 'assignee');
    await reconciler.reconcile(new Date());
    assert.equal((await intentRepo.findOne({ where: { id: i3.id } })).last_reason, 'unstaffed', 'no holder → resolve unstaffed (no infinite spin)');
  });

  await t.test('9: seed — a routed-but-idle ticket with no intent (lost emit) is seeded then dispatched', async () => {
    const t = await mkTicket('lost emit seed');
    // Idle past seedAfterMs, no emit ever ran → no open intent yet.
    await ticketRepo.update(t.id, { created_at: new Date(Date.now() - 10 * 60_000) });
    assert.equal(await intents.findOpenForTicketRole(t.id, 'assignee'), null, 'no intent before the sweep (the emit was lost)');
    await reconciler.reconcile(new Date());
    const seeded = await intents.findOpenForTicketRole(t.id, 'assignee');
    assert.ok(seeded, 'the reconciler seeded a durable intent from committed DB state alone');
    assert.equal(seeded.trigger_source, 'reconcile_seed');
    await reconciler.reconcile(new Date());
    assert.equal((await intentRepo.findOne({ where: { id: seeded.id } })).status, 'in_flight', 'the seeded intent is dispatched on the next sweep');
  });

  await t.test('10: HTTP ack endpoint — manager → server nack flips the intent over the wire', async () => {
    const ticket = await mkTicket('http ack');
    const tid = await triggerLoop.emitAgentTrigger(ticket, agent.id, 'assignee', 'column_move', 'system');
    const key = await createApiKey(app, getDataSourceToken, agent.id, { workspaceId: ws.id, label: 'mgr' });
    const post = (bodyObj) => fetch(`http://127.0.0.1:${port}/api/agent-manager/dispatch/ack`, {
      method: 'POST',
      headers: { 'X-Agent-Key': key.raw_key, 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj),
    });

    const resp = await post({ ticket_id: ticket.id, role: 'assignee', trigger_id: tid, outcome: 'nack', reason: 'pool_exhausted' });
    assert.equal(resp.status, 200, 'ack endpoint accepts the manager POST');
    const body = await resp.json();
    assert.equal(body.applied, true);
    assert.equal(body.matched, true);
    const intent = await intents.findOpenForTicketRole(ticket.id, 'assignee');
    assert.equal(intent.status, 'pending', 'the HTTP nack re-opened the intent via applyManagerAck');
    assert.match(intent.last_reason, /pool_exhausted/);

    const bad = await post({ ticket_id: ticket.id });
    assert.equal(bad.status, 400, 'missing role/outcome → 400 (contract validation)');
  });
});

test.after?.(() => exitAfterTests(0));
process.on('beforeExit', () => exitAfterTests(0));
