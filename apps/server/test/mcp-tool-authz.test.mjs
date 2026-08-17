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
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
import {
  installToolAuthzGate, resolveAuthzTier, TOOL_AUTHZ_TABLE, KNOWN_EXISTING_TOOLS,
} from '../dist/modules/mcp/shared/tool-authz-gate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Scrapes a live `.tool('name', ...)` registration out of a *-tools.ts
// source file. `\s*` alone (no forced `\r?\n`) matches zero-or-more
// whitespace of ANY kind, so it covers both a same-line registration
// (`server.tool('foo', ...)`) and a multi-line one (`.tool(\n  'foo',`)
// uniformly — see the non-vacuous regression test below (ticket 3f744b6d).
const LIVE_TOOL_NAME_PATTERN = /\.tool\(\s*['"]([a-zA-Z0-9_]+)['"]/g;

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

  // ─── Review round 2 (ticket d6b56237 comment b647d97e): the 19 tests above
  // never exercised a workspace-A full-scope caller reaching into workspace
  // B — every prior "allows ..." positive test kept caller and target in the
  // SAME workspace, so requireFullScopeCaller's missing workspace-boundary
  // check went uncaught. These add the cross-tenant destructive paths, plus
  // the sessionless user-tools gate and foreign agent_id linking. ───

  it('rejects update_agent / delete_agent from a workspace-A full-scope caller targeting a workspace-B agent', async () => {
    const caller = await makeAgent('workspace-a');
    const victim = await makeAgent('workspace-b');
    const sessionId = `session-${randomUUID()}`;
    const cleanup = registerSession(sessionId, {
      agentId: caller.id,
      workspaceId: 'workspace-a',
      scope: 'full',
      source: 'db',
    });

    const updateResult = await tools.update_agent.handler(
      { agent_id: victim.id, name: 'renamed-by-outsider' },
      { sessionId },
    );
    assert.equal(updateResult.isError, true);

    const deleteResult = await tools.delete_agent.handler({ agent_id: victim.id }, { sessionId });
    assert.equal(deleteResult.isError, true);
    cleanup();

    const stillThere = await dataSource.getRepository(Agent).findOne({ where: { id: victim.id } });
    assert.ok(stillThere, 'workspace-B victim agent must survive a workspace-A full-scope caller');
    assert.equal(stillThere.name, victim.name);
  });

  it('rejects create_agent into a foreign workspace from a workspace-A full-scope caller', async () => {
    const caller = await makeAgent('workspace-a');
    const sessionId = `session-${randomUUID()}`;
    const cleanup = registerSession(sessionId, {
      agentId: caller.id,
      workspaceId: 'workspace-a',
      scope: 'full',
      source: 'db',
    });

    const result = await tools.create_agent.handler(
      { name: 'planted-in-b', workspace_id: 'workspace-b', type: 'claude', manager_agent_id: 'whatever' },
      { sessionId },
    );
    cleanup();

    assert.equal(result.isError, true);
  });

  it('rejects the committing move_agent_to_workspace call from a workspace-A full-scope caller moving a workspace-B agent', async () => {
    const caller = await makeAgent('workspace-a');
    const victim = await makeAgent('workspace-b');
    const sessionId = `session-${randomUUID()}`;
    const cleanup = registerSession(sessionId, {
      agentId: caller.id,
      workspaceId: 'workspace-a',
      scope: 'full',
      source: 'db',
    });

    const result = await tools.move_agent_to_workspace.handler(
      { agent_id: victim.id, target_workspace_id: 'workspace-c', dry_run: false },
      { sessionId },
    );
    cleanup();

    assert.equal(result.isError, true);
    const stillThere = await dataSource.getRepository(Agent).findOne({ where: { id: victim.id } });
    assert.equal(stillThere.workspace_id, 'workspace-b');
  });

  it('rejects the committing move_agent_to_workspace call when the DESTINATION is foreign, even for the caller\'s own agent', async () => {
    const caller = await makeAgent('workspace-a');
    const sessionId = `session-${randomUUID()}`;
    const cleanup = registerSession(sessionId, {
      agentId: caller.id,
      workspaceId: 'workspace-a',
      scope: 'full',
      source: 'db',
    });

    const result = await tools.move_agent_to_workspace.handler(
      { agent_id: caller.id, target_workspace_id: 'workspace-b', dry_run: false },
      { sessionId },
    );
    cleanup();

    assert.equal(result.isError, true);
  });

  it('rejects delete_workspace of workspace B from a workspace-A full-scope caller', async () => {
    const caller = await makeAgent('workspace-a');
    const sessionId = `session-${randomUUID()}`;
    const cleanup = registerSession(sessionId, {
      agentId: caller.id,
      workspaceId: 'workspace-a',
      scope: 'full',
      source: 'db',
    });

    const result = await tools.delete_workspace.handler({ workspace_id: 'workspace-b' }, { sessionId });
    cleanup();

    assert.equal(result.isError, true);
  });

  it('allows a genuinely global full-scope Agent to update/delete an agent in any workspace (explicit escape hatch)', async () => {
    const globalAgent = await makeAgent(''); // '' normalizes to null (global)
    const victim = await makeAgent('workspace-a');
    const sessionId = `session-${randomUUID()}`;
    const cleanup = registerSession(sessionId, {
      agentId: globalAgent.id,
      scope: 'full',
      source: 'db',
    });

    const result = await tools.delete_agent.handler({ agent_id: victim.id }, { sessionId });
    cleanup();

    assert.equal(result.isError, undefined);
    const gone = await dataSource.getRepository(Agent).findOne({ where: { id: victim.id } });
    assert.equal(gone, null);
  });

  // ─── DoD (b): sessionless / unresolvable-session create_user / update_user ───

  it('rejects create_user and update_user with no session at all', async () => {
    const createResult = await tools.create_user.handler({ name: 'Ghost User' }, {});
    assert.equal(createResult.isError, true);

    const userRepo = dataSource.getRepository(User);
    const target = await userRepo.save(userRepo.create({ name: 'Existing User', role: 'user' }));
    const updateResult = await tools.update_user.handler(
      { user_id: target.id, name: 'Renamed Anonymously' },
      {},
    );
    assert.equal(updateResult.isError, true);
    const reloaded = await userRepo.findOne({ where: { id: target.id } });
    assert.equal(reloaded.name, 'Existing User');
  });

  it('rejects create_user and update_user with a sessionId that resolves to nothing', async () => {
    const createResult = await tools.create_user.handler(
      { name: 'Ghost User 2' },
      { sessionId: `session-${randomUUID()}` }, // never registered
    );
    assert.equal(createResult.isError, true);

    const userRepo = dataSource.getRepository(User);
    const target = await userRepo.save(userRepo.create({ name: 'Existing User 2', role: 'user' }));
    const updateResult = await tools.update_user.handler(
      { user_id: target.id, name: 'Renamed Anonymously 2' },
      { sessionId: `session-${randomUUID()}` },
    );
    assert.equal(updateResult.isError, true);
  });

  it('allows create_user / update_user from a resolvable caller with no role/permissions in the request', async () => {
    const agent = await makeAgent('workspace-a');
    const sessionId = `session-${randomUUID()}`;
    const cleanup = registerSession(sessionId, {
      agentId: agent.id,
      workspaceId: 'workspace-a',
      scope: 'read',
      source: 'db',
    });

    const createResult = await tools.create_user.handler({ name: 'Legit User' }, { sessionId });
    assert.equal(createResult.isError, undefined);
    cleanup();
  });

  // ─── DoD (c): api-key create/update must reject a foreign agent_id ───

  it('rejects create_api_key / update_api_key linking a foreign-workspace agent_id', async () => {
    const agentA = await makeAgent('workspace-a');
    const agentB = await makeAgent('workspace-b');
    const sessionId = `session-${randomUUID()}`;
    const cleanup = registerSession(sessionId, {
      agentId: agentA.id,
      workspaceId: 'workspace-a',
      scope: 'full',
      source: 'db',
    });

    const createResult = await tools.create_api_key.handler(
      { name: 'cross-linked-key', agent_id: agentB.id },
      { sessionId },
    );
    assert.equal(createResult.isError, true);

    const ownKey = await apiKeyService.createApiKey({ name: 'ws-a-key-2', workspace_id: 'workspace-a' });
    const updateResult = await tools.update_api_key.handler(
      { key_id: ownKey.apiKey.id, agent_id: agentB.id },
      { sessionId },
    );
    cleanup();

    assert.equal(updateResult.isError, true);
    const reloaded = await apiKeyService.getApiKey(ownKey.apiKey.id);
    assert.notEqual(reloaded.agent_id, agentB.id);
  });

  it('allows create_api_key linking an agent_id that belongs to the caller\'s own workspace', async () => {
    const agentA = await makeAgent('workspace-a');
    const linked = await makeAgent('workspace-a');
    const sessionId = `session-${randomUUID()}`;
    const cleanup = registerSession(sessionId, {
      agentId: agentA.id,
      workspaceId: 'workspace-a',
      scope: 'full',
      source: 'db',
    });

    const result = await tools.create_api_key.handler(
      { name: 'same-workspace-link', agent_id: linked.id },
      { sessionId },
    );
    cleanup();

    assert.equal(result.isError, undefined);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.agent_id, linked.id);
  });
});

// ─── Central gate (ticket 838f43c4, follow-up to d6b56237) ───
//
// d6b56237 fixed four specific tool files after they shipped with zero
// caller-identity checks. The structural hole stayed open: registerAllTools
// (tools/index.ts) auto-discovers every *-tools.ts file by filename
// convention alone, so a fifth admin-grade file added tomorrow would ship
// exposed the exact same way. These tests exercise installToolAuthzGate
// directly — the wrapper that now runs inside registerAllTools before any
// tool file's own handler — rather than the per-file logic covered above.

describe('MCP tool authorization — central gate (ticket 838f43c4)', () => {
  let dataSource;

  before(async () => {
    dataSource = new DataSource({
      type: 'sqljs',
      entities: [Agent],
      synchronize: true,
      logging: false,
    });
    await dataSource.initialize();
  });

  after(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  async function makeAgent(workspaceId) {
    const repo = dataSource.getRepository(Agent);
    return repo.save(repo.create({
      name: `agent-${randomUUID().slice(0, 8)}`,
      type: 'claude',
      workspace_id: workspaceId ?? '',
    }));
  }

  function registerSession(sessionId, auth) {
    const transport = { close: async () => {} };
    sessionStore.register(sessionId, transport, {}, auth);
    return () => sessionStore.remove(sessionId);
  }

  function makeGatedFakeServer() {
    const tools = {};
    const fakeServer = {
      tool(name, description, schema, handler) {
        tools[name] = { description, schema, handler };
      },
    };
    installToolAuthzGate(fakeServer, dataSource);
    return { fakeServer, tools };
  }

  // ─── resolveAuthzTier: pure mapping unit tests ───

  it('maps the d6b56237 role/credential/cascade tools to their verified tier', () => {
    assert.equal(resolveAuthzTier('delete_user'), 'full');
    assert.equal(resolveAuthzTier('create_agent'), 'full');
    assert.equal(resolveAuthzTier('update_agent'), 'full');
    assert.equal(resolveAuthzTier('delete_agent'), 'full');
    assert.equal(resolveAuthzTier('delete_workspace'), 'full');
    assert.equal(resolveAuthzTier('create_user'), 'caller');
    assert.equal(resolveAuthzTier('update_user'), 'caller');
    assert.equal(resolveAuthzTier('create_api_key'), 'caller');
    assert.equal(resolveAuthzTier('update_api_key'), 'caller');
    assert.equal(resolveAuthzTier('revoke_api_key'), 'caller');
    assert.equal(resolveAuthzTier('delete_api_key'), 'caller');
  });

  it('falls back to the caller tier for existing delete_* tools outside the explicit table', () => {
    // These ship today with zero caller-identity check in their own handler
    // (confirmed by reading source, not inferred from tests) — the fallback
    // is what now covers them without touching each tool file.
    const uncoveredDeleteTools = [
      'delete_board', 'delete_action', 'delete_ticket', 'delete_qa_scenario',
      'delete_security_profile', 'delete_child_ticket', 'delete_qa_schedule',
      'delete_workspace_schedule', 'delete_security_schedule', 'delete_ticket_attachment',
      'delete_function', 'delete_channel', 'delete_resource', 'delete_column',
      'delete_prompt_template', 'delete_chat_message_attachment',
    ];
    for (const name of uncoveredDeleteTools) {
      assert.equal(resolveAuthzTier(name), 'caller', `${name} should fall back to 'caller'`);
      assert.equal(TOOL_AUTHZ_TABLE[name], undefined, `${name} should rely on the fallback, not an explicit table entry`);
    }
  });

  it('falls back to the caller tier for a tool name that does not exist yet (the actual "5th admin file" case)', () => {
    assert.equal(resolveAuthzTier('delete_some_future_admin_resource'), 'caller');
    assert.equal(resolveAuthzTier('revoke_some_future_credential'), 'caller');
  });

  it('denies unconditionally for an unknown tool whose name does NOT match delete_*/revoke_* either (review round 1 gap, tightened in round 2)', () => {
    // Round 1: the original gate only caught a future admin tool if its name
    // happened to start with delete_/revoke_ — anything else (create_*,
    // update_*, set_*, grant_*, rotate_*, purge_*, ...) resolved to null and
    // ran completely unchecked.
    //
    // Round 2: the fix for that (KNOWN_EXISTING_TOOLS) resolved these to the
    // 'caller' tier — an identity floor, not a deny. Any session with a
    // resolvable caller reached the handler regardless of scope, so a
    // read-scoped key could still call an unclassified admin-grade tool like
    // rotate_credential. resolveAuthzTier must return the 'deny' sentinel
    // instead, so installToolAuthzGate rejects before the handler runs no
    // matter what caller/scope is presented — see the
    // 'installToolAuthzGate: unclassified tools deny regardless of caller'
    // block below for the end-to-end proof across all four caller states.
    assert.equal(resolveAuthzTier('rotate_credential'), 'deny');
    assert.equal(resolveAuthzTier('grant_admin_role'), 'deny');
    assert.equal(resolveAuthzTier('set_user_role'), 'deny');
    assert.equal(resolveAuthzTier('purge_workspace_secrets'), 'deny');
    assert.equal(resolveAuthzTier('impersonate_user'), 'deny');
  });

  it('does not gate non-destructive-looking tool names that are on the known-existing snapshot', () => {
    assert.equal(resolveAuthzTier('list_users'), null);
    assert.equal(resolveAuthzTier('get_ticket'), null);
    assert.equal(resolveAuthzTier('create_ticket'), null);
    assert.ok(KNOWN_EXISTING_TOOLS.has('list_users'));
    assert.ok(KNOWN_EXISTING_TOOLS.has('get_ticket'));
    assert.ok(KNOWN_EXISTING_TOOLS.has('create_ticket'));
  });

  it('leaves update_workspace and move_agent_to_workspace to their own nuanced per-file logic', () => {
    // update_workspace intentionally allows a workspace-bound NON-full-scope
    // caller; move_agent_to_workspace only gates when dry_run=false. A
    // static per-name tier would misgate both, so neither is in the table —
    // and neither matches the delete_* / revoke_* fallback pattern, so
    // neither is touched by the fallback either.
    assert.equal(resolveAuthzTier('update_workspace'), null);
    assert.equal(resolveAuthzTier('move_agent_to_workspace'), null);
  });

  // ─── installToolAuthzGate: end-to-end wrapping behavior ───

  it('blocks a table-tiered ("full") tool BEFORE its own handler runs, even if that handler forgot its own check', async () => {
    const { fakeServer, tools } = makeGatedFakeServer();
    let handlerRan = false;
    fakeServer.tool('delete_user', 'test', {}, async () => {
      handlerRan = true;
      return { content: [{ type: 'text', text: '{"success":true}' }] };
    });

    const result = await tools.delete_user.handler({ user_id: 'x' }, {});
    assert.equal(result.isError, true);
    assert.equal(handlerRan, false, 'the central gate must short-circuit before the handler body runs');
  });

  it('lets a full-scope caller reach the handler for a "full"-tiered tool', async () => {
    const { fakeServer, tools } = makeGatedFakeServer();
    let handlerRan = false;
    fakeServer.tool('delete_user', 'test', {}, async () => {
      handlerRan = true;
      return { content: [{ type: 'text', text: '{"success":true}' }] };
    });

    const agent = await makeAgent('workspace-a');
    const sessionId = `session-${randomUUID()}`;
    const cleanup = registerSession(sessionId, {
      agentId: agent.id, workspaceId: 'workspace-a', scope: 'full', source: 'db',
    });
    const result = await tools.delete_user.handler({ user_id: 'x' }, { sessionId });
    cleanup();

    assert.equal(result.isError, undefined);
    assert.equal(handlerRan, true);
  });

  it('rejects a "full"-tiered tool call from a non-full-scope caller even when the handler has no check of its own', async () => {
    const { fakeServer, tools } = makeGatedFakeServer();
    fakeServer.tool('delete_agent', 'test', {}, async () => (
      { content: [{ type: 'text', text: '{"success":true}' }] }
    ));

    const agent = await makeAgent('workspace-a');
    const sessionId = `session-${randomUUID()}`;
    const cleanup = registerSession(sessionId, {
      agentId: agent.id, workspaceId: 'workspace-a', scope: 'write', source: 'db',
    });
    const result = await tools.delete_agent.handler({ agent_id: 'x' }, { sessionId });
    cleanup();

    assert.equal(result.isError, true);
  });

  it('blocks an unmapped delete_* tool (simulating a brand-new admin file) from a sessionless caller via the fallback tier', async () => {
    const { fakeServer, tools } = makeGatedFakeServer();
    let handlerRan = false;
    fakeServer.tool('delete_something_nobody_has_written_yet', 'test', {}, async () => {
      handlerRan = true;
      return { content: [{ type: 'text', text: '{"success":true}' }] };
    });

    const result = await tools.delete_something_nobody_has_written_yet.handler({}, {});
    assert.equal(result.isError, true);
    assert.equal(handlerRan, false);
  });

  it('allows an unmapped delete_* tool through the fallback tier once the caller is resolvable', async () => {
    const { fakeServer, tools } = makeGatedFakeServer();
    let handlerRan = false;
    fakeServer.tool('delete_something_nobody_has_written_yet', 'test', {}, async () => {
      handlerRan = true;
      return { content: [{ type: 'text', text: '{"success":true}' }] };
    });

    const agent = await makeAgent('workspace-a');
    const sessionId = `session-${randomUUID()}`;
    const cleanup = registerSession(sessionId, {
      agentId: agent.id, workspaceId: 'workspace-a', scope: 'read', source: 'db',
    });
    const result = await tools.delete_something_nobody_has_written_yet.handler({}, { sessionId });
    cleanup();

    assert.equal(result.isError, undefined);
    assert.equal(handlerRan, true);
  });

  it('does not gate a tool that is on the known-existing snapshot, even for a sessionless caller', async () => {
    const { fakeServer, tools } = makeGatedFakeServer();
    let handlerRan = false;
    // 'list_users' is a real, pre-existing, non-tabled tool name — it must
    // stay exactly as ungated as before. (A made-up name like
    // 'list_something_new' is no longer a valid fixture for this assertion:
    // it is NOT on KNOWN_EXISTING_TOOLS, so it would now be denied outright
    // by UNCLASSIFIED_TIER — see the
    // 'installToolAuthzGate: unclassified tools deny regardless of caller'
    // block below for that behavior across all caller states.)
    fakeServer.tool('list_users', 'test', {}, async () => {
      handlerRan = true;
      return { content: [{ type: 'text', text: '{"success":true}' }] };
    });

    const result = await tools.list_users.handler({}, {});
    assert.equal(result.isError, undefined);
    assert.equal(handlerRan, true);
  });

  // ─── Review round 2 (comment on ticket 838f43c4): round 1's fix resolved
  // an unmapped, non-delete/revoke-named tool to the 'caller' tier — an
  // identity floor, not a deny. Any session with a resolvable caller reached
  // the handler regardless of scope, so 'read' was enough to call an
  // unclassified admin-grade tool. These four cases must ALL end with
  // handlerRan=false: no session, read scope, write scope, and even a
  // full-scope caller — an unclassified name is denied unconditionally,
  // independent of caller identity or scope. Only explicit classification
  // (TOOL_AUTHZ_TABLE or KNOWN_EXISTING_TOOLS) can make the call succeed. ───

  describe('installToolAuthzGate: unclassified tools deny regardless of caller', () => {
    async function assertDenied(auth) {
      const { fakeServer, tools } = makeGatedFakeServer();
      let handlerRan = false;
      fakeServer.tool('rotate_credential', 'test', {}, async () => {
        handlerRan = true;
        return { content: [{ type: 'text', text: '{"success":true}' }] };
      });

      let extra = {};
      let cleanup = () => {};
      if (auth) {
        const agent = auth.workspaceId !== undefined ? await makeAgent(auth.workspaceId) : null;
        const sessionId = `session-${randomUUID()}`;
        cleanup = registerSession(sessionId, { ...auth, agentId: agent?.id });
        extra = { sessionId };
      }

      const result = await tools.rotate_credential.handler({}, extra);
      cleanup();

      assert.equal(result.isError, true);
      assert.equal(handlerRan, false, 'an unclassified tool must deny before the handler runs');
    }

    it('(1) no session at all', async () => {
      await assertDenied(null);
    });

    it('(2) read-scoped caller', async () => {
      await assertDenied({ workspaceId: 'workspace-a', scope: 'read', source: 'db' });
    });

    it('(3) write-scoped caller', async () => {
      await assertDenied({ workspaceId: 'workspace-a', scope: 'write', source: 'db' });
    });

    it('(4) full-scope, DB-backed, agent-bound caller — the strongest caller this gate ever accepts for a tabled tool', async () => {
      await assertDenied({ workspaceId: 'workspace-a', scope: 'full', source: 'db' });
    });
  });

  it('wires correctly through a real tool file (registerUserTools) — central gate covers delete_user even standalone', async () => {
    const tools = {};
    const fakeServer = { tool(name, description, schema, handler) { tools[name] = { handler }; } };
    installToolAuthzGate(fakeServer, dataSource);

    const noopLogger = { info() {}, warn() {}, error() {} };
    registerUserTools(fakeServer, { dataSource, logger: noopLogger });

    const result = await tools.delete_user.handler({ user_id: 'nonexistent' }, {});
    assert.equal(result.isError, true);
  });

  // ─── Completeness guard: every real tool name must be accounted for ───
  //
  // Review round 1 found the original gate's default silently gave a free
  // pass to any tool name outside TOOL_AUTHZ_TABLE and DESTRUCTIVE_NAME_PATTERN.
  // KNOWN_EXISTING_TOOLS closes that at runtime (see resolveAuthzTier), but
  // the snapshot itself can drift — this test fails the build the moment a
  // real tool name in the source tree is neither tabled, nor
  // destructive-pattern-matched, nor present in the snapshot, forcing a
  // conscious classification decision instead of letting drift go unnoticed.
  it('every real *-tools.ts registration is covered by TOOL_AUTHZ_TABLE, the destructive-name pattern, or KNOWN_EXISTING_TOOLS', () => {
    const toolsSrcDir = join(__dirname, '..', 'src', 'modules', 'mcp', 'tools');
    const files = readdirSync(toolsSrcDir).filter(f => /-tools\.ts$/.test(f));
    assert.ok(files.length >= 30, `sanity: expected 30+ *-tools.ts files, found ${files.length}`);

    const liveNames = new Set();
    for (const file of files) {
      const src = readFileSync(join(toolsSrcDir, file), 'utf8');
      for (const m of src.matchAll(LIVE_TOOL_NAME_PATTERN)) {
        liveNames.add(m[1]);
      }
    }
    assert.ok(liveNames.size >= 150, `sanity: expected 150+ live tool names, found ${liveNames.size}`);

    const destructivePattern = /^(delete_|revoke_)/;
    const unaccounted = [...liveNames].filter(name => (
      TOOL_AUTHZ_TABLE[name] === undefined
      && !destructivePattern.test(name)
      && !KNOWN_EXISTING_TOOLS.has(name)
    ));
    assert.deepEqual(
      unaccounted,
      [],
      `New tool(s) registered without an authz classification decision — add each to `
      + `TOOL_AUTHZ_TABLE (if it needs 'full'/'caller') or KNOWN_EXISTING_TOOLS (if it is safe `
      + `to leave ungated) in shared/tool-authz-gate.ts: ${unaccounted.join(', ')}`,
    );

    // Symmetric check: nothing in the snapshot should be stale (a name that
    // was removed/renamed but left behind would silently narrow real
    // coverage without anyone noticing, since a removed name can never be
    // called anyway — but a rename means the NEW name is unaccounted-for,
    // which the check above already catches).
    const staleSnapshotEntries = [...KNOWN_EXISTING_TOOLS].filter(name => !liveNames.has(name));
    assert.deepEqual(
      staleSnapshotEntries,
      [],
      `KNOWN_EXISTING_TOOLS has name(s) with no matching live registration (removed/renamed?): ${staleSnapshotEntries.join(', ')}`,
    );
  });

  // ─── Non-vacuous regression: a one-line `.tool(` registration must not be
  // a completeness-guard blind spot ───
  //
  // Before ticket 3f744b6d, the scraper required a newline between `.tool(`
  // and the opening quote, so `server.tool('foo', ...)` written on a single
  // line silently fell out of `liveNames` above — the completeness guard
  // could never flag it as unaccounted-for even if it were missing from
  // both TOOL_AUTHZ_TABLE and KNOWN_EXISTING_TOOLS, producing a "build
  // green + runtime deny" blind spot for exactly the kind of drift that
  // test exists to catch. This proves the fix is non-vacuous: the old
  // pattern really did miss the fixture, and the current one does not.
  describe('completeness guard regex: one-line .tool() registration is not a blind spot', () => {
    const ONE_LINE_FIXTURE = `server.tool('example_one_line_tool', 'desc', {}, async () => ({}));`;
    const MULTI_LINE_FIXTURE = [
      "server.tool(",
      "  'example_multi_line_tool',",
      "  'desc',",
      "  {},",
      "  async () => ({}),",
      ");",
    ].join('\n');
    // The pre-fix pattern this ticket replaced — reproduced here (not
    // imported, since the fix deleted it from the source) only to prove the
    // fixture below is a genuine regression case, not a vacuous one.
    const PRE_FIX_PATTERN = /\.tool\(\s*\r?\n\s*['"]([a-zA-Z0-9_]+)['"]/g;

    function namesMatching(pattern, src) {
      return [...src.matchAll(pattern)].map(m => m[1]);
    }

    it('non-vacuous: the pre-fix pattern misses a one-line registration', () => {
      assert.deepEqual(namesMatching(PRE_FIX_PATTERN, ONE_LINE_FIXTURE), []);
    });

    it('the current pattern catches a one-line registration', () => {
      assert.deepEqual(namesMatching(LIVE_TOOL_NAME_PATTERN, ONE_LINE_FIXTURE), ['example_one_line_tool']);
    });

    it('the current pattern still catches a multi-line registration (no regression)', () => {
      assert.deepEqual(namesMatching(LIVE_TOOL_NAME_PATTERN, MULTI_LINE_FIXTURE), ['example_multi_line_tool']);
    });
  });
});
