import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';
import { WorkflowFunction } from '../../entities/WorkflowFunction';
import { WorkflowFunctionRun } from '../../entities/WorkflowFunctionRun';
import { Ticket } from '../../entities/Ticket';
import { BoardColumn } from '../../entities/BoardColumn';
import { ActivityLog } from '../../entities/ActivityLog';
import { Comment } from '../../entities/Comment';
import { ActionsService } from '../actions/actions.service';
import { assertCatalogBoardScope, catalogScopeOf, canUseCatalogItem, normalizeCatalogScope } from '../../common/catalog-scope';
import { Board } from '../../entities/Board';
import { computeReport } from '../../common/prompt-audit-report';

const EXECUTORS = new Set(['builtin', 'pipeline', 'http', 'agent_action']);
const RISK_LEVELS = new Set(['read', 'write', 'destructive', 'high_impact']);
const APPROVAL_POLICIES = new Set(['none', 'admin']);
const IDEMPOTENCY_MODES = new Set(['none', 'key']);
const FUNCTION_KEY_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function parseJson(value: unknown, fallback: any = {}): any {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw httpError(400, 'Invalid JSON value');
  }
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

export interface FunctionExecutionArgs {
  functionId?: string;
  functionKey?: string;
  workspaceId: string;
  boardId?: string;
  ticketId?: string;
  inputs?: Record<string, any>;
  idempotencyKey?: string;
  actorType?: 'user' | 'agent' | 'system';
  actorId?: string;
  actorName?: string;
  actorRole?: string;
  parentRunId?: string;
  depth?: number;
}

const BUILTIN_DEFINITIONS: Array<Partial<WorkflowFunction> & { key: string; name: string }> = [
  {
    key: 'system.noop',
    name: 'No-op / echo',
    description: 'Returns the supplied inputs. Useful for connectivity checks and pipeline composition.',
    executor_type: 'builtin',
    config: stringifyJson({ handler: 'system.noop' }),
    input_schema: stringifyJson({ type: 'object' }),
    output_schema: stringifyJson({ type: 'object' }),
    risk_level: 'read',
  },
  {
    key: 'workflow.ticket_snapshot',
    name: 'Ticket snapshot',
    description: 'Returns the current ticket and column state used as execution evidence.',
    executor_type: 'builtin',
    config: stringifyJson({ handler: 'workflow.ticket_snapshot' }),
    input_schema: stringifyJson({ type: 'object' }),
    output_schema: stringifyJson({ type: 'object' }),
    risk_level: 'read',
  },
  {
    key: 'workflow.verify_children_complete',
    name: 'Verify child tickets complete',
    description: 'Fails closed when any direct child is not in a terminal column.',
    executor_type: 'builtin',
    config: stringifyJson({ handler: 'workflow.verify_children_complete' }),
    input_schema: stringifyJson({ type: 'object' }),
    output_schema: stringifyJson({ type: 'object', required: ['passed'] }),
    risk_level: 'read',
  },
  {
    key: 'workflow.verify_required_functions',
    name: 'Verify required Function runs',
    description: 'Checks that configured Function keys have successful runs for the current ticket.',
    executor_type: 'builtin',
    config: stringifyJson({ handler: 'workflow.verify_required_functions', required_functions: [] }),
    input_schema: stringifyJson({ type: 'object' }),
    output_schema: stringifyJson({ type: 'object', required: ['passed'] }),
    risk_level: 'read',
  },
  {
    key: 'prompt_audit.measure_effect',
    name: 'Prompt audit effect report',
    description: 'Computes the 4 prompt-audit metrics (start_rate, unnecessary_questions, pending_misclassification_rate, completion_rate) over a time window for the calling workspace, via the shared computeReport() formula (see src/common/prompt-audit-report.ts). Read-only. Lets an agent measure production data through MCP instead of needing direct DB credentials (ticket f3fc298a).',
    executor_type: 'builtin',
    config: stringifyJson({ handler: 'prompt_audit.measure_effect' }),
    input_schema: stringifyJson({
      type: 'object',
      properties: {
        since: { type: 'string' },
        until: { type: 'string' },
      },
    }),
    output_schema: stringifyJson({
      type: 'object',
      required: ['window', 'start_rate', 'unnecessary_questions', 'pending_misclassification_rate', 'completion_rate'],
    }),
    risk_level: 'read',
  },
];

@Injectable()
export class WorkflowFunctionsService implements OnModuleInit {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly actionsService: ActionsService,
  ) {}

  async onModuleInit(): Promise<void> {
    const repo = this.dataSource.getRepository(WorkflowFunction);
    for (const definition of BUILTIN_DEFINITIONS) {
      const existing = await repo.findOne({ where: { workspace_id: IsNull(), key: definition.key } });
      if (existing) continue;
      await repo.save(repo.create({
        workspace_id: null,
        board_id: null,
        version: 1,
        description: '',
        executor_type: 'builtin',
        input_schema: '{}',
        output_schema: '{}',
        config: '{}',
        risk_level: 'read',
        idempotency_mode: 'none',
        timeout_ms: 300000,
        max_attempts: 1,
        approval_policy: 'none',
        enabled: true,
        builtin: true,
        ...definition,
      }));
    }
  }

  toView(row: WorkflowFunction): Record<string, any> {
    return {
      ...row,
      scope: catalogScopeOf(row),
      input_schema: parseJson(row.input_schema),
      output_schema: parseJson(row.output_schema),
      config: parseJson(row.config),
    };
  }

  runToView(row: WorkflowFunctionRun): Record<string, any> {
    return {
      ...row,
      inputs: parseJson(row.inputs),
      outputs: parseJson(row.outputs),
      evidence: parseJson(row.evidence),
    };
  }

  async list(
    workspaceId?: string | null,
    includeShadowed = false,
  ): Promise<Record<string, any>[]> {
    const repo = this.dataSource.getRepository(WorkflowFunction);
    if (!workspaceId) {
      const rows = await repo.find({ where: { workspace_id: IsNull(), board_id: IsNull() }, order: { key: 'ASC' } });
      return rows.map(row => this.toView(row));
    }
    let qb = repo.createQueryBuilder('f')
      .where('f.workspace_id IS NULL OR f.workspace_id = :workspaceId', { workspaceId })
      .andWhere('f.board_id IS NULL')
      .orderBy('f.key', 'ASC')
      .addOrderBy('f.workspace_id', 'ASC')
      .addOrderBy('f.board_id', 'ASC');
    const rows = await qb.getMany();
    if (includeShadowed) return rows.map(row => this.toView(row));
    const resolved = new Map<string, WorkflowFunction>();
    for (const row of rows) {
      if (!canUseCatalogItem(row, workspaceId)) continue;
      const rank = row.workspace_id ? 1 : 0;
      const current = resolved.get(row.key);
      const currentRank = current ? (current.workspace_id ? 1 : 0) : -1;
      if (rank > currentRank) resolved.set(row.key, row);
    }
    return Array.from(resolved.values()).sort((a, b) => a.key.localeCompare(b.key)).map(row => this.toView(row));
  }

  async get(id: string): Promise<Record<string, any>> {
    const row = await this.dataSource.getRepository(WorkflowFunction).findOne({ where: { id } });
    if (!row) throw httpError(404, 'Function not found');
    return this.toView(row);
  }

  async resolve(key: string, workspaceId: string): Promise<WorkflowFunction> {
    const repo = this.dataSource.getRepository(WorkflowFunction);
    const local = await repo.findOne({ where: { key, workspace_id: workspaceId, board_id: IsNull() } });
    if (local) return local;
    const global = await repo.findOne({ where: { key, workspace_id: IsNull(), board_id: IsNull() } });
    if (!global) throw httpError(404, `Function "${key}" not found`);
    return global;
  }

  private normalize(input: any, current?: WorkflowFunction): Partial<WorkflowFunction> {
    const key = String(input.key ?? current?.key ?? '').trim().toLowerCase();
    const name = String(input.name ?? current?.name ?? '').trim();
    const executorType = String(input.executor_type ?? current?.executor_type ?? 'builtin');
    const riskLevel = String(input.risk_level ?? current?.risk_level ?? 'read');
    const idempotencyMode = String(input.idempotency_mode ?? current?.idempotency_mode ?? 'none');
    const approvalPolicy = String(input.approval_policy ?? current?.approval_policy ?? 'none');
    if (!FUNCTION_KEY_RE.test(key)) throw httpError(400, 'key must be a lowercase dot/dash/underscore separated identifier');
    if (!name) throw httpError(400, 'name is required');
    if (!EXECUTORS.has(executorType)) throw httpError(400, `executor_type must be one of: ${Array.from(EXECUTORS).join(', ')}`);
    if (!RISK_LEVELS.has(riskLevel)) throw httpError(400, `risk_level must be one of: ${Array.from(RISK_LEVELS).join(', ')}`);
    if (!IDEMPOTENCY_MODES.has(idempotencyMode)) throw httpError(400, 'idempotency_mode must be none or key');
    if (!APPROVAL_POLICIES.has(approvalPolicy)) throw httpError(400, 'approval_policy must be none or admin');
    return {
      key,
      name,
      description: String(input.description ?? current?.description ?? ''),
      executor_type: executorType,
      input_schema: stringifyJson(parseJson(input.input_schema ?? current?.input_schema ?? {})),
      output_schema: stringifyJson(parseJson(input.output_schema ?? current?.output_schema ?? {})),
      config: stringifyJson(parseJson(input.config ?? current?.config ?? {})),
      risk_level: riskLevel,
      idempotency_mode: idempotencyMode,
      timeout_ms: Math.max(1000, Math.min(3600000, Number(input.timeout_ms ?? current?.timeout_ms ?? 300000))),
      max_attempts: Math.max(1, Math.min(10, Number(input.max_attempts ?? current?.max_attempts ?? 1))),
      // Destructive/external high-impact work is always human-gated. Authors
      // may raise the gate for lower-risk Functions, but cannot downgrade it.
      approval_policy: ['destructive', 'high_impact'].includes(riskLevel) ? 'admin' : approvalPolicy,
      enabled: input.enabled ?? current?.enabled ?? true,
    };
  }

  async create(input: any): Promise<Record<string, any>> {
    const repo = this.dataSource.getRepository(WorkflowFunction);
    const scope = normalizeCatalogScope(input);
    await assertCatalogBoardScope(
      async (boardId, workspaceId) => !!await this.dataSource.getRepository(Board).findOne({ where: { id: boardId, workspace_id: workspaceId } }),
      scope,
    );
    const normalized = this.normalize(input);
    const duplicate = await repo.findOne({
      where: {
        workspace_id: scope.workspace_id === null ? IsNull() : scope.workspace_id,
        board_id: scope.board_id === null ? IsNull() : scope.board_id,
        key: normalized.key!,
      },
    });
    if (duplicate) throw httpError(409, `Function key "${normalized.key}" already exists in this scope`);
    const saved = await repo.save(repo.create({
      ...normalized,
      ...scope,
      version: 1,
      builtin: false,
    }));
    return this.toView(saved);
  }

  async update(id: string, input: any): Promise<Record<string, any>> {
    const repo = this.dataSource.getRepository(WorkflowFunction);
    const current = await repo.findOne({ where: { id } });
    if (!current) throw httpError(404, 'Function not found');
    if (
      (input.workspace_id !== undefined && (input.workspace_id || null) !== current.workspace_id)
      || (input.board_id !== undefined && (input.board_id || null) !== current.board_id)
      || (input.scope !== undefined && input.scope !== catalogScopeOf(current))
    ) {
      throw httpError(400, 'Function scope cannot be changed; create a new override instead');
    }
    const normalized = this.normalize(input, current);
    if (normalized.key !== current.key) {
      const duplicate = await repo.findOne({
        where: {
          workspace_id: current.workspace_id === null ? IsNull() : current.workspace_id,
          board_id: current.board_id === null ? IsNull() : current.board_id,
          key: normalized.key!,
        },
      });
      if (duplicate && duplicate.id !== id) throw httpError(409, `Function key "${normalized.key}" already exists in this scope`);
    }
    Object.assign(current, normalized, { version: current.version + 1 });
    return this.toView(await repo.save(current));
  }

  async remove(id: string): Promise<void> {
    const repo = this.dataSource.getRepository(WorkflowFunction);
    const current = await repo.findOne({ where: { id } });
    if (!current) throw httpError(404, 'Function not found');
    if (current.builtin) throw httpError(400, 'Built-in Functions cannot be deleted; disable or override them');
    await repo.delete(id);
  }

  private validateInputs(schemaRaw: string, inputs: Record<string, any>): void {
    const schema = parseJson(schemaRaw);
    if (schema?.type === 'object' && (inputs === null || Array.isArray(inputs) || typeof inputs !== 'object')) {
      throw httpError(400, 'inputs must be an object');
    }
    for (const field of schema?.required || []) {
      if (!(field in inputs)) throw httpError(400, `Missing required input: ${field}`);
    }
    for (const [field, property] of Object.entries<any>(schema?.properties || {})) {
      if (!(field in inputs) || !property?.type) continue;
      const value = inputs[field];
      const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
      if (actual !== property.type) throw httpError(400, `Input "${field}" must be ${property.type}`);
    }
  }

  async execute(args: FunctionExecutionArgs): Promise<Record<string, any>> {
    if (!args.workspaceId) throw httpError(400, 'workspace_id is required to execute a Function');
    if ((args.depth || 0) > 20) throw httpError(400, 'Function pipeline depth exceeded');
    const fn = args.functionId
      ? await this.dataSource.getRepository(WorkflowFunction).findOne({ where: { id: args.functionId } })
      : await this.resolve(String(args.functionKey || ''), args.workspaceId);
    if (!fn) throw httpError(404, 'Function not found');
    if (fn.workspace_id !== null && fn.workspace_id !== args.workspaceId) {
      throw httpError(403, 'Function belongs to a different workspace');
    }
    if (fn.board_id !== null) throw httpError(409, 'Board-scoped Function has not been migrated to Workspace scope');
    if (!fn.enabled) throw httpError(409, 'Function is disabled');
    if (fn.approval_policy === 'admin' && args.actorRole !== 'admin') {
      throw httpError(403, 'This Function requires an authenticated admin execution');
    }
    const inputs = args.inputs || {};
    this.validateInputs(fn.input_schema, inputs);
    const idempotencyKey = String(args.idempotencyKey || '').trim();
    if (fn.idempotency_mode === 'key') {
      if (!idempotencyKey) throw httpError(400, 'idempotency_key is required for this Function');
      const existing = await this.dataSource.getRepository(WorkflowFunctionRun).findOne({
        where: { function_id: fn.id, workspace_id: args.workspaceId, idempotency_key: idempotencyKey },
        order: { created_at: 'DESC' },
      });
      if (existing && ['running', 'succeeded'].includes(existing.status)) {
        return { ...this.runToView(existing), deduplicated: true };
      }
    }

    const runRepo = this.dataSource.getRepository(WorkflowFunctionRun);
    const run = await runRepo.save(runRepo.create({
      function_id: fn.id,
      function_key: fn.key,
      function_version: fn.version,
      workspace_id: args.workspaceId,
      board_id: args.boardId || null,
      ticket_id: args.ticketId || null,
      parent_run_id: args.parentRunId || null,
      actor_type: args.actorType || 'system',
      actor_id: args.actorId || '',
      actor_name: args.actorName || '',
      status: 'running',
      inputs: stringifyJson(inputs),
      outputs: '{}',
      evidence: '{}',
      idempotency_key: idempotencyKey,
      started_at: new Date(),
    }));

    try {
      const output = await this.executeWithRetry(fn, args, run.id, inputs);
      run.status = 'succeeded';
      run.outputs = stringifyJson(output);
      run.evidence = stringifyJson({
        executor_type: fn.executor_type,
        function_version: fn.version,
        completed_at: new Date().toISOString(),
      });
      run.completed_at = new Date();
      await runRepo.save(run);
      return this.runToView(run);
    } catch (error: any) {
      run.status = 'failed';
      run.error_code = error?.code || 'FUNCTION_EXECUTION_FAILED';
      run.error_message = error?.message || 'Function execution failed';
      run.completed_at = new Date();
      await runRepo.save(run);
      throw Object.assign(error instanceof Error ? error : new Error(run.error_message), {
        status: error?.status || 400,
        run_id: run.id,
      });
    }
  }

  private async executeWithRetry(
    fn: WorkflowFunction,
    args: FunctionExecutionArgs,
    runId: string,
    inputs: Record<string, any>,
  ): Promise<any> {
    let lastError: any;
    for (let attempt = 1; attempt <= fn.max_attempts; attempt++) {
      try {
        return await this.executeOnce(fn, args, runId, inputs);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  private async executeOnce(
    fn: WorkflowFunction,
    args: FunctionExecutionArgs,
    runId: string,
    inputs: Record<string, any>,
  ): Promise<any> {
    const config = parseJson(fn.config);
    if (fn.executor_type === 'builtin') return this.executeBuiltin(config.handler || fn.key, args, inputs, config);
    if (fn.executor_type === 'pipeline') {
      const results: any[] = [];
      for (const step of config.steps || []) {
        try {
          const child = await this.execute({
            ...args,
            functionId: undefined,
            functionKey: step.function_key,
            inputs: { ...inputs, ...(step.inputs || {}) },
            idempotencyKey: step.idempotency_key || '',
            parentRunId: runId,
            depth: (args.depth || 0) + 1,
          });
          results.push({ function_key: step.function_key, run_id: child.id, status: child.status, outputs: child.outputs });
        } catch (error: any) {
          results.push({ function_key: step.function_key, status: 'failed', error: error?.message });
          if (!step.continue_on_error) throw error;
        }
      }
      return { steps: results };
    }
    if (fn.executor_type === 'http') {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), fn.timeout_ms);
      try {
        const response = await fetch(config.url, {
          method: config.method || 'POST',
          headers: { 'content-type': 'application/json', ...(config.headers || {}) },
          body: ['GET', 'HEAD'].includes(String(config.method || 'POST').toUpperCase())
            ? undefined
            : JSON.stringify(config.body ?? inputs),
          signal: controller.signal,
        });
        const text = await response.text();
        let body: any = text;
        try { body = text ? JSON.parse(text) : null; } catch {}
        if (!response.ok) throw httpError(response.status, `HTTP executor returned ${response.status}`);
        return { status: response.status, body };
      } finally {
        clearTimeout(timer);
      }
    }
    if (fn.executor_type === 'agent_action') {
      if (!config.action_id) throw httpError(400, 'agent_action config.action_id is required');
      const dispatched = await this.actionsService.dispatch({
        actionId: config.action_id,
        triggeredByType: args.actorType === 'agent' ? 'agent' : args.actorType === 'user' ? 'user' : 'system',
        triggeredById: args.actorId || '',
        sourceTicketId: args.ticketId,
      });
      return {
        dispatched: true,
        action_run_id: dispatched.run.id,
        room_id: dispatched.room_id,
        note: 'This Function run records successful dispatch; the Action run owns asynchronous completion.',
      };
    }
    throw httpError(400, `Unsupported executor: ${fn.executor_type}`);
  }

  private async executeBuiltin(
    handler: string,
    args: FunctionExecutionArgs,
    inputs: Record<string, any>,
    config: Record<string, any>,
  ): Promise<any> {
    if (handler === 'system.noop') return inputs;
    if (handler === 'prompt_audit.measure_effect') return this.executePromptAuditMeasureEffect(args, inputs);
    if (!args.ticketId) throw httpError(400, `${handler} requires ticket_id`);
    const ticketRepo = this.dataSource.getRepository(Ticket);
    const columnRepo = this.dataSource.getRepository(BoardColumn);
    const ticket = await ticketRepo.findOne({ where: { id: args.ticketId } });
    if (!ticket || ticket.workspace_id !== args.workspaceId) throw httpError(404, 'Ticket not found in workspace');
    const column = ticket.column_id ? await columnRepo.findOne({ where: { id: ticket.column_id } }) : null;
    if (handler === 'workflow.ticket_snapshot') {
      return {
        ticket: {
          id: ticket.id,
          title: ticket.title,
          status: ticket.status,
          workspace_id: ticket.workspace_id,
          column_id: ticket.column_id,
          parent_id: ticket.parent_id,
          version: ticket.version,
        },
        column: column && { id: column.id, name: column.name, kind: column.kind, is_terminal: column.is_terminal },
      };
    }
    if (handler === 'workflow.verify_children_complete') {
      const children = await ticketRepo.find({ where: { parent_id: ticket.id } });
      const incomplete: any[] = [];
      for (const child of children) {
        const childColumn = child.column_id ? await columnRepo.findOne({ where: { id: child.column_id } }) : null;
        if (!childColumn?.is_terminal && childColumn?.kind !== 'terminal') {
          incomplete.push({ id: child.id, title: child.title, column_id: child.column_id, column: childColumn?.name || '' });
        }
      }
      if (incomplete.length) throw httpError(409, `${incomplete.length} child ticket(s) are not complete`);
      return { passed: true, child_count: children.length, incomplete: [] };
    }
    if (handler === 'workflow.verify_required_functions') {
      const required = Array.isArray(config.required_functions) ? config.required_functions : [];
      const missing: string[] = [];
      const runRepo = this.dataSource.getRepository(WorkflowFunctionRun);
      for (const key of required) {
        const found = await runRepo.findOne({
          where: { workspace_id: args.workspaceId, ticket_id: ticket.id, function_key: key, status: 'succeeded' },
          order: { created_at: 'DESC' },
        });
        if (!found) missing.push(key);
      }
      if (missing.length) throw httpError(409, `Required Function runs missing: ${missing.join(', ')}`);
      return { passed: true, required, missing: [] };
    }
    throw httpError(400, `Unknown built-in handler: ${handler}`);
  }

  // 위 workflow.* builtin들과 달리 ticket 스코프가 아니다 — 항상 호출한
  // Function-execution 자체의 workspaceId로만 스코프하고 inputs로 넘어온
  // override는 받지 않는다. workspace A로 인가된 호출이 workspace B의 집계
  // 통계를 읽지 못하게 하기 위함.
  private async executePromptAuditMeasureEffect(args: FunctionExecutionArgs, inputs: Record<string, any>): Promise<any> {
    const since = inputs?.since !== undefined ? new Date(String(inputs.since)) : undefined;
    const until = inputs?.until !== undefined ? new Date(String(inputs.until)) : undefined;
    if (since && Number.isNaN(since.getTime())) throw httpError(400, 'inputs.since must be an ISO 8601 timestamp');
    if (until && Number.isNaN(until.getTime())) throw httpError(400, 'inputs.until must be an ISO 8601 timestamp');
    return computeReport(this.dataSource, { ActivityLog, Comment, Ticket, BoardColumn, Board }, { since, until, workspaceId: args.workspaceId });
  }

  async listRuns(workspaceId: string, functionId?: string, ticketId?: string, limit = 50): Promise<Record<string, any>[]> {
    const qb = this.dataSource.getRepository(WorkflowFunctionRun).createQueryBuilder('r')
      .where('r.workspace_id = :workspaceId', { workspaceId });
    if (functionId) qb.andWhere('r.function_id = :functionId', { functionId });
    if (ticketId) qb.andWhere('r.ticket_id = :ticketId', { ticketId });
    const rows = await qb.orderBy('r.created_at', 'DESC').take(Math.max(1, Math.min(200, limit))).getMany();
    return rows.map(row => this.runToView(row));
  }

  async getRun(id: string, workspaceId: string): Promise<Record<string, any>> {
    const row = await this.dataSource.getRepository(WorkflowFunctionRun).findOne({ where: { id, workspace_id: workspaceId } });
    if (!row) throw httpError(404, 'Function run not found');
    return this.runToView(row);
  }
}
