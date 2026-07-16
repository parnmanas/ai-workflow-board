// Per-workspace supervisor cadence / liveness diagnostic (ticket 1fcba693).
//
// The staleMsElevated gauge only counts HOW MANY workspaces are mis-set. This
// endpoint answers WHICH one and by how much: configured vs default vs effective
// cadence + source + elevated flag + the recovery bounds a value implies. So the
// incident's 4 h supervisor_stale_ms is visible at the source, with provenance —
// the "출처·effective value가 진단에서 확인 가능" DoD. Public read (same posture as
// GET /api/diagnostics/memory).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bootApp } from '../helpers/boot.mjs';
import { createWorkspace } from '../helpers/fixtures.mjs';

const FOUR_H = 4 * 60 * 60_000;

test('supervisor-cadence diagnostic: exposes per-workspace configured/default/effective + elevated + recovery bounds', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT || '7873', 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const ds = app.get(modules.getDataSourceToken());

  const wsDefault = await createWorkspace(app, modules.getDataSourceToken, { name: 'cadence-default' });
  const wsIncident = await createWorkspace(app, modules.getDataSourceToken, { name: 'cadence-incident' });
  // Reproduce the incident band-aid on one workspace.
  await ds.getRepository('Workspace').update(wsIncident.id, { supervisor_stale_ms: FOUR_H });

  const resp = await fetch(`http://127.0.0.1:${port}/api/diagnostics/supervisor-cadence`);
  assert.equal(resp.status, 200, 'public endpoint reachable without auth');
  const body = await resp.json();

  // Self-documenting defaults block (the "reasonable defaults" half of the DoD).
  assert.equal(body.units, 'ms');
  assert.equal(body.defaults.supervisor_stale_ms, 1_800_000, 'default stale = 30 min');
  assert.equal(body.defaults.supervisor_resend_ms, 300_000, 'default resend = 5 min');
  assert.equal(body.defaults.liveness_floor_ms, 120_000, 'liveness floor = 2 min');
  assert.equal(body.defaults.sane_max_ms, 7_200_000, 'sane-max = 2 h');
  assert.equal(body.defaults.current_task_stale_ms, 900_000, 'current_task TTL = 15 min');
  assert.equal(body.liveness_floor.effective_ms, 120_000);
  assert.equal(body.liveness_floor.source, 'default');

  const byId = Object.fromEntries(body.workspaces.map((w) => [w.workspace_id, w]));

  // Incident workspace: the 4 h value is visible, flagged, with its provenance.
  const inc = byId[wsIncident.id];
  assert.ok(inc, 'incident workspace present in the diagnostic');
  assert.equal(inc.supervisor_stale_ms.configured, FOUR_H, 'configured value surfaced');
  assert.equal(inc.supervisor_stale_ms.effective, FOUR_H, 'effective = the value the tick uses');
  assert.equal(inc.supervisor_stale_ms.is_default, false, 'NOT the default (a custom/incident value)');
  assert.equal(inc.elevated, true, 'flagged elevated (far above the sane-max)');
  assert.equal(inc.absent_strand_recovery_ms, 120_000, 'a DEAD strand still recovers within the 2 min floor, not 4 h');
  assert.equal(inc.present_strand_recovery_ms, FOUR_H, 'a PRESENT-but-quiet strand is paced off the 4 h window (the observable harm)');

  // Default workspace: effective = default, not elevated.
  const def = byId[wsDefault.id];
  assert.ok(def, 'default workspace present');
  assert.equal(def.supervisor_stale_ms.effective, 1_800_000);
  assert.equal(def.supervisor_stale_ms.is_default, true, 'default value flagged as default');
  assert.equal(def.elevated, false, 'a default-cadence workspace is never elevated');
  assert.equal(def.absent_strand_recovery_ms, 120_000, 'dead-strand recovery is the floor under a 30 min window too');

  assert.equal(body.elevated_count >= 1, true, 'at least the incident workspace is counted elevated');
});
