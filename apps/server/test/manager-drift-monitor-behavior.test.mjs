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

test('update-checker-less Runtime Hosts are ignored', async () => {
  const h = makeHarness();
  h.setInstances([
    // Runtime Host that ships no update telemetry (pre-update build): update_available
    // undefined AND no error → skipped entirely.
    { instance_id: 'm0', agent_id: 'a-old', mode: 'manager', hostname: 'y', plugin_version: '0.1.0' },
    // manager exactly up to date — drift false, no alert.
    managerInstance({ agent_id: 'a-current', update_available: false, plugin_version: '0.10.0', latest_version: '0.10.0' }),
  ]);

  const stats = await h.svc.sweep(at(50 * HOUR)); // far past every threshold
  assert.equal(stats.driftAlerts, 0);
  assert.equal(stats.errorAlerts, 0);
  assert.equal(h.warns.length, 0, 'no alert for up-to-date / telemetry-less Runtime Hosts');
});

// ─────────────────────────────────────────────────────────────────────────
// 사라짐(disappearance) 승격 — ticket bfc34cd5.
//
// 매니저 하트비트가 끊기면 InstanceRegistryService 가 90초 TTL 로 인스턴스를
// 스윕한다. 예전 sweep() 은 `registry.list()` 에서 인스턴스가 사라진 것과
// 인스턴스는 살아있는데 조건만 없어진 것을 구분하지 않아 둘 다 "드리프트 해소"
// 로 기록했다 — 나쁜 빌드가 fleet 을 죽이는 순간 대시보드가 밝아지는 반대 신호.
//
// 아래는 승격 케이스와 **비승격 케이스를 함께** 단언한다. 승격만 검증하면 모든
// 종료를 경보로 만드는 회귀(오탐)를 놓치기 때문이다.
// ─────────────────────────────────────────────────────────────────────────

/** 사라짐 경보(WARN)만 골라낸다. */
const vanishWarns = (h) => h.warns.filter((w) => w.meta?.kind === 'manager_vanished');
/** 사라짐 감사 행만 골라낸다. */
const vanishRows = (h) => h.saved.filter((r) => r.action === 'agent_manager_vanished');
/** "해소" info 라인만 골라낸다. */
const resolvedInfos = (h) => h.infos.filter((i) => /resolved|recovered/i.test(i.msg));

test('승격: 드리프트를 추적 중이던 매니저가 사라지면 해소가 아니라 경보를 낸다', async () => {
  const h = makeHarness();
  h.setInstances([managerInstance()]);

  // 스윕 1 — 인스턴스 존재. 드리프트 추적이 시작된다(임계 미달이라 아직 경보 없음).
  let stats = await h.svc.sweep(at(0));
  assert.equal(stats.vanishedAlerts, 0, '존재하는 동안에는 사라짐 경보가 없어야 한다');
  assert.equal(h.warns.length, 0);

  // 스윕 2 — 하트비트가 끊겨 TTL 로 스윕됨: 레지스트리에서 완전히 사라진다.
  h.setInstances([]);
  stats = await h.svc.sweep(at(30 * MIN));

  assert.equal(stats.vanishedAlerts, 1, '사라진 추적 대상은 경보 경로를 타야 한다');
  assert.equal(stats.resolved, 0, '사라짐을 해소로 집계하면 안 된다');
  assert.equal(
    resolvedInfos(h).length,
    0,
    '_logResolved 가 호출되면 안 된다 — 이게 바로 대시보드를 밝히던 잘못된 신호다',
  );

  // WARN 내용: 마지막 관측 스냅샷으로 문구가 채워져야 한다.
  assert.equal(vanishWarns(h).length, 1, 'WARN 이 정확히 1회 발화해야 한다');
  const w = vanishWarns(h)[0];
  assert.match(w.msg, /vanished while unhealthy/i);
  assert.match(w.msg, /NOT a resolution/i);
  assert.match(w.msg, /box-1/, '마지막으로 관측된 hostname 이 문구에 남아야 한다');
  assert.match(w.msg, /v0\.9\.0/, '마지막으로 관측된 버전이 문구에 남아야 한다');
  assert.equal(w.meta.agent_id, 'agent-aaaaaaaa-1111');
  assert.equal(w.meta.hostname, 'box-1');
  assert.equal(w.meta.current_version, '0.9.0');
  assert.equal(w.meta.latest_version, '0.10.0');
  assert.deepEqual(w.meta.unresolved_conditions, ['version_drift']);

  // 영속 감사 행이 남아야 한다.
  assert.equal(vanishRows(h).length, 1, '감사 행이 정확히 1건 남아야 한다');
  const row = vanishRows(h)[0];
  assert.equal(row.entity_type, 'agent_manager');
  assert.equal(row.entity_id, 'agent-aaaaaaaa-1111');
  assert.equal(row.field_changed, 'manager_vanished');
  assert.equal(row.actor_name, 'ManagerDriftMonitor');
  assert.equal(row.old_value, '0.9.0', '사라지기 직전 버전이 감사 행에 남아야 한다');
  const payload = JSON.parse(row.new_value);
  assert.equal(payload.hostname, 'box-1');
  assert.deepEqual(payload.unresolved_conditions, ['version_drift']);
});

test('승격: 체커오류만 추적 중이던 매니저가 사라져도 경보를 낸다', async () => {
  const h = makeHarness();
  h.setInstances([managerInstance({
    update_available: false,
    update_last_error: 'npm view failed: ETIMEDOUT',
  })]);

  await h.svc.sweep(at(0));
  h.setInstances([]);
  const stats = await h.svc.sweep(at(10 * MIN));

  assert.equal(stats.vanishedAlerts, 1);
  assert.equal(stats.resolved, 0);
  assert.equal(resolvedInfos(h).length, 0, '"checker recovered" 로 기록하면 안 된다');
  assert.deepEqual(vanishWarns(h)[0].meta.unresolved_conditions, ['update_check_error']);
  assert.equal(
    vanishWarns(h)[0].meta.update_last_error,
    'npm view failed: ETIMEDOUT',
    '마지막 체커 오류가 경보에 실려야 조사에 쓸 수 있다',
  );
});

test('비승격: 인스턴스가 살아있는 채 드리프트만 해소되면 기존대로 조용히 해소 처리한다', async () => {
  const h = makeHarness();
  h.setInstances([managerInstance()]);
  await h.svc.sweep(at(0));

  // 매니저가 실제로 업데이트됨 — 여전히 하트비트 중이고 이제 최신이다.
  h.setInstances([managerInstance({
    update_available: false, plugin_version: '0.10.0', latest_version: '0.10.0',
  })]);
  const stats = await h.svc.sweep(at(30 * MIN));

  assert.equal(stats.vanishedAlerts, 0, '살아있는 매니저를 사라졌다고 오인하면 안 된다');
  assert.equal(stats.resolved, 1, '이건 진짜 해소다');
  assert.equal(resolvedInfos(h).length, 1);
  assert.equal(h.warns.length, 0, '진짜 해소에는 경보가 붙으면 안 된다');
  assert.equal(vanishRows(h).length, 0);
});

test('비승격(오탐 방지): 추적 이력이 없는 건강한 매니저의 평범한 종료는 아무 것도 남기지 않는다', async () => {
  const h = makeHarness();
  // 최신이고 체커 오류도 없다 — 추적 대상이 된 적이 없다.
  h.setInstances([managerInstance({
    update_available: false, plugin_version: '0.10.0', latest_version: '0.10.0',
  })]);
  let stats = await h.svc.sweep(at(0));
  assert.equal(stats.driftAlerts + stats.errorAlerts + stats.vanishedAlerts, 0);

  // 운영자가 정상 종료 → 레지스트리에서 사라진다.
  h.setInstances([]);
  stats = await h.svc.sweep(at(30 * MIN));

  assert.equal(stats.vanishedAlerts, 0, '평범한 종료를 경보로 만들면 모든 종료가 시끄러워진다');
  assert.equal(h.warns.length, 0, 'WARN 이 하나도 없어야 한다');
  assert.equal(h.saved.length, 0, '감사 행도 남기지 않아야 한다');
  assert.equal(resolvedInfos(h).length, 0);
});

test('비승격: 레지스트리에 남아있는데 텔레메트리만 끊긴 경우는 사라짐이 아니다', async () => {
  const h = makeHarness();
  h.setInstances([managerInstance()]);
  await h.svc.sweep(at(0));

  // 같은 agent 가 여전히 하트비트 중이지만 update 텔레메트리를 싣지 않는
  // 구버전으로 내려간 상황. byAgent 에서는 빠지지만 registry.list() 에는 남는다.
  h.setInstances([{
    instance_id: 'inst-1', agent_id: 'agent-aaaaaaaa-1111',
    mode: 'manager', hostname: 'box-1', plugin_version: '0.9.0',
  }]);
  const stats = await h.svc.sweep(at(30 * MIN));

  assert.equal(
    stats.vanishedAlerts,
    0,
    '프레즌스를 byAgent 로 판정하면 텔레메트리 중단이 사라짐으로 오인된다',
  );
  assert.equal(stats.resolved, 1);
  assert.equal(vanishWarns(h).length, 0);
});

test('dedupe: 사라진 뒤 스윕을 반복해도 경보는 1회만 발화한다', async () => {
  const h = makeHarness();
  h.setInstances([managerInstance()]);
  await h.svc.sweep(at(0));

  h.setInstances([]);
  let stats = await h.svc.sweep(at(30 * MIN));
  assert.equal(stats.vanishedAlerts, 1);
  assert.equal(vanishWarns(h).length, 1);
  assert.equal(vanishRows(h).length, 1);

  // 이후 스윕들 — 여전히 부재. 스윕마다 다시 쏘면 안 된다.
  for (const t of [40 * MIN, 2 * HOUR, 12 * HOUR, 40 * HOUR]) {
    stats = await h.svc.sweep(at(t));
    assert.equal(stats.vanishedAlerts, 0, `${t}ms 시점에 중복 발화`);
  }
  assert.equal(vanishWarns(h).length, 1, 'WARN 총 1건이어야 한다');
  assert.equal(vanishRows(h).length, 1, '감사 행 총 1건이어야 한다');

  // 매니저가 돌아와 다시 드리프트하다가 또 사라지면 그건 별개의 사건이다.
  h.setInstances([managerInstance()]);
  await h.svc.sweep(at(41 * HOUR));
  h.setInstances([]);
  stats = await h.svc.sweep(at(42 * HOUR));
  assert.equal(stats.vanishedAlerts, 1, '재발은 새 사건으로 다시 경보해야 한다');
  assert.equal(vanishWarns(h).length, 2);
});

test('사라짐 경보는 드리프트 임계·재경보 쿨다운과 무관하게 즉시 발화한다', async () => {
  const h = makeHarness();
  h.setInstances([managerInstance()]);

  // 드리프트 임계(2h)에 한참 못 미치는 시점에 사라진다. 빠른 auto-update 가
  // 나쁜 빌드를 집어 매니저를 죽이는 경로가 정확히 이 모양이므로, 임계를
  // 기다렸다가 놓치면 안 된다.
  await h.svc.sweep(at(0));
  assert.equal(h.warns.length, 0, '아직 드리프트 임계 미달');

  h.setInstances([]);
  const stats = await h.svc.sweep(at(5 * MIN));
  assert.equal(stats.vanishedAlerts, 1, '임계 미달이어도 사라짐은 즉시 경보해야 한다');
  assert.equal(stats.driftAlerts, 0, '드리프트 경보로 잘못 집계하면 안 된다');
});
