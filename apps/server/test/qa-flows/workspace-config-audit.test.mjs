// Workspace config-change audit (ticket 1fcba693).
//
// The incident's 4 h supervisor_stale_ms was applied at runtime with NO audit
// trail — workspace updates were never recorded, so the change's actor / time /
// source could only be RECONSTRUCTED from row timestamps + code archaeology, not
// proven. This closes that gap: every change to a supervisor/dispatch cadence
// knob now writes a grep-able `config_changed` ActivityLog row carrying
// actor + old→new + source, so a value like that can never again land silently.
//
// Real boot: drive the actual WorkspacesController.update() (REST path) and
// assert the persisted audit rows. A static guard pins the MCP write path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bootApp } from '../helpers/boot.mjs';
import { createWorkspace } from '../helpers/fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', '..', 'dist');
const SRC_ROOT = path.join(__dirname, '..', '..', 'src');
const loadDist = (...p) => import('file://' + path.join(DIST_ROOT, ...p));

function fakeRes() {
  return { _status: 200, _json: undefined, status(c) { this._status = c; return this; }, json(x) { this._json = x; return this; } };
}

test('workspace config-change audit: cadence PATCH writes config_changed rows with actor + old→new + source', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT || '7871', 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const ds = app.get(modules.getDataSourceToken());

  const { WorkspacesController } = await loadDist('modules', 'workspaces', 'workspaces.controller.js');
  const controller = app.get(WorkspacesController);
  const activityRepo = ds.getRepository('ActivityLog');

  const ws = await createWorkspace(app, modules.getDataSourceToken, { name: 'audit-target' });
  const user = { id: 'user-parn', name: 'Parn', email: 'parn@x', role: 'admin', permissions: [] };
  const auditRows = async () => activityRepo.find({
    where: { entity_type: 'workspace', entity_id: ws.id, action: 'config_changed' },
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
  assert.equal(r0.actor_id, 'user-parn', 'actor id captured from @CurrentUser');
  assert.equal(r0.actor_name, 'Parn', 'actor name captured');
  assert.equal(r0.trigger_source, 'rest', 'source = rest');
  assert.equal(r0.workspace_id, ws.id, 'workspace-scoped');
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
});

test('guard: the MCP update_workspace path also writes the config_changed audit (source=mcp, caller actor)', () => {
  // The MCP tool shares the same audit shape; pin the wiring so a refactor can't
  // silently drop the non-REST write path.
  const src = fs.readFileSync(path.join(SRC_ROOT, 'modules', 'mcp', 'tools', 'workspace-tools.ts'), 'utf8');
  assert.match(src, /getCallerAgent\(extra\)/, 'MCP handler resolves the caller for the actor');
  assert.match(src, /action:\s*'config_changed'/, 'MCP handler writes a config_changed row');
  assert.match(src, /trigger_source:\s*'mcp'/, 'MCP audit stamps source=mcp');
  assert.match(src, /workspace_id:\s*ws\.id/, 'MCP audit is workspace-scoped');
});
