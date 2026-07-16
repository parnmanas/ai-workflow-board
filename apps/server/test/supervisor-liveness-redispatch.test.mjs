// TicketSupervisor fast liveness-based re-dispatch floor (ticket 1fcba693).
//
// The incident: a workspace carried supervisor_stale_ms = 14_400_000 (4 h),
// written as a one-off band-aid during the 2026-07-01 exit-143 deathloop and
// never reverted. With a 4 h window the supervisor — the only backstop that
// re-dispatches a ticket whose own edge-trigger was already consumed — waited
// up to 4 h before even the FIRST re-push of a ticket whose strand had died /
// been killed on a manager restart / never spawned. Result: "tickets processed
// every 3-4 h, no parallelism".
//
// The fix decouples "nobody is working this ticket" (no live strand AND no
// recent output) from the big stale window: such a ticket is re-dispatched
// after the short SUPERVISOR_LIVENESS_FLOOR_MS floor (default 2 min) instead of
// the full window. A PRESENT / producing strand and a stuck-flagged ticket keep
// the full window (deathloop + stuck throttle untouched).
//
// Two layers, mirroring supervisor-output-liveness.test.mjs:
//   - pure unit tests for resolveFirstPushThresholdMs / classifySupervisorStaleMs
//   - integration tests driving the REAL _tick() with hand-rolled fakes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');
async function loadDist(relParts) {
  return import('file://' + path.join(DIST, ...relParts));
}

const noopLog = { info() {}, warn() {}, error() {}, debug() {}, log() {} };
const MIN = 60_000;
const HOUR = 60 * MIN;
const FOUR_H_MS = 4 * HOUR; // the incident value
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const KEY = 'A:t1:assignee';

// ── Fakes ────────────────────────────────────────────────────────────────
function fakeDataSource({ workspace = null, stuckIds = [], activitySink, lockReleaseSink } = {}) {
  return {
    getRepository(entity) {
      const name = entity?.name || '';
      if (name === 'Workspace') return { async findOne() { return workspace; } };
      if (name === 'StuckTicketAlert') {
        return {
          createQueryBuilder() {
            return { where() { return this; }, async getMany() { return stuckIds.map((id) => ({ ticket_id: id })); } };
          },
        };
      }
      if (name === 'Ticket') {
        return {
          async findOne({ where }) { return { id: where.id }; },
          // Capture the successor-safe stale-claim reclaim UPDATE (ticket 1fcba693).
          createQueryBuilder() {
            const qb = {
              update() { return qb; },
              set(v) { qb._set = v; return qb; },
              where(_clause, params) { qb._params = params; return qb; },
              async execute() { lockReleaseSink?.push({ set: qb._set, params: qb._params }); return { affected: 1 }; },
            };
            return qb;
          },
        };
      }
      if (name === 'ActivityLog') {
        return { create(x) { return x; }, async save(x) { activitySink?.push(x); return x; } };
      }
      return { async findOne() { return null; } };
    },
  };
}

// Build a supervisor whose single allocated row + liveness signals we control.
//   liveStrand   : boolean — hasLiveRoleStrand(agent,ticket,role) result
//   outputAgoMs  : number|null — recent output-liveness age (null = none ever)
//   staleMs      : workspace supervisor_stale_ms (default 4 h — the incident)
//   ttlMs        : output-liveness retention TTL the gate clamps against
async function makeSupervisor({
  allocRow,
  liveStrand = false,
  outputAgoMs = null,
  stuckIds = [],
  staleMs = FOUR_H_MS,
  ttlMs = 6 * HOUR,
} = {}) {
  const { TicketSupervisorService } = await loadDist(['modules', 'agents', 'ticket-supervisor.service.js']);
  const { MemoryMetricsRegistry } = await loadDist(['services', 'memory-metrics.registry.js']);
  const agentRepo = {
    async find() { return [{ id: 'A', last_seen_at: new Date(), workspace_id: 'ws1' }]; },
  };
  const activitySink = [];
  const lockReleaseSink = [];
  const dataSource = fakeDataSource({
    workspace: { id: 'ws1', supervisor_stale_ms: staleMs },
    stuckIds,
    activitySink,
    lockReleaseSink,
  });
  const allocationService = { async getAllocatedTickets() { return [allocRow]; } };
  const emitted = [];
  const emitOrder = [];
  const triggerLoop = {
    async emitAgentTrigger(ticket, agentId, role, _source, _by, opts) {
      emitOrder.push('emit');
      emitted.push({ ticketId: ticket.id, agentId, role, forceRespawn: !!(opts && opts.forceRespawn) });
    },
  };
  const reclaimed = [];
  const agentStatus = {
    getOutputLivenessAt: () => (outputAgoMs == null ? undefined : Date.now() - outputAgoMs),
    getOutputLivenessTtlMs: () => ttlMs,
    hasLiveRoleStrand: () => liveStrand,
    // Compare-and-clear reclaim (ticket 1fcba693). The real impl only clears a
    // TTL-stale entry; here we record the call so a test can assert the
    // supervisor reclaims the seat BEFORE it nudges. Return liveStrand===false
    // (a ghost exists to clear only when no live strand).
    reclaimStaleStrand(agentId, ticketId) {
      emitOrder.push('reclaim');
      reclaimed.push({ agentId, ticketId });
      return !liveStrand;
    },
  };
  const service = new TicketSupervisorService(
    agentRepo, dataSource, allocationService, triggerLoop, agentStatus, noopLog, new MemoryMetricsRegistry(),
  );
  return { service, emitted, activitySink, reclaimed, lockReleaseSink, emitOrder };
}

// ── Unit: pure helpers ─────────────────────────────────────────────────────
test('unit resolveFirstPushThresholdMs: absent strand drops to the floor; present strand / stuck keep the full window', async () => {
  const { resolveFirstPushThresholdMs } = await loadDist(['common', 'supervisor-liveness.js']);
  const staleMs = FOUR_H_MS, floor = 2 * MIN;
  // absent + not stuck → fast floor
  assert.equal(resolveFirstPushThresholdMs({ staleMs, livenessFloorMs: floor, absentStrand: true, isStuck: false }), floor);
  // present strand → full window (no fast path)
  assert.equal(resolveFirstPushThresholdMs({ staleMs, livenessFloorMs: floor, absentStrand: false, isStuck: false }), staleMs);
  // stuck ticket → full window even if absent (stuck throttle owns cadence)
  assert.equal(resolveFirstPushThresholdMs({ staleMs, livenessFloorMs: floor, absentStrand: true, isStuck: true }), staleMs);
  // floor never exceeds the workspace's own (small) window
  assert.equal(resolveFirstPushThresholdMs({ staleMs: 30_000, livenessFloorMs: floor, absentStrand: true, isStuck: false }), 30_000);
});

test('unit classifySupervisorStaleMs: default is normal, the 4 h incident value is elevated, boundary is exclusive', async () => {
  const { classifySupervisorStaleMs, SUPERVISOR_STALE_MS_SANE_MAX, DEFAULT_SUPERVISOR_STALE_MS } =
    await loadDist(['common', 'supervisor-liveness.js']);
  assert.equal(DEFAULT_SUPERVISOR_STALE_MS, 30 * MIN);
  assert.equal(SUPERVISOR_STALE_MS_SANE_MAX, 2 * HOUR);
  assert.equal(classifySupervisorStaleMs(30 * MIN).elevated, false, 'default 30 min → normal');
  assert.equal(classifySupervisorStaleMs(HOUR).elevated, false, '1 h → normal');
  assert.equal(classifySupervisorStaleMs(2 * HOUR).elevated, false, 'exactly sane-max → normal (exclusive)');
  assert.equal(classifySupervisorStaleMs(2 * HOUR + 1).elevated, true, 'just over sane-max → elevated');
  assert.equal(classifySupervisorStaleMs(FOUR_H_MS).elevated, true, 'the 4 h incident value → elevated');
});

test('unit resolveSupervisorLivenessFloorMs: default 2 min, positive env override wins, garbage → default', async () => {
  const { resolveSupervisorLivenessFloorMs, DEFAULT_SUPERVISOR_LIVENESS_FLOOR_MS } =
    await loadDist(['common', 'supervisor-liveness.js']);
  assert.equal(DEFAULT_SUPERVISOR_LIVENESS_FLOOR_MS, 2 * MIN);
  assert.equal(resolveSupervisorLivenessFloorMs({}), 2 * MIN);
  assert.equal(resolveSupervisorLivenessFloorMs({ SUPERVISOR_LIVENESS_FLOOR_MS: '90000' }), 90_000);
  assert.equal(resolveSupervisorLivenessFloorMs({ SUPERVISOR_LIVENESS_FLOOR_MS: '-5' }), 2 * MIN);
  assert.equal(resolveSupervisorLivenessFloorMs({ SUPERVISOR_LIVENESS_FLOOR_MS: 'nope' }), 2 * MIN);
});

// ── Integration: drive _tick() ─────────────────────────────────────────────

test('DoD: a DEAD/absent strand under a 4 h stale window is re-dispatched within minutes, EXACTLY once, and its seat is reclaimed FIRST', async () => {
  // Ticket last written 5 min ago; supervisor_stale_ms = 4 h (the incident).
  // No live strand, no output → nobody is working it. Old behavior: wait ~4 h.
  // (Decision-level coverage with fakes; the REAL AgentStatus reclaim + real
  // in-flight emit gate + restart are proven in
  // qa-flows/supervisor-liveness-reclaim.test.mjs.)
  const { service, emitted, reclaimed, lockReleaseSink, emitOrder } = await makeSupervisor({
    allocRow: { ticket_id: 't1', role: 'assignee', my_last_update_at: ago(5 * MIN) },
    liveStrand: false,
    outputAgoMs: null,
    staleMs: FOUR_H_MS,
  });

  await service._tick();
  assert.equal(emitted.length, 1, 'absent strand re-dispatched on the first tick (floor 2 min < 5 min staleness), not after 4 h');
  assert.equal(emitted[0].forceRespawn, false, 'first re-push is a NON-force nudge (funnels through the in-flight gate — no kill)');

  // Slot reclaim (ticket 1fcba693): the dead strand's current_task ghost and
  // its stale claim are reclaimed BEFORE the nudge, so active-count/claim are
  // correct at re-dispatch (not a sweep later).
  assert.deepEqual(reclaimed, [{ agentId: 'A', ticketId: 't1' }], 'reclaimStaleStrand called once for the dead seat');
  assert.equal(emitOrder[0], 'reclaim', 'reclaim happens BEFORE emit');
  assert.equal(emitOrder[1], 'emit');
  assert.equal(lockReleaseSink.length, 1, 'the stale claim/lock is released once');
  assert.equal(lockReleaseSink[0].params.agentId, 'A', 'lock release is scoped to the dead agent');
  assert.deepEqual(lockReleaseSink[0].set, { locked_by_agent_id: null, locked_at: null }, 'lock columns cleared');

  // Exactly once: a second tick inside the resend cooldown must NOT re-emit
  // (no respawn storm — the completion condition's "정확히 1회 재-dispatch").
  await service._tick();
  assert.equal(emitted.length, 1, 'no re-emit within the resend cooldown — exactly one re-dispatch');
  assert.equal(reclaimed.length, 1, 'no second reclaim within the cooldown (entry exists → not first-push)');
  assert.equal(service.state.size, 1, 'one live state entry (the key it just nudged)');
});

test('DoD: a PRESENT live strand is never reclaimed (successor-safe — no seat eviction)', async () => {
  // A live strand holds the seat (liveStrand=true) and the ticket is well past
  // even a small stale window. absentStrand=false → no fast floor, no reclaim.
  const { service, emitted, reclaimed, lockReleaseSink } = await makeSupervisor({
    allocRow: { ticket_id: 't1', role: 'assignee', my_last_update_at: ago(20 * MIN) },
    liveStrand: true,
    outputAgoMs: null,
    staleMs: FOUR_H_MS,
  });
  await service._tick();
  assert.equal(reclaimed.length, 0, 'a live strand is NEVER reclaimed (never evict a working seat)');
  assert.equal(lockReleaseSink.length, 0, 'a live strand’s claim is never released');
  assert.equal(emitted.length, 0, 'and no false re-dispatch');
});

test('DoD: a PRESENT live strand under a 4 h window is left alone — no false restart of long normal work', async () => {
  // Long-running task: no ticket WRITE for 20 min, but a live strand holds the
  // seat. absentStrand=false → full 4 h window → 20 min < 4 h → not actionable.
  const { service, emitted } = await makeSupervisor({
    allocRow: { ticket_id: 't1', role: 'assignee', my_last_update_at: ago(20 * MIN) },
    liveStrand: true,
    outputAgoMs: null,
    staleMs: FOUR_H_MS,
  });
  await service._tick();
  assert.equal(emitted.length, 0, 'a ticket with a live strand is never fast-floored — no false re-dispatch/restart');
  assert.equal(service.state.get(KEY), undefined, 'no state entry created for the non-stale live ticket');
});

test('DoD: a quiet-but-PRODUCING strand (recent output, no live current_task) is also left alone', async () => {
  // current_task lag / long turn: no live strand registered, but output-liveness
  // is fresh (5 s ago) → the worker IS alive → absentStrand=false → full window.
  const { service, emitted } = await makeSupervisor({
    allocRow: { ticket_id: 't1', role: 'assignee', my_last_update_at: ago(20 * MIN) },
    liveStrand: false,
    outputAgoMs: 5_000,
    staleMs: FOUR_H_MS,
  });
  await service._tick();
  assert.equal(emitted.length, 0, 'fresh output-liveness protects a producing worker from the fast floor');
});

test('DoD: a stuck-flagged ticket keeps the full window even when absent (no fast-floor respawn of a WAIT loop)', async () => {
  const { service, emitted } = await makeSupervisor({
    allocRow: { ticket_id: 't1', role: 'assignee', my_last_update_at: ago(5 * MIN) },
    liveStrand: false,
    outputAgoMs: null,
    staleMs: FOUR_H_MS,
    stuckIds: ['t1'],
  });
  await service._tick();
  assert.equal(emitted.length, 0, 'a stuck ticket is not fast-floored — its throttle owns the cadence');
});

test('DoD: no ghost slot survives a supervisor restart — a fresh supervisor re-derives from live signals', async () => {
  const allocRow = { ticket_id: 't1', role: 'assignee', my_last_update_at: ago(5 * MIN) };
  // Supervisor #1 nudges the dead ticket, then the process "restarts".
  const s1 = await makeSupervisor({ allocRow, liveStrand: false, outputAgoMs: null, staleMs: FOUR_H_MS });
  await s1.service._tick();
  assert.equal(s1.emitted.length, 1, 'supervisor #1 recovered the dead ticket');

  // Fresh supervisor #2 (empty in-memory Map — the restart). The dead ticket is
  // STILL recovered: no lost state entry silently suppresses it.
  const s2dead = await makeSupervisor({ allocRow, liveStrand: false, outputAgoMs: null, staleMs: FOUR_H_MS });
  await s2dead.service._tick();
  assert.equal(s2dead.emitted.length, 1, 'after restart, an absent-strand ticket is re-derived and recovered (no ghost suppression)');

  // And a fresh supervisor does NOT falsely re-dispatch a ticket that is now
  // being worked (a live strand grabbed the seat) — no ghost re-fire after restart.
  const s2live = await makeSupervisor({ allocRow, liveStrand: true, outputAgoMs: null, staleMs: FOUR_H_MS });
  await s2live.service._tick();
  assert.equal(s2live.emitted.length, 0, 'after restart, a live-strand ticket is left alone (no ghost re-dispatch)');
});

test('regression: the elevated-stale gauge flags the 4 h workspace (observability, not silent)', async () => {
  // Drive one tick with the 4 h workspace value; the sane-max observer must
  // add the workspace to the elevated set (gauge > 0) so /diagnostics surfaces it.
  const { service } = await makeSupervisor({
    allocRow: { ticket_id: 't1', role: 'assignee', my_last_update_at: ago(5 * MIN) },
    liveStrand: false, outputAgoMs: null, staleMs: FOUR_H_MS,
  });
  await service._tick();
  // The gauge is registered as ticketSupervisor.staleMsElevated; assert via the
  // private set the tick populated (mirrors staleMsExceedsTtl coverage style).
  assert.equal(service.staleMsElevatedWorkspaces.size, 1, 'the 4 h workspace is flagged elevated (observable)');
});

test('regression: a normal 30 min workspace is NOT flagged elevated', async () => {
  const { service } = await makeSupervisor({
    allocRow: { ticket_id: 't1', role: 'assignee', my_last_update_at: ago(40 * MIN) },
    liveStrand: false, outputAgoMs: null, staleMs: 30 * MIN,
  });
  await service._tick();
  assert.equal(service.staleMsElevatedWorkspaces.size, 0, 'a default-cadence workspace is never flagged');
});
