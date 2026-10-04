// Integration test — Phase 5 Plan 05-05 — MIG-04 / T-05-12
//
// Cross-tenant leak test for the tickets module.
//
// Purpose: Verify that workspace A's tickets cannot be accessed by users belonging only to
// workspace B. This test establishes the isolation CONTRACT that Phase 6 must satisfy
// when WorkspaceGuard is applied to TicketsController.
//
// Tickets live in one pool per workspace (docs/tickets.md): created and listed
// under /api/workspaces/:wsId/tickets, read by id at /api/tickets/:id. Every
// route sits behind AuthGuard + WorkspaceGuard, which checks the caller's
// membership of the workspace named by the X-Workspace-Id header.
//
// Design (mirrors proxy-passthrough.test.mjs):
//   - Boots NestJS app in-process from compiled dist/. Requires `npm run build` (satisfied by test script).
//   - Uses SQLite with auto-created database/data.db.
//   - Creates test data directly via TypeORM repositories (no HTTP auth flow needed for seeding).
//   - Test port: OS-assigned (declared 0). The per-file port ledger was retired
//     in ticket f2d82793 — set this file's *_PORT env var to pin a number.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { apiRequest, makeBaseUrl } from './test-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.DB_TYPE = process.env.DB_TYPE || 'sqlite';
// Hermetic sql.js DB per file. This test boots NestJS inline (not via bootApp,
// which supplies the pid+port default), so without this it falls back to the
// shared database/data.db — and the npm `test` chain runs the four leak files
// back-to-back, so a later file (agents-leak) sees rows the earlier ones left
// behind and its "scoped to ws_a sees only ws_a" assertions fail. Isolate.
process.env.SQLJS_DB_PATH =
  process.env.SQLJS_DB_PATH || path.join(os.tmpdir(), `awb-leak-tickets-${Date.now()}-${process.pid}.db`);
process.env.PORT = process.env.TICKETS_LEAK_PORT || '0';
process.env.NODE_ENV = 'test';
process.env.MCP_DEV_MODE = 'true';
process.env.AGENT_DEV_MODE = 'true';

// 요청 포트가 0(OS 배정)이라 listen 전에는 URL 을 만들 수 없다 — 이 파일은
// bootApp 을 쓰지 않고 NestJS 를 인라인으로 띄우므로, 바인딩된 뒤 실제 포트로
// 직접 채운다(ticket f2d82793).
let BASE_URL;

async function loadServerModules() {
  const distRoot = path.join(__dirname, '..', 'dist');
  try {
    const { NestFactory } = await import('@nestjs/core');
    const appModuleUrl = 'file://' + path.join(distRoot, 'app.module.js');
    const authServiceUrl = 'file://' + path.join(distRoot, 'services', 'auth.service.js');
    const rebacServiceUrl = 'file://' + path.join(distRoot, 'services', 'rebac.service.js');
    const { AppModule } = await import(appModuleUrl);
    const { AuthService } = await import(authServiceUrl);
    const { ReBACService } = await import(rebacServiceUrl);
    const { getDataSourceToken } = await import('@nestjs/typeorm');
    return { NestFactory, AppModule, AuthService, ReBACService, getDataSourceToken };
  } catch (err) {
    throw new Error(
      'Leak test requires the server to be built first. Run `npm run --workspace=apps/server build`. Original error: ' + err.message
    );
  }
}

describe('tickets-leak: cross-workspace ticket isolation', async () => {
  let app;
  let adminToken;
  let wsA;
  let wsB;
  let userA;
  let userB;
  let tokenA;
  let tokenB;
  let userC;
  let tokenC;
  let ticketA;

  const ADMIN_EMAIL = `tickets-leak-admin-${randomUUID()}@awb.local`;
  const USER_A_EMAIL = `tickets-leak-ua-${randomUUID()}@awb.local`;
  const USER_B_EMAIL = `tickets-leak-ub-${randomUUID()}@awb.local`;
  const USER_C_EMAIL = `tickets-leak-uc-${randomUUID()}@awb.local`;
  const PASSWORD = 'TestPass123!';

  before(async () => {
    const { NestFactory, AppModule, AuthService, ReBACService, getDataSourceToken } = await loadServerModules();

    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(parseInt(process.env.PORT, 10), '0.0.0.0');
    BASE_URL = makeBaseUrl(app.getHttpServer().address().port);

    const authService = app.get(AuthService);
    const rebacService = app.get(ReBACService);
    const dataSource = app.get(getDataSourceToken());
    const userRepo = dataSource.getRepository('User');
    const wsRepo = dataSource.getRepository('Workspace');

    // ─── Create admin user directly via TypeORM ────────────────────────────────
    const adminUser = await userRepo.save(userRepo.create({
      name: 'tickets-leak-admin',
      email: ADMIN_EMAIL,
      role: 'admin',
      status: 'active',
    }));
    adminToken = authService.createSession(adminUser.id);

    // ─── Create two workspaces directly ───────────────────────────────────────
    wsA = await wsRepo.save(wsRepo.create({ name: 'Leak WS A (tickets)', description: 'Leak test' }));
    wsB = await wsRepo.save(wsRepo.create({ name: 'Leak WS B (tickets)', description: 'Leak test' }));

    // ─── Create users via HTTP (exercises auth flow + password_hash) ──────────
    const createUserRes = await apiRequest(BASE_URL, '/users', {
      token: adminToken,
      method: 'POST',
      body: { name: 'Tickets Leak User A', email: USER_A_EMAIL, password: PASSWORD, role: 'user' },
    });
    userA = createUserRes.data;

    const createUserBRes = await apiRequest(BASE_URL, '/users', {
      token: adminToken,
      method: 'POST',
      body: { name: 'Tickets Leak User B', email: USER_B_EMAIL, password: PASSWORD, role: 'user' },
    });
    userB = createUserBRes.data;

    const createUserCRes = await apiRequest(BASE_URL, '/users', {
      token: adminToken,
      method: 'POST',
      body: { name: 'Tickets Leak User C', email: USER_C_EMAIL, password: PASSWORD, role: 'user' },
    });
    userC = createUserCRes.data;

    // ─── Activate users (users created via /users endpoint start as active) ───
    // The /users endpoint does not set status — users created without signup are active by default.
    // Login to get tokens for each user.
    tokenA = authService.createSession(userA.id);
    tokenB = authService.createSession(userB.id);
    tokenC = authService.createSession(userC.id);

    // Phase 6+: WorkspaceGuard requires an explicit ReBAC membership tuple plus
    // an X-Workspace-Id header for non-admin callers. Grant user A membership
    // in workspace A so the positive control (a member reading a ticket in their
    // own workspace) actually exercises the allow path. User B is deliberately
    // left without any membership so the negative controls below still reject.
    await rebacService.grant({ type: 'user', id: userA.id }, 'member', { type: 'workspace', id: wsA.id });
    // User C is a genuine member of workspace B — the guard lets them in with
    // X-Workspace-Id: ws_b, so these cases probe the routes' own scoping.
    await rebacService.grant({ type: 'user', id: userC.id }, 'member', { type: 'workspace', id: wsB.id });

    // ─── Create a ticket in workspace A's pool via HTTP ───────────────────────
    const ticketRes = await apiRequest(BASE_URL, `/workspaces/${wsA.id}/tickets`, {
      token: adminToken,
      workspaceId: wsA.id,
      method: 'POST',
      body: { title: 'Leak Test Ticket in WS A', description: 'Should not be visible to WS B users' },
    });
    assert.equal(ticketRes.status, 201, `Failed to create ticket: ${JSON.stringify(ticketRes.data)}`);
    ticketA = ticketRes.data;
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

  it('admin can create a ticket in workspace A', () => {
    assert.ok(ticketA?.id, 'Ticket should have been created with an ID');
    assert.equal(ticketA.title, 'Leak Test Ticket in WS A');
    assert.equal(ticketA.workspace_id, wsA.id);
    assert.equal(ticketA.status, 'todo');
  });

  it('admin can retrieve ticket A by ID (ticket exists)', async () => {
    const res = await apiRequest(BASE_URL, `/tickets/${ticketA.id}`, {
      token: adminToken,
    });
    assert.equal(res.status, 200, 'Admin should be able to fetch ticket by ID');
    assert.equal(res.data.id, ticketA.id);
  });

  it('user A (ws_a member) can retrieve ticket from workspace A', async () => {
    // tokenA is a valid session AND user A holds a member tuple on ws_a, so the
    // WorkspaceGuard allow path is satisfied once X-Workspace-Id is supplied.
    const res = await apiRequest(BASE_URL, `/tickets/${ticketA.id}`, {
      token: tokenA,
      workspaceId: wsA.id,
    });
    assert.equal(res.status, 200, 'User A should be able to fetch ticket from their workspace');
    assert.equal(res.data.id, ticketA.id);
  });

  it('user A lists workspace A tickets and sees ticket A (control)', async () => {
    const res = await apiRequest(BASE_URL, `/workspaces/${wsA.id}/tickets`, {
      token: tokenA,
      workspaceId: wsA.id,
    });
    assert.equal(res.status, 200);
    assert.ok(res.data.tickets.some((t) => t.id === ticketA.id), 'Workspace A ticket should appear in workspace A listing');
  });

  // ─── Isolation contract ───────────────────────────────────────────────────

  it('user B (no membership) cannot retrieve workspace A ticket by ID — 403 or 404', async () => {
    for (const workspaceId of [wsB.id, wsA.id]) {
      const res = await apiRequest(BASE_URL, `/tickets/${ticketA.id}`, {
        token: tokenB,
        workspaceId,
      });
      assert.ok(
        res.status === 403 || res.status === 404,
        `Expected 403 or 404 for cross-workspace ticket access (X-Workspace-Id ${workspaceId}), got ${res.status}: ${JSON.stringify(res.data)}`,
      );
    }
  });

  it('user B (no membership) cannot list workspace A tickets — 403', async () => {
    const res = await apiRequest(BASE_URL, `/workspaces/${wsA.id}/tickets`, {
      token: tokenB,
      workspaceId: wsA.id,
    });
    assert.equal(res.status, 403, `Expected 403, got ${res.status}: ${JSON.stringify(res.data)}`);
  });

  it('user C (ws_b member) listing workspace B does not see workspace A tickets', async () => {
    const res = await apiRequest(BASE_URL, `/workspaces/${wsB.id}/tickets`, {
      token: tokenC,
      workspaceId: wsB.id,
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.tickets.filter((t) => t.id === ticketA.id).length, 0, 'Workspace A ticket must not appear in workspace B listing');
  });

  // WorkspaceGuard checks membership against X-Workspace-Id and requires a
  // `/workspaces/:wsId` path to name the same workspace; TicketWorkspaceGuard
  // 404s a `/tickets/:id` of any other workspace.
  it('user C (ws_b member) cannot list workspace A tickets through the ws_a path', async () => {
    const res = await apiRequest(BASE_URL, `/workspaces/${wsA.id}/tickets`, {
      token: tokenC,
      workspaceId: wsB.id,
    });
    assert.ok(res.status === 403 || res.status === 404, `Expected 403/404, got ${res.status}`);
  });

  it('user C (ws_b member) cannot create a ticket in workspace A', async () => {
    const res = await apiRequest(BASE_URL, `/workspaces/${wsA.id}/tickets`, {
      token: tokenC,
      workspaceId: wsB.id,
      method: 'POST',
      body: { title: 'planted from ws_b' },
    });
    assert.ok(res.status === 403 || res.status === 404, `Expected 403/404, got ${res.status}`);
  });

  it('user C (ws_b member) cannot read or edit workspace A ticket by ID', async () => {
    const read = await apiRequest(BASE_URL, `/tickets/${ticketA.id}`, {
      token: tokenC,
      workspaceId: wsB.id,
    });
    assert.ok(read.status === 403 || read.status === 404, `read: expected 403/404, got ${read.status}`);
    const edit = await apiRequest(BASE_URL, `/tickets/${ticketA.id}`, {
      token: tokenC,
      workspaceId: wsB.id,
      method: 'PATCH',
      body: { title: 'edited from ws_b' },
    });
    assert.ok(edit.status === 403 || edit.status === 404, `edit: expected 403/404, got ${edit.status}`);
  });
});
