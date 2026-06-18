import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Post, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { AdminGuard } from '../../common/guards/admin.guard';
import { Workspace } from '../../entities/Workspace';
import { Board } from '../../entities/Board';
import { BoardColumn } from '../../entities/BoardColumn';
import { Ticket } from '../../entities/Ticket';
import { Comment } from '../../entities/Comment';
import { User } from '../../entities/User';
import { Agent } from '../../entities/Agent';
import { Channel } from '../../entities/Channel';
import { ApiKey } from '../../entities/ApiKey';
import { ActivityLog } from '../../entities/ActivityLog';
import { ActivityService } from '../../services/activity.service';
import { ApiKeyService } from '../../services/api-key.service';
import { AuthService } from '../../services/auth.service';
import { maxTicketPosition, maxChildPosition } from '../mcp/shared/ticket-helpers';

// QA harness owns its own scratch columns. Intentionally NOT shared with
// db.ts seeds — the harness is a self-contained test scenario, so it
// defines exactly the column shape its tests need rather than depending on
// any global "default" board template.
const QA_COLUMNS = [
  { name: 'QA-In', position: 0, color: '#888' },
  { name: 'QA-Out', position: 1, color: '#888' },
];

interface TraceEvent {
  t: number;
  type: string;
  [k: string]: any;
}

interface TestResult {
  name: string;
  category: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  duration_ms: number;
  error?: string;
  detail?: string;
  // Structured event log captured by the test subprocess: step() markers,
  // fixture creations, SSE frames received, and MCP request/response pairs.
  // The UI renders this as an expandable timeline per test.
  trace?: TraceEvent[];
}

interface QAReport {
  run_at: string;
  duration_ms: number;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    pass_rate: string;
  };
  categories: Record<string, { passed: number; failed: number; skipped: number }>;
  results: TestResult[];
  cleanup: { workspace_deleted: boolean; error?: string };
}

@ApiBearerAuth('user-session')
@ApiTags('qa')
@Controller('api/admin/qa')
@UseGuards(AdminGuard)
export class QaController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly activityService: ActivityService,
    private readonly apiKeyService: ApiKeyService,
    private readonly authService: AuthService,
  ) {}

  @Post('run')
  async run(@Res() res: Response) {
    const startTime = Date.now();
    const results: TestResult[] = [];

    // Per-test event collector. wrapRepo/wrapService proxies pull the
    // current collector out of collectorRef.current so the repo bindings
    // can stay hoisted above runTest while events still scope cleanly
    // per-test. runTest swaps the collector at entry, clears it at exit.
    const collectorRef: { current: ReturnType<typeof makeCollector> | null } = { current: null };

    interface TestCtx {
      step: (label: string, extra?: Record<string, any>) => void;
    }

    async function runTest(
      name: string,
      category: string,
      fn: (ctx: TestCtx) => Promise<string | void>,
    ): Promise<void> {
      const t0 = Date.now();
      const collector = makeCollector(t0);
      collectorRef.current = collector;
      try {
        const detail = await fn({ step: collector.step });
        results.push({
          name, category, status: 'PASS',
          duration_ms: Date.now() - t0,
          detail: detail || undefined,
          trace: collector.events,
        });
      } catch (err: any) {
        results.push({
          name, category, status: 'FAIL',
          duration_ms: Date.now() - t0,
          error: err.message,
          trace: collector.events,
        });
      } finally {
        collectorRef.current = null;
      }
    }

    // Every TypeORM repository + injected service is wrapped once up front.
    // Inside a runTest the wrappers push `db-op`/`db-result` /
    // `service-call`/`service-result` events into the active collector so
    // the UI can render the exact DB and service interactions the test
    // performed — same fidelity as the Flow Tests MCP pairs.
    const wsRepo = wrapRepo(this.dataSource.getRepository(Workspace), 'Workspace', collectorRef);
    const boardRepo = wrapRepo(this.dataSource.getRepository(Board), 'Board', collectorRef);
    const colRepo = wrapRepo(this.dataSource.getRepository(BoardColumn), 'BoardColumn', collectorRef);
    const ticketRepo = wrapRepo(this.dataSource.getRepository(Ticket), 'Ticket', collectorRef);
    const commentRepo = wrapRepo(this.dataSource.getRepository(Comment), 'Comment', collectorRef);
    const userRepo = wrapRepo(this.dataSource.getRepository(User), 'User', collectorRef);
    const agentRepo = wrapRepo(this.dataSource.getRepository(Agent), 'Agent', collectorRef);
    const channelRepo = wrapRepo(this.dataSource.getRepository(Channel), 'Channel', collectorRef);
    const activityService = wrapService(this.activityService, 'ActivityService', collectorRef);
    const apiKeyService = wrapService(this.apiKeyService, 'ApiKeyService', collectorRef);

    let qaWsId = '';
    let qaBoardId = '';
    let qaColumnIds: string[] = [];
    let qaTicketId = '';
    let qaChildTicketId = '';
    let qaCommentId = '';
    let qaUserId = '';
    let qaAgentId = '';
    let qaChannelId = '';
    let qaApiKeyId = '';

    // === WORKSPACE TESTS ===
    await runTest('Create QA Workspace', 'Workspace', async ({ step }) => {
      step('Insert Workspace row (QA Test Workspace)');
      const ws = await wsRepo.save(wsRepo.create({ name: 'QA Test Workspace', description: 'Auto-generated for QA' }));
      qaWsId = ws.id;
      step(`Insert Board attached to workspace_id=${ws.id.slice(0, 8)}`);
      const board = await boardRepo.save(boardRepo.create({ workspace_id: ws.id, name: 'QA Board', description: '' }));
      qaBoardId = board.id;
      step(`Batch-insert ${QA_COLUMNS.length} columns (QA-In, QA-Out)`);
      const cols = QA_COLUMNS.map(c => ({ ...c, board_id: board.id }));
      const saved = await colRepo.save(cols.map(c => colRepo.create(c)));
      qaColumnIds = saved.map(c => c.id);
      return `Workspace ${ws.id}, Board ${board.id}, ${saved.length} columns`;
    });

    await runTest('Get Workspace', 'Workspace', async ({ step }) => {
      step(`Lookup workspace by id=${qaWsId.slice(0, 8)}`);
      const ws = await wsRepo.findOne({ where: { id: qaWsId } });
      if (!ws) throw new Error('Workspace not found');
      return `Found: ${ws.name}`;
    });

    await runTest('Update Workspace', 'Workspace', async ({ step }) => {
      step('Read-modify-write: load, mutate name, save');
      const ws = await wsRepo.findOne({ where: { id: qaWsId } });
      if (!ws) throw new Error('Not found');
      ws.name = 'QA Test Workspace (Updated)';
      await wsRepo.save(ws);
      return `Updated: ${ws.name}`;
    });

    // === TICKET TESTS ===
    await runTest('Create Ticket', 'Ticket', async ({ step }) => {
      if (qaColumnIds.length === 0) throw new Error('No columns');
      step(`Resolve next position in column_id=${qaColumnIds[0].slice(0, 8)}`);
      const pos = await maxTicketPosition(this.dataSource, qaColumnIds[0]);
      step(`Insert Ticket "QA Test Ticket" at position=${pos}`);
      const t = await ticketRepo.save(ticketRepo.create({
        column_id: qaColumnIds[0], title: 'QA Test Ticket', description: 'Auto-created', priority: 'high', assignee: 'QA Bot', labels: '["qa"]', channel_ids: '[]', position: pos,
      }));
      qaTicketId = t.id;
      return `Ticket ${t.id}`;
    });

    await runTest('Get Ticket', 'Ticket', async ({ step }) => {
      step(`Load ticket with children + comments relations`);
      const t = await ticketRepo.findOne({ where: { id: qaTicketId }, relations: ['children', 'comments'] });
      if (!t) throw new Error('Not found');
      return `Found: ${t.title}`;
    });

    await runTest('Update Ticket', 'Ticket', async ({ step }) => {
      step('Load ticket, bump title + priority=critical, save');
      const t = await ticketRepo.findOne({ where: { id: qaTicketId } });
      if (!t) throw new Error('Not found');
      t.title = 'QA Test Ticket (Updated)';
      t.priority = 'critical';
      await ticketRepo.save(t);
      return `Updated: priority=${t.priority}`;
    });

    // === CHILD TICKET TESTS ===
    await runTest('Create Child Ticket', 'ChildTicket', async ({ step }) => {
      step(`Resolve next child position for parent=${qaTicketId.slice(0, 8)}`);
      const position = await maxChildPosition(this.dataSource, qaTicketId);
      step(`Insert Ticket as child (parent_id=${qaTicketId.slice(0, 8)}, depth=1)`);
      const child = await ticketRepo.save(ticketRepo.create({
        parent_id: qaTicketId, depth: 1, column_id: null as any, title: 'QA Child Ticket', description: '', priority: 'medium', status: 'todo', assignee: '', reporter: '', labels: '[]', channel_ids: '[]', position,
      }));
      qaChildTicketId = child.id;
      return `Child Ticket ${child.id}`;
    });

    await runTest('Update Child Ticket', 'ChildTicket', async ({ step }) => {
      step('Load child, flip status=done, save');
      const child = await ticketRepo.findOne({ where: { id: qaChildTicketId } });
      if (!child) throw new Error('Not found');
      child.status = 'done';
      await ticketRepo.save(child);
      return `Updated: status=${child.status}`;
    });

    // === COMMENT TESTS ===
    await runTest('Create Comment', 'Comment', async ({ step }) => {
      step(`Insert system Comment on ticket_id=${qaTicketId.slice(0, 8)}`);
      const c = await commentRepo.save(commentRepo.create({
        ticket_id: qaTicketId, author_type: 'system', author_id: '', author: 'QA Bot', content: 'QA test comment',
      }));
      qaCommentId = c.id;
      return `Comment ${c.id}`;
    });

    // === USER TESTS ===
    await runTest('Create User', 'User', async ({ step }) => {
      step('Insert User (QA User / qa@test.local / role=user)');
      const u = await userRepo.save(userRepo.create({ name: 'QA User', email: 'qa@test.local', role: 'user' }));
      qaUserId = u.id;
      return `User ${u.id}`;
    });

    // === AGENT TESTS ===
    await runTest('Create Agent', 'Agent', async ({ step }) => {
      step('Insert Agent (QA Agent / type=custom)');
      const a = await agentRepo.save(agentRepo.create({ name: 'QA Agent', type: 'custom', description: 'QA test agent' }));
      qaAgentId = a.id;
      return `Agent ${a.id}`;
    });

    // === CHANNEL TESTS ===
    await runTest('Create Channel', 'Channel', async ({ step }) => {
      step('Insert Channel (QA Channel / type=discord / inactive)');
      const ch = await channelRepo.save(channelRepo.create({ name: 'QA Channel', type: 'discord', is_active: 0 }));
      qaChannelId = ch.id;
      return `Channel ${ch.id}`;
    });

    // === API KEY TESTS ===
    await runTest('Create API Key', 'ApiKey', async ({ step }) => {
      step('ApiKeyService.createApiKey(name="QA Key", scope=full)');
      const result = await apiKeyService.createApiKey({ name: 'QA Key', scope: 'full' });
      qaApiKeyId = (result.apiKey as any).id;
      return `Key ${qaApiKeyId}`;
    });

    await runTest('Revoke API Key', 'ApiKey', async ({ step }) => {
      step(`ApiKeyService.revokeApiKey(${qaApiKeyId.slice(0, 8)})`);
      const ok = await apiKeyService.revokeApiKey(qaApiKeyId);
      if (!ok) throw new Error('Failed to revoke');
      return 'Revoked';
    });

    // === ACTIVITY TESTS ===
    await runTest('Log Activity', 'Activity', async ({ step }) => {
      step(`ActivityService.logActivity(action=created on ticket ${qaTicketId.slice(0, 8)})`);
      const log = await activityService.logActivity({
        entity_type: 'ticket', entity_id: qaTicketId, action: 'created', ticket_id: qaTicketId, actor_name: 'QA Bot',
      });
      return `Activity ${log.id}`;
    });

    await runTest('Get Ticket Activity', 'Activity', async ({ step }) => {
      step(`ActivityService.getTicketActivity(${qaTicketId.slice(0, 8)})`);
      const logs = await activityService.getTicketActivity(qaTicketId);
      return `${logs.length} entries`;
    });

    // === CLEANUP ===
    await runTest('Cleanup: Delete API Key', 'Cleanup', async ({ step }) => {
      step(`ApiKeyService.deleteApiKey(${qaApiKeyId.slice(0, 8)})`);
      await apiKeyService.deleteApiKey(qaApiKeyId);
      return 'Deleted';
    });

    await runTest('Cleanup: Delete Channel', 'Cleanup', async ({ step }) => {
      step(`Channel.delete(${qaChannelId.slice(0, 8)})`);
      await channelRepo.delete(qaChannelId);
      return 'Deleted';
    });

    await runTest('Cleanup: Delete Agent', 'Cleanup', async ({ step }) => {
      step(`Agent.delete(${qaAgentId.slice(0, 8)})`);
      await agentRepo.delete(qaAgentId);
      return 'Deleted';
    });

    await runTest('Cleanup: Delete User', 'Cleanup', async ({ step }) => {
      step(`User.delete(${qaUserId.slice(0, 8)})`);
      await userRepo.delete(qaUserId);
      return 'Deleted';
    });

    await runTest('Cleanup: Delete QA Workspace', 'Cleanup', async ({ step }) => {
      step(`Workspace.delete(${qaWsId.slice(0, 8)}) — cascade should remove board+columns+tickets+comments`);
      await wsRepo.delete(qaWsId);
      return 'Deleted';
    });

    const passed = results.filter(r => r.status === 'PASS').length;
    const failed = results.filter(r => r.status === 'FAIL').length;
    const skipped = results.filter(r => r.status === 'SKIP').length;
    const total = results.length;

    // Build per-category stats
    const categories: Record<string, { passed: number; failed: number; skipped: number }> = {};
    for (const r of results) {
      if (!categories[r.category]) categories[r.category] = { passed: 0, failed: 0, skipped: 0 };
      if (r.status === 'PASS') categories[r.category].passed++;
      else if (r.status === 'FAIL') categories[r.category].failed++;
      else categories[r.category].skipped++;
    }

    // Check cleanup result
    const cleanupWs = results.find(r => r.name === 'Cleanup: Delete QA Workspace');
    const cleanup = {
      workspace_deleted: cleanupWs?.status === 'PASS',
      error: cleanupWs?.error,
    };

    const report: QAReport = {
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      summary: {
        total,
        passed,
        failed,
        skipped,
        pass_rate: total > 0 ? `${Math.round((passed / total) * 100)}%` : '0%',
      },
      categories,
      results,
      cleanup,
    };

    return res.json(report);
  }

  // ─── Flow test runner ───────────────────────────────────────────────
  //
  // Spawns `node --test --test-reporter=spec test/qa-flows/<file>` per
  // flow file and collects PASS/FAIL + error text. Each flow file boots
  // its own NestJS app on its own port; they never collide with the main
  // server on 7701, but they DO share the sqljs database file unless we
  // isolate it — so we point the subprocess at database/qa-flows.db via
  // SQLJS_DB_PATH (see db.ts). Postgres users are warned in the response.
  //
  // This exists so the admin UI can trigger the same suite CI uses
  // (npm run test:qa) without shelling out manually.
  @Post('run-flows')
  async runFlows(@Res() res: Response) {
    const startTime = Date.now();

    // Each file is a single test() block keyed on its filename, so we can
    // treat one-file = one-result without TAP-parsing subtests.
    const FLOW_FILES: Array<{ file: string; category: string }> = [
      { file: 'ticket-lifecycle.test.mjs', category: 'Flow-Lifecycle' },
      { file: 'self-trigger-guard.test.mjs', category: 'Flow-Lifecycle' },
      { file: 'comment-trigger.test.mjs', category: 'Flow-Comment' },
      { file: 'comment-mention.test.mjs', category: 'Flow-Comment' },
      { file: 'mcp-tools-surface.test.mjs', category: 'Flow-MCP' },
      { file: 'mcp-schema-version.test.mjs', category: 'Flow-MCP' },
      { file: 'mcp-agent-roundtrip.test.mjs', category: 'Flow-MCP' },
      { file: 'backlog-promotion-chain.test.mjs', category: 'Flow-Lifecycle' },
      { file: 'multi-agent-concurrency.test.mjs', category: 'Flow-Concurrency' },
      { file: 'multi-user-chat.test.mjs', category: 'Flow-Chat' },
      { file: 'chat-message-read.test.mjs', category: 'Flow-Chat' },
      { file: 'large-data.test.mjs', category: 'Flow-Scale' },
      { file: 'qa-run-lifecycle.test.mjs', category: 'Flow-QA' },
      { file: 'qa-scenario-list-rollup.test.mjs', category: 'Flow-QA' },
    ];

    // Resolve the apps/server root from wherever this compiled file lives
    // (dist/modules/qa/qa.controller.js). The test files live at
    // <serverRoot>/test/qa-flows/*. A sanity check lets us fail fast with
    // a readable message when the build layout changes.
    const serverRoot = path.resolve(__dirname, '..', '..', '..');
    const testDir = path.join(serverRoot, 'test', 'qa-flows');
    if (!fs.existsSync(testDir)) {
      return res.status(500).json({
        error: 'QA flow tests directory not found',
        detail: `Expected ${testDir}. Run 'npm run build' at apps/server and make sure test/qa-flows/ is present.`,
      });
    }

    // Warn if not sqlite — flow tests run against whatever DB the main
    // process uses unless SQLJS_DB_PATH is wired, which only applies to
    // sqljs. For Postgres/MySQL deployments the operator must accept that
    // flow-test data lands in the live DB (tests use random UUIDs so it
    // doesn't corrupt existing records, but the rows linger).
    const dbType = process.env.DB_TYPE || 'sqlite';
    const warnings: string[] = [];
    if (dbType !== 'sqlite' && dbType !== 'sqljs') {
      warnings.push(
        `Flow tests are sharing the live ${dbType} database; test data (workspaces/agents/tickets with UUID names) will remain unless you clean up manually.`,
      );
    }

    const results: TestResult[] = [];

    for (const { file, category } of FLOW_FILES) {
      const t0 = Date.now();
      const outcome = await runFlowFile(path.join(testDir, file));
      results.push({
        name: file.replace(/\.test\.mjs$/, ''),
        category,
        status: outcome.status,
        duration_ms: outcome.duration_ms ?? Date.now() - t0,
        error: outcome.error,
        detail: outcome.detail,
        trace: outcome.trace,
      });
    }

    const passed = results.filter((r) => r.status === 'PASS').length;
    const failed = results.filter((r) => r.status === 'FAIL').length;
    const skipped = results.filter((r) => r.status === 'SKIP').length;
    const total = results.length;

    const categories: Record<string, { passed: number; failed: number; skipped: number }> = {};
    for (const r of results) {
      if (!categories[r.category]) categories[r.category] = { passed: 0, failed: 0, skipped: 0 };
      if (r.status === 'PASS') categories[r.category].passed++;
      else if (r.status === 'FAIL') categories[r.category].failed++;
      else categories[r.category].skipped++;
    }

    const report: QAReport & { warnings?: string[] } = {
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      summary: {
        total,
        passed,
        failed,
        skipped,
        pass_rate: total > 0 ? `${Math.round((passed / total) * 100)}%` : '0%',
      },
      categories,
      results,
      // Flow suite doesn't create a shared scratch workspace (each file
      // owns its scene), so there's no single cleanup row to surface —
      // we just pass through a trivially-"clean" state for UI-shape parity.
      cleanup: { workspace_deleted: true },
      warnings: warnings.length ? warnings : undefined,
    };

    return res.json(report);
  }
}

// ─── Basic QA trace helpers ──────────────────────────────────────────
//
// These give the in-process `run()` endpoint the same fidelity that the
// subprocess-driven `run-flows` endpoint has: step() markers, DB op pairs
// (db-op / db-result), and service-call pairs (service-call / service-result).
// The UI's TestTimeline component renders all four event types uniformly.

function truncateValue(obj: any, maxChars = 2000): any {
  if (obj === undefined) return undefined;
  try {
    const s = JSON.stringify(obj);
    if (s.length <= maxChars) return JSON.parse(s);
    return { _truncated: true, _original_len: s.length, preview: s.slice(0, maxChars) + '...' };
  } catch {
    return { _unrepresentable: true };
  }
}

// Keep a short, readable summary of what repo.save/find arguments looked
// like. For queries (findOne({where: {id}}), find({order})) the `where`
// and `order` clauses are the most useful to surface.
function summarizeRepoArgs(op: string, args: any[]): any {
  if (args.length === 0) return undefined;
  const first = args[0];
  if ((op === 'findOne' || op === 'find' || op === 'findAndCount') && first && typeof first === 'object') {
    return truncateValue({ where: first.where, order: first.order, relations: first.relations, take: first.take });
  }
  if (op === 'save') {
    if (Array.isArray(first)) {
      return truncateValue({ count: first.length, sample: first.slice(0, 2) });
    }
    return truncateValue(first);
  }
  if (op === 'update' && args.length >= 2) {
    return truncateValue({ criteria: args[0], patch: args[1] });
  }
  if (op === 'delete') {
    return truncateValue({ criteria: first });
  }
  return truncateValue(args);
}

function summarizeRepoResult(op: string, result: any): any {
  if (result === undefined || result === null) return result;
  if (Array.isArray(result)) {
    return truncateValue({ count: result.length, sample: result.slice(0, 3) });
  }
  if (op === 'update' || op === 'delete') {
    return truncateValue({ affected: result.affected, raw: result.raw });
  }
  return truncateValue(result);
}

function makeCollector(testStartAt: number) {
  const events: TraceEvent[] = [];
  const now = () => Date.now() - testStartAt;
  const push = (type: string, data: Record<string, any> = {}) => {
    const ev: TraceEvent = { t: now(), type };
    for (const [k, v] of Object.entries(data)) {
      ev[k] = typeof v === 'object' && v !== null ? truncateValue(v) : v;
    }
    events.push(ev);
  };
  return {
    events,
    push,
    step: (label: string, extra: Record<string, any> = {}) => push('step', { label, ...extra }),
  };
}

type CollectorRef = { current: ReturnType<typeof makeCollector> | null };

// TypeORM methods worth tracing. QueryBuilder + internal metadata access
// stays pass-through so we don't break repo behavior.
const TRACED_REPO_METHODS = new Set([
  'save', 'insert', 'update', 'delete', 'remove',
  'find', 'findOne', 'findBy', 'findOneBy', 'findAndCount', 'count',
]);

function wrapRepo(repo: any, entityName: string, ref: CollectorRef): any {
  return new Proxy(repo, {
    get(target, prop: string | symbol) {
      const orig = (target as any)[prop];
      if (typeof prop !== 'string' || typeof orig !== 'function' || !TRACED_REPO_METHODS.has(prop)) {
        return typeof orig === 'function' ? orig.bind(target) : orig;
      }
      return async (...args: any[]) => {
        const collector = ref.current;
        if (!collector) return orig.apply(target, args);
        collector.push('db-op', { entity: entityName, op: prop, args: summarizeRepoArgs(prop, args) });
        const t0 = Date.now();
        try {
          const result = await orig.apply(target, args);
          collector.push('db-result', {
            entity: entityName, op: prop,
            duration_ms: Date.now() - t0,
            result: summarizeRepoResult(prop, result),
          });
          return result;
        } catch (err: any) {
          collector.push('db-result', {
            entity: entityName, op: prop,
            duration_ms: Date.now() - t0,
            error: String(err?.message || err),
          });
          throw err;
        }
      };
    },
  });
}

function wrapService(svc: any, serviceName: string, ref: CollectorRef): any {
  return new Proxy(svc, {
    get(target, prop: string | symbol) {
      const orig = (target as any)[prop];
      // Pass through non-functions, private methods, and class internals.
      if (typeof prop !== 'string' || typeof orig !== 'function'
          || prop.startsWith('_') || prop === 'constructor') {
        return typeof orig === 'function' ? orig.bind(target) : orig;
      }
      return async (...args: any[]) => {
        const collector = ref.current;
        if (!collector) return orig.apply(target, args);
        collector.push('service-call', {
          service: serviceName, method: prop,
          args: truncateValue(args.length === 1 ? args[0] : args, 1500),
        });
        const t0 = Date.now();
        try {
          const result = await orig.apply(target, args);
          collector.push('service-result', {
            service: serviceName, method: prop,
            duration_ms: Date.now() - t0,
            result: truncateValue(result, 2000),
          });
          return result;
        } catch (err: any) {
          collector.push('service-result', {
            service: serviceName, method: prop,
            duration_ms: Date.now() - t0,
            error: String(err?.message || err),
          });
          throw err;
        }
      };
    },
  });
}

// ─── spawn runner ─────────────────────────────────────────────────────

interface FlowOutcome {
  status: 'PASS' | 'FAIL';
  duration_ms?: number;
  error?: string;
  detail?: string;
  trace?: TraceEvent[];
}

function runFlowFile(absTestPath: string): Promise<FlowOutcome> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    // Each test writes its trace buffer (every MCP request/response, every
    // SSE frame received, every step() marker, every DB fixture) to this
    // file via helpers/trace.mjs writeTrace() just before process.exit.
    // We read + unlink it after the subprocess finishes.
    const traceFile = path.join(
      os.tmpdir(),
      `qa-trace-${path.basename(absTestPath, '.test.mjs')}-${randomUUID()}.json`,
    );
    // Point sqljs at an isolated test DB file so concurrent writes from
    // the main server process don't clobber each other through autoSave.
    // For postgres/mysql this env does nothing (by design) and the caller
    // has already surfaced the warning to the UI.
    const env = {
      ...process.env,
      SQLJS_DB_PATH: process.env.SQLJS_DB_PATH || 'qa-flows.db',
      // Prevent per-file PORT env from leaking into the child and colliding
      // with the main server — each flow file picks its own default port
      // (7801+) via QA_*_PORT envs inside the file.
      PORT: '',
      QA_TRACE_PATH: traceFile,
      QA_TEST_FILE: path.basename(absTestPath),
    };
    const proc = spawn(
      process.execPath,
      ['--test', '--test-reporter=spec', absTestPath],
      {
        cwd: path.resolve(absTestPath, '..', '..', '..'),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    // Hard ceiling per file: 90s. Any individual flow test should finish
    // in under 10s — anything longer is a regression or a hang.
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
    }, 90_000);

    const readTrace = (): TraceEvent[] | undefined => {
      try {
        if (!fs.existsSync(traceFile)) return undefined;
        const raw = fs.readFileSync(traceFile, 'utf8');
        fs.unlinkSync(traceFile);
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : undefined;
      } catch {
        // Best-effort cleanup on parse failure — don't poison the test result.
        try { fs.unlinkSync(traceFile); } catch { /* ignore */ }
        return undefined;
      }
    };

    proc.on('close', (code) => {
      clearTimeout(timer);
      const duration_ms = Date.now() - t0;
      const combined = (stdout + '\n' + stderr).trim();
      const trace = readTrace();

      if (code === 0) {
        // Pull the one-line duration from the spec-reporter summary if present.
        const m = /duration_ms[\s\S]*?(\d+\.?\d*)/.exec(stdout);
        return resolve({
          status: 'PASS',
          duration_ms,
          detail: m ? `runner=${Math.round(parseFloat(m[1]))}ms` : undefined,
          trace,
        });
      }

      // FAIL: surface the error block. node --test spec reporter writes:
      //   ✖ <test name> (Xms)
      //     <assertion / stack>
      // Plus a final "failing tests:" section. We keep stdout intact for
      // copy/paste and additionally extract the most relevant slice for a
      // compact `error` field.
      const compact = extractFailureSummary(combined) ||
        `Exit code ${code ?? '(killed)'} with no parseable failure block.`;
      resolve({
        status: 'FAIL',
        duration_ms,
        error: compact,
        detail: combined.length > 8000 ? combined.slice(-8000) : combined,
        trace,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        status: 'FAIL',
        duration_ms: Date.now() - t0,
        error: `spawn failed: ${err.message}`,
        trace: readTrace(),
      });
    });
  });
}

// Grab the interesting error-bearing slice of the spec-reporter output.
// Prefer the "failing tests:" tail when it exists (richer context with the
// assertion stack), otherwise fall back to the first ✖ line.
function extractFailureSummary(output: string): string {
  const failHeaderIdx = output.indexOf('failing tests:');
  if (failHeaderIdx !== -1) {
    return output.slice(failHeaderIdx).trim().slice(0, 4000);
  }
  const lines = output.split('\n');
  const errLines: string[] = [];
  let collect = false;
  for (const line of lines) {
    if (/^\s*✖|AssertionError|^  Error:/.test(line)) collect = true;
    if (collect) errLines.push(line);
  }
  return errLines.join('\n').trim().slice(0, 4000);
}
