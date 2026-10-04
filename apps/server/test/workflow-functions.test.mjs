import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { DataSource } from 'typeorm';
import { WorkflowFunction } from '../dist/entities/WorkflowFunction.js';
import { WorkflowFunctionRun } from '../dist/entities/WorkflowFunctionRun.js';
import { WorkflowFunctionsService } from '../dist/modules/workflow-functions/workflow-functions.service.js';

describe('Workflow Functions', () => {
  let dataSource;
  let service;

  before(async () => {
    dataSource = new DataSource({
      type: 'sqljs',
      entities: [WorkflowFunction, WorkflowFunctionRun],
      synchronize: true,
      logging: false,
    });
    await dataSource.initialize();
    service = new WorkflowFunctionsService(dataSource, {
      dispatch: async () => {
        throw new Error('not used');
      },
    });
    await service.onModuleInit();
  });

  after(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('resolves global Functions and lets workspace definitions override the same key', async () => {
    const globalRows = await service.list(null);
    assert.ok(globalRows.some(row => row.key === 'system.noop' && row.workspace_id === null));

    await service.create({
      workspace_id: 'workspace-a',
      key: 'system.noop',
      name: 'Workspace echo',
      executor_type: 'builtin',
      config: { handler: 'system.noop' },
    });

    const workspaceRows = await service.list('workspace-a');
    const resolved = workspaceRows.find(row => row.key === 'system.noop');
    assert.equal(resolved.workspace_id, 'workspace-a');
    assert.equal(resolved.name, 'Workspace echo');

    const otherWorkspaceRows = await service.list('workspace-b');
    assert.equal(otherWorkspaceRows.find(row => row.key === 'system.noop').workspace_id, null);
  });

  // prompt_audit.measure_effect computed its report from board columns and was
  // retired with boards. A database seeded before that still holds its global
  // built-in row — users cannot delete built-ins, so boot must, or the Function
  // stays listed with no handler behind it and every execute() fails.
  it('deletes a previously seeded retired built-in on boot instead of listing a Function with no handler', async () => {
    const repo = dataSource.getRepository(WorkflowFunction);
    const source = await repo.findOneByOrFail({ key: 'system.noop', workspace_id: null });
    await repo.save(repo.create({
      ...source,
      id: undefined,
      key: 'prompt_audit.measure_effect',
      name: 'Prompt audit effect (retired)',
      builtin: true,
      workspace_id: null,
    }));
    assert.ok((await service.list(null)).some(row => row.key === 'prompt_audit.measure_effect'), 'precondition: stale seeded row present');

    await service.onModuleInit();

    const rows = await service.list(null);
    assert.equal(rows.some(row => row.key === 'prompt_audit.measure_effect'), false);
    assert.ok(rows.some(row => row.key === 'system.noop'), 'live built-ins are still seeded');
  });

  it('deduplicates key-idempotent executions and persists structured output', async () => {
    const fn = await service.create({
      workspace_id: 'workspace-a',
      key: 'test.idempotent',
      name: 'Idempotent echo',
      executor_type: 'builtin',
      config: { handler: 'system.noop' },
      idempotency_mode: 'key',
    });

    const first = await service.execute({
      functionId: fn.id,
      workspaceId: 'workspace-a',
      inputs: { value: 42 },
      idempotencyKey: 'same-operation',
    });
    const second = await service.execute({
      functionId: fn.id,
      workspaceId: 'workspace-a',
      inputs: { value: 999 },
      idempotencyKey: 'same-operation',
    });

    assert.equal(first.status, 'succeeded');
    assert.deepEqual(first.outputs, { value: 42 });
    assert.equal(second.id, first.id);
    assert.equal(second.deduplicated, true);
  });

  it('executes a pipeline as child Function runs with parent linkage', async () => {
    const pipeline = await service.create({
      workspace_id: 'workspace-a',
      key: 'test.pipeline',
      name: 'Echo pipeline',
      executor_type: 'pipeline',
      config: {
        steps: [
          { function_key: 'system.noop', inputs: { step: 1 } },
          { function_key: 'system.noop', inputs: { step: 2 } },
        ],
      },
    });

    const run = await service.execute({
      functionId: pipeline.id,
      workspaceId: 'workspace-a',
      inputs: { shared: true },
    });
    assert.equal(run.status, 'succeeded');
    assert.equal(run.outputs.steps.length, 2);
    const children = await dataSource.getRepository(WorkflowFunctionRun).find({
      where: { parent_run_id: run.id },
    });
    assert.equal(children.length, 2);
    assert.ok(children.every(child => child.status === 'succeeded'));
  });

  it('rejects execution across workspace boundaries', async () => {
    const fn = await service.create({
      workspace_id: 'workspace-a',
      key: 'test.private',
      name: 'Private Function',
      executor_type: 'builtin',
      config: { handler: 'system.noop' },
    });
    await assert.rejects(
      service.execute({ functionId: fn.id, workspaceId: 'workspace-b', inputs: {} }),
      /different workspace/,
    );
  });

  // 티켓 f177aeb3 H1 — executor_type:'http'는 config.url/headers를 워크스페이스
  // 스코프 에이전트가 자유롭게 지정하는 Function 정의에서 그대로 받는다. 이전에는
  // fetch()에 곧장 넘겨 응답 본문 전체를 반환했으므로(full-read SSRF), 실제
  // 로컬 리스너를 겨냥해도 이 실행 경로 전체(execute → executeOnce → guardedFetch)가
  // 거부하고 run.status가 'failed'로 남는지 wire 경로로 검증한다.
  it('rejects the http executor when config.url targets a loopback listener (SSRF guard)', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ secret: 'should-never-be-returned' }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const fn = await service.create({
        workspace_id: 'workspace-a',
        key: 'test.ssrf-loopback',
        name: 'SSRF loopback probe',
        executor_type: 'http',
        config: { url: `http://127.0.0.1:${port}/secret`, method: 'GET' },
      });
      await assert.rejects(
        service.execute({ functionId: fn.id, workspaceId: 'workspace-a', inputs: {} }),
        /not an allowed outbound target/,
      );
      const runs = await dataSource.getRepository(WorkflowFunctionRun).find({ where: { function_id: fn.id } });
      assert.equal(runs.length, 1);
      assert.equal(runs[0].status, 'failed');
      assert.match(runs[0].error_message, /not an allowed outbound target/);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('rejects the http executor for a cloud-metadata-style link-local target', async () => {
    const fn = await service.create({
      workspace_id: 'workspace-a',
      key: 'test.ssrf-metadata',
      name: 'SSRF metadata probe',
      executor_type: 'http',
      config: { url: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/', method: 'GET' },
    });
    await assert.rejects(
      service.execute({ functionId: fn.id, workspaceId: 'workspace-a', inputs: {} }),
      /not an allowed outbound target/,
    );
  });
});
