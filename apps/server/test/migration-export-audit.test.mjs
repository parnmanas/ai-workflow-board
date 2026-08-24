// Regression / feature proof: live pull import export-surface audit trail
// (ticket 0f638509, review round 1 P3 — blocking). The source export surface
// can return every workspace's plaintext credentials, so every access —
// denied AND successful — must leave a durable, greppable ActivityLog row
// (never the raw X-Agent-Key or actual row/credential contents).
//
// Runs against compiled dist/ (requires `npm run build`). Isolated
// SQLJS_DB_PATH temp file — never touches the shared dev database/data.db.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');
const modPath = (...p) => 'file://' + path.join(DIST, ...p);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-migration-audit-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'migration-audit-test.db');
process.env.NODE_ENV = 'test';

const { buildDataSourceOptions } = await import(modPath('db.js'));
const { ActivityLog } = await import(modPath('entities', 'ActivityLog.js'));
const { Agent } = await import(modPath('entities', 'Agent.js'));
const { ApiKey } = await import(modPath('entities', 'ApiKey.js'));
const { Workspace } = await import(modPath('entities', 'Workspace.js'));
const { ActivityService } = await import(modPath('services', 'activity.service.js'));
const { ApiKeyService } = await import(modPath('services', 'api-key.service.js'));
const { MigrationExportGuard, MIGRATION_EXPORT_SCOPE } = await import(modPath('common', 'guards', 'migration-export.guard.js'));
const { MigrationExportController } = await import(modPath('modules', 'migration', 'migration-export.controller.js'));
const { DataSource } = await import('typeorm');

const ds = new DataSource(buildDataSourceOptions());
await ds.initialize();

const logStub = { warn() {}, info() {}, error() {}, debug() {} };
const activityLogRepo = ds.getRepository(ActivityLog);
const activityService = new ActivityService(activityLogRepo, ds.getRepository(Agent), logStub);
const apiKeyService = new ApiKeyService(ds.getRepository(ApiKey));
const guard = new MigrationExportGuard(apiKeyService, activityService);
const noDeployment = { getLatest: async () => null };
const controller = new MigrationExportController(ds, noDeployment, activityService);

after(async () => {
  await ds.destroy();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function fakeContext(headers) {
  const request = { headers, params: {}, route: { path: '/api/migration/export/meta' } };
  return { switchToHttp: () => ({ getRequest: () => request }), _request: request };
}

async function latestAuditRow(action) {
  return activityLogRepo.findOne({ where: { entity_type: 'migration', action }, order: { created_at: 'DESC' } });
}

test('1. missing X-Agent-Key header is denied AND audited, with no key material logged', async () => {
  const ctx = fakeContext({});
  await assert.rejects(() => guard.canActivate(ctx));

  const row = await latestAuditRow('migration_export_denied');
  assert.ok(row, 'a denial must write a migration_export_denied ActivityLog row');
  assert.equal(row.field_changed, 'missing_x_agent_key_header');
  assert.equal(row.actor_id, '', 'no legitimate identity to attribute when the header itself is missing');
});

test('2. an invalid key is denied AND audited without ever recording the presented raw key', async () => {
  const rawSecret = 'awb_totally-bogus-secret-value-should-never-be-logged';
  const ctx = fakeContext({ 'x-agent-key': rawSecret });
  await assert.rejects(() => guard.canActivate(ctx));

  const row = await latestAuditRow('migration_export_denied');
  assert.match(row.field_changed, /^invalid_key:/);
  assert.ok(!row.field_changed.includes(rawSecret), 'the raw presented key must never appear in the audit row');
  assert.ok(!JSON.stringify(row).includes(rawSecret), 'the raw presented key must not leak into any audit field');
});

test('3. a valid key with the WRONG scope is denied AND audited, but its identity IS captured (legitimate key, just insufficient scope)', async () => {
  const { raw_key } = await apiKeyService.createApiKey({ name: 'wrong-scope-key', scope: 'full' });
  const ctx = fakeContext({ 'x-agent-key': raw_key });
  await assert.rejects(() => guard.canActivate(ctx));

  const row = await latestAuditRow('migration_export_denied');
  assert.equal(row.field_changed, 'wrong_scope');
  assert.equal(row.actor_name, 'wrong-scope-key', 'a legitimate-but-wrong-scope key IS identified in the audit trail');
  assert.ok(!JSON.stringify(row).includes(raw_key), 'the raw key value itself is still never logged, even when identified by name');
});

test('4. a valid scope=migration_export key passes the guard, and req.apiKey is populated for the controller to audit against', async () => {
  const { raw_key } = await apiKeyService.createApiKey({ name: 'good-export-key', scope: MIGRATION_EXPORT_SCOPE });
  const ctx = fakeContext({ 'x-agent-key': raw_key });
  const ok = await guard.canActivate(ctx);
  assert.equal(ok, true);
  assert.equal(ctx._request.apiKey.name, 'good-export-key');
});

test('5. a successful meta() call is audited with the caller identity and a row-count summary, never raw data', async () => {
  const req = { apiKey: { id: 'key-1', name: 'meta-caller' } };
  let captured = null;
  await controller.meta(req, { json: (body) => { captured = body; } });

  const row = await latestAuditRow('migration_export_meta');
  assert.ok(row);
  assert.equal(row.entity_id, 'meta');
  assert.equal(row.actor_name, 'meta-caller');
  assert.match(row.new_value, /tables reported/);
  assert.ok(captured.tables.length > 0);
});

test('6. a successful table() first-page call is audited exactly once; a subsequent resumed page does NOT add a second row (no per-page noise)', async () => {
  const wsRepo = ds.getRepository(Workspace);
  await wsRepo.save(wsRepo.create({ name: 'audit-test-ws' }));

  const req = { apiKey: { id: 'key-2', name: 'table-caller' } };
  let firstPage = null;
  await controller.table('Workspace', undefined, '500', undefined, req, { json: (b) => { firstPage = b; }, status: () => ({ json: () => {} }) });

  const countAfterFirst = await activityLogRepo.count({ where: { entity_type: 'migration', action: 'migration_export_table', entity_id: 'Workspace' } });
  assert.equal(countAfterFirst, 1, 'the first (after=null) page of a fresh pull must be audited exactly once');
  assert.equal(JSON.stringify(firstPage).includes('audit-test-ws'), true, 'sanity: the actual row data is returned to the caller (just not written into the audit trail)');

  // Resume with a cursor — same entity, same run, must NOT add a second audit row.
  await controller.table('Workspace', 'zzzz-nonexistent-cursor', '500', undefined, req, { json: () => {}, status: () => ({ json: () => {} }) });
  const countAfterResume = await activityLogRepo.count({ where: { entity_type: 'migration', action: 'migration_export_table', entity_id: 'Workspace' } });
  assert.equal(countAfterResume, 1, 'a resumed (after != null) page of the same entity must not add a second audit row');

  const auditRow = await latestAuditRow('migration_export_table');
  assert.ok(!JSON.stringify(auditRow).includes('audit-test-ws'), 'actual row contents must never appear in the audit row');
});
