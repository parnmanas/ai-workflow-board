// Integration test — Phase 5 Plan 05-05 — MIG-04 / T-05-12
//
// Cross-tenant leak test for the channels module.
//
// Purpose: Verify that workspace A's channels cannot be accessed by users belonging only to
// workspace B. This test establishes the isolation CONTRACT that Phase 6 must satisfy
// when WorkspaceGuard is applied to ChannelsController.
//
// Current state (Phase 5):
//   - ChannelsController uses PermissionGuard + MANAGE_CHANNELS — no workspace scoping.
//   - GET /api/channels returns ALL channels across all workspaces (no workspace_id filter).
//   - Cross-workspace isolation is NOT enforced until Phase 6 adds WorkspaceGuard.
//
// Tests marked it.todo() will pass after Phase 6 applies WorkspaceGuard to ChannelsController.
//
// Design (mirrors proxy-passthrough.test.mjs):
//   - Boots NestJS app in-process from compiled dist/.
//   - Test port: 7794 (avoids collision with other leak tests and 7791/7792).

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
  process.env.SQLJS_DB_PATH || path.join(os.tmpdir(), `awb-leak-channels-${process.pid}.db`);
process.env.PORT = process.env.CHANNELS_LEAK_PORT || '7794';
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

describe('channels-leak: cross-workspace channel isolation', async () => {
  let app;
  let adminToken;
  let wsA;
  let wsB;
  let channelA;
  let tokenB;

  const ADMIN_EMAIL = `channels-leak-admin-${randomUUID()}@awb.local`;
  const USER_B_EMAIL = `channels-leak-ub-${randomUUID()}@awb.local`;

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
      name: 'channels-leak-admin',
      email: ADMIN_EMAIL,
      role: 'admin',
      status: 'active',
    }));
    adminToken = authService.createSession(adminUser.id);

    // ─── Create two workspaces directly ───────────────────────────────────────
    wsA = await wsRepo.save(wsRepo.create({ name: 'Leak WS A (channels)', description: 'Leak test' }));
    wsB = await wsRepo.save(wsRepo.create({ name: 'Leak WS B (channels)', description: 'Leak test' }));

    // ─── Create user B and assign to workspace B ──────────────────────────────
    const userBRec = await userRepo.save(userRepo.create({
      name: 'channels-leak-user-b',
      email: USER_B_EMAIL,
      role: 'user',
      status: 'active',
    }));
    tokenB = authService.createSession(userBRec.id);
    // Grant userB membership in wsB via ReBAC
    const rebacRepo = dataSource.getRepository('RelationTuple');
    await rebacRepo.save(rebacRepo.create({
      subject_type: 'user', subject_id: userBRec.id,
      relation: 'member',
      object_type: 'workspace', object_id: wsB.id,
    }));

    // ─── Create a channel in workspace A via HTTP ──────────────────────────────
    // Phase 6+: the channels controller persists workspace_id from the
    // X-Workspace-Id header (ChannelsController.create → workspace_id: workspaceId).
    // Create channel A scoped to ws_a so the workspace-scoped list/get paths
    // below can find (or correctly exclude) it.
    const channelRes = await apiRequest(BASE_URL, '/channels', {
      token: adminToken,
      method: 'POST',
      workspaceId: wsA.id,
      body: {
        name: `Leak Channel WS-A ${randomUUID()}`,
        type: 'discord',
        bot_token: 'test-token-ws-a',
        channel_id: '111222333',
        is_active: 1,
      },
    });
    assert.equal(channelRes.status, 201, `Failed to create channel: ${JSON.stringify(channelRes.data)}`);
    channelA = channelRes.data;
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

  it('admin can create a channel (control)', () => {
    assert.ok(channelA?.id, 'Channel should have been created with an ID');
    assert.ok(channelA.name.startsWith('Leak Channel WS-A'));
  });

  it('admin can list channels and sees the created channel (control)', async () => {
    // Channels are workspace-scoped — the admin must supply the ws_a header to
    // see ws_a's channels (an admin with no workspace context gets an empty list).
    const res = await apiRequest(BASE_URL, '/channels', {
      token: adminToken,
      workspaceId: wsA.id,
    });
    assert.equal(res.status, 200);
    const channels = Array.isArray(res.data) ? res.data : [];
    assert.ok(channels.some(ch => ch.id === channelA.id), 'Admin should see channel A in listing');
  });

  it('admin can retrieve channel A by ID (control)', async () => {
    const res = await apiRequest(BASE_URL, `/channels/${channelA.id}`, {
      token: adminToken,
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.id, channelA.id);
  });

  it('bot_token is masked in channel responses', async () => {
    const res = await apiRequest(BASE_URL, `/channels/${channelA.id}`, {
      token: adminToken,
    });
    assert.equal(res.status, 200);
    // bot_token should be masked (only last 4 chars visible)
    assert.ok(
      !res.data.bot_token || res.data.bot_token.startsWith('***'),
      'bot_token should be masked in response'
    );
  });

  // ─── Phase 6 isolation contract ───────────────────────────────────────────
  // The following tests document the EXPECTED behavior once WorkspaceGuard is applied
  // to ChannelsController in Phase 6. Current ChannelsController has no workspace_id
  // column on Channel entity — Phase 6 must add workspace_id to Channel and apply scoping.

  it('user B with X-Workspace-Id: ws_b cannot list channels from ws_a — returns empty or 403 after Phase 6', async () => {
    // User B is a member of ws_b, not ws_a — channels created without workspace_id
    // should not be visible when scoped to ws_b (empty list since channelA has no workspace_id)
    const res = await apiRequest(BASE_URL, '/channels', {
      token: tokenB,
      workspaceId: wsB.id,
    });
    // WorkspaceGuard passes (user B is member of ws_b), but channel list filtered to ws_b scope → empty
    assert.ok(
      res.status === 200 || res.status === 403,
      `Expected 200 (empty) or 403 for ws_b scoped channel list, got ${res.status}`,
    );
    if (res.status === 200) {
      const channels = Array.isArray(res.data) ? res.data : [];
      assert.equal(
        channels.filter(ch => ch.id === channelA.id).length,
        0,
        'Workspace A channel must not appear in workspace B listing',
      );
    }
  });

  it('user B with X-Workspace-Id: ws_a cannot access ws_a channels — returns 403 after Phase 6 WorkspaceGuard', async () => {
    // User B is NOT a member of ws_a — WorkspaceGuard should reject with 403
    const res = await apiRequest(BASE_URL, '/channels', {
      token: tokenB,
      workspaceId: wsA.id,
    });
    assert.equal(res.status, 403, `Expected 403 for cross-workspace channel access, got ${res.status}: ${JSON.stringify(res.data)}`);
  });

  it('GET /api/channels with X-Workspace-Id: ws_b returns empty list when no channels in ws_b — Phase 6', async () => {
    // Admin bypasses workspace guard membership check but we verify the result
    // by checking ws_b has no channels (channelA was created without workspace_id)
    const res = await apiRequest(BASE_URL, '/channels', {
      token: adminToken,
      workspaceId: wsB.id,
    });
    assert.equal(res.status, 200);
    const channels = Array.isArray(res.data) ? res.data : [];
    assert.equal(
      channels.filter(ch => ch.id === channelA.id).length,
      0,
      'channelA (created for wsA) should not appear when listing for wsB',
    );
  });

  it('admin with X-Workspace-Id: ws_a can list channels scoped to ws_a — Phase 6 workspace-scoped channel query', async () => {
    // Admin passes WorkspaceGuard bypass; channels are not yet workspace-scoped in the query
    // This test verifies admin access is not broken by WorkspaceGuard
    const res = await apiRequest(BASE_URL, '/channels', {
      token: adminToken,
      workspaceId: wsA.id,
    });
    assert.equal(res.status, 200, `Admin should be able to list channels with ws_a header, got ${res.status}`);
    assert.ok(Array.isArray(res.data), 'Response should be an array');
  });
});
