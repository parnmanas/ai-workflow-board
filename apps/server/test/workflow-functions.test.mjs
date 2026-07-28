import assert from 'node:assert/strict';
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

  it('keeps Board Functions out of a Global + current Workspace management query', async () => {
    const repo = dataSource.getRepository(WorkflowFunction);
    const source = await repo.findOneByOrFail({ key: 'system.noop', workspace_id: null });
    await repo.save(repo.create({
      ...source,
      id: undefined,
      key: 'test.board-only',
      name: 'Board only',
      builtin: false,
      workspace_id: 'workspace-a',
      board_id: 'board-a',
    }));

    const workspaceManagementRows = await service.list('workspace-a', null, true);
    assert.equal(workspaceManagementRows.some(row => row.key === 'test.board-only'), false);
    assert.ok(workspaceManagementRows.every(row => row.board_id === null));

    const boardRows = await service.list('workspace-a', 'board-a', true);
    assert.equal(boardRows.some(row => row.key === 'test.board-only'), true);
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
});
