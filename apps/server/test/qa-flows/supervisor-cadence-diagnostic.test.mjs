// Per-workspace supervisor cadence / liveness diagnostic (ticket 1fcba693).
//
// The staleMsElevated gauge only counts HOW MANY workspaces are mis-set. This
// endpoint answers WHICH one and by how much: configured vs default vs effective
// cadence + source + elevated flag + the recovery thresholds/bounds a value
// implies. So the incident's 4 h supervisor_stale_ms is visible at the source,
// with provenance — the "출처·effective value가 진단에서 확인 가능" DoD. Public
// read (same posture as GET /api/diagnostics/memory).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bootApp } from '../helpers/boot.mjs';
import { createWorkspace } from '../helpers/fixtures.mjs';

const FOUR_H = 4 * 60 * 60_000;
const FIVE_MIN = 5 * 60_000; // stale window SMALLER than the 15 min current_task TTL
const TICK = 60_000;
const FLOOR = 120_000; // 2 min liveness floor
const TTL = 900_000; // 15 min current_task TTL

test('supervisor-cadence diagnostic: exposes per-workspace configured/default/effective + elevated + recovery thresholds/bounds', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT || '7873', 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const ds = app.get(modules.getDataSourceToken());

  const wsDefault = await createWorkspace(app, modules.getDataSourceToken, { name: 'cadence-default' });
  const wsIncident = await createWorkspace(app, modules.getDataSourceToken, { name: 'cadence-incident' });
  // stale window SMALLER than the current_task TTL — the case the old
  // Math.min(stale, TTL) leaked-bound under-reported (reviewer blocker).
  const wsShort = await createWorkspace(app, modules.getDataSourceToken, { name: 'cadence-short' });
  // Reproduce the incident band-aid on one workspace.
  await ds.getRepository('Workspace').update(wsIncident.id, { supervisor_stale_ms: FOUR_H });
  await ds.getRepository('Workspace').update(wsShort.id, { supervisor_stale_ms: FIVE_MIN });

  const resp = await fetch(`http://127.0.0.1:${port}/api/diagnostics/supervisor-cadence`);
  assert.equal(resp.status, 200, 'public endpoint reachable without auth');
  const body = await resp.json();

  // Self-documenting defaults block (the "reasonable defaults" half of the DoD).
  assert.equal(body.units, 'ms');
  assert.equal(body.defaults.supervisor_stale_ms, 1_800_000, 'default stale = 30 min');
  assert.equal(body.defaults.supervisor_resend_ms, 300_000, 'default resend = 5 min');
  assert.equal(body.defaults.liveness_floor_ms, FLOOR, 'liveness floor = 2 min');
  assert.equal(body.defaults.sane_max_ms, 7_200_000, 'sane-max = 2 h');
  assert.equal(body.defaults.current_task_stale_ms, TTL, 'current_task TTL = 15 min');
  assert.equal(body.defaults.supervisor_tick_ms, TICK, 'supervisor tick = 60 s (exposed so bound = threshold + tick is legible)');
  assert.equal(body.liveness_floor.effective_ms, FLOOR);
  assert.equal(body.liveness_floor.source, 'default');

  const byId = Object.fromEntries(body.workspaces.map((w) => [w.workspace_id, w]));

  // Incident workspace: the 4 h value is visible, flagged, with its provenance.
  const inc = byId[wsIncident.id];
  assert.ok(inc, 'incident workspace present in the diagnostic');
  assert.equal(inc.supervisor_stale_ms.configured, FOUR_H, 'configured value surfaced');
  assert.equal(inc.supervisor_stale_ms.effective, FOUR_H, 'effective = the value the tick uses');
  assert.equal(inc.supervisor_stale_ms.is_default, false, 'NOT the default (a custom/incident value)');
  assert.equal(inc.elevated, true, 'flagged elevated (far above the sane-max)');
  assert.equal(inc.supervisor_tick_ms, TICK, 'tick echoed per workspace');
  // Detection thresholds (tick-exclusive), split by death-mode (reviewer AC):
  // a single "absent" number conflated two very different guarantees.
  assert.equal(inc.recovery_thresholds_ms.registry_absent, FLOOR, 'registry-absent threshold = the 2 min floor, not 4 h');
  assert.equal(inc.recovery_thresholds_ms.leaked_current_task, TTL, 'leaked-current_task threshold = the 15 min TTL — NOT the floor');
  assert.equal(inc.recovery_thresholds_ms.present_strand, FOUR_H, 'present-but-quiet strand is paced off the 4 h window');
  // Observed bounds = threshold + one supervisor tick, so the field named
  // *_bounds_ms actually equals the observed upper bound (reviewer AC #2).
  assert.equal(inc.recovery_bounds_ms.registry_absent, FLOOR + TICK, 'registry-absent bound includes the up-to-one-tick detection lag');
  assert.equal(inc.recovery_bounds_ms.leaked_current_task, TTL + TICK, 'leaked bound = 15 min TTL + one tick');
  assert.equal(inc.recovery_bounds_ms.present_strand, FOUR_H + TICK, 'present-strand bound = 4 h window + one tick');

  // Default workspace: effective = default, not elevated.
  const def = byId[wsDefault.id];
  assert.ok(def, 'default workspace present');
  assert.equal(def.supervisor_stale_ms.effective, 1_800_000);
  assert.equal(def.supervisor_stale_ms.is_default, true, 'default value flagged as default');
  assert.equal(def.elevated, false, 'a default-cadence workspace is never elevated');
  assert.equal(def.recovery_thresholds_ms.registry_absent, FLOOR, 'registry-absent threshold is the floor under a 30 min window too');
  assert.equal(def.recovery_thresholds_ms.leaked_current_task, TTL, 'leaked threshold = the 15 min TTL (TTL < the 30 min stale window)');
  assert.equal(def.recovery_bounds_ms.leaked_current_task, TTL + TICK);

  // REGRESSION (reviewer blocker): a stale window SMALLER than the 15 min TTL.
  // The old code reported leaked = Math.min(stale, TTL) = 5 min, but a LEAKED
  // current_task counts as live until its TTL, so the seat is NOT reclaimable at
  // 5 min — the honest number is the 15 min TTL, independent of the small stale
  // window. This case is what makes the min() bug observable.
  const short = byId[wsShort.id];
  assert.ok(short, 'short-stale workspace present');
  assert.equal(short.supervisor_stale_ms.effective, FIVE_MIN, 'effective = the 5 min value');
  assert.equal(short.recovery_thresholds_ms.registry_absent, FLOOR, 'registry-absent threshold = floor (floor < 5 min stale, so floor wins)');
  assert.equal(
    short.recovery_thresholds_ms.leaked_current_task,
    TTL,
    'leaked threshold stays the 15 min TTL even though the stale window is only 5 min — NOT min(5 min, 15 min) = 5 min',
  );
  assert.notEqual(
    short.recovery_thresholds_ms.leaked_current_task,
    FIVE_MIN,
    'guards against a regression to the under-reporting min(stale, TTL) bound',
  );
  assert.equal(short.recovery_thresholds_ms.present_strand, FIVE_MIN, 'present-strand threshold = the small 5 min window');
  assert.equal(short.recovery_bounds_ms.leaked_current_task, TTL + TICK, 'leaked bound = 15 min TTL + one tick, not 5 min + tick');
  assert.equal(short.recovery_bounds_ms.present_strand, FIVE_MIN + TICK, 'present-strand bound = 5 min + one tick');

  assert.equal(body.elevated_count >= 1, true, 'at least the incident workspace is counted elevated');
});
