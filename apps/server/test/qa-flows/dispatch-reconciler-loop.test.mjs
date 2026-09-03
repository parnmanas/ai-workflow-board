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
//  15. seed is SKIPPED only when the ROLE HOLDER itself has responded since
//      entering the CURRENT column — an assignee-chosen wait (e.g. sequencing
//      around a sibling ticket editing the same file) is not a lost dispatch
//      (ticket fec25d90). Four angles in one scenario: (A) the holder itself
//      responds → skip; (B) a THIRD PARTY (reporter/other-role holder)
//      responds instead → the role's genuinely lost dispatch still seeds
//      (review blocker: role-scoped, not ticket-wide); (C) no engagement at
//      all → still seeds (self-healing preserved); (D) a same-timestamp
//      `moved` burst still resolves a deterministic entry time (review
//      blocker: `id` tiebreaker, not `created_at` alone).
//  16. 15번의 스킵을 매니저 재시작 사실과 교차한다 (ticket 4f1f33c6). self-update
//      가 drain 상한을 넘겨 진행 중 세션을 SIGTERM 하면 그 티켓은 "holder 가 이미
//      응답했다"는 이유로 정확히 재시드가 억제되는 상태에 놓여 조용히 멈춘다.
//      한 sweep 안에서 세 케이스를 함께 단언한다: (A) 재시작에 죽은 세션 → 재시드,
//      (B) 같은 재시작이지만 세션이 정상 종료 → 재시드 안 됨(fec25d90 유지),
//      (C) 죽은 세션이지만 매니저 재시작 없음 → 재시드 안 됨(재시작 사실이
//      load-bearing), (D) 같은 agent 를 두 호스트가 감독하고 host A 의 세션이
//      진행 중인데 host B 가 새로 등록 → 재시드 안 됨. B 를 빼면 fec25d90 회귀를
//      되살리면서 통과하고, C 를 빼면 "죽은 세션이면 무조건 재시드" 하는 구현도
//      통과하며, D 를 빼면 "하나라도 최신 인스턴스가 있으면 재시작" 이라는 존재
//      한정 구현이 통과한다(살아서 일하는 holder 를 재시드하는 회귀).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  setupKanbanScene, createAgent, createTicket, createApiKey,
} from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', '..', 'dist');

process.env.PORT = process.env.QA_DISPATCH_PORT || '7835';
// suppressed ACK의 manager provenance를 검증하므로 dev-mode 인증 우회를 끈다.
process.env.AGENT_API_KEY = 'qa-dispatch-reconciler-static-fallback';
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
  const { activityEvents } = await import('file://' + path.join(DIST_ROOT, 'services', 'activity.service.js'));

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

  await t.test('10b: HTTP suppressed outcome은 매 억제를 기록하되 intent를 변경하지 않는다', async () => {
    const ticket = await mkTicket('http suppression audit');
    const tids = [];
    for (let i = 0; i < 3; i += 1) {
      tids.push(await triggerLoop.emitAgentTrigger(ticket, agent.id, 'assignee', 'column_move', 'system'));
    }
    assert.ok(agent.manager_agent_id, 'fixture agent에 실제 런타임 호스트가 연결되어야 한다');
    const managerKey = (await createApiKey(app, getDataSourceToken, agent.manager_agent_id, {
      workspaceId: ws.id, label: 'mgr-suppression',
    })).raw_key;
    const post = (bodyObj) => fetch(`http://127.0.0.1:${port}/api/agent-manager/dispatch/ack`, {
      method: 'POST',
      headers: { 'X-Agent-Key': managerKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj),
    });
    const before = await intents.findOpenForTicketRole(ticket.id, 'assignee');

    for (let i = 0; i < 3; i += 1) {
      const resp = await fetch(`http://127.0.0.1:${port}/api/agent-manager/dispatch/ack`, {
        method: 'POST',
        headers: { 'X-Agent-Key': managerKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticket_id: ticket.id, role: 'assignee', trigger_id: tids[i],
          outcome: 'suppressed', reason: 'inflight_dispatch',
        }),
      });
      assert.equal(resp.status, 200, 'suppressed 보고를 wire endpoint가 받아야 한다');
    }

    const rows = await ds.getRepository('ActivityLog').find({
      where: { ticket_id: ticket.id, action: 'dispatch_twin_suppressed' },
    });
    assert.equal(rows.length, 3, '표시 알림 throttle과 무관하게 억제 N건이 각각 기록되어야 한다');
    const after = await intents.findOpenForTicketRole(ticket.id, 'assignee');
    assert.equal(after.status, before.status, 'suppressed 관측은 intent 상태를 바꾸면 안 된다');
    assert.equal(after.last_ack_kind, before.last_ack_kind, '진행 중 holder의 ack 상태를 덮으면 안 된다');

    const otherTicket = await mkTicket('other suppression audit');
    const otherTid = await triggerLoop.emitAgentTrigger(otherTicket, agent.id, 'assignee', 'column_move', 'system');
    const invalidCases = [
      { ticket_id: ticket.id, role: 'assignee', trigger_id: '존재하지-않는-trigger' },
      { ticket_id: ticket.id, role: 'reviewer', trigger_id: tids[0] },
      { ticket_id: ticket.id, role: 'assignee', trigger_id: otherTid },
    ];
    for (const invalid of invalidCases) {
      const resp = await post({ ...invalid, outcome: 'suppressed', reason: 'inflight_dispatch' });
      assert.equal(resp.status, 200);
      assert.equal((await resp.json()).applied, false, 'emit과 상관되지 않은 억제 보고는 적용하면 안 된다');
    }
    assert.equal(await ds.getRepository('ActivityLog').count({
      where: { ticket_id: ticket.id, action: 'dispatch_twin_suppressed' },
    }), 3, '미상관 trigger/role은 차감 activity를 만들면 안 된다');

    for (const source of ['manual', 'comment_summary']) {
      const excludedTriggerId = `${source}-suppression`;
      await ds.getRepository('ActivityLog').save({
        entity_type: 'ticket', entity_id: ticket.id, ticket_id: ticket.id,
        action: 'trigger_emitted', field_changed: excludedTriggerId,
        role: 'assignee', trigger_source: source,
      });
      const excluded = await post({
        ticket_id: ticket.id, role: 'assignee', trigger_id: excludedTriggerId,
        outcome: 'suppressed', reason: 'inflight_dispatch',
      });
      assert.equal((await excluded.json()).applied, false,
        `hard-budget 원시 집합에서 제외한 ${source} emit은 차감하면 안 된다`);
    }

    const forged = await fetch(`http://127.0.0.1:${port}/api/agent-manager/dispatch/ack`, {
      method: 'POST',
      headers: { 'X-Agent-Key': (await createApiKey(app, getDataSourceToken, agent.id, { workspaceId: ws.id, label: 'non-manager' })).raw_key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket_id: ticket.id, role: 'assignee', trigger_id: 'forged', outcome: 'suppressed' }),
    });
    assert.equal(forged.status, 403, '일반 agent는 hard-budget 차감 신호를 위조할 수 없어야 한다');
  });

  await t.test('10c: SSE 수신 즉시 도착한 suppressed ACK도 상관 행을 찾는다', async () => {
    const ticket = await mkTicket('immediate suppression correlation');
    assert.ok(agent.manager_agent_id, 'fixture agent에 실제 런타임 호스트가 연결되어야 한다');
    const managerKey = (await createApiKey(app, getDataSourceToken, agent.manager_agent_id, {
      workspaceId: ws.id, label: 'mgr-immediate-suppression',
    })).raw_key;

    let resolveAck;
    let rejectAck;
    const ackResult = new Promise((resolve, reject) => {
      resolveAck = resolve;
      rejectAck = reject;
    });
    const onTrigger = (event) => {
      if (event.ticket_id !== ticket.id) return;
      void fetch(`http://127.0.0.1:${port}/api/agent-manager/dispatch/ack`, {
        method: 'POST',
        headers: { 'X-Agent-Key': managerKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticket_id: ticket.id,
          role: 'assignee',
          trigger_id: event.trigger_id,
          outcome: 'suppressed',
          reason: 'inflight_dispatch',
        }),
      }).then(async (response) => ({ status: response.status, body: await response.json() }))
        .then(resolveAck, rejectAck);
    };
    activityEvents.on('agent_trigger', onTrigger);
    t.after(() => activityEvents.removeListener('agent_trigger', onTrigger));

    const triggerId = await triggerLoop.emitAgentTrigger(ticket, agent.id, 'assignee', 'column_move', 'system');
    const ack = await ackResult;
    activityEvents.removeListener('agent_trigger', onTrigger);

    assert.equal(ack.status, 200);
    assert.equal(ack.body.applied, true, 'SSE 리스너가 즉시 보낸 ACK도 이미 커밋된 emit과 상관되어야 한다');
    assert.equal(await ds.getRepository('ActivityLog').count({
      where: { ticket_id: ticket.id, action: 'dispatch_twin_suppressed', entity_id: triggerId },
    }), 1, '즉시 억제도 정확히 한 번 차감 activity로 남아야 한다');
  });

  await t.test('10d: mention_seat 억제 뒤에도 기존 승자의 processed ACK가 유지된다', async () => {
    const ticket = await mkTicket('mention seat suppression correlation');
    const winnerTriggerId = await triggerLoop.emitAgentTrigger(
      ticket, agent.id, 'assignee', 'column_move', 'system',
    );
    const winnerBeforeSuppression = await intents.findOpenForTicketRole(ticket.id, 'assignee');
    assert.ok(winnerBeforeSuppression, '승자 dispatch가 실제 open intent를 만들어야 한다');
    assert.equal(winnerBeforeSuppression.last_trigger_id, winnerTriggerId);

    const { recordCommentMentionDispatch } = await import(
      path.join(DIST_ROOT, 'common', 'mention-dispatch-correlation.js')
    );
    const suppressedTriggerId = await recordCommentMentionDispatch(ds, {
      ticketId: ticket.id,
      workspaceId: ws.id,
      agentId: agent.id,
      role: 'assignee',
    });
    const managerKey = (await createApiKey(app, getDataSourceToken, agent.manager_agent_id, {
      workspaceId: ws.id, label: 'mgr-mention-suppression',
    })).raw_key;
    const response = await fetch(`http://127.0.0.1:${port}/api/agent-manager/dispatch/ack`, {
      method: 'POST',
      headers: { 'X-Agent-Key': managerKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticket_id: ticket.id,
        role: 'assignee',
        trigger_id: suppressedTriggerId,
        outcome: 'suppressed',
        reason: 'mention_seat',
      }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).applied, true);
    const audit = await ds.getRepository('ActivityLog').findOne({
      where: {
        ticket_id: ticket.id,
        action: 'dispatch_twin_suppressed',
        entity_id: suppressedTriggerId,
      },
    });
    assert.ok(audit, 'mention 억제 ACK가 원본 trigger_emitted ID로 감사 행을 남겨야 한다');
    assert.equal(audit.field_changed, 'mention_seat');
    assert.equal(audit.role, 'assignee');
    assert.equal(audit.trigger_source, 'comment_mention');

    const winnerAfterSuppression = await intents.findOpenForTicketRole(ticket.id, 'assignee');
    assert.equal(winnerAfterSuppression.last_trigger_id, winnerTriggerId,
      'mention emit과 suppressed ACK가 기존 승자의 상관 키를 덮으면 안 된다');
    assert.equal(winnerAfterSuppression.last_ack_kind, winnerBeforeSuppression.last_ack_kind,
      '패자 억제는 승자의 ACK 상태를 바꾸면 안 된다');

    const processed = await intents.applyManagerAck({
      ticketId: ticket.id,
      role: 'assignee',
      triggerId: winnerTriggerId,
      outcome: 'processed',
    });
    assert.equal(processed.applied, true, '승자의 processed ACK가 적용되어야 한다');
    assert.equal(processed.matched, true, '승자의 trigger ID가 stale 처리되면 안 된다');
    const processedIntent = await intents.findOpenForTicketRole(ticket.id, 'assignee');
    assert.equal(processedIntent.last_trigger_id, winnerTriggerId);
    assert.equal(processedIntent.last_ack_kind, 'processed');
    const processedAudit = await ds.getRepository('ActivityLog').findOne({
      where: { ticket_id: ticket.id, action: 'dispatch_ack_processed' },
      order: { created_at: 'DESC', id: 'DESC' },
    });
    assert.ok(processedAudit, '승자의 processed 감사 행이 남아야 한다');
    const processedDetail = JSON.parse(processedAudit.new_value);
    assert.equal(processedDetail.trigger_id, winnerTriggerId);
    assert.equal(processedDetail.role, 'assignee');
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

  await t.test('15: seed is SKIPPED only when the ROLE HOLDER itself responded after entering this column (ticket fec25d90)', async () => {
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
    //
    // Review round 1 covered here:
    //   1. the skip must be scoped to the CURRENT ROLE's holder — a comment
    //      from a reporter / other-role holder must NOT suppress a genuinely
    //      lost assignee dispatch (scenario B).
    //   2. `_lastColumnEntryMs` needs a deterministic tiebreaker for a
    //      same-timestamp `moved` burst, not `created_at` alone (scenario D).
    //   3. the fixture creates a REAL `moved`/column ActivityLog row so
    //      `_lastColumnEntryMs`'s primary query is exercised, not just its
    //      ticket.created_at fallback.
    const reporter = await createAgent(app, getDataSourceToken, ws.id, { name: 'other-role-holder' });
    const activityLogRepo = ds.getRepository('ActivityLog');
    const moveActivity = (ticketId, at) => activityLogRepo.save(activityLogRepo.create({
      entity_type: 'ticket', entity_id: ticketId, ticket_id: ticketId, workspace_id: ws.id,
      action: 'moved', field_changed: 'column', old_value: 'To Do', new_value: 'In Progress',
      actor_id: 'system', actor_name: 'System', trigger_source: 'test', created_at: at,
    }));

    // --- A: the ASSIGNEE holder itself responds after column entry → skip. ---
    const waited = await mkTicket('assignee left a wait comment, then went quiet');
    const enteredAt = new Date(Date.now() - 6 * 60_000);      // entered this column 6 min ago
    const waitCommentAt = new Date(Date.now() - 4 * 60_000);  // responded 2 min later, silent since
    await ticketRepo.update(waited.id, { created_at: enteredAt });
    await moveActivity(waited.id, enteredAt);
    await commentRepo.save(commentRepo.create({
      ticket_id: waited.id, workspace_id: ws.id, author_type: 'agent', author: 'ralf', author_id: agent.id,
      content: 'ee26302d touches the same file — sequencing after it lands, not starting yet',
      type: 'note', created_at: waitCommentAt,
    }));
    assert.equal(await intents.findOpenForTicketRole(waited.id, 'assignee'), null, 'no intent exists yet');

    // --- B (review blocker #1): a THIRD PARTY (not the assignee holder)
    // comments after column entry, but the assignee's own dispatch is
    // genuinely lost — must still seed for the assignee role despite the
    // ticket-wide "someone commented" signal. ---
    const thirdParty = await mkTicket('reporter commented, but assignee dispatch is genuinely lost');
    const tpEnteredAt = new Date(Date.now() - 6 * 60_000);
    const tpCommentAt = new Date(Date.now() - 4 * 60_000);
    await ticketRepo.update(thirdParty.id, { created_at: tpEnteredAt });
    await moveActivity(thirdParty.id, tpEnteredAt);
    await commentRepo.save(commentRepo.create({
      ticket_id: thirdParty.id, workspace_id: ws.id, author_type: 'agent', author: 'other-role-holder',
      author_id: reporter.id, content: 'when will this land?', type: 'note', created_at: tpCommentAt,
    }));

    // --- C (control): a genuinely lost-emit sibling with NO engagement at
    // all — the original self-healing seed guarantee must still fire. ---
    const lost = await mkTicket('genuinely lost emit, no engagement at all');
    const lostEnteredAt = new Date(Date.now() - 6 * 60_000);
    await ticketRepo.update(lost.id, { created_at: lostEnteredAt });
    await moveActivity(lost.id, lostEnteredAt);

    // --- D (review blocker #2): a same-timestamp `moved` BURST (e.g. a quick
    // multi-hop promotion landing within the same wall-clock second) must
    // still resolve a deterministic entry time, and a holder comment strictly
    // AFTER that tied timestamp must still count as progress. ---
    const burst = await mkTicket('same-timestamp moved burst, then assignee responds');
    const burstAt = new Date(Date.now() - 6 * 60_000);
    await ticketRepo.update(burst.id, { created_at: burstAt });
    await Promise.all([moveActivity(burst.id, burstAt), moveActivity(burst.id, burstAt), moveActivity(burst.id, burstAt)]);
    await commentRepo.save(commentRepo.create({
      ticket_id: burst.id, workspace_id: ws.id, author_type: 'agent', author: 'ralf', author_id: agent.id,
      content: 'landed after the burst', type: 'note', created_at: new Date(Date.now() - 4 * 60_000),
    }));

    // Sweep ~4 min after the responses — well past seedAfterMs=1min either way.
    await reconciler.reconcile(new Date());

    assert.equal(
      await intents.findOpenForTicketRole(waited.id, 'assignee'), null,
      'the assignee holder itself responded after entering this column — NOT re-seeded, the dispatch was demonstrably not lost',
    );
    const seededAudits = await activityLogRepo.find({
      where: { ticket_id: waited.id, action: 'dispatch_intent_seeded' },
    });
    assert.equal(seededAudits.length, 0, 'no dispatch_intent_seeded audit row for the ticket the assignee already responded on');

    const thirdPartySeeded = await intents.findOpenForTicketRole(thirdParty.id, 'assignee');
    assert.ok(thirdPartySeeded, "a third party's comment does not suppress the assignee role's genuinely lost dispatch — still seeded");
    assert.equal(thirdPartySeeded.trigger_source, 'reconcile_seed');

    const lostSeeded = await intents.findOpenForTicketRole(lost.id, 'assignee');
    assert.ok(lostSeeded, 'the genuinely lost-emit sibling is still seeded in the same sweep — the fix is scoped, not a wholesale seed disable');
    assert.equal(lostSeeded.trigger_source, 'reconcile_seed');

    assert.equal(
      await intents.findOpenForTicketRole(burst.id, 'assignee'), null,
      'a same-timestamp moved burst still resolves a deterministic entry time — the later holder comment counts as progress, not re-seeded',
    );
  });

  await t.test('16: 15번의 스킵을 매니저 재시작 사실과 교차한다 (ticket 4f1f33c6)', async () => {
    // 이 보드의 관례는 착수 직후 claim + "작업을 시작합니다" 코멘트다. 그래서
    // self-update 가 drain 상한을 넘겨 진행 중 세션을 `self_update_restart` 로
    // SIGTERM 하면, 그 티켓은 15번이 만든 스킵 조건("holder 가 이미 응답했다")에
    // 정확히 걸려 재시드되지 않고 조용히 멈춘다. 재시드 스킵을 매니저 재시작
    // 사실과 교차해 그 구간에 걸린 in-flight role 만 되돌린다.
    const instanceRegistry = app.get(
      (await import('file://' + path.join(DIST_ROOT, 'modules', 'agent-manager', 'instance-registry.service.js')))
        .InstanceRegistryService,
    );
    const subagentRepo = ds.getRepository('Subagent');
    const activityLogRepo = ds.getRepository('ActivityLog');

    const enteredAt = new Date(Date.now() - 12 * 60_000);
    const respondedAt = new Date(Date.now() - 10 * 60_000);
    const sessionStartedAt = new Date(Date.now() - 11 * 60_000);

    const moveActivity = (ticketId, at) => activityLogRepo.save(activityLogRepo.create({
      entity_type: 'ticket', entity_id: ticketId, ticket_id: ticketId, workspace_id: ws.id,
      action: 'moved', field_changed: 'column', old_value: 'To Do', new_value: 'In Progress',
      actor_id: 'system', actor_name: 'System', trigger_source: 'test', created_at: at,
    }));
    // "작업을 시작합니다" — 15번의 스킵을 발동시키는 holder 본인의 응답.
    const startComment = (ticketId, authorId, authorName) => commentRepo.save(commentRepo.create({
      ticket_id: ticketId, workspace_id: ws.id, author_type: 'agent', author: authorName,
      author_id: authorId, content: '작업을 시작합니다 (assignee, To Do → In Progress).',
      type: 'note', created_at: respondedAt,
    }));
    const session = (ticketId, agentId, over) => subagentRepo.save(subagentRepo.create({
      subagent_id: randomUUID(), agent_id: agentId, workspace_id: ws.id, kind: 'ticket',
      session_key: `${ticketId}:assignee`, pid: 4242, started_at: sessionStartedAt,
      ticket_id: ticketId, role: 'assignee', ended_at: null, signal: null, exit_code: null,
      line_count: 0, ...over,
    }));
    // 매니저는 재시작할 때마다 새 instance_id + 새 started_at 으로 등록한다.
    const registerManager = (agentId, hostname, startedAt) => instanceRegistry.upsert({
      instance_id: randomUUID(), agent_id: agentId, workspace_id: ws.id, mode: 'manager',
      hostname, plugin_version: '1.0.0-test', cli: 'claude', cli_adapters: ['claude'],
      pid: 999, started_at: startedAt.toISOString(),
    });

    // 두 agent 로 나누는 이유: 레지스트리는 agent 단위라 "재시작한 매니저"와
    // "재시작하지 않은 매니저"를 같은 sweep 안에 공존시키려면 identity 를 분리해야
    // 한다. C 가 A/B 와 같은 매니저를 쓰면 재시작 사실 조건을 단언할 수 없다.
    const restartedAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'restart-victim' });
    const steadyAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'no-restart' });
    // 응답(10분 전) 이후인 6분 전에 부팅 = 그 응답을 낸 세션은 살아 있을 수 없다.
    registerManager(restartedAgent.id, 'host-restarted', new Date(Date.now() - 6 * 60_000));
    // 응답보다 먼저인 20분 전에 부팅 = 그 세션을 계속 안고 있었다.
    registerManager(steadyAgent.id, 'host-steady', new Date(Date.now() - 20 * 60_000));

    const mkFor = (title, agentId) => createTicket(app, getDataSourceToken, {
      columnId: columns.inProgress.id, workspaceId: ws.id, title, assigneeId: agentId,
    });

    // --- A: 재시작에 죽은 세션. 매니저가 종료를 보고하기 전에 사라져 행이 열린
    // 채로 남았다 — self-update 재시작의 가장 흔한 형태. ---
    const killed = await mkFor('self-update 재시작에 끊긴 작업', restartedAgent.id);
    await ticketRepo.update(killed.id, { created_at: enteredAt });
    await moveActivity(killed.id, enteredAt);
    await startComment(killed.id, restartedAgent.id, 'restart-victim');
    await session(killed.id, restartedAgent.id, {});

    // --- B (fec25d90 유지): 같은 매니저 재시작을 겪었지만, 세션은 그 전에 턴을
    // 마치고 정상 종료했다. holder 의 침묵은 선택된 대기다. ---
    const waiting = await mkFor('의도적으로 대기 중 — 세션은 정상 종료', restartedAgent.id);
    await ticketRepo.update(waiting.id, { created_at: enteredAt });
    await moveActivity(waiting.id, enteredAt);
    await startComment(waiting.id, restartedAgent.id, 'restart-victim');
    await session(waiting.id, restartedAgent.id, {
      ended_at: new Date(Date.now() - 9 * 60_000), signal: null, exit_code: 0,
    });

    // --- C: 세션은 SIGTERM 으로 죽었지만 매니저는 재시작하지 않았다. 재시작 사실이
    // 없으면 재시드하지 않는다 — 이 케이스가 없으면 "죽은 세션이면 무조건 재시드"
    // 하는 구현도 통과한다. ---
    const noRestart = await mkFor('세션은 죽었으나 매니저 재시작은 없었음', steadyAgent.id);
    await ticketRepo.update(noRestart.id, { created_at: enteredAt });
    await moveActivity(noRestart.id, enteredAt);
    await startComment(noRestart.id, steadyAgent.id, 'no-restart');
    await session(noRestart.id, steadyAgent.id, {
      ended_at: new Date(Date.now() - 9 * 60_000), signal: 'SIGTERM', exit_code: null,
    });

    // --- D (리뷰 반례): 같은 agent identity 를 두 호스트가 감독한다. host A 는
    // 응답 이전부터 계속 살아 있고 그 위에서 세션이 진행 중인데, host B 가 응답
    // 이후 새로 등록했다. "하나라도 최신 인스턴스가 있으면 재시작" 으로 판정하면
    // 살아서 일하는 holder 를 재시드해버린다 — fec25d90 회귀. ---
    const multiHostAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'multi-host' });
    registerManager(multiHostAgent.id, 'host-a', new Date(Date.now() - 20 * 60_000)); // 응답 이전부터 생존
    registerManager(multiHostAgent.id, 'host-b', new Date(Date.now() - 6 * 60_000));  // 응답 이후 신규 등록
    const multiHost = await mkFor('두 호스트가 감독 — host A 세션은 진행 중', multiHostAgent.id);
    await ticketRepo.update(multiHost.id, { created_at: enteredAt });
    await moveActivity(multiHost.id, enteredAt);
    await startComment(multiHost.id, multiHostAgent.id, 'multi-host');
    await session(multiHost.id, multiHostAgent.id, {});   // host A 에서 열려 있는 세션

    for (const tk of [killed, waiting, noRestart, multiHost]) {
      assert.equal(await intents.findOpenForTicketRole(tk.id, 'assignee'), null,
        `${tk.title}: sweep 전에는 열린 intent 가 없다`);
    }

    await reconciler.reconcile(new Date());

    const killedSeeded = await intents.findOpenForTicketRole(killed.id, 'assignee');
    assert.ok(killedSeeded, 'A: 매니저 재시작 구간에 걸린 holder 는 이미 응답했더라도 재시드된다');
    assert.equal(killedSeeded.trigger_source, 'reconcile_seed');
    const killedAudit = await activityLogRepo.find({
      where: { ticket_id: killed.id, action: 'dispatch_intent_seeded' },
    });
    assert.equal(killedAudit.length, 1, 'A: 재시드 감사 로그가 정확히 한 번 남는다');
    assert.equal(
      JSON.parse(killedAudit[0].new_value).reason, 'holder_session_lost_to_manager_restart',
      'A: 감사 로그가 일반 idle 재시드가 아니라 재시작 사유를 구분해 남긴다',
    );

    assert.equal(
      await intents.findOpenForTicketRole(waiting.id, 'assignee'), null,
      'B: 같은 재시작을 겪었어도 세션이 정상 종료했다면 재시드하지 않는다 (fec25d90 유지)',
    );
    assert.equal(
      (await activityLogRepo.find({ where: { ticket_id: waiting.id, action: 'dispatch_intent_seeded' } })).length, 0,
      'B: 재시드 감사 로그도 남지 않는다',
    );

    assert.equal(
      await intents.findOpenForTicketRole(noRestart.id, 'assignee'), null,
      'C: 세션이 죽었어도 매니저 재시작 사실이 없으면 재시드하지 않는다',
    );
    assert.equal(
      (await activityLogRepo.find({ where: { ticket_id: noRestart.id, action: 'dispatch_intent_seeded' } })).length, 0,
      'C: 재시드 감사 로그도 남지 않는다',
    );

    assert.equal(
      await intents.findOpenForTicketRole(multiHost.id, 'assignee'), null,
      'D: 응답 시점부터 살아 있는 매니저가 하나라도 있으면, 다른 호스트가 새로 등록해도 재시드하지 않는다',
    );
    assert.equal(
      (await activityLogRepo.find({ where: { ticket_id: multiHost.id, action: 'dispatch_intent_seeded' } })).length, 0,
      'D: 재시드 감사 로그도 남지 않는다',
    );

    // 재시드는 재시작 1회당 1회로 유한하다 — A 의 holder 가 재디스패치에 응답하면
    // 그 응답이 재시작 시각보다 나중이라 다음 sweep 은 다시 재시드하지 않는다.
    // 이 단언이 없으면 fec25d90 이 경계한 무한 재시드 루프를 되살린 구현도 통과한다.
    await intentRepo.update(killedSeeded.id, { status: 'resolved', resolved_at: new Date() });
    await commentRepo.save(commentRepo.create({
      ticket_id: killed.id, workspace_id: ws.id, author_type: 'agent', author: 'restart-victim',
      author_id: restartedAgent.id, content: '재시작 뒤 이어서 작업합니다', type: 'note',
      created_at: new Date(Date.now() - 3 * 60_000),
    }));
    await reconciler.reconcile(new Date());
    assert.equal(
      await intents.findOpenForTicketRole(killed.id, 'assignee'), null,
      'A-후속: 재시작 이후의 응답이 있으면 같은 재시작으로 다시 재시드하지 않는다 (루프 부재)',
    );
  });
});

test.after?.(() => exitAfterTests(0));
process.on('beforeExit', () => exitAfterTests(0));
