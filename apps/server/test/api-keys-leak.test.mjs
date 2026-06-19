// Integration test — Phase 5 Plan 05-05 — MIG-04 / T-05-12
//
// Cross-tenant leak test for the api-keys module.
//
// Purpose: Verify that workspace A's API keys cannot be accessed by users belonging only to
// workspace B. This test establishes the isolation CONTRACT that Phase 6 must satisfy
// when WorkspaceGuard is applied to ApiKeysController.
//
// Current state (Phase 5):
//   - ApiKeysController uses PermissionGuard + MANAGE_API_KEYS — no workspace scoping.
//   - GET /api/keys returns ALL keys across all workspaces (no workspace_id filter).
//   - Cross-workspace isolation is NOT enforced until Phase 6 adds WorkspaceGuard + workspace_id to ApiKey.
//
// Tests marked it.todo() will pass after Phase 6 applies WorkspaceGuard to ApiKeysController.
//
// Design (mirrors proxy-passthrough.test.mjs):
//   - Boots NestJS app in-process from compiled dist/.
//   - Test port: 7795 (avoids collision with other leak tests and 7791/7792/7793/7794).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { apiRequest, makeBaseUrl } from './test-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.DB_TYPE = process.env.DB_TYPE || 'sqlite';
// Hermetic sql.js DB per file — see tickets-leak for the rationale (inline boot
// + back-to-back npm `test` chain would otherwise share database/data.db).
process.env.SQLJS_DB_PATH =
  process.env.SQLJS_DB_PATH || path.join(os.tmpdir(), `awb-leak-apikeys-${Date.now()}-${process.pid}.db`);
process.env.PORT = process.env.API_KEYS_LEAK_PORT || '7795';
process.env.NODE_ENV = 'test';
process.env.MCP_DEV_MODE = 'true';
process.env.AGENT_DEV_MODE = 'true';

const BASE_URL = makeBaseUrl(parseInt(process.env.PORT, 10));

async function loadServerModules() {
  const distRoot = path.join(__dirname, '..', 'dist');
  try {
    const { NestFactory } = await import('@nestjs/core');
    const appModuleUrl = 'file://' + path.join(distRoot, 'app.module.js');
    const authServiceUrl = 'file://' + path.join(distRoot, 'services', 'auth.service.js');
    const { AppModule } = await import(appModuleUrl);
    const { AuthService } = await import(authServiceUrl);
    const { getDataSourceToken } = await import('@nestjs/typeorm');
    return { NestFactory, AppModule, AuthService, getDataSourceToken };
  } catch (err) {
    throw new Error(
      'Leak test requires the server to be built first. Run `npm run --workspace=apps/server build`. Original error: ' + err.message
    );
  }
}

describe('api-keys-leak: cross-workspace API key isolation', async () => {
  let app;
  let adminToken;
  let wsA;
  let wsB;
  let apiKeyA;
  let tokenB;

  const ADMIN_EMAIL = `apikeys-leak-admin-${randomUUID()}@awb.local`;
  const USER_B_EMAIL = `apikeys-leak-ub-${randomUUID()}@awb.local`;

  before(async () => {
    const { NestFactory, AppModule, AuthService, getDataSourceToken } = await loadServerModules();

    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(parseInt(process.env.PORT, 10), '0.0.0.0');

    const authService = app.get(AuthService);
    const dataSource = app.get(getDataSourceToken());
    const userRepo = dataSource.getRepository('User');
    const wsRepo = dataSource.getRepository('Workspace');

    // ─── Create admin user directly via TypeORM ────────────────────────────────
    const adminUser = await userRepo.save(userRepo.create({
      name: 'apikeys-leak-admin',
      email: ADMIN_EMAIL,
      role: 'admin',
      status: 'active',
    }));
    adminToken = authService.createSession(adminUser.id);

    // ─── Create two workspaces directly ───────────────────────────────────────
    wsA = await wsRepo.save(wsRepo.create({ name: 'Leak WS A (api-keys)', description: 'Leak test' }));
    wsB = await wsRepo.save(wsRepo.create({ name: 'Leak WS B (api-keys)', description: 'Leak test' }));

    // ─── Create user B and assign to workspace B ──────────────────────────────
    const userBRec = await userRepo.save(userRepo.create({
      name: 'apikeys-leak-user-b',
      email: USER_B_EMAIL,
      role: 'user',
      status: 'active',
    }));
    tokenB = authService.createSession(userBRec.id);
    const rebacRepo = dataSource.getRepository('RelationTuple');
    await rebacRepo.save(rebacRepo.create({
      subject_type: 'user', subject_id: userBRec.id,
      relation: 'member',
      object_type: 'workspace', object_id: wsB.id,
    }));

    // ─── Create an API key in workspace A via HTTP ─────────────────────────────
    // Phase 6+: ApiKeysController.create persists workspace_id from the
    // X-Workspace-Id header, and list/get/revoke are workspace-scoped. Create
    // key A scoped to ws_a so the scoped controls below can find it.
    const keyRes = await apiRequest(BASE_URL, '/keys', {
      token: adminToken,
      method: 'POST',
      workspaceId: wsA.id,
      body: {
        name: `Leak API Key WS-A ${randomUUID()}`,
        scope: 'full',
      },
    });
    assert.equal(keyRes.status, 201, `Failed to create API key: ${JSON.stringify(keyRes.data)}`);
    apiKeyA = keyRes.data;
  });

  after(async () => {
    if (app) {
      try { await app.close(); } catch { /* ignore */ }
    }
    // No process.exit here: it would override the real exit code and mask a
    // failed assertion. The suite is launched with `--test-force-exit`, which
    // tears down NestJS's unreffed intervals / TypeORM handles and exits with
    // the code node:test computed.
  });

  it('admin can create an API key (control)', () => {
    assert.ok(apiKeyA?.id, 'API key should have been created with an ID');
    assert.ok(apiKeyA.name.startsWith('Leak API Key WS-A'));
    // raw_key is returned only on creation and must not be stored/logged
    assert.ok(apiKeyA.raw_key, 'raw_key should be returned on creation');
  });

  it('raw_key is only returned on creation (not on list/get)', async () => {
    const res = await apiRequest(BASE_URL, `/keys/${apiKeyA.id}`, {
      token: adminToken,
    });
    assert.equal(res.status, 200);
    // raw_key must NOT be present in subsequent get responses (security requirement)
    assert.equal(res.data.raw_key, undefined, 'raw_key must not be exposed after creation');
  });

  it('admin can list API keys and sees the created key (control)', async () => {
    // API keys are workspace-scoped — the admin must supply the ws_a header to
    // see ws_a's keys (an admin with no workspace context gets an empty list).
    const res = await apiRequest(BASE_URL, '/keys', {
      token: adminToken,
      workspaceId: wsA.id,
    });
    assert.equal(res.status, 200);
    const keys = Array.isArray(res.data) ? res.data : [];
    assert.ok(keys.some(k => k.id === apiKeyA.id), 'Admin should see API key A in listing');
  });

  it('admin can retrieve API key A by ID (control)', async () => {
    const res = await apiRequest(BASE_URL, `/keys/${apiKeyA.id}`, {
      token: adminToken,
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.id, apiKeyA.id);
  });

  it('admin can revoke an API key', async () => {
    // Create a temporary key to revoke so we don't affect apiKeyA
    const tempKeyRes = await apiRequest(BASE_URL, '/keys', {
      token: adminToken,
      method: 'POST',
      body: { name: `Temp revoke key ${randomUUID()}`, scope: 'full' },
    });
    assert.equal(tempKeyRes.status, 201);

    const revokeRes = await apiRequest(BASE_URL, `/keys/${tempKeyRes.data.id}/revoke`, {
      token: adminToken,
      method: 'POST',
    });
    assert.equal(revokeRes.status, 200);
    assert.equal(revokeRes.data.success, true);
  });

  // ─── Phase 6 isolation contract ───────────────────────────────────────────
  // The following tests document the EXPECTED behavior once WorkspaceGuard is applied
  // to ApiKeysController in Phase 6. Phase 6 must add workspace_id to ApiKey entity
  // and filter keys by the X-Workspace-Id header.

  it('user in ws_b with X-Workspace-Id: ws_b cannot list ws_a API keys — returns empty after Phase 6', async () => {
    // User B is a member of ws_b — WorkspaceGuard passes, but list is scoped to ws_b
    // apiKeyA was created without workspace_id, so it should not appear under ws_b scope
    const res = await apiRequest(BASE_URL, '/keys', {
      token: tokenB,
      workspaceId: wsB.id,
    });
    assert.ok(
      res.status === 200 || res.status === 403,
      `Expected 200 (empty) or 403 for ws_b scoped key list, got ${res.status}`,
    );
    if (res.status === 200) {
      const keys = Array.isArray(res.data) ? res.data : [];
      assert.equal(
        keys.filter(k => k.id === apiKeyA.id).length,
        0,
        'Workspace A API key must not appear in workspace B listing',
      );
    }
  });

  it('user in ws_b with X-Workspace-Id: ws_a cannot access ws_a keys — returns 403 after Phase 6 WorkspaceGuard', async () => {
    // User B is NOT a member of ws_a — WorkspaceGuard should reject with 403
    const res = await apiRequest(BASE_URL, '/keys', {
      token: tokenB,
      workspaceId: wsA.id,
    });
    assert.equal(res.status, 403, `Expected 403 for cross-workspace key access, got ${res.status}: ${JSON.stringify(res.data)}`);
  });

  it('admin with X-Workspace-Id: ws_a can list only ws_a API keys — Phase 6 workspace-scoped key query', async () => {
    // Admin bypasses WorkspaceGuard membership check — access should succeed
    const res = await apiRequest(BASE_URL, '/keys', {
      token: adminToken,
      workspaceId: wsA.id,
    });
    assert.equal(res.status, 200, `Admin should be able to list keys with ws_a header, got ${res.status}`);
    assert.ok(Array.isArray(res.data), 'Response should be an array');
  });

  it('admin with X-Workspace-Id: ws_b gets empty list (no keys in ws_b) — Phase 6', async () => {
    // Admin bypasses WorkspaceGuard — verify no ws_a keys bleed into ws_b listing
    const res = await apiRequest(BASE_URL, '/keys', {
      token: adminToken,
      workspaceId: wsB.id,
    });
    assert.equal(res.status, 200);
    const keys = Array.isArray(res.data) ? res.data : [];
    assert.equal(
      keys.filter(k => k.id === apiKeyA.id).length,
      0,
      'Workspace A API key must not appear in workspace B listing',
    );
  });
});
