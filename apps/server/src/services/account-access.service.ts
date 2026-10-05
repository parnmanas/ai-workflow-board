import { Injectable, ForbiddenException, BadRequestException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { Account } from '../entities/Account';
import { ReBACService } from './rebac.service';

/** Ownership is resolved from the resource, never from the page displaying it. */
@Injectable()
export class AccountAccessService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly rebac: ReBACService,
  ) {}

  async accessibleIds(user: { id: string; role: string }): Promise<string[]> {
    if (user.role === 'admin') {
      return (await this.dataSource.getRepository(Account).find({ select: ['id'], order: { created_at: 'ASC', id: 'ASC' } })).map(a => a.id);
    }
    const ids = await this.rebac.listObjectsByMultipleRelations({ type: 'user', id: user.id }, ['member', 'owner'], 'account');
    if (!ids.length) return [];
    return (await this.dataSource.getRepository(Account).find({ where: { id: In(ids) }, select: ['id'], order: { created_at: 'ASC', id: 'ASC' } })).map(a => a.id);
  }

  async bindRequest(req: any): Promise<void> {
    if (req.accountAccessBound) return;
    const ids = await this.accessibleIds(req.currentUser);
    req.accessibleAccountIds = ids;
    const path = String(req.path || req.url || '').split('?')[0];
    const owners: Record<string, string> = {
      accounts: 'Account', tickets: 'Ticket', projects: 'Project', 'chat-rooms': 'ChatRoom',
      actions: 'Action', credentials: 'Credential', resources: 'Resource',
      functions: 'WorkflowFunction', skills: 'Skill',
      'api-keys': 'ApiKey', channels: 'Channel',
      'qa-scenarios': 'QaScenario', 'qa-schedules': 'QaSchedule',
      'security-profiles': 'SecurityProfile', 'security-schedules': 'SecuritySchedule',
      'automation-schedules': 'AutomationSchedule',
    };
    let entity: string | undefined;
    let resourceId: string | undefined;
    const nested = path.match(/\/api\/(qa|security|actions|functions)\/(scenarios|profiles|schedules|runs|batches)\/([^/]+)/);
    const orchestration = path.match(/\/orchestration\/(missions|teams|steps)\/([^/]+)/);
    if (orchestration) {
      entity = { missions: 'OrchestrationMission', teams: 'OrchestrationTeam', steps: 'OrchestrationStep' }[orchestration[1]];
      resourceId = orchestration[2];
    } else if (nested) {
      entity = ({ qa: { scenarios: 'QaScenario', schedules: 'QaSchedule', runs: 'QaRun', batches: 'QaRunBatch' },
        security: { profiles: 'SecurityProfile', schedules: 'SecuritySchedule', runs: 'SecurityRun', batches: 'SecurityRunBatch' },
        actions: { runs: 'ActionRun' }, functions: { runs: 'WorkflowFunctionRun' },
      } as Record<string, Record<string, string>>)[nested[1]]?.[nested[2]];
      resourceId = nested[3];
    } else {
      const match = path.match(/\/api\/([^/]+)\/([^/]+)/);
      if (match) { entity = owners[match[1]]; resourceId = match[2]; }
    }
    let owner: string | null | undefined;
    const nativeSession = path.match(/\/agent-sessions\/hosts\/([^/]+)\/([^/]+)\/sessions(?:\/([^/]+))?$/)
      || path.match(/\/agent-sessions\/hosts\/([^/]+)\/([^/]+)\/sessions\/([^/]+)\//);
    const nativeId = nativeSession?.[3] || (nativeSession && req.body?.session_id);
    if (nativeSession && nativeId) {
      let decodedId: string;
      try { decodedId = nativeSession[3] ? decodeURIComponent(nativeId) : nativeId; }
      catch { throw new BadRequestException('invalid_session_id'); }
      const binding = await this.dataSource.getRepository('AgentSessionExecution').findOne({
        where: { manager_id: decodeURIComponent(nativeSession[1]), cli: decodeURIComponent(nativeSession[2]), session_id: decodedId }, select: ['account_id'],
      });
      if (binding) owner = binding.account_id;
    }
    // Selecting a project/team determines the owner of newly created work.
    // A page's default account must not make another accessible project fail.
    if (!owner && req.method === 'POST' && (path === '/api/tickets' || path === '/api/orchestration/missions')) {
      const referenceId = req.body?.project_id || req.body?.team_id;
      const referenceEntity = req.body?.project_id ? 'Project' : 'OrchestrationTeam';
      if (referenceId && /^[0-9a-f-]{36}$/i.test(referenceId)) {
        owner = (await this.dataSource.getRepository(referenceEntity).findOne({ where: { id: referenceId }, select: ['account_id'] }))?.account_id;
      }
    }
    if (resourceId) {
      try { resourceId = decodeURIComponent(resourceId); }
      catch { throw new BadRequestException('invalid_resource_id'); }
    }
    if (entity && resourceId && /^[0-9a-f-]{36}$/i.test(resourceId)) {
      const metadata = this.dataSource.entityMetadatas.find(m => m.name === entity);
      if (entity === 'Account') {
        const row = await this.dataSource.getRepository(Account).findOne({ where: { id: resourceId }, select: ['id'] });
        if (row) owner = row.id;
      } else if (metadata?.findColumnWithPropertyName('account_id')) {
        const row = await this.dataSource.getRepository(entity).findOne({ where: { id: resourceId }, select: ['id', 'account_id'] });
        if (row) owner = row.account_id;
      } else if (entity === 'OrchestrationStep') {
        const step = await this.dataSource.getRepository(entity).findOne({ where: { id: resourceId } });
        if (step) owner = (await this.dataSource.getRepository('OrchestrationMission').findOne({ where: { id: step.mission_id }, select: ['account_id'] }))?.account_id;
      }
    }
    const pathId = req.params?.accountId || req.params?.wsId;
    const requested = pathId || req.body?.account_id || req.query?.account_id;
    const hint = requested || req.headers?.['x-account-id'];
    // Administrative list filters are explicit parameters. The browser's
    // creation-default header remains an ownership hint, not a list filter.
    req.requestedAccountId = requested || null;
    const effective = owner || hint || ids[0] || null;
    if (effective && !ids.includes(effective)) throw new ForbiddenException('account_access_denied');
    if (pathId && owner && pathId !== owner) throw new ForbiddenException('account_access_denied');
    req.currentAccountId = effective;
    if (effective) {
      req.headers['x-account-id'] = effective;
      // Express 5 exposes query through a getter; replace it once for decorators.
      Object.defineProperty(req, 'query', { value: { ...req.query, account_id: effective }, configurable: true, writable: true });
      if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) && !Array.isArray(req.body)
        && (owner || (path.includes('/orchestration/') && req.body.account_id === undefined))) {
        req.body.account_id = effective;
      }
    }
    req.accountAccessBound = true;
  }
}
