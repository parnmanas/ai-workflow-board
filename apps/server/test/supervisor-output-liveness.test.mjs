// Integration + round-trip test — TicketSupervisor output-liveness gate
// (ticket fdc69c13). Complements the pure decideForceRespawn unit test by
// driving the REAL `_tick()` with fake deps, proving the whole wiring:
// _tick → AgentStatusService.getOutputLivenessAt → decideForceRespawn → the
// force_respawn flag actually emitted on the trigger. Also covers the
// AgentStatusService.recordOutputLiveness round-trip and a static guard that
// the manager→server ingest endpoint stays wired.
//
// No NestJS boot: services are constructed directly with hand-rolled fakes,
// mirroring agent-status-supervisor-eviction.test.mjs (fast + deterministic).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'src');
const DIST = path.join(__dirname, '..', 'dist');

async function loadDist(relParts) {
  return import('file://' + path.join(DIST, ...relParts));
}
function readSrc(relParts) {
  return fs.readFileSync(path.join(SRC, ...relParts), 'utf8');
}

const noopLog = { info() {}, warn() {}, error() {}, debug() {}, log() {} };
const HOUR_AGO_ISO = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();
const KEY = 'A:t1:assignee';

// Fake DataSource that answers the exact getRepository(Entity) calls _tick /
// _emit / _flagCircuitOpen make. Branches on the entity class .name so we don't
// have to import the entities.
function fakeDataSource({ workspace = null, stuckIds = [], activitySink } = {}) {
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
      if (name === 'Ticket') return { async findOne({ where }) { return { id: where.id }; } };
      if (name === 'ActivityLog') {
        return { create(x) { return x; }, async save(x) { activitySink?.push(x); return x; } };
      }
      return { async findOne() { return null; } };
    },
  };
}

async function makeSupervisor(SupervisorClass, RegistryClass, { allocRow, outputAtFor, stuckIds = [], ttlMs = 6 * 60 * 60_000, workspace = null }) {
  const agentRepo = {
    async find() {
      return [{ id: 'A', last_seen_at: new Date(), workspace_id: 'ws1' }];
    },
  };
  const activitySink = [];
  const dataSource = fakeDataSource({ workspace, stuckIds, activitySink });
  const allocationService = { async getAllocatedTickets() { return [allocRow]; } };
  const emitted = [];
  const triggerLoop = {
    async emitAgentTrigger(ticket, agentId, role, _source, _by, opts) {
      emitted.push({ ticketId: ticket.id, agentId, role, forceRespawn: !!(opts && opts.forceRespawn) });
    },
  };
  // getOutputLivenessTtlMs added by ticket 47a72129 — the gate now clamps its
  // window to min(staleMs, retentionTtl). Default the mock to the real 6h FLOOR
  // so min(staleMs<=30min, 6h) === staleMs and these pre-existing cases keep
  // their original gate window; override ttlMs to exercise the clamp.
  const agentStatus = {
    getOutputLivenessAt: outputAtFor || (() => undefined),
    getOutputLivenessTtlMs: () => ttlMs,
    // ticket 1fcba693 added the fast-liveness floor, which reads
    // hasLiveRoleStrand for every row. These cases model output-liveness only
    // (no live current_task), so a stub reporting "no live strand" preserves the
    // original semantics: the force-escalation gate still turns on hasRecentOutput.
    hasLiveRoleStrand: () => false,
  };
  const service = new SupervisorClass(
    agentRepo, dataSource, allocationService, triggerLoop, agentStatus, noopLog, new RegistryClass(),
  );
  return { service, emitted, activitySink };
}

// Force the resend window to have elapsed so the NEXT _tick escalates past the
// first "no entry → non-force nudge" step.
function elapseResend(service) {
  const e = service.state.get(KEY);
  if (e) e.lastEmitAt = 0;
}

const staleRow = { ticket_id: 't1', role: 'assignee', my_last_update_at: HOUR_AGO_ISO() };

test('DoD(a) integration: a live-output worker is NEVER force-respawned across many stale ticks', async () => {
  const { TicketSupervisorService } = await loadDist(['modules', 'agents', 'ticket-supervisor.service.js']);
  const { MemoryMetricsRegistry } = await loadDist(['services', 'memory-metrics.registry.js']);
  const { service, emitted } = await makeSupervisor(TicketSupervisorService, MemoryMetricsRegistry, {
    allocRow: staleRow,
    outputAtFor: () => Date.now() - 5_000, // output 5s ago → fresh
  });

  // Simulate the exit-143 deathloop scenario: ticket-write stale for an hour,
  // but the subagent keeps emitting tokens. Drive several resend cycles.
  for (let i = 0; i < 6; i++) {
    await service._tick();
    elapseResend(service);
  }

  assert.ok(emitted.length >= 2, 'supervisor keeps re-pushing the stale ticket');
  assert.ok(
    emitted.every((e) => e.forceRespawn === false),
    'a worker with fresh output-liveness must never be force_respawned (deathloop fixed)',
  );
});

// ---- ticket 47a72129: gate-window clamp against the retained TTL ----
const NINE_H_AGO_ISO = () => new Date(Date.now() - 9 * 60 * 60 * 1000).toISOString();

test('47a72129 integration: staleMs=8h + output 7h old + retention extended to 8h → gate SUPPRESSES force', async () => {
  const { TicketSupervisorService } = await loadDist(['modules', 'agents', 'ticket-supervisor.service.js']);
  const { MemoryMetricsRegistry } = await loadDist(['services', 'memory-metrics.registry.js']);
  // Operator raised supervisor_stale_ms to 8h (incident response). Ticket-write
  // has been silent 9h (> 8h → the gate is reached), but the worker emitted
  // output 7h ago — inside the 8h escalation window and in the band a fixed-6h
  // TTL would have evicted. Retention derives to 8h, so the gate window is
  // min(8h, 8h)=8h → 7h < 8h → alive → force is suppressed on every tick.
  const { service, emitted } = await makeSupervisor(TicketSupervisorService, MemoryMetricsRegistry, {
    workspace: { id: 'ws1', supervisor_stale_ms: 8 * 60 * 60_000 },
    allocRow: { ticket_id: 't1', role: 'assignee', my_last_update_at: NINE_H_AGO_ISO() },
    outputAtFor: () => Date.now() - 7 * 60 * 60_000, // 7h ago — the old-evict band
    ttlMs: 8 * 60 * 60_000,                          // retention tracks the raised staleMs
  });
  for (let i = 0; i < 6; i++) { await service._tick(); elapseResend(service); }
  assert.ok(emitted.length >= 1, 'supervisor re-pushes the write-stale ticket');
  assert.ok(
    emitted.every((e) => e.forceRespawn === false),
    'with retention extended to 8h a 7h-old-output worker is never force_respawned (exit-143 deathloop stays closed)',
  );
});

test('47a72129 integration contrast: same case but retention NOT extended (stuck at 6h) → gate FORCES (the bug)', async () => {
  const { TicketSupervisorService } = await loadDist(['modules', 'agents', 'ticket-supervisor.service.js']);
  const { MemoryMetricsRegistry } = await loadDist(['services', 'memory-metrics.registry.js']);
  // Feed the gate a 6h retention (what the old fixed-constant TTL reported)
  // while staleMs=8h: the window clamps to min(8h, 6h)=6h, so the 7h-old output
  // reads as stale → force. Proves the derivation (retention tracking staleMs)
  // is the load-bearing fix; the clamp alone can't resurrect an evicted entry.
  const { service, emitted } = await makeSupervisor(TicketSupervisorService, MemoryMetricsRegistry, {
    workspace: { id: 'ws1', supervisor_stale_ms: 8 * 60 * 60_000 },
    allocRow: { ticket_id: 't1', role: 'assignee', my_last_update_at: NINE_H_AGO_ISO() },
    outputAtFor: () => Date.now() - 7 * 60 * 60_000,
    ttlMs: 6 * 60 * 60_000,                          // retention NOT extended past the floor
  });
  await service._tick();          // first re-push → non-force nudge
  elapseResend(service);
  await service._tick();          // escalation → force (because the gate window is only 6h)
  assert.ok(
    emitted.some((e) => e.forceRespawn === true),
    'un-extended retention reproduces the false force_respawn — exactly what the derived TTL fixes',
  );
});

test('DoD(b) integration: a genuinely silent session still escalates to force_respawn', async () => {
  const { TicketSupervisorService } = await loadDist(['modules', 'agents', 'ticket-supervisor.service.js']);
  const { MemoryMetricsRegistry } = await loadDist(['services', 'memory-metrics.registry.js']);
  const { service, emitted } = await makeSupervisor(TicketSupervisorService, MemoryMetricsRegistry, {
    allocRow: staleRow,
    outputAtFor: () => undefined, // no output-liveness ever
  });

  await service._tick();          // first re-push → non-force nudge
  elapseResend(service);
  await service._tick();          // escalation → force

  assert.equal(emitted[0].forceRespawn, false, 'first re-push is a non-force nudge');
  assert.ok(
    emitted.slice(1).some((e) => e.forceRespawn === true),
    'a silent/wedged session must still be recovered via force_respawn (backstop intact)',
  );
});

test('DoD(c) integration: circuit-breaker stops force after MAX and writes exactly one flag', async () => {
  const { TicketSupervisorService } = await loadDist(['modules', 'agents', 'ticket-supervisor.service.js']);
  const { MemoryMetricsRegistry } = await loadDist(['services', 'memory-metrics.registry.js']);
  const { service, emitted, activitySink } = await makeSupervisor(TicketSupervisorService, MemoryMetricsRegistry, {
    allocRow: staleRow,
    outputAtFor: () => undefined,
  });

  await service._tick();          // non-force nudge, entry.forceCount = 0
  for (let i = 0; i < 12; i++) {
    elapseResend(service);
    await service._tick();
  }

  const forces = emitted.filter((e) => e.forceRespawn).length;
  assert.equal(forces, 5, 'exactly SUPERVISOR_FORCE_RESPAWN_MAX (5) force_respawns before the breaker opens');
  const flags = activitySink.filter((a) => a.action === 'supervisor_force_respawn_circuit_open');
  assert.equal(flags.length, 1, 'circuit-open flag written exactly once, not every tick');
  assert.equal(flags[0].actor_id, 'system', "flag actor is 'system' so it cannot re-enter the trigger loop (DoD#4)");
});

test('stuck-detector throttle still suppresses force (no regression on b55e4421)', async () => {
  const { TicketSupervisorService } = await loadDist(['modules', 'agents', 'ticket-supervisor.service.js']);
  const { MemoryMetricsRegistry } = await loadDist(['services', 'memory-metrics.registry.js']);
  const { service, emitted } = await makeSupervisor(TicketSupervisorService, MemoryMetricsRegistry, {
    allocRow: staleRow,
    outputAtFor: () => undefined,
    stuckIds: ['t1'], // stuck detector already flagged it
  });
  await service._tick();
  elapseResend(service);
  await service._tick();
  assert.ok(emitted.every((e) => e.forceRespawn === false), 'stuck-flagged ticket is never force_respawned');
});

test('AgentStatusService.recordOutputLiveness round-trips and is keyed by (agent,ticket,role)', async () => {
  const { AgentStatusService } = await loadDist(['modules', 'agents', 'agent-status.service.js']);
  const { MemoryMetricsRegistry } = await loadDist(['services', 'memory-metrics.registry.js']);
  const agentRepo = { async find() { return []; }, async update() {} };
  const dataSource = { getRepository: () => ({ async findOne() { return null; } }) };
  // connectivity + instanceRegistry (ticket 1f750878) — inert fakes so
  // isReachable() falls back to status.is_online (identical to the pre-1f750878
  // _emit behavior these output-liveness assertions were written against).
  const service = new AgentStatusService(agentRepo, dataSource, noopLog, new MemoryMetricsRegistry(), { isReachable: () => false }, { list: () => [] });

  assert.equal(service.getOutputLivenessAt('a', 't', 'assignee'), undefined, 'unknown strand → undefined');
  const before = Date.now();
  service.recordOutputLiveness('a', 't', 'assignee');
  const ts = service.getOutputLivenessAt('a', 't', 'assignee');
  assert.ok(typeof ts === 'number' && ts >= before, 'records a server-receipt epoch ms');
  // role-scoped key: a different role is a distinct strand
  assert.equal(service.getOutputLivenessAt('a', 't', 'reviewer'), undefined, 'role is part of the key');
  // empty agent/ticket is ignored (defensive)
  service.recordOutputLiveness('', 't', 'assignee');
  service.recordOutputLiveness('a', '', 'assignee');
  assert.equal(service.getOutputLivenessAt('', 't', 'assignee'), undefined);
});

test('static: agent-manager controller wires the output-liveness ingest endpoint to AgentStatusService', () => {
  const raw = readSrc(['modules', 'agent-manager', 'agent-manager.controller.ts']);
  assert.match(raw, /api\/agent-manager\/output-liveness/, 'ingest route present');
  assert.match(raw, /@UseGuards\(AgentAuthGuard\)/, 'ingest route guarded by AgentAuthGuard');
  assert.match(raw, /this\.agentStatus\.recordOutputLiveness\(/, 'ingest handler records liveness');
});

test('static: agent-manager reports output-liveness from the ticket-session output hook', () => {
  const rest = readSrc(['..', '..', 'agent-manager', 'src', 'lib', 'rest.ts']);
  assert.match(rest, /export async function postOutputLiveness/, 'rest client exposes postOutputLiveness');
  assert.match(rest, /api\/agent-manager\/output-liveness/, 'posts to the server ingest route');
  const tsm = readSrc(['..', '..', 'agent-manager', 'src', 'lib', 'ticket-session-manager.ts']);
  assert.match(tsm, /postOutputLiveness\(/, 'ticket-session-manager fires the heartbeat');
  assert.match(tsm, /parsed\.stage \|\| parsed\.isResult/, 'gated on the same liveness signal as the base watchdog');
});
