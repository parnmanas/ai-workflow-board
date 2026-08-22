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
//  11. seed on a REVIEW-kind column (blocker B1): a lost reviewer emit leaves no
//      intent; the widened seeder re-derives and dispatches it. Previously the
//      seeder scanned only active/intake, so review/merging never self-healed.
//  15. seed is SKIPPED once the holder has already responded (comment) since
//      entering the CURRENT column — an assignee-chosen wait (e.g. sequencing
//      around a sibling ticket editing the same file) is not a lost dispatch
//      (ticket fec25d90). A sibling with NO engagement at all still seeds in
//      the same sweep — the fix is scoped, not a wholesale seed disable.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  setupKanbanScene, createAgent, createTicket, createApiKey,
} from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

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

  await t.test('11: seed — a REVIEW-kind ticket with a lost reviewer emit is seeded then dispatched (blocker B1)', async () => {
    // Reviewer blocker B1: the seeder previously scanned only active/intake, so a
    // reviewer trigger lost to a commit↔emit crash left the ticket in Review with
    // NO open intent AND no seed to re-derive one — the durable outbox self-heal
    // never covered review/merging. Prove the widened candidate set seeds it.
    const reviewer = await createAgent(app, getDataSourceToken, ws.id, { name: 'carol' });
    const t = await createTicket(app, getDataSourceToken, {
      columnId: columns.review.id, workspaceId: ws.id, title: 'lost reviewer emit in Review',
      reviewerId: reviewer.id,
    });
    // Idle past seedAfterMs, no emit ever ran → no open intent for the reviewer.
    await ticketRepo.update(t.id, { created_at: new Date(Date.now() - 10 * 60_000) });
    assert.equal(await intents.findOpenForTicketRole(t.id, 'reviewer'), null, 'no reviewer intent before the sweep (the emit was lost)');

    await reconciler.reconcile(new Date());
    const seeded = await intents.findOpenForTicketRole(t.id, 'reviewer');
    assert.ok(seeded, 'the reconciler seeded a durable reviewer intent for the review-kind stall');
    assert.equal(seeded.trigger_source, 'reconcile_seed');
    assert.equal(seeded.role, 'reviewer', 'the seed is owed to the reviewer role that routes on the Review column');

    await reconciler.reconcile(new Date());
    assert.equal((await intentRepo.findOne({ where: { id: seeded.id } })).status, 'in_flight', 'the seeded review-column intent is dispatched on the next sweep');
  });

  await t.test('12: escalation recovery message names the in-flight-strand cause, not the generic checklist (ticket d35b8ac8)', async () => {
    // The reconciler's escalation `recovery` text used to be a single
    // hardcoded string ("verify agent online / worktree pool / focus
    // capacity") regardless of why the reconciler kept re-dispatching. Three
    // live incidents all had an online agent, a healthy worktree pool, and no
    // pending gate — the actual cause was a same-(agent,ticket,role) strand
    // still running, and the generic text sent a human looking in the wrong
    // place. Seed an intent with the exact `last_reason` shape
    // trigger-loop.service.ts's in-flight-strand gate now writes (including
    // the blocking strand's live-since timestamp) and assert the escalation
    // names that cause instead.
    const ticket = await mkTicket('escalation names the inflight strand');
    const liveSince = new Date(Date.now() - 5 * 60_000).toISOString();
    const strandId = 'sub-blocking-strand-1234';
    await intents.recordOwed({
      workspaceId: ws.id, boardId: board.id, ticketId: ticket.id, role: 'assignee', agentId: agent.id,
      triggerSource: 'supervisor',
      reason: `inflight_strand_serialization queued_for_replay=true strand_id=${strandId} strand_live_since=${liveSince}`,
    });
    const intent = await intents.findOpenForTicketRole(ticket.id, 'assignee');
    // Fast-forward straight to the escalation threshold: attempts=2 so
    // claimForDispatch's +1 crosses the default escalateAfterAttempts=3.
    await intentRepo.update(intent.id, {
      attempts: 2, status: 'pending', next_attempt_at: new Date(Date.now() - 1000),
      lease_owner: '', lease_expires_at: null,
    });

    await reconciler.reconcile(new Date());

    const escalations = await ds.getRepository('ActivityLog').find({
      where: { ticket_id: ticket.id, action: 'dispatch_intent_escalated' },
    });
    assert.equal(escalations.length, 1, 'exactly one escalation row');
    const payload = JSON.parse(escalations[0].new_value);
    assert.doesNotMatch(
      payload.recovery,
      /verify agent online \/ worktree pool \/ focus capacity/,
      'the misdirecting generic checklist must not be used when the real cause is an inflight strand',
    );
    assert.match(payload.recovery, /still running as a process/i, 'the recovery text names the actual blocking-strand cause');
    assert.ok(
      payload.recovery.includes(liveSince),
      "the recovery text surfaces the blocking strand's live-since timestamp (strand id/start-time requirement)",
    );
    assert.ok(
      payload.recovery.includes(strandId),
      'the recovery text surfaces the blocking strand identifier itself (review blocker, ticket d35b8ac8)',
    );
    assert.ok(payload.recovery.includes(agent.id), 'the recovery text names the blocking agent');
  });

  await t.test('13: escalation keeps the generic recovery message for a non-inflight-strand reason', async () => {
    // Control case: a genuinely capacity/reachability-shaped stall must keep
    // getting the original generic guidance — this fix is conditional, not a
    // wholesale replacement of the escalation message.
    const ticket = await mkTicket('escalation keeps generic guidance');
    await intents.recordOwed({
      workspaceId: ws.id, boardId: board.id, ticketId: ticket.id, role: 'assignee', agentId: agent.id,
      triggerSource: 'supervisor', reason: 'focus_window_capacity cap=1',
    });
    const intent = await intents.findOpenForTicketRole(ticket.id, 'assignee');
    await intentRepo.update(intent.id, {
      attempts: 2, status: 'pending', next_attempt_at: new Date(Date.now() - 1000),
      lease_owner: '', lease_expires_at: null,
    });

    await reconciler.reconcile(new Date());

    const escalations = await ds.getRepository('ActivityLog').find({
      where: { ticket_id: ticket.id, action: 'dispatch_intent_escalated' },
    });
    assert.equal(escalations.length, 1, 'exactly one escalation row');
    const payload = JSON.parse(escalations[0].new_value);
    assert.match(
      payload.recovery,
      /verify agent online \/ worktree pool \/ focus capacity/,
      'a genuinely capacity-shaped stall still gets the original generic guidance',
    );
  });

  await t.test('14: invalid_mcp_transport repeats then the ticket is parked — dispatch_generation stops climbing (ticket da4358ee)', async () => {
    // Reproduces the incident this ticket reports: Codex exits immediately every
    // time on `Error loading config.toml: invalid transport in mcp_servers.awb`,
    // and (pre-fix) the reconciler kept re-dispatching forever — 196
    // dispatch_reconcile_redispatch rows / ~2 days observed on the source ticket.
    // The agent-manager side of the fix (event-dispatcher.ts, this same PR)
    // classifies that spawn failure as the durable blocker `invalid_mcp_transport`
    // and pends the ticket on the FIRST abort by calling the real pend_ticket MCP
    // tool (driven below over the real MCP protocol — see review round 2 blocker
    // #2 — the manager side's comment/pend/nack wiring itself is covered
    // end-to-end in apps/agent-manager/test/invalid-mcp-transport-notification.test.mjs).
    // This subtest proves the RECONCILER half: once parked via that real tool,
    // dispatch_generation freezes instead of climbing without bound.
    const ticket = await mkTicket('invalid mcp transport storm');
    const tid = await triggerLoop.emitAgentTrigger(ticket, agent.id, 'assignee', 'column_move', 'system');
    let intent = await intents.findOpenForTicketRole(ticket.id, 'assignee');
    await intentRepo.update(intent.id, { created_at: new Date(Date.now() - HOUR) });

    // The manager aborts the spawn every time — the config error is
    // deterministic, so it nacks with the same reason on every attempt.
    await intents.applyManagerAck({ ticketId: ticket.id, role: 'assignee', triggerId: tid, outcome: 'nack', reason: 'invalid_mcp_transport' });
    intent = await intentRepo.findOne({ where: { id: intent.id } });
    assert.equal(intent.status, 'pending', 'nack re-opened as pending');

    // Baseline (pre-fix shape): without an intervening pend, repeated
    // past-backoff sweeps keep re-dispatching and dispatch_generation keeps
    // climbing — this is the storm the ticket reports.
    for (let i = 0; i < 3; i++) {
      const next = new Date(intent.next_attempt_at).getTime() + 1000;
      await reconciler.reconcile(new Date(next));
      intent = await intentRepo.findOne({ where: { id: intent.id } });
      assert.equal(intent.status, 'in_flight', `sweep ${i}: re-dispatched again — a config error never shows forward progress`);
      // The manager immediately nacks the fresh dispatch with the same
      // deterministic reason (mirrors the real incident's repeated identical error).
      await intents.applyManagerAck({ ticketId: ticket.id, role: 'assignee', triggerId: intent.last_trigger_id, outcome: 'nack', reason: 'invalid_mcp_transport' });
      intent = await intentRepo.findOne({ where: { id: intent.id } });
    }
    const generationBeforePend = intent.dispatch_generation;
    assert.ok(generationBeforePend >= 3, 'generation climbed across the unrepaired repeats — the storm this fix must stop');

    // The manager's durable-blocker handling (RoleSpawnSuppressor.note treats
    // invalid_mcp_transport as durable — pends on the very FIRST abort in
    // production, event-dispatcher.ts) parks the ticket by calling the REAL
    // pend_ticket MCP tool (review round 2, blocker #2: a raw
    // `ticketRepo.update(..., { pending_user_action: true })` here would only
    // re-prove "a parked ticket freezes dispatch_generation" without ever
    // exercising the actual pend_ticket tool's action-gate / terminal-gate /
    // audit-log path production traffic goes through — a regression there
    // could pass this test while the real chokepoint stayed broken). Drive it
    // over the real MCP protocol, exactly as the manager's
    // fireAndForgetTool(this.#config, 'pend_ticket', ...) call does.
    const mcp = new McpClient({ baseUrl: `http://localhost:${port}`, apiKey: (await createApiKey(app, getDataSourceToken, agent.id, { workspaceId: ws.id, label: 'mcp-transport-pend' })).raw_key });
    await mcp.initialize();
    const pendResult = await mcp.callTool('pend_ticket', {
      ticket_id: ticket.id,
      reason: 'invalid MCP transport config — operator must fix mcp_servers.<name> and unpend',
    });
    assert.ok(!pendResult.isError, 'the real pend_ticket tool call succeeded');
    assert.equal(pendResult.pending_user_action, true, 'the tool actually parked the ticket');
    await mcp.close();

    const next = new Date(intent.next_attempt_at).getTime() + 1000;
    await reconciler.reconcile(new Date(next));
    intent = await intentRepo.findOne({ where: { id: intent.id } });
    assert.equal(intent.status, 'resolved', 'a parked ticket resolves the intent — the reconciler stops treating it as owed');
    assert.equal(intent.last_reason, 'parked');
    assert.equal(intent.dispatch_generation, generationBeforePend, 'generation is frozen the moment the durable block pends the ticket');

    // A later sweep never revisits it — generation stays bounded forever, not
    // just for the one sweep right after the pend.
    await reconciler.reconcile(new Date(next + 10 * 60_000));
    intent = await intentRepo.findOne({ where: { id: intent.id } });
    assert.equal(intent.dispatch_generation, generationBeforePend, 'still frozen on a later sweep — no infinite generation growth');
  });

  await t.test('15: seed is SKIPPED once the holder already responded after entering this column (ticket fec25d90)', async () => {
    // Reproduces the production incident this ticket reports: an assignee left
    // an explicit "sequencing after a sibling ticket editing the same file"
    // comment shortly after the ticket was routed, then deliberately left the
    // ticket routed (no move_ticket / pend_ticket — by design, per the board's
    // single-file-overlap wait guidance) rather than actively working it. The
    // OLD seeder only measured "idle since the last progress signal" against
    // seedAfterMs — so once idle time since that comment crossed the threshold,
    // it seeded a BRAND NEW intent whose created_at postdates the comment. That
    // reseeded intent can never resolve via decideIntentReconcile's `progressed`
    // rule (which needs FRESH progress strictly after ITS OWN creation) — an
    // unbounded re-dispatch/escalation loop misdiagnosed as an agent/infra
    // failure, for what is actually a correct, deliberate pause.
    const waited = await mkTicket('assignee left a wait comment, then went quiet');
    const enteredAt = new Date(Date.now() - 6 * 60_000);      // entered this column 6 min ago
    const waitCommentAt = new Date(Date.now() - 4 * 60_000);  // responded 2 min later, silent since
    await ticketRepo.update(waited.id, { created_at: enteredAt });
    await commentRepo.save(commentRepo.create({
      ticket_id: waited.id, workspace_id: ws.id, author_type: 'agent', author: 'ralf',
      content: 'ee26302d touches the same file — sequencing after it lands, not starting yet',
      type: 'note', created_at: waitCommentAt,
    }));
    assert.equal(await intents.findOpenForTicketRole(waited.id, 'assignee'), null, 'no intent exists yet');

    // Control: a genuinely lost-emit sibling with NO engagement at all — the
    // original self-healing seed guarantee must still fire for it in the SAME
    // sweep, proving the fix is scoped rather than a wholesale seed disable.
    const lost = await mkTicket('genuinely lost emit, no engagement at all');
    await ticketRepo.update(lost.id, { created_at: new Date(Date.now() - 6 * 60_000) });

    // Sweep ~4 min after the wait comment — well past seedAfterMs=1min either way.
    await reconciler.reconcile(new Date());

    assert.equal(
      await intents.findOpenForTicketRole(waited.id, 'assignee'), null,
      'a holder who already responded after entering this column is NOT re-seeded — the dispatch was demonstrably not lost',
    );
    const seededAudits = await ds.getRepository('ActivityLog').find({
      where: { ticket_id: waited.id, action: 'dispatch_intent_seeded' },
    });
    assert.equal(seededAudits.length, 0, 'no dispatch_intent_seeded audit row for the ticket the assignee already responded on');

    const lostSeeded = await intents.findOpenForTicketRole(lost.id, 'assignee');
    assert.ok(lostSeeded, 'the genuinely lost-emit sibling is still seeded in the same sweep — the fix is scoped, not a wholesale seed disable');
    assert.equal(lostSeeded.trigger_source, 'reconcile_seed');
  });
});

test.after?.(() => exitAfterTests(0));
process.on('beforeExit', () => exitAfterTests(0));
