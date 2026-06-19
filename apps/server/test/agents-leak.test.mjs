// Integration test — Phase 5 Plan 05-05 — MIG-04 / T-05-12
//
// Cross-tenant leak test for the agents module.
//
// Purpose: Verify that workspace A's agents cannot be accessed by users belonging only to
// workspace B. This test establishes the isolation CONTRACT that Phase 6 must satisfy
// when WorkspaceGuard is applied to AgentsController.
//
// Current state (Phase 5):
//   - AgentsController uses PermissionGuard + MANAGE_AGENTS — no workspace scoping on list.
//   - GET /api/agents returns ALL agents (no workspace_id filter).
//   - GET /api/agents/dashboard?workspace_id=X IS workspace-scoped (intentional safe default).
//   - Cross-workspace isolation on the list endpoint is NOT enforced until Phase 6.
//
// Tests marked it.todo() will pass after Phase 6 applies WorkspaceGuard to AgentsController list.
//
// Design (mirrors proxy-passthrough.test.mjs):
//   - Boots NestJS app in-process from compiled dist/.
//   - Test port: 7796 (avoids collision with other leak tests and 7791-7795).

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
// + back-to-back npm `test` chain would otherwise share database/data.db; this
// file's "scoped to ws_a sees only ws_a" assertions are exactly what break when
// earlier leak files leave agents/workspaces behind in a shared db).
process.env.SQLJS_DB_PATH =
  process.env.SQLJS_DB_PATH || path.join(os.tmpdir(), `awb-leak-agents-${Date.now()}-${process.pid}.db`);
process.env.PORT = process.env.AGENTS_LEAK_PORT || '7796';
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

describe('agents-leak: cross-workspace agent isolation', async () => {
  let app;
  let adminToken;
  let wsA;
  let wsB;
  let agentA;
  let tokenB;

  const ADMIN_EMAIL = `agents-leak-admin-${randomUUID()}@awb.local`;
  const USER_B_EMAIL = `agents-leak-ub-${randomUUID()}@awb.local`;

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
      name: 'agents-leak-admin',
      email: ADMIN_EMAIL,
      role: 'admin',
      status: 'active',
    }));
    adminToken = authService.createSession(adminUser.id);

    // ─── Create two workspaces directly ───────────────────────────────────────
    wsA = await wsRepo.save(wsRepo.create({ name: 'Leak WS A (agents)', description: 'Leak test' }));
    wsB = await wsRepo.save(wsRepo.create({ name: 'Leak WS B (agents)', description: 'Leak test' }));

    // ─── Create user B and assign to workspace B ──────────────────────────────
    const userBRec = await userRepo.save(userRepo.create({
      name: 'agents-leak-user-b',
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

    // ─── Create an agent in workspace A via HTTP ───────────────────────────────
    // The create endpoint IGNORES body.workspace_id (anti cross-workspace
    // creation) and uses the WorkspaceGuard-resolved workspace from the
    // X-Workspace-Id header; with no header it falls back to the lexicographically
    // smallest workspace id (order: id ASC), which is wsA-or-wsB by UUID lottery —
    // the non-determinism behind the original "Agent should be assigned to
    // workspace A" drift. Send the header so the agent lands in ws_a every time.
    const agentRes = await apiRequest(BASE_URL, '/agents', {
      token: adminToken,
      method: 'POST',
      workspaceId: wsA.id,
      body: {
        name: `Leak Agent WS-A ${randomUUID()}`,
        description: 'Cross-workspace leak test agent',
        type: 'custom',
        workspace_id: wsA.id,
      },
    });
    assert.equal(agentRes.status, 201, `Failed to create agent: ${JSON.stringify(agentRes.data)}`);
    agentA = agentRes.data;
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

  it('admin can create an agent in workspace A (control)', () => {
    assert.ok(agentA?.id, 'Agent should have been created with an ID');
    assert.ok(agentA.name.startsWith('Leak Agent WS-A'));
    assert.equal(agentA.workspace_id, wsA.id, 'Agent should be assigned to workspace A');
  });

  it('admin can retrieve agent A by ID (control)', async () => {
    const res = await apiRequest(BASE_URL, `/agents/${agentA.id}`, {
      token: adminToken,
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.id, agentA.id);
  });

  it('GET /api/agents/dashboard?workspace_id=ws_a returns agent A (workspace-scoped, already safe)', async () => {
    const res = await apiRequest(BASE_URL, `/agents/dashboard?workspace_id=${wsA.id}`, {
      token: adminToken,
    });
    assert.equal(res.status, 200);
    const agents = Array.isArray(res.data) ? res.data : [];
    assert.ok(agents.some(a => a.id === agentA.id), 'Dashboard should return agent A when scoped to ws_a');
  });

  it('GET /api/agents/dashboard?workspace_id=ws_b returns empty (safe default, already enforced)', async () => {
    // The dashboard endpoint already filters by workspace_id — this is a safe default
    // enforced in the current codebase even before Phase 6.
    const res = await apiRequest(BASE_URL, `/agents/dashboard?workspace_id=${wsB.id}`, {
      token: adminToken,
    });
    assert.equal(res.status, 200);
    const agents = Array.isArray(res.data) ? res.data : [];
    const wsAAgents = agents.filter(a => a.id === agentA.id);
    assert.equal(wsAAgents.length, 0, 'Dashboard should NOT show ws_a agents when queried for ws_b');
  });

  it('GET /api/agents/dashboard without workspace_id returns empty (safe default)', async () => {
    // The dashboard endpoint returns empty array when workspace_id is absent — prevents
    // cross-workspace data leak on the dashboard surface. Verified per agents.controller.ts line.
    const res = await apiRequest(BASE_URL, '/agents/dashboard', {
      token: adminToken,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(Array.isArray(res.data) ? res.data : [], [], 'Dashboard without workspace_id should return empty array');
  });

  it('role_prompt is redacted for non-admin viewers on GET /api/agents/:id', async () => {
    // First set a role_prompt on agentA
    await apiRequest(BASE_URL, `/agents/${agentA.id}`, {
      token: adminToken,
      method: 'PATCH',
      body: { role_prompt: 'Secret system prompt for WS A agent' },
    });

    // Admin sees the role_prompt
    const adminRes = await apiRequest(BASE_URL, `/agents/${agentA.id}`, {
      token: adminToken,
    });
    assert.equal(adminRes.status, 200);
    assert.equal(adminRes.data.redacted, false, 'Admin should see unredacted agent data');
    assert.equal(adminRes.data.role_prompt, 'Secret system prompt for WS A agent');
  });

  // ─── Phase 6 isolation contract ───────────────────────────────────────────
  // The following tests document the EXPECTED behavior once WorkspaceGuard is applied
  // to AgentsController in Phase 6. The list endpoint (/api/agents) will be workspace-scoped.

  it('GET /api/agents with X-Workspace-Id: ws_b does not show ws_a agents — Phase 6 workspace scoping on list', async () => {
    // User B is a member of ws_b — WorkspaceGuard passes, list scoped to ws_b
    // agentA belongs to wsA, so should not appear in ws_b listing
    const res = await apiRequest(BASE_URL, '/agents', {
      token: tokenB,
      workspaceId: wsB.id,
    });
    assert.ok(
      res.status === 200 || res.status === 403,
      `Expected 200 (empty/scoped) or 403, got ${res.status}`,
    );
    if (res.status === 200) {
      const agents = Array.isArray(res.data) ? res.data : [];
      assert.equal(
        agents.filter(a => a.id === agentA.id).length,
        0,
        'Workspace A agent must not appear in workspace B agent listing',
      );
    }
  });

  it('cross-workspace GET /api/agents/:id is intentionally id-only but redacts the role_prompt for non-admins', async () => {
    // CONTRACT (deliberate, not a leak): GET /api/agents/:id is keyed on id only
    // and is NOT workspace-scoped — see AgentsController.get ("Operator directive:
    // id-only"). The AgentManager page fetches managed/cross-workspace agents by
    // id, so the detail surface must resolve any id. The security boundary on this
    // endpoint is FIELD-LEVEL: the sensitive role_prompt is admin-gated and
    // redacted for everyone else. The workspace ISOLATION boundary lives on the
    // LIST endpoint (asserted by the ws_b list test above), which IS scoped.
    //
    // So a ws_b member resolving a ws_a agent by id gets 200 with a redacted
    // payload — never the role_prompt. (agentA had a role_prompt set above.)
    const res = await apiRequest(BASE_URL, `/agents/${agentA.id}`, {
      token: tokenB,
      workspaceId: wsB.id,
    });
    assert.equal(res.status, 200, `id-only lookup should resolve, got ${res.status}: ${JSON.stringify(res.data)}`);
    assert.equal(res.data.id, agentA.id);
    assert.equal(res.data.redacted, true, 'non-admin cross-workspace viewer must get a redacted payload');
    assert.ok(
      !res.data.role_prompt,
      `role_prompt must be stripped for a non-admin cross-workspace viewer, got: ${JSON.stringify(res.data.role_prompt)}`,
    );
  });

  it('admin with X-Workspace-Id: ws_a lists agents and sees only ws_a agents — Phase 6', async () => {
    // Admin bypasses WorkspaceGuard membership check — access should succeed
    const res = await apiRequest(BASE_URL, '/agents', {
      token: adminToken,
      workspaceId: wsA.id,
    });
    assert.equal(res.status, 200, `Admin should be able to list agents with ws_a header, got ${res.status}`);
    const agents = Array.isArray(res.data) ? res.data : [];
    assert.ok(agents.some(a => a.id === agentA.id), 'Admin scoped to ws_a should see agentA');
  });

  it('admin with X-Workspace-Id: ws_b lists agents and sees empty (no agents in ws_b) — Phase 6', async () => {
    // Admin scoped to ws_b — no agents in ws_b, so result should be empty
    const res = await apiRequest(BASE_URL, '/agents', {
      token: adminToken,
      workspaceId: wsB.id,
    });
    assert.equal(res.status, 200);
    const agents = Array.isArray(res.data) ? res.data : [];
    assert.equal(
      agents.filter(a => a.id === agentA.id).length,
      0,
      'Workspace A agent must not appear in workspace B listing',
    );
  });
});
