// Behavioural + static regression — ticket 59090d37 ([mem-leak v2]:
// subagent-monitor appendLocks Map never evicts → prod OOM).
//
// The bug: `_serialize` stored `prior.then(() => next)` (a fresh chained
// promise) under the subagentId key, but its finally-guard deleted only
// `if (appendLocks.get(key) === next)`. The stored value is the chain, never
// `=== next`, so the guard was dead and EVERY subagentId left a permanent
// entry — one retained promise chain per subagent forever. At hundreds–
// thousands of subagents/day this is the unbounded grower behind "OOM only
// after long uptime".
//
// The fix deletes by identity of the actually-stored chained promise. This
// test drives appendLines through the real service (fake repos) and asserts:
//
//   1. A single subagent's lock is evicted once its append drains (size → 0).
//   2. N distinct subagents each appending then draining collapses to 0 —
//      the size is NON-MONOTONIC across waves, not one-entry-per-id-forever.
//   3. Overlapping appends on the SAME key serialize and still fully drain
//      (the last finisher owns the eviction), AND order is preserved.
//   4. The `subagent.appendLocks` gauge registered into MemoryMetricsRegistry
//      tracks the live size (so /api/diagnostics/memory reflects a regression).
//   5. Static guard — the eviction compares against the stored `chained`
//      promise, never the dead `=== next` form a refactor might reintroduce.

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

// Fake TypeORM repositories — just enough for appendLines() to complete its
// read-insert-update cycle without a real DB. line_count math is irrelevant to
// the leak; we only care that run() resolves so _serialize hits its finally.
function makeService(MonitorClass, RegistryClass) {
  const subagents = {
    async findOne({ where: { subagent_id } }) {
      return { subagent_id, agent_id: 'agentX', workspace_id: 'wsX', line_count: 0 };
    },
    async update() {},
    async find() {
      return [];
    },
  };
  const lines = {
    create(row) {
      return row;
    },
    async save() {},
  };
  const logService = { info() {}, warn() {}, error() {}, debug() {}, log() {} };
  const registry = new RegistryClass();
  const service = new MonitorClass(subagents, lines, logService, registry);
  return { service, registry };
}

const ONE_LINE = [{ direction: 'out', line: 'hello' }];

test('single subagent: appendLocks evicts once the append drains', async () => {
  const { SubagentMonitorService } = await loadDist(['services', 'subagent-monitor.service.js']);
  const { MemoryMetricsRegistry } = await loadDist(['services', 'memory-metrics.registry.js']);
  const { service } = makeService(SubagentMonitorService, MemoryMetricsRegistry);

  assert.equal(service.appendLocks.size, 0, 'starts empty');
  const p = service.appendLines('sa-1', 'agentX', ONE_LINE);
  // _serialize sets the lock synchronously before its first await.
  assert.equal(service.appendLocks.size, 1, 'lock present while in-flight');
  const res = await p;
  assert.deepEqual(res, { ok: true });
  assert.equal(service.appendLocks.size, 0, 'lock evicted after drain (the dead-guard regression)');
});

test('N distinct subagents: size collapses to 0, not monotonic across waves', async () => {
  const { SubagentMonitorService } = await loadDist(['services', 'subagent-monitor.service.js']);
  const { MemoryMetricsRegistry } = await loadDist(['services', 'memory-metrics.registry.js']);
  const { service } = makeService(SubagentMonitorService, MemoryMetricsRegistry);

  const N = 200;
  // Wave 1
  await Promise.all(
    Array.from({ length: N }, (_, i) => service.appendLines(`wave1-${i}`, 'agentX', ONE_LINE)),
  );
  assert.equal(service.appendLocks.size, 0, 'wave 1 fully evicted');

  // Wave 2 — fresh subagentIds. With the old leak the map would now hold 2N
  // permanent entries; with the fix it returns to 0 again.
  await Promise.all(
    Array.from({ length: N }, (_, i) => service.appendLines(`wave2-${i}`, 'agentX', ONE_LINE)),
  );
  assert.equal(service.appendLocks.size, 0, 'wave 2 fully evicted — size is non-monotonic');
});

test('overlapping appends on the same key serialize, preserve order, and fully drain', async () => {
  const { SubagentMonitorService } = await loadDist(['services', 'subagent-monitor.service.js']);
  const { MemoryMetricsRegistry } = await loadDist(['services', 'memory-metrics.registry.js']);
  const { service } = makeService(SubagentMonitorService, MemoryMetricsRegistry);

  // Fire several appends for ONE subagent without awaiting between them — this
  // is the concurrency the lock guards. They must run in submission order and
  // the map must be back to empty once the last one finishes.
  const order = [];
  const orig = service.lines.save.bind(service.lines);
  service.lines.save = async (rows) => {
    order.push(rows[0]?.line);
    return orig(rows);
  };

  const pending = [];
  for (let i = 0; i < 8; i++) {
    pending.push(service.appendLines('same-key', 'agentX', [{ direction: 'out', line: `L${i}` }]));
  }
  // While in-flight the key occupies exactly one slot (overwritten, not leaked).
  assert.equal(service.appendLocks.size, 1, 'one slot for the contended key while in-flight');

  await Promise.all(pending);
  assert.equal(service.appendLocks.size, 0, 'contended key evicted after the last finisher drains');
  assert.deepEqual(order, ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'], 'serialization order preserved');
});

test('the subagent.appendLocks gauge tracks the live map size', async () => {
  const { SubagentMonitorService } = await loadDist(['services', 'subagent-monitor.service.js']);
  const { MemoryMetricsRegistry } = await loadDist(['services', 'memory-metrics.registry.js']);
  const { service, registry } = makeService(SubagentMonitorService, MemoryMetricsRegistry);

  assert.equal(registry.collect()['subagent.appendLocks'], 0, 'gauge registered and starts at 0');
  const p = service.appendLines('gauge-1', 'agentX', ONE_LINE);
  assert.equal(registry.collect()['subagent.appendLocks'], 1, 'gauge reflects in-flight lock');
  await p;
  assert.equal(registry.collect()['subagent.appendLocks'], 0, 'gauge drains back to 0');
});

// Static guard: a future refactor must not reintroduce the dead `=== next`
// comparison. The eviction has to compare the map head against the promise it
// actually stored.
test('static: _serialize evicts by the stored chained promise, not the dead `=== next`', () => {
  const src = fs.readFileSync(path.join(SRC, 'services', 'subagent-monitor.service.ts'), 'utf8');
  // Strip comments so prose mentioning the old form doesn't false-pass/fail.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.match(
    code,
    /const chained = prior\.then\(\(\) => next\);/,
    'must bind the chained promise to a variable',
  );
  assert.match(
    code,
    /this\.appendLocks\.set\([^,]+,\s*chained\)/,
    'must store the chained promise under the key',
  );
  assert.match(
    code,
    /if \(this\.appendLocks\.get\([^)]+\) === chained\)\s*this\.appendLocks\.delete/,
    'eviction must compare against the stored `chained`, not `next`',
  );
  assert.doesNotMatch(
    code,
    /appendLocks\.get\([^)]+\) === next/,
    'the dead `=== next` guard must not reappear',
  );
});
