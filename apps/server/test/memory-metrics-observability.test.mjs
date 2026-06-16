// Behavioural + static regression — ticket 38546a07 (memory observability:
// RSS + in-memory map size health gauges).
//
// Adds a `collections` section to GET /api/diagnostics/memory and folds the
// same sizes into the `[Memory]` watchdog log row. The mechanism is a
// dependency-free MemoryMetricsRegistry: every long-lived collection holder
// self-registers a `() => size` gauge; the diagnostics controller and the
// watchdog just call collect(). This test pins three things:
//
//   1. Registry behaviour — register/collect, idempotent overwrite by name,
//      key-sorted output, and a throwing gauge degrading to -1 rather than
//      taking down the whole snapshot (observability must not crash the
//      endpoint it observes).
//   2. SessionStore.distinctAgentCount() — the successor gauge to the removed
//      agentId→McpServer map; collapses reconnect-overlap duplicate sessions
//      to unique connected agents.
//   3. Static wiring — each holder named in the ticket actually registers a
//      gauge, the public endpoint emits `collections`, and the watchdog wires
//      the debounced threshold warn. A future refactor that drops a
//      registration silently would regress the observability surface without
//      this guard.

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

test('registry: register + collect returns key-sorted sizes', async () => {
  const { MemoryMetricsRegistry } = await loadDist(['services', 'memory-metrics.registry.js']);
  const reg = new MemoryMetricsRegistry();
  let n = 3;
  reg.register('zeta.map', () => 7);
  reg.register('alpha.set', () => n);
  const snap = reg.collect();
  assert.deepEqual(Object.keys(snap), ['alpha.set', 'zeta.map'], 'keys must be sorted');
  assert.equal(snap['alpha.set'], 3);
  assert.equal(snap['zeta.map'], 7);
  // Gauges are live closures — re-collecting reflects the new size.
  n = 9;
  assert.equal(reg.collect()['alpha.set'], 9);
});

test('registry: re-registering a name overwrites (no duplicate closure leak)', async () => {
  const { MemoryMetricsRegistry } = await loadDist(['services', 'memory-metrics.registry.js']);
  const reg = new MemoryMetricsRegistry();
  reg.register('dup', () => 1);
  reg.register('dup', () => 2);
  const snap = reg.collect();
  assert.equal(Object.keys(snap).filter((k) => k === 'dup').length, 1);
  assert.equal(snap['dup'], 2);
});

test('registry: a throwing gauge degrades to -1, others still report', async () => {
  const { MemoryMetricsRegistry } = await loadDist(['services', 'memory-metrics.registry.js']);
  const reg = new MemoryMetricsRegistry();
  reg.register('ok', () => 5);
  reg.register('boom', () => {
    throw new Error('gauge failure');
  });
  const snap = reg.collect();
  assert.equal(snap['ok'], 5, 'healthy gauge unaffected by a sibling throwing');
  assert.equal(snap['boom'], -1, 'throwing gauge reported as -1, not propagated');
});

test('registry: unregister removes the gauge', async () => {
  const { MemoryMetricsRegistry } = await loadDist(['services', 'memory-metrics.registry.js']);
  const reg = new MemoryMetricsRegistry();
  reg.register('temp', () => 1);
  reg.unregister('temp');
  assert.equal(Object.prototype.hasOwnProperty.call(reg.collect(), 'temp'), false);
});

test('sessionStore.distinctAgentCount collapses reconnect-overlap duplicates', async () => {
  const { sessionStore } = await loadDist(['modules', 'mcp', 'internal', 'session-store.js']);
  const fakeTransport = () => ({ close: async () => {} });
  const fakeServer = () => ({});
  // Two live sessions for the SAME agent (reconnect overlap) + one for another.
  sessionStore.register('s1', fakeTransport(), fakeServer(), { agentId: 'agentA', source: 'db' });
  sessionStore.register('s2', fakeTransport(), fakeServer(), { agentId: 'agentA', source: 'db' });
  sessionStore.register('s3', fakeTransport(), fakeServer(), { agentId: 'agentB', source: 'db' });
  // A session with no agentId (unauthenticated handshake) must not be counted.
  sessionStore.register('s4', fakeTransport(), fakeServer());
  try {
    assert.equal(sessionStore.size, 4, 'raw session count includes every transport');
    assert.equal(sessionStore.distinctAgentCount(), 2, 'distinct agents collapse duplicates, ignore null');
  } finally {
    for (const sid of ['s1', 's2', 's3', 's4']) sessionStore.remove(sid);
  }
  assert.equal(sessionStore.distinctAgentCount(), 0, 'drains back to 0 after removal');
});

test('static: every ticket-named collection holder registers a gauge', () => {
  const cases = [
    [['services', 'auth.service.ts'], "register('auth.sessions'"],
    [['services', 'presence.service.ts'], "register('presence.tickets'"],
    [['services', 'presence.service.ts'], "register('presence.viewers'"],
    [['services', 'memory-watchdog.service.ts'], "register('log.entries'"],
    [['modules', 'mcp', 'mcp.controller.ts'], "register('mcp.sessions'"],
    [['modules', 'mcp', 'mcp.controller.ts'], "register('mcp.connectedAgents'"],
    [['modules', 'events', 'events.controller.ts'], "register('sse.connections'"],
    [['modules', 'events', 'events.controller.ts'], "register('sse.agents'"],
    [['modules', 'events', 'events.controller.ts'], "register('sse.mainPins'"],
    [['modules', 'agent-manager', 'instance-registry.service.ts'], "register('agentManager.instances'"],
    [['modules', 'agent-manager', 'pairing.service.ts'], "register('agentManager.pairingTokens'"],
    [['modules', 'agent-manager', 'command-ledger.service.ts'], "register('agentManager.commandRecords'"],
  ];
  for (const [relParts, needle] of cases) {
    assert.ok(
      readSrc(relParts).includes(needle),
      `${relParts.join('/')} must self-register gauge via ${needle})`,
    );
  }
});

test('static: public diagnostics endpoint emits a collections section', () => {
  const src = readSrc(['modules', 'admin', 'diagnostics.controller.ts']);
  assert.ok(
    src.includes('collections: this.metricsRegistry.collect()'),
    'GET /api/diagnostics/memory must include collections from the registry',
  );
});

test('static: watchdog wires the debounced collection threshold warn', () => {
  const src = readSrc(['services', 'memory-watchdog.service.ts']);
  assert.ok(src.includes('checkCollectionThresholds'), 'watchdog must run the threshold check');
  assert.ok(src.includes('breachingCollections'), 'must use an edge-triggered breach set for debounce');
  assert.ok(
    src.includes('MEMORY_WATCHDOG_COLLECTION_WARN'),
    'threshold must be env-configurable',
  );
});
