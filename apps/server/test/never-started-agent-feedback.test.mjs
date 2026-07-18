// Regression — never-started / offline agent gets FEEDBACK + AUTO-START instead
// of a silent drop (ticket bfdd80b7).
//
// Proves the three requirements end-to-end at the service layer (no NestFactory
// — services constructed directly with fakes, the house style):
//   (a) chat to a never-started agent → a room system message is posted AND an
//       auto-start (spawn_agent) is attempted.
//   (b) ticket dispatch to a never-started agent → a `dispatch_deferred` ticket
//       activity is logged (rides the live SSE + projects a comment) AND an
//       auto-start is attempted.
//   (c) auto-start that can't run (no manager / manager offline / no working
//       dir) surfaces the SPECIFIC reason in the feedback — never a silent drop.
//
// Also unit-covers the pure lifecycle classifier and the spawn-command service's
// feasibility classification (the auto-start decision the manager relies on).

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

function agentRepoOf(rows) {
  return {
    async findOne({ where }) {
      return rows.find((r) => r.id === where.id) ?? null;
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

async function buildCommandService(registry, agentRows) {
  const { AgentManagerCommandService } = await loadDist(['modules', 'agent-manager', 'agent-manager-command.service.js']);
  const { CommandLedgerService } = await loadDist(['modules', 'agent-manager', 'command-ledger.service.js']);
  const { MemoryMetricsRegistry } = await loadDist(['services', 'memory-metrics.registry.js']);
  const ledger = new CommandLedgerService(new MemoryMetricsRegistry());
  const svc = new AgentManagerCommandService(registry, ledger, noopLog, agentRepoOf(agentRows));
  return { svc, ledger };
}

// Live-SSE reachability stand-in. Default: nothing reachable (never-started
// agents stay unreachable); pass `reachable` ids for the reachable-path checks.
function connectivityOf(reachable = []) {
  const set = new Set(reachable);
  return { isReachable: (id) => set.has(id) };
}

async function buildAutostart({ agentRows, instances, agentStatus, activity, roomMessaging, connectivity }) {
  const { AgentAutostartService } = await loadDist(['modules', 'agents', 'agent-autostart.service.js']);
  const registry = registryOf(instances);
  const { svc: managerCommand } = await buildCommandService(registry, agentRows);
  const service = new AgentAutostartService(
    agentRepoOf(agentRows),
    registry,
    connectivity ?? connectivityOf(),
    managerCommand,
    agentStatus,
    activity,
    roomMessaging,
    noopLog,
  );
  return service;
}

// Capture agent_manager_command emissions on the shared bus for the window of a
// callback, then detach — a spawn attempt lands here.
async function captureCommands(fn) {
  const { activityEvents } = await loadDist(['services', 'activity.service.js']);
  const seen = [];
  const listener = (e) => seen.push(e);
  activityEvents.on('agent_manager_command', listener);
  try { await fn(); } finally { activityEvents.removeListener('agent_manager_command', listener); }
  return seen;
}

const MANAGER_ID = 'mgr-1';
function liveManagerInstance() {
  return { instance_id: 'inst-1', agent_id: MANAGER_ID, mode: 'manager', agent_ids: [], started_at: '2026-07-18T00:00:00.000Z' };
}
// A managed, never-started agent whose manager IS online and has a working dir.
function startableAgent(id = 'agent-1') {
  return { id, name: 'Bob', type: 'claude', is_online: 0, connected_at: null, last_seen_at: null, manager_agent_id: MANAGER_ID, working_dir: '/work/bob' };
}

// ── pure classifier ─────────────────────────────────────────────────────────

test('deriveAgentLifecycleState — never_started vs offline vs online, precedence', async () => {
  const { deriveAgentLifecycleState, isUnreachableState, agentLifecycleLabel } = await loadDist(['common', 'agent-lifecycle.js']);

  assert.equal(deriveAgentLifecycleState({ isOnline: false, connectedAt: null }), 'never_started', 'never connected → never_started');
  assert.equal(deriveAgentLifecycleState({ isOnline: false, connectedAt: new Date() }), 'offline', 'was connected, now down → offline');
  assert.equal(deriveAgentLifecycleState({ isOnline: true, connectedAt: null }), 'online', 'reachable → online (wins over never_started)');
  assert.equal(deriveAgentLifecycleState({ isOnline: false, connectedAt: null, isStarting: true }), 'starting', 'spawn dispatched → starting');
  assert.equal(deriveAgentLifecycleState({ isOnline: false, connectedAt: null, isStarting: true, hasRecentStartError: true }), 'error', 'error outranks starting');
  assert.equal(deriveAgentLifecycleState({ isOnline: true, connectedAt: null, hasRecentStartError: true }), 'online', 'online outranks error');

  assert.equal(isUnreachableState('never_started'), true);
  assert.equal(isUnreachableState('online'), false);
  assert.equal(agentLifecycleLabel('never_started'), '미시작');
});

// ── spawn-command feasibility (the auto-start decision) ─────────────────────

test('issueSpawnAgent — classifies every failure, only emits when feasible', async () => {
  // no manager linked
  {
    const a = { id: 'a', name: 'A', type: 'claude', manager_agent_id: null, working_dir: '/w' };
    const { svc } = await buildCommandService(registryOf([]), [a]);
    const cmds = await captureCommands(async () => {
      const r = await svc.issueSpawnAgent('a', 'test');
      assert.equal(r.ok, false); assert.equal(r.reason, 'no_manager_linked');
    });
    assert.equal(cmds.length, 0, 'no spawn command emitted when no manager linked');
  }
  // manager linked but offline (no live instance)
  {
    const a = startableAgent('b');
    const { svc } = await buildCommandService(registryOf([]), [a]);
    const r = await svc.issueSpawnAgent('b', 'test');
    assert.equal(r.reason, 'manager_offline');
  }
  // manager online but no working_dir
  {
    const a = { ...startableAgent('c'), working_dir: '' };
    const { svc } = await buildCommandService(registryOf([liveManagerInstance()]), [a]);
    const r = await svc.issueSpawnAgent('c', 'test');
    assert.equal(r.reason, 'no_working_dir');
  }
  // feasible → emits agent_manager_command spawn_agent
  {
    const a = startableAgent('d');
    const { svc } = await buildCommandService(registryOf([liveManagerInstance()]), [a]);
    const cmds = await captureCommands(async () => {
      const r = await svc.issueSpawnAgent('d', 'test');
      assert.equal(r.ok, true); assert.equal(r.reason, 'ok'); assert.equal(r.instance_id, 'inst-1');
    });
    assert.equal(cmds.length, 1, 'exactly one spawn command emitted');
    assert.equal(cmds[0].command, 'spawn_agent');
    assert.equal(cmds[0].instance_id, 'inst-1');
    assert.equal(cmds[0].args.agent_id, 'd', 'target agent rides in args.agent_id');
    assert.equal(cmds[0].args.working_dir, '/work/bob', 'hydrated working_dir from the agent row');
  }
});

// ── (b) ticket path: activity feedback + auto-start ─────────────────────────

test('maybeHandleUnreachableTicket — reachable agent dispatches normally (no feedback)', async () => {
  const agent = { id: 'agent-1', name: 'Bob', is_online: 1, connected_at: new Date(), manager_agent_id: MANAGER_ID, working_dir: '/w' };
  const activity = activityFake();
  const svc = await buildAutostart({ agentRows: [agent], instances: [], agentStatus: agentStatusFake(), activity, roomMessaging: roomMessagingFake() });
  const handled = await svc.maybeHandleUnreachableTicket({ ticket: { id: 't1', workspace_id: 'w' }, agentId: 'agent-1', role: 'assignee', triggerSource: 'column_move', triggeredBy: 'user' });
  assert.equal(handled, false, 'online agent → not handled → caller emits normally');
  assert.equal(activity.logged.length, 0, 'no dispatch_deferred for a reachable agent');
});

test('classify — SSE-reachable agent with is_online=0 is NOT deferred (no false silent-drop)', async () => {
  // The exact regression: a proxy / VirtualAgent receives triggers over a live
  // SSE session yet never sets is_online. It MUST classify reachable, else the
  // gate would wrongly defer every real dispatch.
  const neverPings = { id: 'agent-1', name: 'Bob', is_online: 0, connected_at: null, manager_agent_id: MANAGER_ID, working_dir: '/w' };
  const activity = activityFake();
  const svc = await buildAutostart({ agentRows: [neverPings], instances: [], agentStatus: agentStatusFake(), activity, roomMessaging: roomMessagingFake(), connectivity: connectivityOf(['agent-1']) });
  const cls = await svc.classify('agent-1');
  assert.equal(cls.reachable, true, 'a live SSE session makes it reachable despite is_online=0');
  const handled = await svc.maybeHandleUnreachableTicket({ ticket: { id: 't1', workspace_id: 'w' }, agentId: 'agent-1', role: 'assignee', triggerSource: 'column_move', triggeredBy: 'user' });
  assert.equal(handled, false, 'reachable via SSE → caller dispatches normally, no feedback');
  assert.equal(activity.logged.length, 0, 'no dispatch_deferred for an SSE-reachable agent');
});

test('maybeHandleUnreachableTicket — never-started agent: activity feedback + spawn attempt', async () => {
  const agentStatus = agentStatusFake();
  const activity = activityFake();
  const cmds = await captureCommands(async () => {
    const svc = await buildAutostart({ agentRows: [startableAgent()], instances: [liveManagerInstance()], agentStatus, activity, roomMessaging: roomMessagingFake() });
    const handled = await svc.maybeHandleUnreachableTicket({ ticket: { id: 't1', workspace_id: 'w' }, agentId: 'agent-1', role: 'assignee', triggerSource: 'column_move', triggeredBy: 'user' });
    assert.equal(handled, true, 'unreachable → feedback + auto-start handled (emit still proceeds additively)');
  });
  assert.equal(cmds.length, 1, 'auto-start (spawn_agent) attempted');
  assert.ok(agentStatus.isStarting('agent-1'), 'agent marked starting');
  assert.equal(activity.logged.length, 1, 'one dispatch_deferred activity logged (live SSE + comment projection)');
  const row = activity.logged[0];
  assert.equal(row.action, 'dispatch_deferred');
  assert.equal(row.ticket_id, 't1');
  assert.equal(row.field_changed, 'never_started', 'lifecycle state carried on field_changed');
  assert.match(row.new_value, /자동 시작/, 'message states an auto-start was requested');
});

// ── (c) auto-start failure is surfaced (no silent drop) ─────────────────────

test('maybeHandleUnreachableTicket — no manager: failure reason surfaced', async () => {
  const agent = { id: 'agent-1', name: 'Bob', is_online: 0, connected_at: null, last_seen_at: null, manager_agent_id: null, working_dir: '' };
  const agentStatus = agentStatusFake();
  const activity = activityFake();
  const svc = await buildAutostart({ agentRows: [agent], instances: [], agentStatus, activity, roomMessaging: roomMessagingFake() });
  const handled = await svc.maybeHandleUnreachableTicket({ ticket: { id: 't1', workspace_id: 'w' }, agentId: 'agent-1', role: 'assignee', triggerSource: 'column_move', triggeredBy: 'user' });
  assert.equal(handled, true);
  assert.equal(agentStatus.getStartError('agent-1'), 'no_manager_linked', 'error marker set with the specific reason');
  assert.equal(activity.logged.length, 1);
  assert.match(activity.logged[0].new_value, /자동 시작할 수 없습니다/, 'message states auto-start could NOT run');
  assert.match(activity.logged[0].new_value, /연결되어 있지 않아|수동 Start/, 'message names the no-manager reason');
});

test('ticket feedback + spawn are debounced (supervisor/reconciler re-push does not spam)', async () => {
  const agentStatus = agentStatusFake();
  const activity = activityFake();
  const cmds = await captureCommands(async () => {
    const svc = await buildAutostart({ agentRows: [startableAgent()], instances: [liveManagerInstance()], agentStatus, activity, roomMessaging: roomMessagingFake() });
    const args = { ticket: { id: 't1', workspace_id: 'w' }, agentId: 'agent-1', role: 'assignee', triggerSource: 'supervisor', triggeredBy: 'system' };
    await svc.maybeHandleUnreachableTicket(args);
    await svc.maybeHandleUnreachableTicket(args); // immediate re-push
    await svc.maybeHandleUnreachableTicket(args);
  });
  assert.equal(cmds.length, 1, 'spawn issued once despite three dispatch attempts (spawn debounce)');
  assert.equal(activity.logged.length, 1, 'feedback comment written once for the same unchanged situation (feedback debounce)');
});

// ── (a) chat path: room system message + auto-start ─────────────────────────

test('chat path — never-started agent gets a room system message + spawn attempt', async () => {
  const { AGENT_AUTOSTART_REQUESTED } = await loadDist(['common', 'agent-autostart-events.js']);
  const { activityEvents } = await loadDist(['services', 'activity.service.js']);
  const agentStatus = agentStatusFake();
  const roomMessaging = roomMessagingFake();

  const cmds = await captureCommands(async () => {
    const svc = await buildAutostart({ agentRows: [startableAgent()], instances: [liveManagerInstance()], agentStatus, activity: activityFake(), roomMessaging });
    svc.onModuleInit();
    // Fire the internal signal RoomMessagingService emits and let the handler run.
    activityEvents.emit(AGENT_AUTOSTART_REQUESTED, { agent_id: 'agent-1', agent_name: 'Bob', room_id: 'room-1', workspace_id: 'w', source: 'chat' });
    await new Promise((r) => setTimeout(r, 20)); // handler is async off the bus
    svc.onModuleDestroy();
  });

  assert.equal(roomMessaging.sent.length, 1, 'a room system message was posted (no silent drop)');
  assert.equal(roomMessaging.sent[0].roomId, 'room-1');
  assert.match(roomMessaging.sent[0].content, /Bob/, 'names the target agent');
  assert.match(roomMessaging.sent[0].content, /자동 시작/, 'tells the user an auto-start was requested');
  assert.equal(cmds.length, 1, 'auto-start (spawn_agent) attempted from the chat path too');
  assert.ok(agentStatus.isStarting('agent-1'), 'agent marked starting');
});

test('chat path — reachable agent produces NO system message (no false noise)', async () => {
  const { AGENT_AUTOSTART_REQUESTED } = await loadDist(['common', 'agent-autostart-events.js']);
  const { activityEvents } = await loadDist(['services', 'activity.service.js']);
  const roomMessaging = roomMessagingFake();
  const online = { id: 'agent-1', name: 'Bob', is_online: 1, connected_at: new Date(), manager_agent_id: MANAGER_ID, working_dir: '/w' };
  const svc = await buildAutostart({ agentRows: [online], instances: [], agentStatus: agentStatusFake(), activity: activityFake(), roomMessaging });
  svc.onModuleInit();
  activityEvents.emit(AGENT_AUTOSTART_REQUESTED, { agent_id: 'agent-1', agent_name: 'Bob', room_id: 'room-1', workspace_id: 'w', source: 'chat' });
  await new Promise((r) => setTimeout(r, 20));
  svc.onModuleDestroy();
  assert.equal(roomMessaging.sent.length, 0, 'reachable agent → the hub stays silent (classify is the authority)');
});
