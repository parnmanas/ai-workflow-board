// Behavioral test for ManagerDriftMonitorService.sweep() — ticket 7485df07.
//
// Drives the monitor against a stub InstanceRegistry (no DB, no real timers)
// with an injected `now`, exercising the onset clock, alert threshold, re-alert
// cooldown (dedup), and resolution transition for both conditions:
//
//   drift  — instance.update_available === true (running behind latest)
//   error  — instance.update_last_error non-empty (the update checker failing)
//
// Imports the compiled service from dist/ (built by `npm run build` in the test
// script). Construction bypasses Nest DI: stub registry + stub LogService +
// stub DataSource (getRepository → { create, save }), exactly the constructor
// seams the service exposes, plus the `now` param on sweep().
//
// The service reads thresholds from env at construction; these tests rely on
// the built-in DEFAULTS (drift 2h, error 30m, realert 6h) and cross them by
// advancing `now`, so they don't mutate process.env.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ManagerDriftMonitorService,
  __test__,
} from '../dist/modules/agent-manager/manager-drift-monitor.service.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = new Date('2026-06-30T00:00:00.000Z').getTime();
const at = (ms) => new Date(T0 + ms);

function managerInstance(over = {}) {
  return {
    instance_id: over.instance_id || 'inst-1',
    agent_id: over.agent_id || 'agent-aaaaaaaa-1111',
    mode: 'manager',
    hostname: over.hostname || 'box-1',
    plugin_version: over.plugin_version || '0.9.0',
    latest_version: 'latest_version' in over ? over.latest_version : '0.10.0',
    update_available: 'update_available' in over ? over.update_available : true,
    default_branch: over.default_branch || 'main',
    update_last_error: 'update_last_error' in over ? over.update_last_error : null,
    ...over,
  };
}

function makeHarness() {
  let instances = [];
  const warns = [];
  const infos = [];
  const errors = [];
  const saved = [];
  const log = {
    warn: (cat, msg, meta) => warns.push({ cat, msg, meta }),
    info: (cat, msg, meta) => infos.push({ cat, msg, meta }),
    error: (cat, msg, meta) => errors.push({ cat, msg, meta }),
    debug: () => {},
  };
  const registry = { list: () => instances };
  const repo = {
    create: (x) => x,
    save: async (x) => { saved.push(x); return x; },
  };
  const dataSource = { getRepository: () => repo };
  const svc = new ManagerDriftMonitorService(registry, log, dataSource);
  return {
    svc,
    setInstances: (arr) => { instances = arr; },
    warns, infos, errors, saved,
  };
}

test('readConfigFromEnv parses env and falls back to defaults', () => {
  const def = __test__.readConfigFromEnv({});
  assert.equal(def.enabled, true);
  assert.equal(def.driftThresholdMs, __test__.DEFAULTS.DRIFT_THRESHOLD_MS);
  assert.equal(def.errorThresholdMs, __test__.DEFAULTS.ERROR_THRESHOLD_MS);

  const custom = __test__.readConfigFromEnv({
    MANAGER_DRIFT_MONITOR_ENABLED: 'false',
    MANAGER_DRIFT_SWEEP_MS: '1000',
    MANAGER_DRIFT_THRESHOLD_MS: '5000',
    MANAGER_DRIFT_ERROR_THRESHOLD_MS: '2000',
    MANAGER_DRIFT_REALERT_MS: '9000',
  });
  assert.equal(custom.enabled, false);
  assert.equal(custom.sweepMs, 1000);
  assert.equal(custom.driftThresholdMs, 5000);
  assert.equal(custom.errorThresholdMs, 2000);
  assert.equal(custom.realertMs, 9000);

  // Junk / non-positive values fall back to the default, not 0/NaN.
  const junk = __test__.readConfigFromEnv({ MANAGER_DRIFT_THRESHOLD_MS: 'abc', MANAGER_DRIFT_SWEEP_MS: '-5' });
  assert.equal(junk.driftThresholdMs, __test__.DEFAULTS.DRIFT_THRESHOLD_MS);
  assert.equal(junk.sweepMs, __test__.DEFAULTS.SWEEP_MS);
});

test('drift below threshold does not alert; past threshold alerts once and persists a record', async () => {
  const h = makeHarness();
  h.setInstances([managerInstance()]);

  // age 0 — far below the 2h drift threshold.
  let stats = await h.svc.sweep(at(0));
  assert.equal(stats.driftAlerts, 0, 'no alert at onset');
  assert.equal(h.warns.length, 0);
  assert.equal(stats.agents, 1);

  // age ~1h — still below threshold.
  stats = await h.svc.sweep(at(1 * HOUR));
  assert.equal(stats.driftAlerts, 0, 'no alert below threshold');
  assert.equal(h.warns.length, 0);

  // age just past 2h — first alert fires.
  stats = await h.svc.sweep(at(2 * HOUR + MIN));
  assert.equal(stats.driftAlerts, 1, 'alert once threshold crossed');
  assert.equal(h.warns.length, 1);
  assert.match(h.warns[0].msg, /version drift/i);
  assert.equal(h.warns[0].meta.kind, 'version_drift');
  assert.equal(h.warns[0].meta.agent_id, 'agent-aaaaaaaa-1111');

  // durable audit row written exactly once so far.
  assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0].entity_type, 'agent_manager');
  assert.equal(h.saved[0].action, 'agent_manager_drift');
  assert.equal(h.saved[0].actor_name, 'ManagerDriftMonitor');
  assert.equal(h.saved[0].entity_id, 'agent-aaaaaaaa-1111');
});

test('re-alert is suppressed within the cooldown and re-fires after it', async () => {
  const h = makeHarness();
  h.setInstances([managerInstance()]);

  await h.svc.sweep(at(0));
  await h.svc.sweep(at(2 * HOUR + MIN)); // first alert @ ~2h1m
  assert.equal(h.warns.length, 1);

  // 1h after first alert — well inside the 6h realert cooldown → dedup.
  let stats = await h.svc.sweep(at(3 * HOUR + MIN));
  assert.equal(stats.driftAlerts, 0, 'deduped inside cooldown');
  assert.equal(h.warns.length, 1);
  assert.equal(h.saved.length, 1, 'no extra audit row while deduped');

  // >6h after the first alert (first alert was @2h1m → fire again ~8h2m).
  stats = await h.svc.sweep(at(8 * HOUR + 2 * MIN));
  assert.equal(stats.driftAlerts, 1, 're-alert after cooldown lapses');
  assert.equal(h.warns.length, 2);
  assert.equal(h.saved.length, 2);
});

test('resolution: drift clearing logs a resolved line and forgets the agent', async () => {
  const h = makeHarness();
  h.setInstances([managerInstance()]);

  await h.svc.sweep(at(0));
  await h.svc.sweep(at(2 * HOUR + MIN)); // alerted
  assert.equal(h.warns.length, 1);

  // Manager updated: same agent still heartbeats but is no longer behind.
  h.setInstances([managerInstance({ update_available: false, plugin_version: '0.10.0', latest_version: '0.10.0' })]);
  let stats = await h.svc.sweep(at(2 * HOUR + 5 * MIN));
  assert.equal(stats.resolved, 1, 'condition resolved');
  assert.equal(h.infos.filter((i) => /drift resolved/i.test(i.msg)).length, 1);

  // A later sweep with no drift produces no further alerts (state was cleared).
  stats = await h.svc.sweep(at(20 * HOUR));
  assert.equal(stats.driftAlerts, 0);
  assert.equal(h.warns.length, 1, 'no spurious re-alert after resolution');
});

test('checker-error condition alerts on its own (shorter) threshold', async () => {
  const h = makeHarness();
  // Not behind on version, but the update checker itself is erroring.
  h.setInstances([managerInstance({
    update_available: false,
    update_last_error: 'git fetch failed: Could not resolve host: github.com',
  })]);

  // First observation @10m establishes the onset clock; age is measured from
  // here, not from T0.
  let stats = await h.svc.sweep(at(10 * MIN));
  assert.equal(stats.errorAlerts, 0, 'no alert at onset');
  assert.equal(h.warns.length, 0);

  // @30m — only 20m since onset, still below the 30m error threshold.
  stats = await h.svc.sweep(at(30 * MIN));
  assert.equal(stats.errorAlerts, 0, 'no alert below threshold (20m since onset)');
  assert.equal(h.warns.length, 0);

  // @45m — 35m since onset, past threshold → alert.
  stats = await h.svc.sweep(at(45 * MIN));
  assert.equal(stats.errorAlerts, 1);
  assert.equal(h.warns.length, 1);
  assert.match(h.warns[0].msg, /checker failing/i);
  assert.equal(h.warns[0].meta.kind, 'update_check_error');
  assert.equal(h.saved[0].action, 'agent_manager_update_error');

  // Checker recovers → resolved, state forgotten.
  h.setInstances([managerInstance({ update_available: false, update_last_error: null })]);
  stats = await h.svc.sweep(at(50 * MIN));
  assert.equal(stats.resolved, 1);
  assert.equal(h.infos.filter((i) => /checker recovered/i.test(i.msg)).length, 1);
});

test('non-manager instances and update-checker-less managers are ignored', async () => {
  const h = makeHarness();
  h.setInstances([
    // daemon/proxy — never considered.
    { instance_id: 'd1', agent_id: 'a-daemon', mode: 'proxy', hostname: 'x', plugin_version: '1', update_available: true },
    // manager that ships no update telemetry (pre-update build): update_available
    // undefined AND no error → skipped entirely.
    { instance_id: 'm0', agent_id: 'a-old', mode: 'manager', hostname: 'y', plugin_version: '0.1.0' },
    // manager exactly up to date — drift false, no alert.
    managerInstance({ agent_id: 'a-current', update_available: false, plugin_version: '0.10.0', latest_version: '0.10.0' }),
  ]);

  const stats = await h.svc.sweep(at(50 * HOUR)); // far past every threshold
  assert.equal(stats.driftAlerts, 0);
  assert.equal(stats.errorAlerts, 0);
  assert.equal(h.warns.length, 0, 'no alert for non-manager / up-to-date / telemetry-less');
});
