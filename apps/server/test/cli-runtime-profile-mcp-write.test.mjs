// 티켓 0d2c53bf — MCP `update_agent` / `update_board` 에 cli_runtime_profile
// 쓰기 필드가 없어서 기본 backend/runtime 프로파일을 opt-out
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
let tools; // name -> { handler }
let workspace;
let profile;

function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

before(async () => {
  const { DataSource } = await import('typeorm');
  const { buildDataSourceOptions } = await import('../dist/db.js');
  ({ registerAgentTools } = await import('../dist/modules/mcp/tools/agent-tools.js'));
  ({ registerBoardTools } = await import('../dist/modules/mcp/tools/board-tools.js'));
  ({ BoardsController } = await import('../dist/modules/boards/boards.controller.js'));
  ({ resolveClaudeBackendProfileForDispatch } = await import('../dist/common/claude-backend-registry.js'));

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

  workspace = await ds.getRepository('Workspace').save(ds.getRepository('Workspace').create({
    name: 'cli_runtime_profile MCP write workspace',
  }));
  profile = await ds.getRepository('ClaudeBackendProfile').save(
    ds.getRepository('ClaudeBackendProfile').create({
      id: randomUUID(),
      name: 'Global default vLLM',
      protocol: 'anthropic-compatible',
      base_url: 'http://vllm.invalid:8000',
      model: 'qwen3-coder-next',
      config: '{}',
    }),
  );
  // 프로필은 인스턴스 전역이라 워크스페이스 배정이 없다(티켓 e616dbfc).
  // 상속의 마지막 단계는 SystemSetting 의 전역 기본값 하나뿐이다.
  await ds.getRepository('SystemSetting').save(
    ds.getRepository('SystemSetting').create({
      key: 'claude_backend_profiles.default',
      value: profile.id,
      description: 'Instance default Claude backend profile',
      is_secret: 0,
    }),
  );

});

after(async () => {
  if (ds?.isInitialized) await ds.destroy();
});

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
  // P4c-4: update_agent 삭제 — agent 핀 테스트 제거.
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

  it("board-level 'none' stops dispatch from inheriting the global default (success criterion 4)", async () => {
    const board = await makeBoard();
    await tools.update_board.handler({ board_id: board.id, cli_runtime_profile: 'none' }, {});
    const stored = await ds.getRepository('Board').findOneByOrFail({ id: board.id });

    const withOptOut = await resolveClaudeBackendProfileForDispatch(ds, [
      { source: 'run', value: null },
      { source: 'agent', value: null },
      { source: 'board', value: stored.cli_runtime_profile },
    ]);
    assert.equal(withOptOut, null, "board 'none' must not inherit the global default");
  });

  it('rejects a nonexistent profile id and leaves the stored value unchanged (fail-closed)', async () => {
    const board = await makeBoard({ cli_runtime_profile: 'none' });

    const boardResult = await tools.update_board.handler(
      { board_id: board.id, cli_runtime_profile: 'does-not-exist' },
      {},
    );
    assert.equal(boardResult.isError, true);

    assert.equal(
      (await ds.getRepository('Board').findOneByOrFail({ id: board.id })).cli_runtime_profile,
      'none',
    );
  });

  // P4c-4: agent 핀 테스트 2건 삭제 (update_agent 삭제). board 핀은 위에서 커버.
  it('전역 기본값이 비어 있으면 아무 핀도 없을 때 null 로 해석한다', async () => {
    const settings = ds.getRepository('SystemSetting');
    const saved = await settings.findOneByOrFail({ key: 'claude_backend_profiles.default' });
    try {
      await settings.update({ key: 'claude_backend_profiles.default' }, { value: '' });
      const resolved = await resolveClaudeBackendProfileForDispatch(ds, [
        { source: 'run', value: null },
        { source: 'agent', value: null },
        { source: 'board', value: null },
      ]);
      assert.equal(resolved, null, '상속 체인이 모두 비면 프로필 없이 디스패치한다');
    } finally {
      await settings.update({ key: 'claude_backend_profiles.default' }, { value: saved.value });
    }
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
    assert.match(res.body.error, /cli_runtime_profile "does-not-exist" does not exist$/);

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
