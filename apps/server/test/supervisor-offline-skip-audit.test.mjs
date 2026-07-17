// Integration test — TicketSupervisor offline-agent skip is no longer SILENT
// (ticket e7c87517). Drives the REAL `_tick()` with hand-rolled fakes (no
// NestJS boot, mirroring supervisor-output-liveness.test.mjs) to prove:
//   1. An OFFLINE agent that WAS being supervised (has live `state` keys) gets
//      one structured `supervisor_skip_agent_offline` ActivityLog audit per
//      tracked (ticket, role), and the keys are pruned.
//   2. The audit is emitted ONCE per offline episode (a second tick, still
//      offline with no keys, writes nothing more) — no per-tick spam.
//   3. No agent_trigger is re-pushed to the offline proxy.
//
// This closes the supervisor's last silent early-return: before this, an
// assignee whose manager went offline had its stale tickets stop being
// re-pushed with zero trail. (The cause-agnostic no-progress detector still
// surfaces the ticket to an operator regardless — this is the supervisor-side
// reason audit specifically.)

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

function fakeDataSource(activitySink) {
  return {
    getRepository(entity) {
      const name = entity?.name || '';
      if (name === 'ActivityLog') {
        return { create(x) { return x; }, async save(x) { activitySink.push(x); return x; } };
      }
      if (name === 'Workspace') return { async findOne() { return null; } };
      if (name === 'Ticket') return { async findOne({ where }) { return { id: where.id }; } };
      if (name === 'StuckTicketAlert') {
        return { createQueryBuilder() { return { where() { return this; }, async getMany() { return []; } }; } };
      }
      return { async findOne() { return null; } };
    },
  };
}

function makeSupervisor(SupervisorClass, RegistryClass, { agentLastSeen, allocCalls }) {
  const agentRepo = {
    async find() {
      return [{ id: 'A', last_seen_at: agentLastSeen, workspace_id: 'ws1' }];
    },
  };
  const activitySink = [];
  const dataSource = fakeDataSource(activitySink);
  const allocationService = {
    async getAllocatedTickets() { allocCalls.push(1); return []; },
  };
  const emitted = [];
  const triggerLoop = {
    async emitAgentTrigger(ticket, agentId, role) { emitted.push({ ticketId: ticket.id, agentId, role }); },
  };
  const agentStatus = {
    getOutputLivenessAt: () => undefined,
    getOutputLivenessTtlMs: () => 6 * 60 * 60_000,
    hasLiveRoleStrand: () => false,
  };
  const service = new SupervisorClass(
    agentRepo, dataSource, allocationService, triggerLoop, agentStatus, noopLog, new RegistryClass(),
  );
  return { service, activitySink, emitted };
}

test('offline agent with tracked keys → one supervisor_skip_agent_offline audit per key, then pruned', async () => {
  const { TicketSupervisorService } = await loadDist(['modules', 'agents', 'ticket-supervisor.service.js']);
  const { MemoryMetricsRegistry } = await loadDist(['services', 'memory-metrics.registry.js']);

  const allocCalls = [];
  // last_seen 10 min ago → older than ONLINE_THRESHOLD_MS (90s) → offline.
  const { service, activitySink, emitted } = makeSupervisor(
    TicketSupervisorService, MemoryMetricsRegistry,
    { agentLastSeen: new Date(Date.now() - 10 * 60_000), allocCalls },
  );

  // Simulate "was being supervised": two live state keys for agent A.
  service.state.set('A:t1:assignee', { lastEmitAt: Date.now() - 60_000, forceCount: 0, circuitOpen: false });
  service.state.set('A:t2:reviewer', { lastEmitAt: Date.now() - 60_000, forceCount: 0, circuitOpen: false });

  await service._tick();

  const audits = activitySink.filter(a => a.action === 'supervisor_skip_agent_offline');
  assert.equal(audits.length, 2, 'one offline-skip audit per previously-tracked (ticket, role) key');
  const byTicket = new Map(audits.map(a => [a.ticket_id, a]));
  assert.ok(byTicket.has('t1') && byTicket.has('t2'), 'both tracked tickets audited');
  assert.equal(byTicket.get('t1').actor_id, 'system', "actor 'system' so it can't re-enter the trigger loop");
  assert.equal(byTicket.get('t1').role, 'assignee', 'role parsed from the state key');
  assert.equal(byTicket.get('t2').role, 'reviewer', 'role parsed from the state key');
  assert.match(byTicket.get('t1').new_value, /agent_offline/, 'reason is greppable in new_value');

  assert.equal(service.state.size, 0, 'offline agent keys are pruned after audit');
  assert.equal(emitted.length, 0, 'no agent_trigger re-pushed to an offline proxy');
  assert.equal(allocCalls.length, 0, 'offline agent is skipped before the allocation lookup');
});

test('offline skip audit fires ONCE per episode — a second tick (no keys) is silent', async () => {
  const { TicketSupervisorService } = await loadDist(['modules', 'agents', 'ticket-supervisor.service.js']);
  const { MemoryMetricsRegistry } = await loadDist(['services', 'memory-metrics.registry.js']);

  const allocCalls = [];
  const { service, activitySink } = makeSupervisor(
    TicketSupervisorService, MemoryMetricsRegistry,
    { agentLastSeen: new Date(Date.now() - 10 * 60_000), allocCalls },
  );
  service.state.set('A:t1:assignee', { lastEmitAt: Date.now() - 60_000, forceCount: 0, circuitOpen: false });

  await service._tick(); // episode start → 1 audit + prune
  await service._tick(); // still offline, no keys → no new audit

  const audits = activitySink.filter(a => a.action === 'supervisor_skip_agent_offline');
  assert.equal(audits.length, 1, 'exactly one audit per offline episode, not one per tick');
});

test('online agent takes the normal path (no offline-skip audit)', async () => {
  const { TicketSupervisorService } = await loadDist(['modules', 'agents', 'ticket-supervisor.service.js']);
  const { MemoryMetricsRegistry } = await loadDist(['services', 'memory-metrics.registry.js']);

  const allocCalls = [];
  const { service, activitySink } = makeSupervisor(
    TicketSupervisorService, MemoryMetricsRegistry,
    { agentLastSeen: new Date(), allocCalls }, // fresh → online
  );
  await service._tick();
  const audits = activitySink.filter(a => a.action === 'supervisor_skip_agent_offline');
  assert.equal(audits.length, 0, 'online agent is never offline-skip-audited');
  assert.equal(allocCalls.length, 1, 'online agent runs the allocation lookup');
});
