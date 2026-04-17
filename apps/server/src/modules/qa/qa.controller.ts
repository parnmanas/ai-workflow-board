import { Controller, Post, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AdminGuard } from '../../common/guards/admin.guard';
import { Workspace } from '../../entities/Workspace';
import { Board } from '../../entities/Board';
import { BoardColumn } from '../../entities/BoardColumn';
import { Ticket } from '../../entities/Ticket';
import { Comment } from '../../entities/Comment';
import { User } from '../../entities/User';
import { Agent } from '../../entities/Agent';
import { AgentChannelIdentity } from '../../entities/AgentChannelIdentity';
import { Channel } from '../../entities/Channel';
import { ApiKey } from '../../entities/ApiKey';
import { ActivityLog } from '../../entities/ActivityLog';
import { ActivityService } from '../../services/activity.service';
import { ApiKeyService } from '../../services/api-key.service';
import { AuthService } from '../../services/auth.service';
import { DEFAULT_COLUMNS } from '../../database/database.module';
import { maxTicketPosition, maxChildPosition } from '../mcp/shared/ticket-helpers';

interface TestResult {
  name: string;
  category: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  duration_ms: number;
  error?: string;
  detail?: string;
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

    async function runTest(name: string, category: string, fn: () => Promise<string | void>): Promise<void> {
      const t0 = Date.now();
      try {
        const detail = await fn();
        results.push({ name, category, status: 'PASS', duration_ms: Date.now() - t0, detail: detail || undefined });
      } catch (err: any) {
        results.push({ name, category, status: 'FAIL', duration_ms: Date.now() - t0, error: err.message });
      }
    }

    const wsRepo = this.dataSource.getRepository(Workspace);
    const boardRepo = this.dataSource.getRepository(Board);
    const colRepo = this.dataSource.getRepository(BoardColumn);
    const ticketRepo = this.dataSource.getRepository(Ticket);
    const commentRepo = this.dataSource.getRepository(Comment);
    const userRepo = this.dataSource.getRepository(User);
    const agentRepo = this.dataSource.getRepository(Agent);
    const identityRepo = this.dataSource.getRepository(AgentChannelIdentity);
    const channelRepo = this.dataSource.getRepository(Channel);

    let qaWsId = '';
    let qaBoardId = '';
    let qaColumnIds: string[] = [];
    let qaTicketId = '';
    let qaChildTicketId = '';
    let qaCommentId = '';
    let qaUserId = '';
    let qaAgentId = '';
    let qaIdentityId = '';
    let qaChannelId = '';
    let qaApiKeyId = '';

    // === WORKSPACE TESTS ===
    await runTest('Create QA Workspace', 'Workspace', async () => {
      const ws = await wsRepo.save(wsRepo.create({ name: 'QA Test Workspace', description: 'Auto-generated for QA' }));
      qaWsId = ws.id;
      const board = await boardRepo.save(boardRepo.create({ workspace_id: ws.id, name: 'QA Board', description: '' }));
      qaBoardId = board.id;
      const cols = DEFAULT_COLUMNS.map(c => ({ ...c, board_id: board.id }));
      const saved = await colRepo.save(cols.map(c => colRepo.create(c)));
      qaColumnIds = saved.map(c => c.id);
      return `Workspace ${ws.id}, Board ${board.id}, ${saved.length} columns`;
    });

    await runTest('Get Workspace', 'Workspace', async () => {
      const ws = await wsRepo.findOne({ where: { id: qaWsId } });
      if (!ws) throw new Error('Workspace not found');
      return `Found: ${ws.name}`;
    });

    await runTest('Update Workspace', 'Workspace', async () => {
      const ws = await wsRepo.findOne({ where: { id: qaWsId } });
      if (!ws) throw new Error('Not found');
      ws.name = 'QA Test Workspace (Updated)';
      await wsRepo.save(ws);
      return `Updated: ${ws.name}`;
    });

    // === TICKET TESTS ===
    await runTest('Create Ticket', 'Ticket', async () => {
      if (qaColumnIds.length === 0) throw new Error('No columns');
      const pos = await maxTicketPosition(this.dataSource, qaColumnIds[0]);
      const t = await ticketRepo.save(ticketRepo.create({
        column_id: qaColumnIds[0], title: 'QA Test Ticket', description: 'Auto-created', priority: 'high', assignee: 'QA Bot', labels: '["qa"]', channel_ids: '[]', position: pos,
      }));
      qaTicketId = t.id;
      return `Ticket ${t.id}`;
    });

    await runTest('Get Ticket', 'Ticket', async () => {
      const t = await ticketRepo.findOne({ where: { id: qaTicketId }, relations: ['children', 'comments'] });
      if (!t) throw new Error('Not found');
      return `Found: ${t.title}`;
    });

    await runTest('Update Ticket', 'Ticket', async () => {
      const t = await ticketRepo.findOne({ where: { id: qaTicketId } });
      if (!t) throw new Error('Not found');
      t.title = 'QA Test Ticket (Updated)';
      t.priority = 'critical';
      await ticketRepo.save(t);
      return `Updated: priority=${t.priority}`;
    });

    // === CHILD TICKET TESTS ===
    await runTest('Create Child Ticket', 'ChildTicket', async () => {
      const position = await maxChildPosition(this.dataSource, qaTicketId);
      const child = await ticketRepo.save(ticketRepo.create({
        parent_id: qaTicketId, depth: 1, column_id: null as any, title: 'QA Child Ticket', description: '', priority: 'medium', status: 'todo', assignee: '', reporter: '', labels: '[]', channel_ids: '[]', position,
      }));
      qaChildTicketId = child.id;
      return `Child Ticket ${child.id}`;
    });

    await runTest('Update Child Ticket', 'ChildTicket', async () => {
      const child = await ticketRepo.findOne({ where: { id: qaChildTicketId } });
      if (!child) throw new Error('Not found');
      child.status = 'done';
      await ticketRepo.save(child);
      return `Updated: status=${child.status}`;
    });

    // === COMMENT TESTS ===
    await runTest('Create Comment', 'Comment', async () => {
      const c = await commentRepo.save(commentRepo.create({
        ticket_id: qaTicketId, author_type: 'system', author_id: '', author: 'QA Bot', content: 'QA test comment',
      }));
      qaCommentId = c.id;
      return `Comment ${c.id}`;
    });

    // === USER TESTS ===
    await runTest('Create User', 'User', async () => {
      const u = await userRepo.save(userRepo.create({ name: 'QA User', email: 'qa@test.local', role: 'user' }));
      qaUserId = u.id;
      return `User ${u.id}`;
    });

    // === AGENT TESTS ===
    await runTest('Create Agent', 'Agent', async () => {
      const a = await agentRepo.save(agentRepo.create({ name: 'QA Agent', type: 'custom', description: 'QA test agent' }));
      qaAgentId = a.id;
      return `Agent ${a.id}`;
    });

    await runTest('Add Channel Identity', 'Agent', async () => {
      const i = await identityRepo.save(identityRepo.create({
        agent_id: qaAgentId, channel_type: 'discord', channel_external_id: '123456', display_name: 'QA Bot',
      }));
      qaIdentityId = i.id;
      return `Identity ${i.id}`;
    });

    // === CHANNEL TESTS ===
    await runTest('Create Channel', 'Channel', async () => {
      const ch = await channelRepo.save(channelRepo.create({ name: 'QA Channel', type: 'discord', is_active: 0 }));
      qaChannelId = ch.id;
      return `Channel ${ch.id}`;
    });

    // === API KEY TESTS ===
    await runTest('Create API Key', 'ApiKey', async () => {
      const result = await this.apiKeyService.createApiKey({ name: 'QA Key', scope: 'full' });
      qaApiKeyId = (result.apiKey as any).id;
      return `Key ${qaApiKeyId}`;
    });

    await runTest('Revoke API Key', 'ApiKey', async () => {
      const ok = await this.apiKeyService.revokeApiKey(qaApiKeyId);
      if (!ok) throw new Error('Failed to revoke');
      return 'Revoked';
    });

    // === ACTIVITY TESTS ===
    await runTest('Log Activity', 'Activity', async () => {
      const log = await this.activityService.logActivity({
        entity_type: 'ticket', entity_id: qaTicketId, action: 'created', ticket_id: qaTicketId, actor_name: 'QA Bot',
      });
      return `Activity ${log.id}`;
    });

    await runTest('Get Ticket Activity', 'Activity', async () => {
      const logs = await this.activityService.getTicketActivity(qaTicketId);
      return `${logs.length} entries`;
    });

    // === CLEANUP ===
    await runTest('Cleanup: Delete API Key', 'Cleanup', async () => {
      await this.apiKeyService.deleteApiKey(qaApiKeyId);
      return 'Deleted';
    });

    await runTest('Cleanup: Delete Channel', 'Cleanup', async () => {
      await channelRepo.delete(qaChannelId);
      return 'Deleted';
    });

    await runTest('Cleanup: Delete Agent', 'Cleanup', async () => {
      await agentRepo.delete(qaAgentId);
      return 'Deleted';
    });

    await runTest('Cleanup: Delete User', 'Cleanup', async () => {
      await userRepo.delete(qaUserId);
      return 'Deleted';
    });

    await runTest('Cleanup: Delete QA Workspace', 'Cleanup', async () => {
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
}
