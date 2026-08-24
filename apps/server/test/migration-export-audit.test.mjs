// Regression / feature proof: live pull import export-surface audit trail
// (ticket 0f638509, review round 1 P3 — blocking). The source export surface
// can return every workspace's plaintext credentials, so every access —
// denied AND successful — must leave a durable, greppable ActivityLog row
// (never the raw X-Agent-Key or actual row/credential contents).
//
// Review round 2 (blocking) found two holes in round 1's fix, both fixed in
// migration-export.controller.ts and covered by tests 6-8 below:
//   1. table() only audited when `after` was empty ("first page"). `after`
//      is a client-supplied query param with no server-side session
//      binding, so a caller could skip the audit on its very first request
//      by sending any non-empty `after` — for a single-column PK a
//      synthetic low sentinel still returns virtually the whole table, and
//      for the composite-PK entity a malformed cursor makes the keyset
//      filter silently no-op, returning a full unfiltered first page. Fix:
//      audit unconditionally on every call (test 6, test 7).
//   2. A failed audit write was swallowed and the plaintext export still
//      went out — not acceptable for a mandatory control on a surface that
//      can return every workspace's credentials. Fix: _auditAccess() now
//      returns a boolean and both handlers refuse with 503 when it's false
//      (test 8).
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
const { Ticket } = await import(modPath('entities', 'Ticket.js'));
const { TicketPrerequisite } = await import(modPath('entities', 'TicketPrerequisite.js'));
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

async function auditCount(entityId) {
  return activityLogRepo.count({ where: { entity_type: 'migration', action: 'migration_export_table', entity_id: entityId } });
}

/** Minimal Express-`Response` double supporting both `res.json(x)` (200) and `res.status(n).json(x)`. */
function fakeRes() {
  const r = { statusCode: 200, body: null };
  r.status = (code) => { r.statusCode = code; return { json: (b) => { r.body = b; } }; };
  r.json = (b) => { r.statusCode = 200; r.body = b; };
  return r;
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

test('6. [review round 2 — supersedes the old "first page only" behavior] EVERY table() call is audited, including a resumed page of the same entity', async () => {
  // Review round 2 (blocking): the previous version of this controller only
  // audited when `after` was empty ("first page"), on the theory that a
  // resumed page is just a continuation of an already-audited pull. The
  // reviewer pointed out `after` is entirely client-supplied with no
  // server-side session binding, so that assumption doesn't hold — see tests
  // 7 and 8 below for the two concrete bypasses this enabled. The fix is
  // simply "audit unconditionally"; this test pins the resulting behavior:
  // a resumed page now ALSO writes its own row, not zero.
  const wsRepo = ds.getRepository(Workspace);
  await wsRepo.save(wsRepo.create({ name: 'audit-test-ws-6' }));

  const req = { apiKey: { id: 'key-2', name: 'table-caller' } };
  const countBefore = await auditCount('Workspace');

  let firstPage = null;
  await controller.table('Workspace', undefined, '500', undefined, req, { json: (b) => { firstPage = b; }, status: () => ({ json: () => {} }) });
  const countAfterFirst = await auditCount('Workspace');
  assert.equal(countAfterFirst, countBefore + 1, 'the first (after=null) page of a fresh pull must be audited');
  assert.equal(JSON.stringify(firstPage).includes('audit-test-ws-6'), true, 'sanity: the actual row data is returned to the caller (just not written into the audit trail)');

  // Resume with a cursor — same entity, same run — must NOW also add a row.
  await controller.table('Workspace', 'zzzz-nonexistent-cursor', '500', undefined, req, { json: () => {}, status: () => ({ json: () => {} }) });
  const countAfterResume = await auditCount('Workspace');
  assert.equal(countAfterResume, countBefore + 2, 'a resumed (after != null) page of the same entity must ALSO be audited — every call, not just the first');

  const auditRow = await latestAuditRow('migration_export_table');
  assert.ok(!JSON.stringify(auditRow).includes('audit-test-ws-6'), 'actual row contents must never appear in the audit row');
});

test('7. [review round 2, blocking] a call using a non-empty client-supplied `after` on its very FIRST-ever request is still audited', async (t) => {
  await t.test('single-column PK (Workspace) — a synthetic low-sentinel `after` still returns real data, proving the old if(!after) heuristic was a live bypass', async () => {
    const wsRepo = ds.getRepository(Workspace);
    await wsRepo.save(wsRepo.create({ name: 'audit-test-ws-7a' }));

    const req = { apiKey: { id: 'key-3', name: 'bypass-attempt-sort-order' } };
    const countBefore = await auditCount('Workspace');

    let page = null;
    // '!' (0x21) sorts before every character that appears in a UUID PK, so
    // `id > '!'` still matches virtually the whole table — a non-empty
    // `after` that is functionally "give me everything" despite never having
    // paged through anything before.
    await controller.table('Workspace', '!', '500', undefined, req, { json: (b) => { page = b; }, status: () => ({ json: () => {} }) });
    assert.ok(JSON.stringify(page).includes('audit-test-ws-7a'), 'a synthetic non-empty after must still yield real row data — this is what made the old heuristic exploitable');

    const countAfter = await auditCount('Workspace');
    assert.equal(countAfter, countBefore + 1, 'the old `if (!after)` heuristic would have skipped this call entirely; it must now be audited');
  });

  await t.test('composite PK (TicketPrerequisite) — a malformed cursor silently skips keyset filtering, returning an unfiltered first page under the guise of a "resume"', async () => {
    const ticketRepo = ds.getRepository(Ticket);
    const prereqRepo = ds.getRepository(TicketPrerequisite);
    const a = await ticketRepo.save(ticketRepo.create({ title: 'A', workspace_id: 'w1' }));
    const b = await ticketRepo.save(ticketRepo.create({ title: 'B', workspace_id: 'w1' }));
    await prereqRepo.save(prereqRepo.create({ ticket_id: a.id, prerequisite_ticket_id: b.id, created_by: 'test' }));

    const req = { apiKey: { id: 'key-4', name: 'bypass-attempt-malformed-cursor' } };
    const countBefore = await auditCount('TicketPrerequisite');

    let page = null;
    // decodeCursor() catches the JSON.parse failure and returns `[]`; its
    // length (0) never matches pkNames.length (2), so applyKeysetCursor()
    // takes the `values.length !== pkNames.length` early return and applies
    // NO filter at all — a malformed non-empty cursor looks like "page 2" to
    // a naive audit-once heuristic but is actually an unfiltered full first
    // page.
    await controller.table('TicketPrerequisite', 'not-valid-json', '500', undefined, req, { json: (bd) => { page = bd; }, status: () => ({ json: () => {} }) });
    assert.ok(
      JSON.stringify(page).includes(a.id) && JSON.stringify(page).includes(b.id),
      'a malformed cursor must fall back to an unfiltered (full) first page rather than erroring',
    );

    const countAfter = await auditCount('TicketPrerequisite');
    assert.equal(countAfter, countBefore + 1, 'a malformed non-empty cursor must still be audited — this is exactly the composite-PK bypass the old heuristic missed');
  });
});

test('8. [review round 2, blocking] fail-closed — when the audit write itself fails, meta() and table() refuse to return data (503, no tables/rows body)', async () => {
  const throwingActivityService = { logActivity: async () => { throw new Error('simulated audit-store outage'); } };
  const brokenController = new MigrationExportController(ds, noDeployment, throwingActivityService);
  const req = { apiKey: { id: 'key-5', name: 'audit-outage-caller' } };

  const metaRes = fakeRes();
  await brokenController.meta(req, metaRes);
  assert.equal(metaRes.statusCode, 503, 'meta() must refuse with 503 when it cannot write the access audit');
  assert.ok(!metaRes.body.tables, 'no table list may be returned when the audit write failed — "audited but data withheld", never the reverse');
  assert.match(metaRes.body.error, /audit/i);

  const tableRes = fakeRes();
  await brokenController.table('Workspace', undefined, '500', undefined, req, tableRes);
  assert.equal(tableRes.statusCode, 503, 'table() must refuse with 503 when it cannot write the access audit');
  assert.ok(!tableRes.body.rows, 'no row data may be returned when the audit write failed');
  assert.match(tableRes.body.error, /audit/i);

  // Sanity: the real (working) controller sharing the same DataSource is unaffected.
  const sanityRes = fakeRes();
  await controller.meta(req, sanityRes);
  assert.equal(sanityRes.statusCode, 200, 'a controller wired to a healthy ActivityService must still serve requests normally');
});
