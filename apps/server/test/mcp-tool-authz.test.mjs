// 티켓 d6b56237 — MCP user/api-key/agent/workspace 도구 인가 누락 회귀 테스트.
//
// 취약점 요약(수정 전):
//   C1) user-tools.ts의 create/update/delete_user가 getCallerAgent를 전혀
//       호출하지 않아, 스코프에 상관없이 어떤 인증된 MCP 키든 임의 사용자를
//       admin으로 승격하거나 삭제할 수 있었다.
//   C2) api-key-tools.ts의 모든 핸들러가 extra/sessionId를 아예 받지 않아,
//       워크스페이스에 바인딩되지 않은 full-scope 키를 발급하거나 다른
//       워크스페이스의 키를 열람/삭제할 수 있었다.
//   Medium) workflow-function-tools.ts의 scopeAllowed()가
//       `!caller?.workspaceId || ...` 형태의 fail-open이라 워크스페이스가
//       없는(바인딩되지 않은) 호출자를 무조건 통과시켰다.
//   후속) agent-tools.ts(create/update/delete_agent, move_agent_to_workspace)와
//       workspace-tools.ts(update/delete_workspace)도 동일한 패턴(호출자 검증
//       없음, 또는 문서만 "Admin-gated"라고 주장할 뿐 실제 게이트가 없음).
//
// 이 파일은 apps/server/test/hermes-collaboration.test.mjs의 패턴을 그대로
// 따른다: 가짜 McpServer가 `.tool(name, desc, schema, handler)` 등록을
// 캡처하고, 실제 sessionStore.register()/remove()로 세션 신원을 만든 뒤
// 캡처된 handler를 직접 호출해 { content, isError }를 검증한다.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';

import { Agent } from '../dist/entities/Agent.js';
import { User } from '../dist/entities/User.js';
import { ApiKey } from '../dist/entities/ApiKey.js';

import { registerUserTools } from '../dist/modules/mcp/tools/user-tools.js';
import { registerApiKeyTools } from '../dist/modules/mcp/tools/api-key-tools.js';
import { registerWorkflowFunctionTools } from '../dist/modules/mcp/tools/workflow-function-tools.js';
import { registerAgentTools } from '../dist/modules/mcp/tools/agent-tools.js';
import { registerWorkspaceTools } from '../dist/modules/mcp/tools/workspace-tools.js';

import { ApiKeyService } from '../dist/services/api-key.service.js';
import { sessionStore } from '../dist/modules/mcp/internal/session-store.js';

describe('MCP tool authorization (ticket d6b56237)', () => {
  let dataSource;
  let apiKeyService;
  let tools; // name -> { handler }

  before(async () => {
    dataSource = new DataSource({
      type: 'sqljs',
      entities: [Agent, User, ApiKey],
      synchronize: true,
      logging: false,
    });
    await dataSource.initialize();
    apiKeyService = new ApiKeyService(dataSource.getRepository(ApiKey));

    tools = {};
    const fakeServer = {
      tool(name, description, schema, handler) {
        tools[name] = { description, schema, handler };
      },
    };

    const noopLogger = { info() {}, warn() {}, error() {} };
    const stubWorkflowFunctionsService = {
      list: async () => [],
      get: async () => { throw new Error('not found'); },
      create: async () => { throw new Error('not implemented in stub'); },
      update: async () => { throw new Error('not implemented in stub'); },
      remove: async () => {},
      execute: async () => ({}),
      listRuns: async () => [],
    };

    const ctx = {
      dataSource,
      apiKeyService,
      logger: noopLogger,
      workflowFunctionsService: stubWorkflowFunctionsService,
      // move_agent_to_workspace only touches activityService on the commit
      // path, which every negative (denied) test here never reaches.
      activityService: undefined,
    };

    registerUserTools(fakeServer, ctx);
    registerApiKeyTools(fakeServer, ctx);
    registerWorkflowFunctionTools(fakeServer, ctx);
    registerAgentTools(fakeServer, ctx);
    registerWorkspaceTools(fakeServer, ctx);
  });

  after(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  // ─── Test fixtures: two workspace-scoped agents + one full-scope agent ───

  async function makeAgent(workspaceId) {
    const repo = dataSource.getRepository(Agent);
    const agent = await repo.save(repo.create({
      name: `agent-${randomUUID().slice(0, 8)}`,
      type: 'claude',
      workspace_id: workspaceId ?? '',
    }));
    return agent;
  }

  function registerSession(sessionId, auth) {
    const transport = { close: async () => {} };
    sessionStore.register(sessionId, transport, {}, auth);
    return () => sessionStore.remove(sessionId);
  }

  // ─── DoD (a): workspace-scoped key cannot change another user's role ───

  it('rejects update_user role change from a workspace-scoped caller (and from any caller)', async () => {
    const agent = await makeAgent('workspace-a');
    const userRepo = dataSource.getRepository(User);
    const target = await userRepo.save(userRepo.create({ name: 'Target User', role: 'user' }));

    const sessionId = `session-${randomUUID()}`;
    const cleanup = registerSession(sessionId, {
      agentId: agent.id,
      workspaceId: 'workspace-a',
      scope: 'read',
      source: 'db',
    });

    const result = await tools.update_user.handler(
      { user_id: target.id, role: 'admin' },
      { sessionId },
    );
    cleanup();

    assert.equal(result.isError, true);
    const reloaded = await userRepo.findOne({ where: { id: target.id } });
    assert.equal(reloaded.role, 'user');
  });

  it('rejects create_user with role/permissions from any caller (privilege escalation via create)', async () => {
    const result = await tools.create_user.handler(
      { name: 'New Admin', role: 'admin', permissions: ['admin.users'] },
      {},
    );
    assert.equal(result.isError, true);
  });

  it('rejects delete_user from a workspace-scoped (non-full-scope) caller', async () => {
    const agent = await makeAgent('workspace-a');
    const userRepo = dataSource.getRepository(User);
    const target = await userRepo.save(userRepo.create({ name: 'Doomed User', role: 'user' }));

    const sessionId = `session-${randomUUID()}`;
    const cleanup = registerSession(sessionId, {
      agentId: agent.id,
      workspaceId: 'workspace-a',
      scope: 'full', // even full scope must still be DB-backed + agent-bound; read/write also rejected below
      source: 'db',
    });

    const result = await tools.delete_user.handler({ user_id: target.id }, { sessionId });
    cleanup();

    // A db-backed, full-scope, agent-bound caller is exactly what
    // requireFullScopeCaller demands — this specific combination is allowed.
    assert.equal(result.isError, undefined);
    const reloaded = await userRepo.findOne({ where: { id: target.id } });
    assert.equal(reloaded, null);
  });

  it('rejects delete_user from a read-scoped caller', async () => {
    const agent = await makeAgent('workspace-a');
    const userRepo = dataSource.getRepository(User);
    const target = await userRepo.save(userRepo.create({ name: 'Safe User', role: 'user' }));

    const sessionId = `session-${randomUUID()}`;
    const cleanup = registerSession(sessionId, {
      agentId: agent.id,
      workspaceId: 'workspace-a',
      scope: 'read',
      source: 'db',
    });

    const result = await tools.delete_user.handler({ user_id: target.id }, { sessionId });
    cleanup();

    assert.equal(result.isError, true);
    const reloaded = await userRepo.findOne({ where: { id: target.id } });
    assert.ok(reloaded);
  });

  // ─── DoD (b): workspace-scoped key cannot mint a full-scope key ───

  it('rejects create_api_key minting a broader scope than the caller', async () => {
    const agent = await makeAgent('workspace-a');
    const sessionId = `session-${randomUUID()}`;
    const cleanup = registerSession(sessionId, {
      agentId: agent.id,
      workspaceId: 'workspace-a',
      scope: 'read',
      source: 'db',
    });

    const result = await tools.create_api_key.handler(
      { name: 'escalated-key', scope: 'full' },
      { sessionId },
    );
    cleanup();

    assert.equal(result.isError, true);
  });

  it('allows create_api_key at or below the caller scope, always workspace-bound to the caller', async () => {
    const agent = await makeAgent('workspace-a');
    const sessionId = `session-${randomUUID()}`;
    const cleanup = registerSession(sessionId, {
      agentId: agent.id,
      workspaceId: 'workspace-a',
      scope: 'write',
      source: 'db',
    });

    const result = await tools.create_api_key.handler(
      { name: 'ok-key', scope: 'read' },
      { sessionId },
    );
    cleanup();

    assert.equal(result.isError, undefined);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.workspace_id, 'workspace-a');
    assert.ok(body.raw_key);
  });

  it('rejects create_api_key from a caller with no resolvable workspace (unbound)', async () => {
    const sessionId = `session-${randomUUID()}`;
    // No agentId, no workspaceId — e.g. an env-configured master key.
    const cleanup = registerSession(sessionId, { scope: 'full', source: 'env' });

    const result = await tools.create_api_key.handler({ name: 'orphan-key' }, { sessionId });
    cleanup();

    assert.equal(result.isError, true);
  });

  // ─── DoD (c): workspace-scoped key cannot list/view/delete another workspace's keys ───

  it('scopes list_api_keys to the caller workspace and excludes other workspaces', async () => {
    const agentA = await makeAgent('workspace-a');
    const agentB = await makeAgent('workspace-b');

    const created = await apiKeyService.createApiKey({ name: 'ws-a-key', workspace_id: 'workspace-a' });
    await apiKeyService.createApiKey({ name: 'ws-b-key', workspace_id: 'workspace-b' });

    const sessionId = `session-${randomUUID()}`;
    const cleanup = registerSession(sessionId, {
      agentId: agentA.id,
      workspaceId: 'workspace-a',
      scope: 'read',
      source: 'db',
    });

    const result = await tools.list_api_keys.handler({}, { sessionId });
    cleanup();

    assert.equal(result.isError, undefined);
    const body = JSON.parse(result.content[0].text);
    assert.ok(body.some(k => k.id === created.apiKey.id));
    assert.ok(body.every(k => k.workspace_id === 'workspace-a'));
    void agentB;
  });

  it('rejects get_api_key / delete_api_key for a key belonging to another workspace', async () => {
    const agentA = await makeAgent('workspace-a');
    const foreignKey = await apiKeyService.createApiKey({ name: 'ws-b-key', workspace_id: 'workspace-b' });

    const sessionId = `session-${randomUUID()}`;
    const cleanup = registerSession(sessionId, {
      agentId: agentA.id,
      workspaceId: 'workspace-a',
      scope: 'full',
      source: 'db',
    });

    const getResult = await tools.get_api_key.handler({ key_id: foreignKey.apiKey.id }, { sessionId });
    assert.equal(getResult.isError, true);

    const deleteResult = await tools.delete_api_key.handler({ key_id: foreignKey.apiKey.id }, { sessionId });
    assert.equal(deleteResult.isError, true);
    cleanup();

    const stillThere = await apiKeyService.getApiKey(foreignKey.apiKey.id);
    assert.ok(stillThere);
  });

  it('rejects every api-key tool for an unbound caller (no session, dev-mode style)', async () => {
    const listResult = await tools.list_api_keys.handler({}, {});
    assert.equal(listResult.isError, true);
  });

  // ─── Medium: workflow-function-tools scopeAllowed fail-open → fail-closed ───

  it('rejects list_functions cross-workspace access from an unbound caller (was fail-open)', async () => {
    const sessionId = `session-${randomUUID()}`;
    // Unbound: no agentId at all, so there is nothing to resolve a real
    // workspace from — the old code let this straight through.
    const cleanup = registerSession(sessionId, { scope: 'full', source: 'env' });

    const result = await tools.list_functions.handler({ workspace_id: 'workspace-a' }, { sessionId });
    cleanup();

    assert.equal(result.isError, true);
    assert.match(JSON.parse(result.content[0].text).error, /scope mismatch/i);
  });

  it('allows list_functions when the caller is bound to the requested workspace', async () => {
    const agent = await makeAgent('workspace-a');
    const sessionId = `session-${randomUUID()}`;
    const cleanup = registerSession(sessionId, {
      agentId: agent.id,
      workspaceId: 'workspace-a',
      scope: 'read',
      source: 'db',
    });

    const result = await tools.list_functions.handler({ workspace_id: 'workspace-a' }, { sessionId });
    cleanup();

    assert.equal(result.isError, undefined);
  });

  it('rejects list_functions when a workspace-bound caller targets a different workspace', async () => {
    const agent = await makeAgent('workspace-a');
    const sessionId = `session-${randomUUID()}`;
    const cleanup = registerSession(sessionId, {
      agentId: agent.id,
      workspaceId: 'workspace-a',
      scope: 'read',
      source: 'db',
    });

    const result = await tools.list_functions.handler({ workspace_id: 'workspace-b' }, { sessionId });
    cleanup();

    assert.equal(result.isError, true);
  });

  it('allows a genuinely global (workspace_id-less) full-scope Agent through the escape hatch', async () => {
    const globalAgent = await makeAgent(''); // '' normalizes to null (global)
    const sessionId = `session-${randomUUID()}`;
    // No caller.workspaceId on the session — must fall through to the DB
    // lookup, which proves this agent really is global.
    const cleanup = registerSession(sessionId, {
      agentId: globalAgent.id,
      scope: 'full',
      source: 'db',
    });

    const result = await tools.list_functions.handler({ workspace_id: 'workspace-any' }, { sessionId });
    cleanup();

    assert.equal(result.isError, undefined);
  });

  // ─── agent-tools.ts: create/update/delete_agent, move_agent_to_workspace ───

  it('rejects create_agent / update_agent / delete_agent from a non-full-scope caller', async () => {
    const caller = await makeAgent('workspace-a');
    const victim = await makeAgent('workspace-a');
    const sessionId = `session-${randomUUID()}`;
    const cleanup = registerSession(sessionId, {
      agentId: caller.id,
      workspaceId: 'workspace-a',
      scope: 'write',
      source: 'db',
    });

    const createResult = await tools.create_agent.handler(
      { name: 'sneaky', workspace_id: null, type: 'claude', manager_agent_id: 'whatever' },
      { sessionId },
    );
    assert.equal(createResult.isError, true);

    const updateResult = await tools.update_agent.handler(
      { agent_id: victim.id, workspace_id: null },
      { sessionId },
    );
    assert.equal(updateResult.isError, true);

    const deleteResult = await tools.delete_agent.handler({ agent_id: victim.id }, { sessionId });
    assert.equal(deleteResult.isError, true);
    cleanup();

    const stillThere = await dataSource.getRepository(Agent).findOne({ where: { id: victim.id } });
    assert.ok(stillThere, 'victim agent must not have been reassigned or deleted');
  });

  it('allows delete_agent from a DB-backed, full-scope, agent-bound caller', async () => {
    const caller = await makeAgent('workspace-a');
    const victim = await makeAgent('workspace-a');
    const sessionId = `session-${randomUUID()}`;
    const cleanup = registerSession(sessionId, {
      agentId: caller.id,
      workspaceId: 'workspace-a',
      scope: 'full',
      source: 'db',
    });

    const result = await tools.delete_agent.handler({ agent_id: victim.id }, { sessionId });
    cleanup();

    assert.equal(result.isError, undefined);
    const gone = await dataSource.getRepository(Agent).findOne({ where: { id: victim.id } });
    assert.equal(gone, null);
  });

  it('gates the committing move_agent_to_workspace call (dry_run=false) — the "Admin-gated" docstring is now enforced', async () => {
    const caller = await makeAgent('workspace-a');
    const sessionId = `session-${randomUUID()}`;
    const cleanup = registerSession(sessionId, {
      agentId: caller.id,
      workspaceId: 'workspace-a',
      scope: 'read',
      source: 'db',
    });

    const commitResult = await tools.move_agent_to_workspace.handler(
      { agent_id: caller.id, target_workspace_id: 'workspace-b', dry_run: false },
      { sessionId },
    );
    cleanup();

    assert.equal(commitResult.isError, true);
  });

  // ─── workspace-tools.ts: update/delete_workspace ───

  it('rejects update_workspace when the caller does not belong to the target workspace', async () => {
    const caller = await makeAgent('workspace-a');
    const sessionId = `session-${randomUUID()}`;
    const cleanup = registerSession(sessionId, {
      agentId: caller.id,
      workspaceId: 'workspace-a',
      scope: 'full',
      source: 'db',
    });

    const result = await tools.update_workspace.handler(
      { workspace_id: 'workspace-b', name: 'Renamed by outsider' },
      { sessionId },
    );
    cleanup();

    assert.equal(result.isError, true);
  });

  it('rejects delete_workspace from a non-full-scope caller', async () => {
    const caller = await makeAgent('workspace-a');
    const sessionId = `session-${randomUUID()}`;
    const cleanup = registerSession(sessionId, {
      agentId: caller.id,
      workspaceId: 'workspace-a',
      scope: 'write',
      source: 'db',
    });

    const result = await tools.delete_workspace.handler({ workspace_id: 'workspace-a' }, { sessionId });
    cleanup();

    assert.equal(result.isError, true);
  });
});
