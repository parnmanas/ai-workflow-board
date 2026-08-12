import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DataSource } from 'typeorm';
import { WorkflowFunction } from '../dist/entities/WorkflowFunction.js';
import { WorkflowFunctionRun } from '../dist/entities/WorkflowFunctionRun.js';
import { WorkflowFunctionsService } from '../dist/modules/workflow-functions/workflow-functions.service.js';
import { Board } from '../dist/entities/Board.js';
import { BoardColumn } from '../dist/entities/BoardColumn.js';
import { Ticket } from '../dist/entities/Ticket.js';
import { Comment } from '../dist/entities/Comment.js';
import { ActivityLog } from '../dist/entities/ActivityLog.js';
import { Workspace } from '../dist/entities/Workspace.js';
import * as entitiesBarrel from '../dist/entities/index.js';

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

  it('excludes legacy Board-scoped Function rows from list() regardless of the _boardId argument', async () => {
    // board_id는 65adf0b(카탈로그 board→workspace 승격)에서 폐지된 레거시 호환 컬럼으로,
    // 부트 마이그레이션 이후에는 항상 NULL이어야 한다(WorkflowFunction 엔티티 주석 참고).
    // list()는 만에 하나 남아있는 board-scoped 행도 _boardId 인자 값과 무관하게 항상 제외해야 한다.
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
    assert.equal(boardRows.some(row => row.key === 'test.board-only'), false);
    assert.ok(boardRows.every(row => row.board_id === null));
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

// ticket f3fc298a — agent가 production DB 자격증명 없이 MCP(execute_function)로
// scripts/measure-prompt-audit-effect.mjs와 동일한 측정을 수행할 수 있게 한다.
// 이 builtin은 위 Function-only 스위트가 일부러 생략한 전체
// Board/Ticket/Comment/ActivityLog 메타데이터가 필요해 별도 DataSource/describe
// 블록으로 분리했다. 이건 얇은 wiring 테스트일 뿐 — 산식 자체는
// test/measure-prompt-audit-effect.test.mjs가 고정한다.
describe('Workflow Functions — prompt_audit.measure_effect builtin', () => {
  let dataSource;
  let service;

  before(async () => {
    // Board/Ticket은 이 몇 개 클래스 밖까지 뻗는 관계(예: Board->Workspace)를
    // 가진다 — TypeORM은 관련된 모든 엔티티의 메타데이터가 함께 등록되어
    // 있어야 하므로, 관계를 하나씩 "Entity metadata ... was not found"로
    // 맞닥뜨리며 손으로 골라내는 대신 전체 barrel(db.ts의
    // buildDataSourceOptions()가 쓰는 것과 동일)을 그대로 쓴다.
    dataSource = new DataSource({
      type: 'sqljs',
      entities: Object.values(entitiesBarrel),
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

  it('is seeded as a global builtin Function', async () => {
    const rows = await service.list(null);
    const fn = rows.find(row => row.key === 'prompt_audit.measure_effect');
    assert.ok(fn, 'prompt_audit.measure_effect must be auto-seeded like the other builtins');
    assert.equal(fn.executor_type, 'builtin');
    assert.equal(fn.risk_level, 'read');
    assert.equal(fn.approval_policy, 'none');
  });

  it('executes without a ticket_id and returns a well-formed report scoped to the caller workspace', async () => {
    const boardRepo = dataSource.getRepository(Board);
    const colRepo = dataSource.getRepository(BoardColumn);
    const ticketRepo = dataSource.getRepository(Ticket);

    const board = await boardRepo.save(boardRepo.create({ name: 'MeasureBuiltinFixture' }));
    const done = await colRepo.save(colRepo.create({ board_id: board.id, name: 'Done', position: 1, kind: 'terminal', is_terminal: true }));
    const wsId = `ws-builtin-${Date.now()}`;
    const inWindow = new Date(Date.now() - 60_000);
    await ticketRepo.save(ticketRepo.create({ title: 'X', column_id: done.id, workspace_id: wsId, created_at: inWindow, terminal_entered_at: inWindow }));
    // 다른 workspace의 티켓이 아래 wsId 리포트로 새어 들어가면 안 된다.
    await ticketRepo.save(ticketRepo.create({ title: 'Y', column_id: done.id, workspace_id: `${wsId}-other`, created_at: inWindow, terminal_entered_at: inWindow }));

    const since = new Date(inWindow.getTime() - 60_000).toISOString();
    const until = new Date(inWindow.getTime() + 60_000).toISOString();
    const run = await service.execute({
      functionKey: 'prompt_audit.measure_effect',
      workspaceId: wsId,
      inputs: { since, until },
    });

    assert.equal(run.status, 'succeeded');
    assert.equal(run.outputs.workspace_id, wsId);
    assert.equal(run.outputs.window.since, since);
    assert.equal(run.outputs.window.until, until);
    assert.deepEqual(run.outputs.completion_rate, { created: 1, completed: 1, rate: 1 }, 'only the wsId ticket counts, not the other workspace one');
  });

  it('rejects a non-ISO since/until input instead of silently computing against Invalid Date', async () => {
    await assert.rejects(
      service.execute({
        functionKey: 'prompt_audit.measure_effect',
        workspaceId: `ws-invalid-${Date.now()}`,
        inputs: { since: 'not-a-date' },
      }),
      /ISO 8601/,
    );
  });

  // maturation_buffer_hours 파라미터 자체의 산식 검증(버퍼가 completion_rate를
  // 어떻게 바꾸는지)은 measure-prompt-audit-effect.test.mjs가 고정한다 — 여기는
  // executePromptAuditMeasureEffect()의 Number.isFinite() 검증 분기만 확인하는
  // 얇은 wiring 테스트다(ticket c936cee7). 문자열 등 typeof가 다른 입력은
  // execute()의 스키마 검증(validateInputs, typeof number 체크)이 먼저 막아
  // 핸들러까지 도달하지 않으므로, 그 스키마 체크를 typeof로는 통과하지만
  // 산술에 쓸 수 없는 Infinity로 핸들러 자체의 방어 분기를 겨냥한다.
  it('rejects a non-finite maturation_buffer_hours input that passes the number typeof check', async () => {
    await assert.rejects(
      service.execute({
        functionKey: 'prompt_audit.measure_effect',
        workspaceId: `ws-invalid-buffer-${Date.now()}`,
        inputs: { maturation_buffer_hours: Infinity },
      }),
      /maturation_buffer_hours must be a number/,
    );
  });

  // Review blocker (ticket c936cee7): the handler/CLI used to accept a
  // negative maturation_buffer_hours and let computeReport() silently clamp
  // it to 0 via Math.max(0, x) instead of rejecting the bad input outright.
  // The Function's input_schema now declares `minimum: 0`, enforced generically
  // by validateInputs() — this pins that the schema-level rejection actually
  // fires (not just documents the constraint) before the handler ever runs.
  it('rejects a negative maturation_buffer_hours input at the schema boundary instead of silently clamping to 0', async () => {
    await assert.rejects(
      service.execute({
        functionKey: 'prompt_audit.measure_effect',
        workspaceId: `ws-negative-buffer-${Date.now()}`,
        inputs: { maturation_buffer_hours: -1 },
      }),
      /must be >= 0/,
    );
  });

  // Review blocker (ticket c936cee7): a huge-but-finite buffer (e.g.
  // Number.MAX_VALUE) passes both the typeof and minimum>=0 checks, but
  // `* 60 * 60 * 1000` overflows to Infinity inside computeReport() and used
  // to build an Invalid Date cutoff that silently excluded every ticket from
  // completion_rate instead of erroring. The handler now converts
  // computeReport()'s thrown Error into a proper 400 instead of a bare 500.
  it('rejects an out-of-Date-range maturation_buffer_hours input instead of silently excluding every ticket', async () => {
    await assert.rejects(
      service.execute({
        functionKey: 'prompt_audit.measure_effect',
        workspaceId: `ws-huge-buffer-${Date.now()}`,
        inputs: { maturation_buffer_hours: Number.MAX_VALUE },
      }),
      /out-of-range cutoff date/,
    );
  });

  // Regression (ec498050/f3fc298a review): BoardColumn has no reliable own
  // workspace_id (columns.controller.ts never sets it), so the active/review/
  // merging/terminal column-kind lookups in computeReport() must be scoped
  // through Board.workspace_id, NOT queried globally across every workspace.
  // Column-kind matching against ActivityLog is by NAME (see
  // prompt-audit-report.ts doc comment), so a same-named column belonging to
  // a DIFFERENT workspace can leak its `kind` into this workspace's matching
  // if the scoping is missing. Here workspace B has an active-kind column
  // named "Conflict"; workspace A's own "Conflict" column is unclassified
  // (kind=''). A ticket move into workspace A's "Conflict" column must NOT
  // be counted as an active-column entry.
  it('does not let a same-named active-kind column in another workspace pollute start_rate', async () => {
    const workspaceRepo = dataSource.getRepository(Workspace);
    const boardRepo = dataSource.getRepository(Board);
    const colRepo = dataSource.getRepository(BoardColumn);
    const ticketRepo = dataSource.getRepository(Ticket);
    const activityRepo = dataSource.getRepository(ActivityLog);

    // Board.workspace_id is a real FK to Workspace (unlike Ticket.workspace_id,
    // which is a bare indexed string column) — real Workspace rows are required.
    const wsA = await workspaceRepo.save(workspaceRepo.create({ name: 'ConflictWorkspaceA' }));
    const wsB = await workspaceRepo.save(workspaceRepo.create({ name: 'ConflictWorkspaceB' }));
    const wsId = wsA.id;

    const boardA = await boardRepo.save(boardRepo.create({ name: 'ConflictFixtureA', workspace_id: wsA.id }));
    const conflictColA = await colRepo.save(colRepo.create({ board_id: boardA.id, name: 'Conflict', position: 1, kind: '' }));

    const boardB = await boardRepo.save(boardRepo.create({ name: 'ConflictFixtureB', workspace_id: wsB.id }));
    await colRepo.save(colRepo.create({ board_id: boardB.id, name: 'Conflict', position: 1, kind: 'active' }));

    const inWindow = new Date(Date.now() - 60_000);
    const ticket = await ticketRepo.save(ticketRepo.create({
      title: 'Z', column_id: conflictColA.id, workspace_id: wsId, created_at: inWindow,
    }));
    await activityRepo.save(activityRepo.create({
      entity_type: 'ticket', entity_id: ticket.id, ticket_id: ticket.id, action: 'moved', field_changed: 'column',
      old_value: '', new_value: 'Conflict', actor_id: 'system', actor_name: 'test', created_at: inWindow,
    }));

    const since = new Date(inWindow.getTime() - 60_000).toISOString();
    const until = new Date(inWindow.getTime() + 60_000).toISOString();
    const run = await service.execute({
      functionKey: 'prompt_audit.measure_effect',
      workspaceId: wsId,
      inputs: { since, until },
    });

    assert.equal(run.status, 'succeeded');
    assert.deepEqual(
      run.outputs.start_rate,
      { entered_active: 0, also_advanced: 0, rate: null },
      'workspace B\'s active-kind "Conflict" column must not classify workspace A\'s non-active "Conflict" column as active',
    );
  });
});
