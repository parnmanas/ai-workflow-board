// Account config-change audit (ticket 1fcba693).
//
// The incident's 4 h supervisor_stale_ms was applied at runtime with NO audit
// trail — account updates were never recorded, so the change's actor / time /
// source could only be RECONSTRUCTED from row timestamps + code archaeology, not
// proven. This closes that gap: every change to a supervisor/dispatch cadence
// knob now writes a grep-able `config_changed` ActivityLog row carrying
// actor + old→new + source, so a value like that can never again land silently.
//
// Real boot: drive the actual AccountsController.update() (REST path) and
// assert the persisted audit rows. A static guard pins the MCP write path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bootApp } from '../helpers/boot.mjs';
import { createAccount, createAgent, createApiKey, createUser } from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', '..', 'dist');
const loadDist = (...p) => import('file://' + path.join(DIST_ROOT, ...p));

function fakeRes() {
  return { _status: 200, _json: undefined, status(c) { this._status = c; return this; }, json(x) { this._json = x; return this; } };
}

test('account config-change audit: cadence PATCH writes config_changed rows with actor + old→new + source', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT || '0', 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const ds = app.get(modules.getDataSourceToken());

  const { AccountsController } = await loadDist('modules', 'accounts', 'accounts.controller.js');
  const controller = app.get(AccountsController);
  const activityRepo = ds.getRepository('ActivityLog');

  const user = await createUser(app, modules.getDataSourceToken, { name: 'Parn' });
  const ws = await createAccount(app, modules.getDataSourceToken, 'audit-target');
  const auditRows = async () => activityRepo.find({
    where: { entity_type: 'account', entity_id: ws.id, action: 'config_changed' },
    order: { created_at: 'ASC' },
  });

  // Baseline: no audit rows before any change.
  assert.equal((await auditRows()).length, 0, 'no config audit before any change');

  // 1) Apply the incident value (30 min → 4 h) — must be audited.
  await controller.update(ws.id, { supervisor_stale_ms: 14_400_000 }, fakeRes(), user);
  let rows = await auditRows();
  assert.equal(rows.length, 1, 'one audit row for the supervisor_stale_ms change');
  const r0 = rows[0];
  assert.equal(r0.field_changed, 'supervisor_stale_ms');
  assert.equal(r0.old_value, '1800000', 'old value = the 30 min default');
  assert.equal(r0.new_value, '14400000', 'new value = the 4 h incident value');
  assert.equal(r0.actor_id, user.id, 'actor id captured from @CurrentUser');
  assert.equal(r0.actor_name, user.name, 'actor name captured');
  assert.equal(r0.trigger_source, 'rest', 'source = rest');
  assert.equal(r0.account_id, ws.id, 'account-scoped');
  assert.equal(r0.ticket_id, '', 'not tied to a ticket');

  // 2) A no-op PATCH (same value) writes NO new row.
  await controller.update(ws.id, { supervisor_stale_ms: 14_400_000 }, fakeRes(), user);
  assert.equal((await auditRows()).length, 1, 'unchanged value → no duplicate audit row');

  // 3) A non-cadence change (name only) writes NO cadence audit row.
  await controller.update(ws.id, { name: 'renamed' }, fakeRes(), user);
  assert.equal((await auditRows()).length, 1, 'a name change is not a cadence audit');

  // 4) Reset to the default (the mitigation) — audited as old→new too.
  await controller.update(ws.id, { supervisor_stale_ms: 1_800_000, supervisor_resend_ms: 600_000 }, fakeRes(), user);
  rows = await auditRows();
  assert.equal(rows.length, 3, 'two more rows (stale reset + resend change)');
  const staleReset = rows.find((r) => r.field_changed === 'supervisor_stale_ms' && r.new_value === '1800000');
  assert.ok(staleReset, 'the reset back to 30 min is audited');
  assert.equal(staleReset.old_value, '14400000', 'reset old value = the 4 h value it replaced');
  assert.ok(rows.find((r) => r.field_changed === 'supervisor_resend_ms' && r.new_value === '600000'), 'resend change audited');

  // 5) Audit ATOMICITY (reviewer AC — the audit must not be best-effort). If the
  //    config_changed write fails, the WHOLE PATCH rolls back: a cadence value
  //    can never persist "with no trail" again. Force the audit write to throw,
  //    then assert the PATCH 500s, the value is unchanged (rolled back), and no
  //    partial audit row landed.
  const activityService = app.get(modules.ActivityService);
  const origTx = activityService.logActivityTx.bind(activityService);
  activityService.logActivityTx = async () => { throw new Error('audit boom'); };
  const beforeVal = (await ds.getRepository('Account').findOne({ where: { id: ws.id } })).supervisor_stale_ms;
  const rowsBefore = (await auditRows()).length;
  const failRes = fakeRes();
  await controller.update(ws.id, { supervisor_stale_ms: 999_000 }, failRes, user);
  assert.equal(failRes._status, 500, 'audit-write failure fails the PATCH (fail-closed, not swallowed)');
  activityService.logActivityTx = origTx; // restore before re-reading / other tests
  const afterVal = (await ds.getRepository('Account').findOne({ where: { id: ws.id } })).supervisor_stale_ms;
  assert.equal(afterVal, beforeVal, 'settings change rolled back — no cadence value persisted without its audit row');
  assert.equal((await auditRows()).length, rowsBefore, 'no config_changed row persisted on a rolled-back audit');
});
