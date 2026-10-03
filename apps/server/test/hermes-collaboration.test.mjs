import assert from 'node:assert/strict';
import test from 'node:test';
import 'reflect-metadata';

import { ChildRunService } from '../dist/modules/agents/child-run.service.js';
import { registerSkillProposalTools } from '../dist/modules/mcp/tools/skill-proposal-tools.js';
import { sessionStore } from '../dist/modules/mcp/internal/session-store.js';

function childRepository() {
  const rows = [];
  return {
    rows,
    async findOne({ where }) {
      return rows.find((row) =>
        row.workspace_id === where.workspace_id
        && row.parent_run_id === where.parent_run_id
        && row.runtime_child_id === where.runtime_child_id,
      ) || null;
    },
    async find({ where }) {
      return rows.filter((row) =>
        row.workspace_id === where.workspace_id
        && row.parent_run_id === where.parent_run_id,
      );
    },
    create(value) {
      return { id: `child-${rows.length + 1}`, ...value };
    },
    async save(value) {
      if (!rows.includes(value)) rows.push(value);
      return value;
    },
  };
}

test('ChildRuns remain bounded, attributed, sanitized and idempotent under the parent run', async () => {
  const repo = childRepository();
  const service = new ChildRunService(repo);
  const first = await service.start({
    workspaceId: 'ws-1',
    parentRunId: 'ticket:t-1:reviewer',
    parentAgentId: 'agent-1',
    childId: 'hermes-child-1',
    strategy: 'delegated',
    depth: 99,
    title: `Research\u0000${'x'.repeat(500)}`,
    metadata: {
      access_token: 'secret',
      note: 'safe',
      ignored: { deeply: 'nested' },
    },
  });
  const duplicate = await service.start({
    workspaceId: 'ws-1',
    parentRunId: 'ticket:t-1:reviewer',
    parentAgentId: 'agent-1',
    childId: 'hermes-child-1',
    strategy: 'delegated',
  });
  assert.equal(duplicate.id, first.id);
  assert.equal(first.depth, 8);
  assert.equal(first.title.length, 240);
  assert.equal(first.runtime_metadata.access_token, '[REDACTED]');
  assert.equal(Object.hasOwn(first.runtime_metadata, 'ignored'), false);

  const finished = await service.finish({
    workspaceId: 'ws-1',
    parentRunId: 'ticket:t-1:reviewer',
    childId: 'hermes-child-1',
    status: 'completed',
    summary: 'done',
  });
  assert.equal(finished.status, 'completed');
  assert.equal(finished.summary, 'done');
  assert.ok(finished.finished_at instanceof Date);
});

test('runtime MCP exposes proposal-only skill learning with server-bound attribution', async (t) => {
  let registered;
  const fakeServer = {
    tool(name, description, schema, handler) {
      if (name === 'propose_skill_change') {
        registered = { name, description, schema, handler };
      }
    },
  };
  const proposals = [];
  // P4c-4: 호출자 정체성은 Host 행 또는 ApiKey 링크로 해소한다 (Agent 테이블 없음).
  const childUuid = '11111111-1111-4111-8111-111111111111';
  const repositories = {
    RuntimeHost: {
      // 링크 해소는 연결된 Host 행까지 확인한다 (authz.resolveCallerIdentityRow).
      async findOne({ where } = {}) {
        if (where?.id && where.id !== 'host-1') return null;
        return { id: 'host-1', name: 'host', workspace_id: 'ws-1' };
      },
    },
    ApiKey: {
      async findOne() {
        return { agent_id: childUuid, host_id: 'host-1', workspace_id: 'ws-1' };
      },
      // resolveCallerIdentityRow 는 host 바인딩 우선 조회(find)다.
      async find() {
        return [{ agent_id: childUuid, host_id: 'host-1', workspace_id: 'ws-1' }];
      },
    },
    Skill: {
      async findOne() {
        return { id: 'skill-1', workspace_id: 'ws-1' };
      },
    },
    SkillProposal: {
      create(value) {
        return { id: 'proposal-1', ...value };
      },
      async save(value) {
        proposals.push(value);
        return value;
      },
    },
  };
  const context = {
    dataSource: {
      getRepository(entity) {
        return repositories[entity.name];
      },
    },
  };
  registerSkillProposalTools(fakeServer, context);
  assert.ok(registered);
  assert.match(registered.description, /never publishes/i);

  const transport = { close: async () => {} };
  sessionStore.register('runtime-session', transport, {}, {
    agentId: childUuid,
    source: 'db',
    clientType: 'runtime-child',
    runtimeRunId: 'ticket:t-1:reviewer',
    executionStrategy: 'delegated',
  });
  t.after(() => sessionStore.remove('runtime-session'));

  const result = await registered.handler({
    skill_id: 'skill-1',
    title: 'Improve review',
    body: '# Review\nCheck tests.\n',
    support_files: [],
  }, { sessionId: 'runtime-session' });
  assert.equal(result.isError, undefined);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].status, 'pending');
  assert.equal(proposals[0].source_agent_id, childUuid);
  assert.equal(proposals[0].source_run_id, 'ticket:t-1:reviewer');

  const unauthorized = await registered.handler({
    title: 'No runtime',
    body: 'body',
    support_files: [],
  }, {});
  assert.equal(unauthorized.isError, true);
  assert.equal(proposals.length, 1);
});
