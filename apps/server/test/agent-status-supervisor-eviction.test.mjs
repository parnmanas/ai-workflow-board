// Behavioural + static regression — ticket d1fc18ac ([mem-leak v2] server
// secondary: agent-status / ticket-supervisor stale-key eviction +
// agent-connection timer hygiene).
//
// Three slow/secondary unbounded growers in apps/server, all Postgres-relevant
// (they live in long-lived NestJS singletons, not the dev-only SQLite path):
//
//   1. AgentStatusService.state (Map<agentId, AgentStatus>): the 30s _sweep
//      only ever `set`s. An agent whose DB row is deleted lingered in the Map
//      for the life of the process. Fix: _sweep builds a `seen` set of current
//      agent ids and deletes any state entry not in it.
//   2. TicketSupervisorService.state (Map<`${agentId}:${ticketId}:${role}`>):
//      end-of-tick reap is correct, BUT if getAllocatedTickets throws the whole
//      tick aborted (reap skipped); if it returned a non-array the agent
//      `continue`d without contributing live keys. Under sustained per-agent
//      allocation errors that agent's stale keys were never reaped. Fix:
//      try/catch the lookup and prune that agent's keys on throw or non-array.
//   3. AgentConnectionService: two setInterval handles were never stored, never
//      unref'd, no onModuleDestroy — blocked graceful shutdown. Fix: store +
//      unref + clear in onModuleDestroy.
//
// Plus: both Maps now self-register a size gauge into MemoryMetricsRegistry so
// /api/diagnostics/memory reflects a regression.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'src');
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

function readSrc(relParts) {
  return fs.readFileSync(path.join(SRC, ...relParts), 'utf8');
}

const noopLog = { info() {}, warn() {}, error() {}, debug() {}, log() {} };

// ── 1. AgentStatusService: _sweep keeps entries without DB rows (P4c-4) ─────

function makeAgentStatus(StatusClass, RegistryClass) {
  // dataSource is only touched by setCurrentTask, not by _sweep.
  const dataSource = { getRepository: () => ({ async findOne() { return null; } }) };
  const registry = new RegistryClass();
  // connectivity + instanceRegistry (ticket 1f750878) — inert fakes so any
  // _emit on this path falls back to status.is_online (unchanged behavior).
  // P4c-4: (dataSource, logService, metrics, connectivity, instanceRegistry).
  const service = new StatusClass(dataSource, noopLog, registry, { isReachable: () => false }, { list: () => [] });
  return { service, registry };
}

test('agent-status: _sweep keeps in-memory entries without DB rows to compare against (P4c-4: no Agent table)', async () => {
  const { AgentStatusService } = await loadDist(['modules', 'agents', 'agent-status.service.js']);
  const { MemoryMetricsRegistry } = await loadDist(['services', 'memory-metrics.registry.js']);

  // P4c-4: there is no Agent table, so _sweep has no DB snapshot to compare
  // against — entries are dropped only by offline/task staleness, never for
  // merely lacking a row. Both fresh-presence entries survive the sweep.
  const recent = new Date();
  const { service } = makeAgentStatus(AgentStatusService, MemoryMetricsRegistry);

  service.state.set('keep', { agent_id: 'keep', is_online: true, last_seen_at: recent });
  service.state.set('gone', { agent_id: 'gone', is_online: true, last_seen_at: recent });
  assert.equal(service.state.size, 2, 'seeded with two agents');

  await service._sweep();

  assert.ok(service.state.has('keep'), 'fresh entry retained');
  assert.ok(service.state.has('gone'), 'no DB row to compare against — sweep must not drop it');
  assert.equal(service.state.size, 2, 'map does not shrink without a staleness reason');
});

test('agent-status: the agentStatus.state gauge tracks the live map size', async () => {
  const { AgentStatusService } = await loadDist(['modules', 'agents', 'agent-status.service.js']);
  const { MemoryMetricsRegistry } = await loadDist(['services', 'memory-metrics.registry.js']);
  const recent = new Date();
  const { service, registry } = makeAgentStatus(AgentStatusService, MemoryMetricsRegistry);
  assert.equal(registry.collect()['agentStatus.state'], 0, 'gauge registered, starts at 0');
  service.state.set('keep', { agent_id: 'keep', is_online: true, last_seen_at: recent });
  service.state.set('gone', { agent_id: 'gone', is_online: true, last_seen_at: recent });
  assert.equal(registry.collect()['agentStatus.state'], 2, 'reflects seeded entries');
  await service._sweep();
  assert.equal(registry.collect()['agentStatus.state'], 2, 'no eviction without a staleness reason (P4c-4)');
});

// ── 2. TicketSupervisorService: prune keys on allocation failure ────────────

// P4c-4: _tick iterates TicketRoleAssignment holder ids (uuid-shaped only).
const HOLDER_BOOM = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const HOLDER_OK = 'cccccccc-2222-4222-8222-cccccccccccc';
const HOLDER_WEIRD = 'dddddddd-3333-4333-8333-dddddddddddd';
function makeSupervisor(SupervisorClass, RegistryClass, { holderIds, allocFor }) {
  const dataSource = {
    getRepository: (entity) => {
      if ((entity?.name || '') === 'TicketRoleAssignment') {
        return { async find() { return holderIds.map((agent_id) => ({ agent_id })); } };
      }
      return {
        async findOne() { return null; }, // Workspace cadence → defaults
      };
    },
  };
  const allocationService = {
    async getAllocatedWorkspaceIds() { return ['ws1']; },
    async getAllocatedTickets(agentId) {
      return allocFor(agentId);
    },
  };
  const triggerLoop = { async emitAgentTrigger() {} };
  // ticket fdc69c13 added AgentStatusService as a supervisor dep (output-
  // liveness gate). These leak tests never reach the force-escalation branch
  // (allocation throws / returns non-array / prune-helper only), so a stub that
  // reports "no output" is enough — but it MUST occupy the right ctor slot or
  // the metrics arg shifts and construction throws.
  const agentStatus = { getOutputLivenessAt() { return undefined; } };
  const registry = new RegistryClass();
  // P4c-4: (dataSource, allocationService, triggerLoop, agentStatus, logService, metrics).
  const service = new SupervisorClass(
    dataSource, allocationService, triggerLoop, agentStatus, noopLog, registry,
  );
  return { service, registry };
}

test('ticket-supervisor: a throwing allocation lookup does not abort the tick and prunes that agent keys', async () => {
  const { TicketSupervisorService } = await loadDist(['modules', 'agents', 'ticket-supervisor.service.js']);
  const { MemoryMetricsRegistry } = await loadDist(['services', 'memory-metrics.registry.js']);

  const recent = new Date();
  // "boom" throws every lookup; "ok" returns a valid (empty) array. boom is
  // processed FIRST — pre-fix its throw aborted the tick before ok and before
  // the end-of-tick reap, stranding both agents' keys forever.
  const { service } = makeSupervisor(TicketSupervisorService, MemoryMetricsRegistry, {
    holderIds: [HOLDER_BOOM, HOLDER_OK],
    allocFor(agentId) {
      if (agentId === HOLDER_BOOM) throw new Error('allocation backend down');
      return [];
    },
  });

  service.state.set(`${HOLDER_BOOM}:t1:assignee`, { lastEmitAt: 1 });
  service.state.set(`${HOLDER_OK}:t2:assignee`, { lastEmitAt: 1 });
  assert.equal(service.state.size, 2);

  await assert.doesNotReject(service._tick(), 'tick completes despite a per-agent throw');

  assert.ok(!service.state.has('boom:t1:assignee'), 'throwing agent keys pruned');
  assert.ok(!service.state.has('ok:t2:assignee'), 'healthy agent stale key reaped end-of-tick');
  assert.equal(service.state.size, 0, 'map fully drains under a persistent per-agent error');
});

test('ticket-supervisor: a non-array allocation result prunes that agent keys', async () => {
  const { TicketSupervisorService } = await loadDist(['modules', 'agents', 'ticket-supervisor.service.js']);
  const { MemoryMetricsRegistry } = await loadDist(['services', 'memory-metrics.registry.js']);
  const recent = new Date();
  const { service, registry } = makeSupervisor(TicketSupervisorService, MemoryMetricsRegistry, {
    holderIds: [HOLDER_WEIRD],
    allocFor() { return undefined; }, // non-array
  });

  service.state.set(`${HOLDER_WEIRD}:t9:reviewer`, { lastEmitAt: 1 });
  assert.equal(registry.collect()['ticketSupervisor.state'], 1, 'gauge registered, reflects seeded key');

  await service._tick();

  assert.equal(service.state.size, 0, 'non-array lookup prunes the agent keys');
  assert.equal(registry.collect()['ticketSupervisor.state'], 0, 'gauge drains to 0');
});

test('ticket-supervisor: _pruneAgentKeys only drops the target agent (UUID prefix is unambiguous)', async () => {
  const { TicketSupervisorService } = await loadDist(['modules', 'agents', 'ticket-supervisor.service.js']);
  const { MemoryMetricsRegistry } = await loadDist(['services', 'memory-metrics.registry.js']);
  const { service } = makeSupervisor(TicketSupervisorService, MemoryMetricsRegistry, {
    holderIds: [],
    allocFor() { return []; },
  });
  service.state.set('agentA:t1:assignee', { lastEmitAt: 1 });
  service.state.set('agentA:t2:reviewer', { lastEmitAt: 1 });
  service.state.set('agentB:t1:assignee', { lastEmitAt: 1 });

  service._pruneAgentKeys('agentA');

  assert.ok(!service.state.has('agentA:t1:assignee'));
  assert.ok(!service.state.has('agentA:t2:reviewer'));
  assert.ok(service.state.has('agentB:t1:assignee'), 'sibling agent untouched');
});

// ── 3. AgentConnectionService: timer hygiene ────────────────────────────────

test('agent-connection: onModuleInit stores handles, onModuleDestroy clears them', async () => {
  const { AgentConnectionService } = await loadDist(['modules', 'agents', 'agent-connection.service.js']);
  // P4c-4: (ticketRepo, logService).
  const ticketRepo = { createQueryBuilder: () => ({}) };
  const service = new AgentConnectionService(ticketRepo, noopLog);

  service.onModuleInit();
  assert.ok(service.offlineSweepHandle, 'offline sweep handle stored');
  assert.ok(service.lockSweepHandle, 'lock sweep handle stored');

  service.onModuleDestroy();
  assert.equal(service.offlineSweepHandle, null, 'offline sweep handle cleared on destroy');
  assert.equal(service.lockSweepHandle, null, 'lock sweep handle cleared on destroy');
});

// ── Static guards — a refactor must not silently reintroduce the leaks ───────

test('static: agent-status _sweep has no Agent-row comparison and registers a gauge (P4c-4)', () => {
  const raw = readSrc(['modules', 'agents', 'agent-status.service.ts']);
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /getRepository\(Agent\)/, 'no Agent-table read in the status service');
  assert.match(code, /metrics\.register\('agentStatus\.state'/, 'state gauge still registered');
  assert.ok(raw.includes("register('agentStatus.state'"), 'must register the agentStatus.state gauge');
});

test('static: ticket-supervisor guards allocation lookup and prunes on failure', () => {
  const raw = readSrc(['modules', 'agents', 'ticket-supervisor.service.ts']);
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.match(code, /_pruneAgentKeys\(agentId: string\)/, 'must define the per-agent prune helper');
  assert.match(code, /} catch[\s\S]*?this\._pruneAgentKeys\(agent\.id\)/, 'must prune on a thrown lookup');
  assert.match(code, /if \(!Array\.isArray\(raw\)\)[\s\S]*?this\._pruneAgentKeys\(agent\.id\)/, 'must prune on a non-array result');
  assert.ok(raw.includes("register('ticketSupervisor.state'"), 'must register the ticketSupervisor.state gauge');
});

test('static: agent-connection stores/unrefs sweep handles and clears them on destroy', () => {
  const raw = readSrc(['modules', 'agents', 'agent-connection.service.ts']);
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.match(code, /implements OnModuleInit, OnModuleDestroy/, 'must implement OnModuleDestroy');
  assert.match(code, /this\.offlineSweepHandle = setInterval/, 'must store the offline sweep handle');
  assert.match(code, /this\.lockSweepHandle = setInterval/, 'must store the lock sweep handle');
  assert.match(code, /this\.offlineSweepHandle\.unref\?\.\(\)/, 'must unref the offline sweep');
  assert.match(code, /this\.lockSweepHandle\.unref\?\.\(\)/, 'must unref the lock sweep');
  assert.match(code, /onModuleDestroy\(\)[\s\S]*?clearInterval\(this\.offlineSweepHandle\)/, 'must clear offline sweep on destroy');
  assert.match(code, /clearInterval\(this\.lockSweepHandle\)/, 'must clear lock sweep on destroy');
});
