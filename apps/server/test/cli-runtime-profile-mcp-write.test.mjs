// 티켓 0d2c53bf — MCP `update_agent` / `update_board` 에 cli_runtime_profile
// 쓰기 필드가 없어서 워크스페이스 기본 backend/runtime 프로파일을 opt-out
// (`'none'`) 으로 핀하려면 REST/웹 UI 개입이 항상 필요했던 문제의 회귀
// 테스트. 검증 로직은 새 헬퍼 validateCliRuntimeProfileSelection
// (apps/server/src/common/claude-backend-registry.ts) 이 agents.controller.ts
// PATCH 핸들러(:724-733)와 동일한 판정을 내리는지, 그리고 MCP 두 툴이 그
// 헬퍼를 실제로 호출해 저장/거부하는지를 확인한다.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(
  os.tmpdir(),
  `awb-cli-runtime-profile-mcp-write-${process.pid}-${Date.now()}.db`,
);
process.env.NODE_ENV = 'test';

let ds;
let registerAgentTools;
let registerBoardTools;
let BoardsController;
let resolveClaudeBackendProfileForDispatch;
let sessionStore;
let tools; // name -> { handler }
let manager;
let workspace;
let profile;
let callerSessionId;
let releaseCallerSession;

function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

// update_agent is gated by requireWorkspaceScopedFullAccess (ticket
// d6b56237) — a DB-backed, full-scope caller bound to a genuinely GLOBAL
// Agent (workspace_id null) may reach any workspace. update_board has no
// such gate, so this extra is harmless there.
function agentExtra() {
  return { sessionId: callerSessionId };
}

before(async () => {
  const { DataSource } = await import('typeorm');
  const { buildDataSourceOptions } = await import('../dist/db.js');
  ({ registerAgentTools } = await import('../dist/modules/mcp/tools/agent-tools.js'));
  ({ registerBoardTools } = await import('../dist/modules/mcp/tools/board-tools.js'));
  ({ BoardsController } = await import('../dist/modules/boards/boards.controller.js'));
  ({ resolveClaudeBackendProfileForDispatch } = await import('../dist/common/claude-backend-registry.js'));
  ({ sessionStore } = await import('../dist/modules/mcp/internal/session-store.js'));

  ds = new DataSource(buildDataSourceOptions());
  await ds.initialize();

  const noopLogger = { info() {}, warn() {}, error() {} };
  tools = {};
  const fakeServer = {
    tool(name, description, schema, handler) {
      tools[name] = { description, schema, handler };
    },
  };
  registerAgentTools(fakeServer, { dataSource: ds, logger: noopLogger });
  registerBoardTools(fakeServer, { dataSource: ds });

  manager = await ds.getRepository('Agent').save(ds.getRepository('Agent').create({
    name: 'Profile write manager',
    type: 'manager',
    workspace_id: null,
  }));
  workspace = await ds.getRepository('Workspace').save(ds.getRepository('Workspace').create({
    name: 'cli_runtime_profile MCP write workspace',
  }));
  profile = await ds.getRepository('ClaudeBackendProfile').save(
    ds.getRepository('ClaudeBackendProfile').create({
      id: randomUUID(),
      name: 'Workspace default vLLM',
      protocol: 'anthropic-compatible',
      base_url: 'http://vllm.invalid:8000',
      model: 'qwen3-coder-next',
      config: '{}',
    }),
  );
  await ds.getRepository('WorkspaceClaudeBackendProfile').save(
    ds.getRepository('WorkspaceClaudeBackendProfile').create({
      workspace_id: workspace.id,
      profile_id: profile.id,
    }),
  );
  workspace.claude_backend_profiles_migrated = true;
  workspace.default_claude_backend_profile_id = profile.id;
  await ds.getRepository('Workspace').save(workspace);

  callerSessionId = `session-${randomUUID()}`;
  const transport = { close: async () => {} };
  sessionStore.register(callerSessionId, transport, {}, {
    agentId: manager.id,
    scope: 'full',
    source: 'db',
  });
  releaseCallerSession = () => sessionStore.remove(callerSessionId);
});

after(async () => {
  releaseCallerSession?.();
  if (ds?.isInitialized) await ds.destroy();
});

async function makeAgent(overrides = {}) {
  const repo = ds.getRepository('Agent');
  return repo.save(repo.create({
    name: `agent-${Math.random().toString(36).slice(2, 8)}`,
    type: 'claude',
    workspace_id: workspace.id,
    manager_agent_id: manager.id,
    // update_agent's post-write runtime_config re-validation (unrelated to
    // cli_runtime_profile) requires a valid config on every save — supply
    // the minimal shape so these agents pass it uneventfully.
    runtime_config: { strategy: 'single', permission_mode: 'trusted' },
    ...overrides,
  }));
}

async function makeBoard(overrides = {}) {
  const repo = ds.getRepository('Board');
  return repo.save(repo.create({
    name: `board-${Math.random().toString(36).slice(2, 8)}`,
    workspace_id: workspace.id,
    routing_config: '{}',
    ...overrides,
  }));
}

describe('MCP cli_runtime_profile write (ticket 0d2c53bf)', () => {
  it("update_agent stores an explicit 'none' opt-out", async () => {
    const agent = await makeAgent();
    const result = await tools.update_agent.handler(
      { agent_id: agent.id, cli_runtime_profile: 'none' },
      agentExtra(),
    );
    assert.equal(result.isError, undefined);
    const stored = await ds.getRepository('Agent').findOneByOrFail({ id: agent.id });
    assert.equal(stored.cli_runtime_profile, 'none');
  });

  it("update_board stores an explicit 'none' opt-out", async () => {
    const board = await makeBoard();
    const result = await tools.update_board.handler(
      { board_id: board.id, cli_runtime_profile: 'none' },
      {},
    );
    assert.equal(result.isError, undefined);
    const stored = await ds.getRepository('Board').findOneByOrFail({ id: board.id });
    assert.equal(stored.cli_runtime_profile, 'none');
  });

  it("agent-level 'none' stops dispatch from inheriting the workspace default (success criterion 4)", async () => {
    const agent = await makeAgent();
    await tools.update_agent.handler({ agent_id: agent.id, cli_runtime_profile: 'none' }, agentExtra());
    const stored = await ds.getRepository('Agent').findOneByOrFail({ id: agent.id });

    const withoutOptOut = await resolveClaudeBackendProfileForDispatch(ds, workspace, [
      { source: 'run', value: null },
      { source: 'agent', value: null },
      { source: 'board', value: null },
    ]);
    assert.equal(withoutOptOut?.id, profile.id, 'sanity: workspace default resolves when nothing pins it');

    const withOptOut = await resolveClaudeBackendProfileForDispatch(ds, workspace, [
      { source: 'run', value: null },
      { source: 'agent', value: stored.cli_runtime_profile },
      { source: 'board', value: null },
    ]);
    assert.equal(withOptOut, null, "agent 'none' must not inherit the workspace default");
  });

  it("board-level 'none' stops dispatch from inheriting the workspace default (success criterion 4)", async () => {
    const board = await makeBoard();
    await tools.update_board.handler({ board_id: board.id, cli_runtime_profile: 'none' }, {});
    const stored = await ds.getRepository('Board').findOneByOrFail({ id: board.id });

    const withOptOut = await resolveClaudeBackendProfileForDispatch(ds, workspace, [
      { source: 'run', value: null },
      { source: 'agent', value: null },
      { source: 'board', value: stored.cli_runtime_profile },
    ]);
    assert.equal(withOptOut, null, "board 'none' must not inherit the workspace default");
  });

  it('rejects a nonexistent profile id and leaves the stored value unchanged (fail-closed)', async () => {
    const agent = await makeAgent({ cli_runtime_profile: 'none' });
    const board = await makeBoard({ cli_runtime_profile: 'none' });

    const agentResult = await tools.update_agent.handler(
      { agent_id: agent.id, cli_runtime_profile: 'does-not-exist' },
      agentExtra(),
    );
    assert.equal(agentResult.isError, true);
    const boardResult = await tools.update_board.handler(
      { board_id: board.id, cli_runtime_profile: 'does-not-exist' },
      {},
    );
    assert.equal(boardResult.isError, true);

    assert.equal(
      (await ds.getRepository('Agent').findOneByOrFail({ id: agent.id })).cli_runtime_profile,
      'none',
    );
    assert.equal(
      (await ds.getRepository('Board').findOneByOrFail({ id: board.id })).cli_runtime_profile,
      'none',
    );
  });

  it('null clears the pin back to inherit; empty string is accepted the same way REST accepts it', async () => {
    const agent = await makeAgent({ cli_runtime_profile: profile.id });
    const nulled = await tools.update_agent.handler(
      { agent_id: agent.id, cli_runtime_profile: null },
      agentExtra(),
    );
    assert.equal(nulled.isError, undefined);
    assert.equal(
      (await ds.getRepository('Agent').findOneByOrFail({ id: agent.id })).cli_runtime_profile,
      null,
    );

    // Empty string is not a valid profile id, so it skips the existence
    // check (same short-circuit as agents.controller.ts:730) and is stored
    // as-is — resolveCliRuntimeProfile treats '' the same as 'none' at
    // dispatch time, so this still stops inheritance from proceeding to a
    // stale/foreign selection while remaining byte-identical to the REST
    // PATCH handler's behavior.
    const emptied = await tools.update_agent.handler(
      { agent_id: agent.id, cli_runtime_profile: '' },
      agentExtra(),
    );
    assert.equal(emptied.isError, undefined);
    assert.equal(
      (await ds.getRepository('Agent').findOneByOrFail({ id: agent.id })).cli_runtime_profile,
      '',
    );
  });

  it('validates against the DESTINATION workspace when workspace_id is reassigned in the same call (Step 2 order guard)', async () => {
    const otherWorkspace = await ds.getRepository('Workspace').save(
      ds.getRepository('Workspace').create({ name: 'Other workspace (no profile link)' }),
    );
    const agent = await makeAgent();

    // profile.id is authoritative in `workspace` but NOT linked to
    // otherWorkspace — if validation ran against the agent's PRE-update
    // workspace, this would wrongly succeed.
    const result = await tools.update_agent.handler(
      { agent_id: agent.id, workspace_id: otherWorkspace.id, cli_runtime_profile: profile.id },
      agentExtra(),
    );
    assert.equal(result.isError, true);
    const stored = await ds.getRepository('Agent').findOneByOrFail({ id: agent.id });
    assert.equal(stored.cli_runtime_profile, null, 'rejected profile must not have been saved');
  });

  it('REST PATCH /boards/:id and the MCP update_board tool reach the same verdict for a bogus profile id', async () => {
    const board = await makeBoard();
    const controller = new BoardsController(
      ds.getRepository('Board'),
      ds.getRepository('BoardColumn'),
      ds.getRepository('Ticket'),
      ds.getRepository('BoardLesson'),
      ds,
      undefined, // promptTemplatesService — untouched by a cli_runtime_profile-only body
      undefined, // agentWorkload
      undefined, // workspaceMove
      undefined, // ticketRoleAssignments
    );

    const res = fakeRes();
    await controller.update(board.id, { cli_runtime_profile: 'does-not-exist' }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /cli_runtime_profile "does-not-exist" does not exist in workspace/);

    const mcpResult = await tools.update_board.handler(
      { board_id: board.id, cli_runtime_profile: 'does-not-exist' },
      {},
    );
    assert.equal(mcpResult.isError, true);
    const mcpBody = JSON.parse(mcpResult.content[0].text);
    assert.equal(mcpBody.error, res.body.error, 'REST and MCP must return the identical error message');

    const stored = await ds.getRepository('Board').findOneByOrFail({ id: board.id });
    assert.equal(stored.cli_runtime_profile, null, 'both rejected paths must leave the board unchanged');
  });
});
