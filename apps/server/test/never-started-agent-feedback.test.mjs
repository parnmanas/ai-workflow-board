// Regression — never-started / offline agent gets FEEDBACK + AUTO-START instead
// of a silent drop (ticket bfdd80b7).
//
// P4c-4 rewrite: Agent 테이블이 없다. 정체성은 RuntimeHost 행 또는 api_keys
// 페어링 링크로 해소하고, 모든 id 는 UUID 형태를 쓴다 (비-UUID 는 runtime
// holder 로 보고 autostart 가 조용히 건너뛴다 — classify 조기 리턴).
// spawn 실발행은 이 레이어에 working_dir 이 없어 항상 분류 실패로 끝난다
// (issueSpawnAgent 는 절대 ok:true 를 내지 않는다) — 피드백은 그 분류 사유를
// 정직하게 말한다.
//
// Proves at the service layer (no NestFactory — services constructed directly
// with fakes, the house style):
//   (a) chat to an unreachable host-bound identity → a room system message is
//       posted with the classified reason (no silent drop, no emission).
//   (b) ticket dispatch to an unreachable identity → a `dispatch_deferred`
//       ticket activity is logged with the classified reason.
//   (c) every failure classifies (agent_not_found / manager_offline /
//       no_working_dir) — never thrown, never silent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');

async function loadDist(relParts) {
  const url = 'file://' + path.join(DIST, ...relParts);
  try {
    return await import(url);
  } catch (err) {
    throw new Error(
      'This test requires the server to be built first. Run `npm run --workspace=apps/server build`. Original error: ' +
        err.message,
    );
  }
}

const noopLog = { info() {}, warn() {}, error() {}, debug() {}, log() {} };

// ── fakes ───────────────────────────────────────────────────────────────────

function hostRepoOf(hosts) {
  return {
    async findOne({ where }) {
      return hosts.find((h) => h.id === where.id) ?? null;
    },
  };
}

function linkRepoOf(links) {
  return {
    async findOne({ where }) {
      return links.find((l) => l.agent_id === where.agent_id) ?? null;
    },
  };
}

// InstanceRegistryService stand-in — only list() is consulted.
function registryOf(instances) {
  return { list: () => instances.slice() };
}

// Stateful AgentStatusService stand-in for the auto-start markers.
function agentStatusFake() {
  const starting = new Set();
  const errors = new Map();
  return {
    markStarting(id) { starting.add(id); errors.delete(id); },
    markStartError(id, r) { errors.set(id, r); starting.delete(id); },
    isStarting(id) { return starting.has(id); },
    getStartError(id) { return errors.get(id); },
  };
}

function activityFake() {
  const logged = [];
  return { logged, async logActivity(p) { logged.push(p); return p; } };
}

function roomMessagingFake() {
  const sent = [];
  return { sent, async sendSystemMessage(roomId, wsId, content) { sent.push({ roomId, wsId, content }); return { id: 'sys' }; } };
}

async function buildCommandService(registry, { hosts = [], links = [] } = {}) {
  const { AgentManagerCommandService } = await loadDist(['modules', 'agent-manager', 'agent-manager-command.service.js']);
  const { CommandLedgerService } = await loadDist(['modules', 'agent-manager', 'command-ledger.service.js']);
  const { MemoryMetricsRegistry } = await loadDist(['services', 'memory-metrics.registry.js']);
  const ledger = new CommandLedgerService(new MemoryMetricsRegistry());
  const svc = new AgentManagerCommandService(registry, ledger, noopLog, hostRepoOf(hosts), linkRepoOf(links));
  return { svc, ledger };
}

// Live-SSE reachability stand-in. Default: nothing reachable (never-started
// agents stay unreachable); pass `reachable` ids for the reachable-path checks.
function connectivityOf(reachable = []) {
  const set = new Set(reachable);
  return { isReachable: (id) => set.has(id) };
}

function metricsFake() {
  return { register() {} };
}

async function buildAutostart({ hosts = [], links = [], instances, agentStatus, activity, roomMessaging, connectivity }) {
  const { AgentAutostartService } = await loadDist(['modules', 'agents', 'agent-autostart.service.js']);
  const registry = registryOf(instances);
  const conn = connectivity ?? connectivityOf();
  const { svc: managerCommand } = await buildCommandService(registry, { hosts, links });
  // Reachability now lives on AgentStatusService.isReachable (ticket 1f750878) —
  // the autostart service delegates to it (no longer injects Instance/Connectivity
  // directly). Augment the passed fake with the SAME OR over the test's
  // connectivity + instances so classify() resolves reachability identically.
  // The spread preserves the marker closures, so the test's assertions on the
  // original agentStatus (markStarting/getStartError) still observe the mutations.
  const status = {
    ...agentStatus,
    isReachable: (id, isOnlineFallback) =>
      conn.isReachable(id) ||
      instances.some(
        (i) => (i.mode !== 'manager' && i.agent_id === id) || (Array.isArray(i.agent_ids) && i.agent_ids.includes(id)),
      ) ||
      !!isOnlineFallback,
  };
  return new AgentAutostartService(
    hostRepoOf(hosts),
    linkRepoOf(links),
    managerCommand,
    status,
    activity,
    roomMessaging,
    noopLog,
    metricsFake(),
    { isQuiesced: async () => false },
  );
}

// Capture agent_manager_command emissions on the shared bus for the window of a
// callback, then detach. P4c-4: this layer never emits — used for no-emit assertions.
async function captureCommands(fn) {
  const { activityEvents } = await loadDist(['services', 'activity.service.js']);
  const seen = [];
  const listener = (e) => seen.push(e);
  activityEvents.on('agent_manager_command', listener);
  try { await fn(); } finally { activityEvents.removeListener('agent_manager_command', listener); }
  return seen;
}

// Fixed UUID identities (classify skips non-UUID ids as runtime holders).
const HOST_BOB = '11111111-1111-4111-8111-111111111111';
const HOST_ALICE = '22222222-2222-4222-8222-222222222222';
const UNKNOWN_ID = '33333333-3333-4333-8333-333333333333';
function liveManagerInstance(hostId) {
  return { instance_id: 'inst-1', agent_id: 'mgr-1', host_id: hostId, mode: 'manager', agent_ids: [], started_at: '2026-07-18T00:00:00.000Z' };
}

// ── pure classifier ─────────────────────────────────────────────────────────

test('deriveAgentLifecycleState — never_started vs offline vs online, precedence', async () => {
  const { deriveAgentLifecycleState, isUnreachableState, agentLifecycleLabel } = await loadDist(['common', 'agent-lifecycle.js']);

  assert.equal(deriveAgentLifecycleState({ isOnline: false, connectedAt: null }), 'never_started', 'never connected → never_started');
  assert.equal(deriveAgentLifecycleState({ isOnline: false, connectedAt: null, isStarting: true }), 'starting', 'spawn dispatched → starting');
  assert.equal(deriveAgentLifecycleState({ isOnline: false, connectedAt: null, isStarting: true, hasRecentStartError: true }), 'error', 'error outranks starting');
  assert.equal(deriveAgentLifecycleState({ isOnline: true, connectedAt: null }), 'online', 'reachable → online (wins over never_started)');
  assert.equal(deriveAgentLifecycleState({ isOnline: false, connectedAt: new Date() }), 'offline', 'was connected, now down → offline');
  assert.equal(deriveAgentLifecycleState({ isOnline: true, connectedAt: null, hasRecentStartError: true }), 'online', 'online outranks error');

  assert.equal(isUnreachableState('never_started'), true);
  assert.equal(isUnreachableState('online'), false);
  assert.equal(agentLifecycleLabel('never_started'), '미시작');
});

// ── spawn-command feasibility (the auto-start decision) ─────────────────────

test('issueSpawnAgent — classifies every failure, never emits (P4c-4: spawn needs working_dir this layer lacks)', async () => {
  // unknown identity — no Host row, no link.
  {
    const { svc } = await buildCommandService(registryOf([]), {});
    const cmds = await captureCommands(async () => {
      const r = await svc.issueSpawnAgent(UNKNOWN_ID, 'test');
      assert.equal(r.ok, false); assert.equal(r.reason, 'agent_not_found');
    });
    assert.equal(cmds.length, 0, 'no spawn command emitted for an unknown identity');
  }
  // known Host but no live instance.
  {
    const { svc } = await buildCommandService(
      registryOf([]), { hosts: [{ id: HOST_BOB, name: 'Rolf' }] },
    );
    const r = await svc.issueSpawnAgent(HOST_BOB, 'test');
    assert.equal(r.reason, 'manager_offline');
  }
  // known Host + live instance — still no emission: working_dir lives outside
  // this layer, so the honest classification is no_working_dir.
  {
    const { svc } = await buildCommandService(
      registryOf([liveManagerInstance(HOST_BOB)]), { hosts: [{ id: HOST_BOB, name: 'Rolf' }] },
    );
    const cmds = await captureCommands(async () => {
      const r = await svc.issueSpawnAgent(HOST_BOB, 'test');
      assert.equal(r.ok, false); assert.equal(r.reason, 'no_working_dir');
    });
    assert.equal(cmds.length, 0, 'this layer classifies, it does not dispatch spawn_agent');
  }
  // Retired Agent aliases no longer resolve to a Host.
  {
    const { svc } = await buildCommandService(
      registryOf([liveManagerInstance(HOST_ALICE)]),
      { hosts: [{ id: HOST_ALICE, name: 'Alice' }], links: [{ agent_id: HOST_BOB, host_id: HOST_ALICE }] },
    );
    const r = await svc.issueSpawnAgent(HOST_BOB, 'test');
    assert.equal(r.reason, 'agent_not_found');
  }
});

// ── (b) ticket path: activity feedback + auto-start ─────────────────────────

test('maybeHandleUnreachableTicket — reachable agent dispatches normally (no feedback)', async () => {
  const activity = activityFake();
  const svc = await buildAutostart({
    hosts: [{ id: HOST_BOB, name: 'Rolf' }], instances: [],
    agentStatus: agentStatusFake(), activity, roomMessaging: roomMessagingFake(),
    connectivity: connectivityOf([HOST_BOB]),
  });
  const handled = await svc.maybeHandleUnreachableTicket({ ticket: { id: 't1', account_id: 'w' }, agentId: HOST_BOB, role: 'assignee', triggerSource: 'column_move', triggeredBy: 'user' });
  assert.equal(handled, false, 'reachable agent → not handled → caller emits normally');
  assert.equal(activity.logged.length, 0, 'no dispatch_deferred for a reachable agent');
});

test('classify — live-instance-supervised identity with no connectivity is reachable (no false silent-drop)', async () => {
  const activity = activityFake();
  const svc = await buildAutostart({
    hosts: [{ id: HOST_BOB, name: 'Rolf' }], instances: [liveManagerInstance(HOST_BOB)],
    agentStatus: agentStatusFake(), activity, roomMessaging: roomMessagingFake(),
  });
  const cls = await svc.classify(HOST_BOB);
  assert.equal(cls.reachable, true, 'a supervising live instance makes it reachable');
  const handled = await svc.maybeHandleUnreachableTicket({ ticket: { id: 't1', account_id: 'w' }, agentId: HOST_BOB, role: 'assignee', triggerSource: 'column_move', triggeredBy: 'user' });
  assert.equal(handled, false, 'reachable → caller dispatches normally, no feedback');
  assert.equal(activity.logged.length, 0, 'no dispatch_deferred for a supervised identity');
});

test('maybeHandleUnreachableTicket — offline Host: classified-failure feedback, no silent drop', async () => {
  const agentStatus = agentStatusFake();
  const activity = activityFake();
  const cmds = await captureCommands(async () => {
    const svc = await buildAutostart({
      hosts: [{ id: HOST_BOB, name: 'Rolf' }], instances: [],
      agentStatus, activity, roomMessaging: roomMessagingFake(),
    });
    const handled = await svc.maybeHandleUnreachableTicket({ ticket: { id: 't1', account_id: 'w' }, agentId: HOST_BOB, role: 'assignee', triggerSource: 'column_move', triggeredBy: 'user' });
    assert.equal(handled, true, 'unreachable → feedback handled (emit still proceeds additively)');
  });
  assert.equal(cmds.length, 0, 'this layer never emits spawn_agent');
  assert.equal(agentStatus.getStartError(HOST_BOB), 'manager_offline', 'error marker set with the specific reason');
  assert.equal(activity.logged.length, 1, 'one dispatch_deferred activity logged (live SSE + comment projection)');
  const row = activity.logged[0];
  assert.equal(row.action, 'dispatch_deferred');
  assert.equal(row.ticket_id, 't1');
  assert.equal(row.field_changed, 'never_started', 'lifecycle state carried on field_changed');
  assert.match(row.new_value, /자동 시작할 수 없습니다/, 'message states auto-start could NOT run');
  assert.match(row.new_value, /오프라인/, 'message names the offline-Host reason');
});

// ── (c) auto-start failure is surfaced (no silent drop) ─────────────────────

test('maybeHandleUnreachableTicket — unknown identity: handled, silent (nothing to start)', async () => {
  const agentStatus = agentStatusFake();
  const activity = activityFake();
  const svc = await buildAutostart({
    hosts: [], instances: [],
    agentStatus, activity, roomMessaging: roomMessagingFake(),
  });
  const handled = await svc.maybeHandleUnreachableTicket({ ticket: { id: 't1', account_id: 'w' }, agentId: UNKNOWN_ID, role: 'assignee', triggerSource: 'column_move', triggeredBy: 'user' });
  assert.equal(handled, true, 'vanished identity → handled (skip), no target to start');
  assert.equal(agentStatus.getStartError(UNKNOWN_ID), undefined, 'no marker for a non-existent identity');
  assert.equal(activity.logged.length, 0, 'no feedback when there is nothing to start');
});

test('ticket feedback is debounced (supervisor/reconciler re-push does not spam)', async () => {
  const agentStatus = agentStatusFake();
  const activity = activityFake();
  const svc = await buildAutostart({
    hosts: [{ id: HOST_BOB, name: 'Rolf' }], instances: [],
    agentStatus, activity, roomMessaging: roomMessagingFake(),
  });
  const args = { ticket: { id: 't1', account_id: 'w' }, agentId: HOST_BOB, role: 'assignee', triggerSource: 'supervisor', triggeredBy: 'system' };
  await svc.maybeHandleUnreachableTicket(args);
  await svc.maybeHandleUnreachableTicket(args); // immediate re-push
  await svc.maybeHandleUnreachableTicket(args);
  assert.equal(activity.logged.length, 1, 'feedback comment written once for the same unchanged situation (feedback debounce)');
});

// ── (a) chat path: room system message + classified reason ──────────────────

test('chat path — unreachable identity gets a room system message with the reason', async () => {
  const { AGENT_AUTOSTART_REQUESTED } = await loadDist(['common', 'agent-autostart-events.js']);
  const { activityEvents } = await loadDist(['services', 'activity.service.js']);
  const agentStatus = agentStatusFake();
  const roomMessaging = roomMessagingFake();

  const cmds = await captureCommands(async () => {
    const svc = await buildAutostart({
      hosts: [{ id: HOST_BOB, name: 'Rolf' }], instances: [],
      agentStatus, activity: activityFake(), roomMessaging,
    });
    svc.onModuleInit();
    // Fire the internal signal RoomMessagingService emits and let the handler run.
    activityEvents.emit(AGENT_AUTOSTART_REQUESTED, { agent_id: HOST_BOB, agent_name: 'Rolf', room_id: 'room-1', account_id: 'w', source: 'chat' });
    await new Promise((r) => setTimeout(r, 20)); // handler is async off the bus
    svc.onModuleDestroy();
  });

  assert.equal(roomMessaging.sent.length, 1, 'a room system message was posted (no silent drop)');
  assert.equal(roomMessaging.sent[0].roomId, 'room-1');
  assert.match(roomMessaging.sent[0].content, /Rolf/, 'names the target identity');
  assert.match(roomMessaging.sent[0].content, /자동 시작할 수 없습니다/, 'states the classified failure honestly');
  assert.equal(cmds.length, 0, 'no spawn_agent emission from the chat path either');
  assert.equal(agentStatus.getStartError(HOST_BOB), 'manager_offline', 'failure marker set');
});

test('chat path — reachable agent produces NO system message (no false noise)', async () => {
  const { AGENT_AUTOSTART_REQUESTED } = await loadDist(['common', 'agent-autostart-events.js']);
  const { activityEvents } = await loadDist(['services', 'activity.service.js']);
  const roomMessaging = roomMessagingFake();
  const svc = await buildAutostart({
    hosts: [{ id: HOST_BOB, name: 'Rolf' }], instances: [],
    agentStatus: agentStatusFake(), activity: activityFake(), roomMessaging,
    connectivity: connectivityOf([HOST_BOB]),
  });
  svc.onModuleInit();
  activityEvents.emit(AGENT_AUTOSTART_REQUESTED, { agent_id: HOST_BOB, agent_name: 'Rolf', room_id: 'room-1', account_id: 'w', source: 'chat' });
  await new Promise((r) => setTimeout(r, 20));
  svc.onModuleDestroy();
  assert.equal(roomMessaging.sent.length, 0, 'reachable agent → the hub stays silent (classify is the authority)');
});

// ─────────────────────────────────────────────────────────────────────────────
// Follow-up 3 (ticket 1f750878): reachability unification · debounce-map TTL.
// ─────────────────────────────────────────────────────────────────────────────

// Real AgentStatusService (fakes for the DB / registries) — exercises the SHARED
// reachability + error-detail logic the SSE badge, REST badge and dispatch gate
// all now delegate to. onModuleInit (DB seed + sweep) is never called.
async function buildAgentStatus({ instances = [], reachable = [] } = {}) {
  const { AgentStatusService } = await loadDist(['modules', 'agents', 'agent-status.service.js']);
  // P4c-4: constructor is (dataSource, logService, metrics, connectivity,
  // instanceRegistry) — no agentRepo (no Agent table).
  const dataSource = { getRepository() { return { async find() { return []; } }; } };
  return new AgentStatusService(dataSource, noopLog, metricsFake(), connectivityOf(reachable), registryOf(instances));
}

// ── #2 reachability — the SINGLE isReachable definition ─────────────────────
test('isReachable — Runtime Host connectivity or supervision only', async () => {
  // Runtime Host delivery connectivity makes its managed identity reachable.
  const viaSse = await buildAgentStatus({ reachable: ['a'] });
  assert.equal(viaSse.isReachable('a', false), true, 'live Runtime Host delivery → reachable');
  assert.equal(viaSse.isReachable('other', false), false, 'no Runtime Host signal → not reachable');

  // A Runtime Host instance listing the agent in agent_ids[] carries it.
  const viaMgr = await buildAgentStatus({ instances: [{ instance_id: 'i', agent_id: 'mgr', mode: 'manager', agent_ids: ['b'], started_at: 't' }] });
  assert.equal(viaMgr.isReachable('b', false), true, 'Runtime Host agent_ids[] carries it → reachable');
  assert.equal(viaMgr.isReachable('mgr', false), true, 'the Runtime Host identity owns the live instance');

  // A stale/direct DB online bit is never an execution route.
  const plain = await buildAgentStatus();
  assert.equal(plain.isReachable('c', true), false, 'is_online alone → unreachable');
  assert.equal(plain.isReachable('c', false), false, 'nothing → not reachable');
  assert.equal(plain.isReachable('', true), false, 'empty id is never reachable');
});

// ── #1 error surfacing — markStartError → error state + concrete detail ─────
test('markStartError → error lifecycle + concrete detail surfaced, no silent revert (ticket 1f750878 #1)', async () => {
  const svc = await buildAgentStatus();

  // Manager-side spawn-failure detail (free-form) surfaces verbatim so "구체
  // 실패 사유" is visible instead of the badge silently flipping back to 미시작.
  svc.markStartError('a', 'spawn_agent: working_dir is empty');
  assert.equal(svc.lifecycleStateFor('a', false, null), 'error', 'start error → error lifecycle state');
  assert.equal(svc.isStarting('a'), false, 'markStartError clears the starting marker (no 시작 중→미시작 revert)');
  assert.equal(svc.lifecycleDetailFor('a', 'error'), 'spawn_agent: working_dir is empty', 'raw manager detail passes through as the reason');
  assert.equal(svc.lifecycleDetailFor('a', 'online'), undefined, 'detail is only surfaced for the error state');

  // A known feasibility slug is localized (shared with the autostart feedback copy).
  svc.markStartError('b', 'manager_offline');
  assert.match(svc.lifecycleDetailFor('b', 'error'), /오프라인/, 'known slug → localized label');

  // markStarting supersedes the error (a fresh spawn dispatch).
  svc.markStarting('a');
  assert.equal(svc.lifecycleStateFor('a', false, null), 'starting');
  assert.equal(svc.lifecycleDetailFor('a', 'starting'), undefined, 'no detail once back to starting');
});

// ── #3 debounce maps — TTL eviction ─────────────────────────────────────────
test('debounce maps evict stale entries, keep fresh (ticket 1f750878 #3)', async () => {
  const svc = await buildAutostart({
    hosts: [{ id: HOST_BOB, name: 'Rolf' }], instances: [liveManagerInstance(HOST_BOB)],
    agentStatus: agentStatusFake(), activity: activityFake(), roomMessaging: roomMessagingFake(),
  });
  const now = Date.now();
  const OLD = now - 24 * 60 * 60_000; // 24h ago — older than every debounce window
  // Seed the private maps directly (TS `private` compiles to a plain property).
  svc.lastSpawnAt.set('stale', OLD);
  svc.lastSpawnAt.set('fresh', now);
  svc.lastTicketFeedback.set('t:stale', { at: OLD, sig: 'ok' });
  svc.lastTicketFeedback.set('t:fresh', { at: now, sig: 'ok' });
  svc.lastChatFeedback.set('c:stale', OLD);
  svc.lastChatFeedback.set('c:fresh', now);

  svc._evictStaleDebounce();

  assert.equal(svc.lastSpawnAt.has('stale'), false, 'stale spawn entry evicted');
  assert.equal(svc.lastSpawnAt.has('fresh'), true, 'fresh spawn entry kept');
  assert.equal(svc.lastTicketFeedback.has('t:stale'), false, 'stale ticket-feedback entry evicted');
  assert.equal(svc.lastTicketFeedback.has('t:fresh'), true, 'fresh ticket-feedback entry kept');
  assert.equal(svc.lastChatFeedback.has('c:stale'), false, 'stale chat-feedback entry evicted');
  assert.equal(svc.lastChatFeedback.has('c:fresh'), true, 'fresh chat-feedback entry kept');
});
