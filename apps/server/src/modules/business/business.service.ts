import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BusinessFormation } from '../../entities/BusinessFormation';
import { BusinessCompany } from '../../entities/BusinessCompany';
import { BusinessTask } from '../../entities/BusinessTask';
import { BusinessTaskEntry } from '../../entities/BusinessTaskEntry';
import { User } from '../../entities/User';
import { BusinessConnection } from '../../entities/BusinessConnection';
import { BusinessEvent } from '../../entities/BusinessEvent';
import { Credential } from '../../entities/Credential';
import { MarketingCampaign } from '../../entities/MarketingCampaign';
import { Ticket } from '../../entities/Ticket';
import { decryptStrict } from '../../services/encryption.service';
import { BUSINESS_STAGES } from './business.types';
import { BUSINESS_TEMPLATE } from './business-template';
import { businessConnector } from './connectors/registry';
import { connectorGet, externalId } from './connectors/connector-http';
import { TicketService, type TicketActor } from '../tickets/ticket.service';
import { parseTicketStatus } from '../../common/ticket-status';
import { assessSelfService, isSelfProvider, SELF_SERVICE_VERSION, selfAnswersSchema } from './business-self-service';

export const companySchema = z.object({
  name: z.string().trim().min(1).max(120),
  entity_type: z.enum(['LLC', 'CCorp', 'other']),
  country: z.string().regex(/^[A-Z]{2}$/),
  jurisdiction: z.string().trim().max(80),
  description: z.string().trim().max(2000),
  campaign_ids: z.array(z.string().uuid()).max(50),
});
const dueDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const date = new Date(v);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === v;
}, '유효한 날짜를 입력하세요.').nullable();
export const taskSchema = z.object({
  title: z.string().trim().min(1).max(200), stage: z.enum(BUSINESS_STAGES),
  description: z.string().trim().max(2000), status: z.enum(['todo', 'in_progress', 'waiting', 'done']),
  depends_on: z.array(z.string().uuid()).max(30), due_on: dueDate,
  owner: z.string().trim().max(100), notes: z.string().trim().max(4000), ticket_id: z.string().uuid().nullable(),
});
export const taskEntrySchema = z.object({
  request_id: z.string().uuid(),
  kind: z.enum(['progress', 'result', 'decision', 'request', 'resolution']),
  content: z.string().trim().min(1).max(20000),
  resolves_entry_id: z.string().uuid().nullable().default(null),
}).refine(v => (v.kind === 'resolution') === !!v.resolves_entry_id, '처리 기록에는 같은 업무의 추가·수정 요청을 지정하세요.');
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new BadRequestException(result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
  return result.data;
}

@Injectable()
export class BusinessService {
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly tickets: TicketService) {}

  async company(id: string, accountId: string, manager = this.ds.manager): Promise<BusinessCompany> {
    if (!accountId) throw new BadRequestException('소유 계정을 확인하지 못했습니다.');
    const company = await manager.getRepository(BusinessCompany).findOneBy({ id, account_id: accountId });
    if (!company) throw new NotFoundException('회사를 찾을 수 없습니다.');
    return company;
  }

  async event(manager: EntityManager, company: BusinessCompany, actor: string, kind: string, message: string) {
    await manager.getRepository(BusinessEvent).save({ company_id: company.id, account_id: company.account_id, actor_id: actor, kind, message: message.slice(0, 500) });
  }

  /** Claim the company row before changing its task graph, on both SQL backends. */
  async claim(manager: EntityManager, id: string, accountId: string, revision: unknown) {
    if (!Number.isSafeInteger(revision) || Number(revision) < 0) throw new BadRequestException('revision이 필요합니다.');
    const company = await this.company(id, accountId, manager);
    const result = await manager.getRepository(BusinessCompany).update({ id, account_id: accountId, revision: Number(revision) }, { revision: Number(revision) + 1 });
    if (result.affected !== 1) throw new ConflictException('다른 화면에서 변경되었습니다. 새로고침 후 다시 저장하세요.');
    company.revision = Number(revision) + 1;
    return company;
  }

  async list(accountIds: string[]) {
    if (!accountIds.length) return [];
    const companies = await this.ds.getRepository(BusinessCompany).find({ where: { account_id: In(accountIds) }, order: { created_at: 'ASC' } });
    if (!companies.length) return [];
    const tasks = await this.ds.getRepository(BusinessTask).find({ where: { account_id: In(accountIds), company_id: In(companies.map(c => c.id)) } });
    return companies.map(c => ({ ...c, task_count: tasks.filter(t => t.company_id === c.id).length, done_count: tasks.filter(t => t.company_id === c.id && t.status === 'done').length }));
  }

  async detail(id: string, accountId: string, canViewMarketing = false) {
    const company = await this.company(id, accountId);
    const [formations, tasks, connections, events, campaigns] = await Promise.all([
      this.ds.getRepository(BusinessFormation).find({ where: { company_id: id, account_id: accountId }, order: { created_at: 'DESC' } }),
      this.ds.getRepository(BusinessTask).find({ where: { company_id: id, account_id: accountId }, order: { position: 'ASC', created_at: 'ASC' } }),
      this.ds.getRepository(BusinessConnection).find({ where: { company_id: id, account_id: accountId }, order: { created_at: 'ASC' } }),
      this.ds.getRepository(BusinessEvent).find({ where: { company_id: id, account_id: accountId }, order: { created_at: 'DESC', id: 'DESC' }, take: 40 }),
      canViewMarketing && company.campaign_ids.length ? this.ds.getRepository(MarketingCampaign).find({
        where: { id: In(company.campaign_ids), account_id: accountId }, select: ['id', 'name', 'status', 'goal', 'cycle_count', 'next_cycle_at'],
      }) : [],
    ]);
    const ids = tasks.map(t => t.ticket_id).filter((v): v is string => !!v);
    const tickets = ids.length ? await this.ds.getRepository(Ticket).find({ where: { id: In(ids), account_id: accountId }, select: ['id', 'title', 'status'] }) : [];
    return { company, formations: formations.map(({ customer_id, encrypted_request, credential_digest, ...safe }) => safe), tasks: tasks.map(task => ({ ...task,
      blocked_by: task.depends_on.filter(id => tasks.find(t => t.id === id)?.status !== 'done'),
      ticket: tickets.find(t => t.id === task.ticket_id) || null,
    })), connections, events, campaigns };
  }

  private async checkCampaigns(ids: string[], accountId: string, canViewMarketing: boolean, manager: EntityManager) {
    if (!ids.length) return;
    if (!canViewMarketing) throw new BadRequestException('캠페인을 연결하려면 마케팅 조회 권한이 필요합니다.');
    if (new Set(ids).size !== ids.length) throw new BadRequestException('같은 캠페인을 두 번 연결할 수 없습니다.');
    const count = await manager.getRepository(MarketingCampaign).countBy({ id: In(ids), account_id: accountId });
    if (count !== ids.length) throw new BadRequestException('같은 소유 계정의 캠페인만 연결할 수 있습니다.');
  }

  async create(accountId: string, body: unknown, actor: string, canViewMarketing: boolean) {
    if (!accountId) throw new BadRequestException('소유 계정을 확인하지 못했습니다.');
    const input = parse(companySchema, { entity_type: 'LLC', country: 'US', jurisdiction: '', description: '', campaign_ids: [], ...(body && typeof body === 'object' ? body : {}) });
    return this.ds.transaction(async manager => {
      await this.checkCampaigns(input.campaign_ids, accountId, canViewMarketing, manager);
      const company = await manager.getRepository(BusinessCompany).save({ ...input, account_id: accountId });
      const ids = new Map(BUSINESS_TEMPLATE.map(t => [t.key, randomUUID()]));
      await manager.getRepository(BusinessTask).save(BUSINESS_TEMPLATE.map((t, position) => ({
        id: ids.get(t.key), account_id: accountId, company_id: company.id, title: t.title, stage: t.stage, description: t.description,
        status: 'todo' as const, depends_on: t.requires.map(key => ids.get(key)!), due_on: null, owner: '', notes: '', ticket_id: null, position,
      })));
      await this.event(manager, company, actor, 'company', `${company.name}의 운영 워크플로를 만들었습니다.`);
      return company;
    });
  }

  async update(id: string, accountId: string, body: any, actor: string, canViewMarketing: boolean) {
    const input = parse(companySchema.partial(), body);
    if (!Object.keys(input).length) throw new BadRequestException('변경할 회사 정보를 입력하세요.');
    return this.ds.transaction(async manager => {
      const company = await this.claim(manager, id, accountId, body?.revision);
      if (input.campaign_ids) await this.checkCampaigns(input.campaign_ids, accountId, canViewMarketing, manager);
      const resetConditions = ['name', 'country', 'entity_type', 'jurisdiction'].some(key => key in input && input[key] !== company[key]);
      if (resetConditions) company.self_service = {};
      await manager.getRepository(BusinessCompany).update({ id, account_id: accountId }, { ...input, ...(resetConditions ? { self_service: {} } : {}) });
      await this.event(manager, company, actor, 'company', '회사 정보와 연결 캠페인을 수정했습니다.');
      return { ...company, ...input };
    });
  }

  async initializeTrademark(id: string, accountId: string, revision: unknown, actor: string) {
    return this.ds.transaction(async manager => {
      const company = await this.claim(manager, id, accountId, revision);
      const repo = manager.getRepository(BusinessTask);
      const tasks = await repo.findBy({ company_id: id, account_id: accountId });
      if (tasks.some(task => task.stage === 'trademark')) return { created: 0 };
      const template = BUSINESS_TEMPLATE.filter(task => task.stage === 'trademark');
      if (tasks.length + template.length > 200) throw new BadRequestException('회사당 업무 한도 200개를 확인하세요.');
      const ids = new Map(template.map(task => [task.key, randomUUID()]));
      const offset = Math.max(-1, ...tasks.map(task => task.position)) + 1;
      await repo.save(template.map((task, index) => ({ id: ids.get(task.key), company_id: id, account_id: accountId, stage: task.stage,
        title: task.title, description: task.description, status: 'todo' as const, depends_on: task.requires.map(key => ids.get(key)!),
        due_on: null, owner: '', notes: '', ticket_id: null, position: offset + index })));
      await this.event(manager, company, actor, 'task', '상표 출원부터 유지·갱신까지의 기본 업무를 추가했습니다.');
      return { created: template.length };
    });
  }

  async chooseService(id: string, accountId: string, stage: string, body: any, actor: string) {
    const input = parse(z.object({ provider: z.string(), plan: z.string(), revision: z.number().int().nonnegative(), self_service_answers: selfAnswersSchema.optional() }), body);
    const descriptor = businessConnector(input.provider).descriptor;
    if (descriptor.stage !== stage || !descriptor.offering?.pricing.plans.some(p => p.id === input.plan)) throw new BadRequestException('영역과 서비스 플랜을 확인하세요.');
    return this.ds.transaction(async manager => {
      const company = await this.claim(manager, id, accountId, input.revision);
      if (isSelfProvider(input.provider)) {
        const assessment = assessSelfService(company, input.provider, input.plan, input.self_service_answers || {});
        if (!assessment.eligible) throw new BadRequestException(['직접 처리 조건을 확인하세요.', ...assessment.blockers, ...assessment.unanswered.map(key => `미응답: ${key}`)].join(' '));
        company.self_service = { ...company.self_service, [input.provider]: { answers: assessment.answers, version: SELF_SERVICE_VERSION, confirmed_at: new Date().toISOString(), actor_id: actor } };
      }
      company.service_choices = { ...company.service_choices, [stage]: { provider: input.provider, plan: input.plan } };
      await manager.getRepository(BusinessCompany).update({ id, account_id: accountId }, { service_choices: company.service_choices, self_service: company.self_service });
      await this.event(manager, company, actor, 'service_choice', `${descriptor.name} 서비스 선택을 저장했습니다. 가입·구매는 실행되지 않았습니다.`);
      return company;
    });
  }

  async assessSelfService(id: string, accountId: string, provider: string, plan: string, answers?: Record<string, boolean>) {
    const company = await this.company(id, accountId);
    const saved = company.self_service?.[provider];
    const assessment = assessSelfService(company, provider, plan, answers ?? saved?.answers ?? {});
    const stale = answers === undefined && saved?.version !== SELF_SERVICE_VERSION;
    return { ...assessment, eligible: assessment.eligible && !stale, stale, company_revision: company.revision, confirmed_at: saved?.confirmed_at || null };
  }

  async saveTask(id: string, accountId: string, taskId: string | null, body: any, actor: string) {
    const patch = parse(taskSchema.partial(), body);
    return this.ds.transaction(async manager => {
      const company = await this.claim(manager, id, accountId, body?.revision);
      const tasks = await manager.getRepository(BusinessTask).findBy({ company_id: id, account_id: accountId });
      const existing = taskId ? tasks.find(t => t.id === taskId) : null;
      if (taskId && !existing) throw new NotFoundException('업무를 찾을 수 없습니다.');
      if (!taskId && tasks.length >= 200) throw new BadRequestException('회사당 업무는 최대 200개입니다.');
      const task = { ...(existing || { id: randomUUID(), company_id: id, account_id: accountId, status: 'todo', description: '', notes: '', owner: '', due_on: null, ticket_id: null, depends_on: [], position: Math.max(-1, ...tasks.map(t => t.position)) + 1 }), ...patch } as BusinessTask;
      parse(taskSchema, task);
      task.depends_on = [...new Set(task.depends_on)];
      if (task.depends_on.some(dep => dep === task.id || !tasks.some(t => t.id === dep))) throw new BadRequestException('선행 업무는 같은 회사의 다른 업무여야 합니다.');
      const graph = [...tasks.filter(t => t.id !== task.id), task];
      const visited = new Set<string>();
      const visit = (current: string, path: Set<string>) => {
        if (path.has(current)) throw new BadRequestException('선행 업무가 순환합니다.');
        if (visited.has(current)) return;
        const next = new Set(path).add(current);
        for (const dep of graph.find(t => t.id === current)?.depends_on || []) visit(dep, next);
        visited.add(current);
      };
      visit(task.id, new Set());
      for (const item of graph) {
        if (['in_progress', 'done'].includes(item.status) && item.depends_on.some(dep => graph.find(t => t.id === dep)?.status !== 'done')) {
          throw new ConflictException('먼저 선행 업무를 완료하세요. 완료를 취소하려면 이어지는 업무부터 다시 할 일로 옮기세요.');
        }
      }
      if (task.ticket_id && !await manager.getRepository(Ticket).existsBy({ id: task.ticket_id, account_id: accountId })) {
        throw new BadRequestException('같은 소유 계정의 티켓만 연결할 수 있습니다.');
      }
      const saved = await manager.getRepository(BusinessTask).save(task);
      const labels = { todo: '할 일', in_progress: '진행 중', waiting: '외부 응답 대기', done: '완료' };
      const changes = Object.fromEntries(Object.keys(patch).filter(key => JSON.stringify(existing?.[key]) !== JSON.stringify(saved[key]))
        .map(key => [key, { before: existing?.[key] ?? null, after: saved[key] }]));
      if (existing && Object.keys(changes).length) {
        const user = actor.startsWith('mcp:') ? null : await manager.getRepository(User).findOneBy({ id: actor });
        await manager.getRepository(BusinessTaskEntry).save({ account_id: accountId, company_id: id, task_id: saved.id,
          kind: 'change', content: existing ? '업무 정보를 수정했습니다.' : '업무를 등록했습니다.', changes,
          actor_id: actor, author: user?.name || (actor.startsWith('mcp:') ? 'MCP' : 'User'), author_type: actor.startsWith('mcp:') ? 'agent' : 'user',
          revision: company.revision, resolves_entry_id: null });
      }
      await this.event(manager, company, actor, 'task', `${task.title} · ${labels[task.status]}`);
      return saved;
    });
  }

  async taskDetail(id: string, accountId: string, taskId: string, before?: number) {
    const company = await this.company(id, accountId);
    const tasks = await this.ds.getRepository(BusinessTask).findBy({ company_id: id, account_id: accountId });
    const task = tasks.find(t => t.id === taskId);
    if (!task) throw new NotFoundException('업무를 찾을 수 없습니다.');
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 0)) throw new BadRequestException('기록 커서를 확인하세요.');
    const where = { account_id: accountId, company_id: id, task_id: taskId };
    const repo = this.ds.getRepository(BusinessTaskEntry);
    const page = repo.createQueryBuilder('entry').where(where).orderBy('entry.revision', 'DESC').addOrderBy('entry.id', 'DESC').take(51);
    if (before !== undefined) page.andWhere('entry.revision < :before', { before });
    const [entries, result, decision, requests, ticket] = await Promise.all([
      page.getMany(),
      repo.findOne({ where: { ...where, kind: 'result' }, order: { revision: 'DESC' } }),
      repo.findOne({ where: { ...where, kind: 'decision' }, order: { revision: 'DESC' } }),
      repo.createQueryBuilder('entry').where(where).andWhere('entry.kind = :kind', { kind: 'request' })
        .leftJoin(BusinessTaskEntry, 'resolution', 'resolution.resolves_entry_id = entry.id AND resolution.task_id = entry.task_id AND resolution.account_id = entry.account_id')
        .andWhere('resolution.id IS NULL').orderBy('entry.revision', 'ASC').getMany(),
      task.ticket_id ? this.ds.getRepository(Ticket).findOne({ where: { id: task.ticket_id, account_id: accountId }, select: ['id', 'title', 'status'] }) : null,
    ]);
    const requestIds = entries.slice(0, 50).map(entry => entry.resolves_entry_id).filter((value): value is string => !!value);
    const referencedRequests = requestIds.length ? await repo.find({ where: { ...where, id: In(requestIds), kind: 'request' }, select: ['id', 'content', 'author', 'created_at'] }) : [];
    return { task: { ...task, blocked_by: task.depends_on.filter(dep => tasks.find(t => t.id === dep)?.status !== 'done'), ticket },
      company_revision: company.revision, entries: entries.slice(0, 50).map(entry => ({ ...entry, request: referencedRequests.find(request => request.id === entry.resolves_entry_id) || null })), next_before: entries.length > 50 ? entries[49].revision : null,
      result, decision, open_requests: requests };
  }

  async addTaskEntry(id: string, accountId: string, taskId: string, body: unknown, actor: TicketActor) {
    const input = parse(taskEntrySchema, body);
    return this.ds.transaction(async manager => {
      const company = await this.company(id, accountId, manager);
      const task = await manager.getRepository(BusinessTask).findOneBy({ id: taskId, company_id: id, account_id: accountId });
      if (!task) throw new NotFoundException('업무를 찾을 수 없습니다.');
      const repo = manager.getRepository(BusinessTaskEntry);
      const existing = await repo.findOneBy({ id: input.request_id });
      if (existing) {
        if (existing.account_id !== accountId || existing.company_id !== id || existing.task_id !== taskId || existing.actor_id !== actor.id
          || existing.kind !== input.kind || existing.content !== input.content || existing.resolves_entry_id !== input.resolves_entry_id) {
          throw new ConflictException('다른 내용에 사용한 요청 ID입니다.');
        }
        return existing;
      }
      // Claim before validating a resolution, so concurrent answers cannot both close one request.
      const claimed = await this.claim(manager, id, accountId, company.revision);
      if (input.resolves_entry_id) {
        const request = await repo.findOneBy({ id: input.resolves_entry_id, account_id: accountId, company_id: id, task_id: taskId, kind: 'request' });
        if (!request) throw new BadRequestException('같은 업무의 추가·수정 요청만 처리할 수 있습니다.');
        if (await repo.existsBy({ task_id: taskId, resolves_entry_id: request.id })) throw new ConflictException('이미 처리 기록이 있습니다. 새로고침하세요.');
      }
      const entry = await repo.save({ id: input.request_id, account_id: accountId, company_id: id, task_id: taskId,
        kind: input.kind, content: input.content, resolves_entry_id: input.resolves_entry_id, changes: null,
        actor_id: actor.id, author: actor.name, author_type: actor.type, revision: claimed.revision });
      await this.event(manager, claimed, actor.id, 'task_entry', `${task.title} · ${input.kind === 'request' ? '추가·수정 요청' : '진행 기록 추가'}`);
      return entry;
    });
  }

  async createTaskTicket(id: string, accountId: string, taskId: string, revision: unknown, actor: TicketActor) {
    const company = await this.company(id, accountId);
    const task = await this.ds.getRepository(BusinessTask).findOneBy({ id: taskId, company_id: id, account_id: accountId });
    if (!task) throw new NotFoundException('업무를 찾을 수 없습니다.');
    const summary = (ticket: Ticket) => ({ id: ticket.id, title: ticket.title, status: ticket.status });
    // A retry returns the already linked ticket even when the caller's revision is old.
    if (task.ticket_id) {
      const linked = await this.ds.getRepository(Ticket).findOneBy({ id: task.ticket_id, account_id: accountId });
      if (!linked) throw new ConflictException('연결된 티켓이 삭제되었습니다. 업무에서 기존 티켓 연결을 해제한 뒤 다시 만드세요.');
      return { ticket: summary(linked) };
    }
    const description = [
      `회사: ${company.name} (${company.entity_type}, ${[company.country, company.jurisdiction].filter(Boolean).join(' · ')})`,
      `업무: ${task.title}`,
      task.description,
      task.owner ? `업무 담당: ${task.owner}` : '',
      task.due_on ? `기한: ${task.due_on}` : '',
      task.notes ? `진행 메모:\n${task.notes}` : '',
      `[업무의 과정과 결과 열기](/business/operations?company=${id}&stage=${task.stage}&task=${taskId})`,
      `Business 업무 ID: ${taskId}. get_business_task로 기존 결과·결정·추가 요청을 읽고, add_business_task_entry로 진행·결과·결정을 이 업무에 남기세요. 수정 요청 처리 후 resolution과 resolves_entry_id로 연결하세요.`,
      '담당 에이전트와 실행 상태를 지정해 진행하세요. 결과 확인 후 회사 워크플로의 업무도 완료로 표시하세요.',
    ].filter(Boolean).join('\n\n');
    const { ticket } = await this.tickets.create(accountId, {
      title: `[${company.name}] ${task.title}`, description,
      status: parseTicketStatus('backlog'), assignee: null, tags: ['business', task.stage],
    }, actor, async (manager, created) => {
      const claimed = await this.claim(manager, id, accountId, revision);
      const tasks = await manager.getRepository(BusinessTask).findBy({ company_id: id, account_id: accountId });
      const current = tasks.find(t => t.id === taskId);
      if (!current) throw new NotFoundException('업무를 찾을 수 없습니다.');
      if (current.ticket_id) throw new ConflictException('이미 연결된 티켓이 있습니다. 워크플로를 새로고침하세요.');
      if (current.status === 'done' || current.depends_on.some(dep => tasks.find(t => t.id === dep)?.status !== 'done')) {
        throw new ConflictException('선행 업무를 완료한 미완료 업무에서 티켓을 만들 수 있습니다.');
      }
      await manager.getRepository(BusinessTask).update({ id: taskId, company_id: id, account_id: accountId }, { ticket_id: created.id });
      await manager.getRepository(BusinessTaskEntry).save({ account_id: accountId, company_id: id, task_id: taskId,
        kind: 'change', content: '실행 티켓을 연결했습니다.', changes: { ticket_id: { before: null, after: created.id } },
        actor_id: actor.id, author: actor.name, author_type: actor.type, revision: claimed.revision, resolves_entry_id: null });
      await this.event(manager, claimed, actor.id, 'ticket', `${current.title}의 실행 티켓을 만들었습니다.`);
    });
    return { ticket: summary(ticket) };
  }

  async removeTask(id: string, accountId: string, taskId: string, revision: unknown, actor: string) {
    return this.ds.transaction(async manager => {
      const company = await this.claim(manager, id, accountId, revision);
      const tasks = await manager.getRepository(BusinessTask).findBy({ company_id: id, account_id: accountId });
      const task = tasks.find(t => t.id === taskId);
      if (!task) throw new NotFoundException('업무를 찾을 수 없습니다.');
      if (tasks.some(t => t.depends_on.includes(taskId))) throw new ConflictException('이 업무를 기다리는 후속 업무의 연결을 먼저 해제하세요.');
      if (await manager.getRepository(BusinessTaskEntry).existsBy({ task_id: taskId, company_id: id, account_id: accountId })) {
        throw new ConflictException('진행 기록이 있는 업무는 삭제할 수 없습니다. 기록을 보존하고 상태를 변경하세요.');
      }
      await manager.getRepository(BusinessTask).delete({ id: taskId, company_id: id, account_id: accountId });
      await this.event(manager, company, actor, 'task', `${task.title} 업무를 삭제했습니다.`);
      return { success: true };
    });
  }

  async credentials(accountId: string) {
    // A picker receives names only, even if the caller cannot administer credentials.
    return this.ds.getRepository(Credential).find({ where: { account_id: accountId, agent_env: false }, select: ['id', 'name', 'provider'] });
  }

  async secret(credentialId: string, provider: string, accountId: string) {
    const descriptor = businessConnector(provider).descriptor;
    if (!descriptor.credential_provider) throw new BadRequestException('키를 사용하는 커넥터가 아닙니다.');
    const cred = await this.ds.getRepository(Credential).findOneBy({ id: credentialId, account_id: accountId, agent_env: false, provider: descriptor.credential_provider });
    if (!cred) throw new BadRequestException('이 회사의 소유 계정에 있는 서버 전용 credential을 선택하세요.');
    let fields: Record<string, string>;
    try {
      fields = JSON.parse(decryptStrict(cred.encrypted_data));
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error();
    } catch { throw new BadRequestException('저장된 키를 읽지 못했습니다. Credentials에서 다시 저장하세요.'); }
    for (const key of descriptor.secret_fields) {
      if (typeof fields[key] !== 'string' || !fields[key].trim() || /[\r\n]/.test(fields[key])) throw new BadRequestException(`Credential의 ${key} 값을 확인하세요.`);
    }
    return { fields, encrypted: cred.encrypted_data };
  }

  async connect(id: string, accountId: string, provider: string, body: any, actor: string) {
    await this.company(id, accountId);
    const adapter = businessConnector(provider);
    if (!adapter.sync) throw new BadRequestException('이 서비스는 외부 화면에서 진행합니다.');
    const input = parse(z.object({ credential_id: z.string().uuid(), environment: z.enum(['sandbox', 'live']), config: z.record(z.string(), z.string().trim().max(120)).default({}) }), body);
    if (!adapter.descriptor.environments.includes(input.environment)) throw new BadRequestException('이 환경은 지원하지 않습니다.');
    const fields = adapter.descriptor.fields.map(f => f.key);
    if (Object.keys(input.config).some(k => !fields.includes(k))) throw new BadRequestException('지원하지 않는 연결 설정입니다.');
    for (const key of fields) externalId(input.config[key] || '');
    await this.secret(input.credential_id, provider, accountId);
    return this.ds.transaction(async manager => {
      const company = await this.claim(manager, id, accountId, body?.revision);
      const repo = manager.getRepository(BusinessConnection);
      const existing = await repo.findOneBy({ company_id: id, account_id: accountId, provider });
      const connection = await repo.save({ ...existing, ...input, account_id: accountId, company_id: id, provider,
        status: 'configured' as const, snapshot: null, synced_at: null, attempted_at: null, last_error: '', revision: (existing?.revision || 0) + 1 });
      await this.event(manager, company, actor, 'connector', `${adapter.descriptor.name} 연결 설정을 저장했습니다.`);
      return connection;
    });
  }

  async disconnect(id: string, accountId: string, provider: string, revision: unknown, actor: string) {
    return this.ds.transaction(async manager => {
      const company = await this.claim(manager, id, accountId, revision);
      await manager.getRepository(BusinessConnection).delete({ company_id: id, account_id: accountId, provider });
      await this.event(manager, company, actor, 'connector', `${businessConnector(provider).descriptor.name} 연결을 해제했습니다.`);
      return { success: true };
    });
  }

  async sync(id: string, accountId: string, provider: string, actor: string) {
    const company = await this.company(id, accountId);
    const adapter = businessConnector(provider);
    if (!adapter.sync) throw new BadRequestException('조회 API가 없는 커넥터입니다.');
    const repo = this.ds.getRepository(BusinessConnection);
    const connection = await repo.findOneBy({ company_id: id, account_id: accountId, provider });
    if (!connection) throw new NotFoundException('커넥터를 먼저 연결하세요.');
    if (connection.attempted_at && Date.now() - Date.parse(connection.attempted_at) < (connection.status === 'syncing' ? 60_000 : 10_000)) {
      throw new ConflictException('최근 조회가 진행 중이거나 방금 끝났습니다. 잠시 후 다시 시도하세요.');
    }
    const revision = connection.revision + 1;
    const claim = await repo.update({ id: connection.id, account_id: accountId, revision: connection.revision }, { revision, status: 'syncing', attempted_at: new Date().toISOString() });
    if (claim.affected !== 1) throw new ConflictException('연결 설정이 변경되었습니다. 다시 조회하세요.');
    let patch: Partial<BusinessConnection>;
    try {
      const secret = await this.secret(connection.credential_id, provider, accountId);
      const snapshot = await adapter.sync({ environment: connection.environment, config: connection.config, secrets: secret.fields, get: connectorGet });
      // Recheck ownership/exposure after I/O; credential administration can race a read.
      const current = await this.secret(connection.credential_id, provider, accountId);
      if (current.encrypted !== secret.encrypted) throw new BadRequestException('조회 중 키가 변경되었습니다. 새 키로 다시 조회하세요.');
      patch = { status: 'connected', snapshot, synced_at: new Date().toISOString(), last_error: '' };
    } catch (e) {
      patch = { status: 'error', last_error: e instanceof BadRequestException || (e as any)?.getStatus?.() === 502
        ? (e as Error).message : '외부 서비스 조회에 실패했습니다. 연결 설정과 서비스 상태를 확인하세요.' };
    }
    // Network I/O never holds the DB write queue. A changed/disconnected configuration wins.
    return this.ds.transaction(async manager => {
      const saved = await manager.getRepository(BusinessConnection).update({ id: connection.id, account_id: accountId, revision }, { ...patch, revision: revision + 1 });
      if (saved.affected !== 1) throw new ConflictException('조회 중 연결 설정이 변경되어 응답을 반영하지 않았습니다.');
      await this.event(manager, company, actor, 'sync', `${adapter.descriptor.name} · ${patch.status === 'connected' ? '조회 완료' : '조회 실패'}`);
      return manager.getRepository(BusinessConnection).findOneByOrFail({ id: connection.id, account_id: accountId });
    });
  }
}
