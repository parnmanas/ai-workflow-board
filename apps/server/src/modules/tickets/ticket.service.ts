import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, Not } from 'typeorm';
import { Ticket } from '../../entities/Ticket';
import { Comment } from '../../entities/Comment';
import { TicketPrerequisite } from '../../entities/TicketPrerequisite';
import { Project } from '../../entities/Project';
import { RuntimeHost } from '../../entities/RuntimeHost';
import { ActivityService } from '../../services/activity.service';
import { ProjectsService } from '../projects/projects.service';
import { TicketDispatchService } from '../agents/ticket-dispatch.service';
import { TicketDuplicateService } from './ticket-duplicate.service';
import {
  DEFAULT_TICKET_STATUS,
  isTicketPending,
  parseTicketStatus,
  TICKET_STATUSES,
  type TicketStatus,
} from '../../common/ticket-status';
import { normalizeRuntimeSpec, parseRuntimeSpec, runtimeIdentityKey, RuntimeSpecError, type RuntimeSpec } from '../../common/runtime-spec';
import { PRIORITY_ORDER } from '../agents/priority';
import { validateNextTicketId } from '../mcp/shared/ticket-helpers';

/** Caller mistake; `status` is the HTTP status the REST layer answers with. */
export class TicketInputError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'invalid_ticket') {
    super(message);
    this.name = 'TicketInputError';
  }
}

export interface TicketActor {
  id: string;
  name: string;
  type: 'user' | 'agent' | 'system';
}

export const SYSTEM_ACTOR: TicketActor = { id: '', name: 'AWB', type: 'system' };

export interface TicketListFilter {
  status?: TicketStatus[];
  tags?: string[];
  project_id?: string;
  assignee_key?: string;
  q?: string;
  include_archived?: boolean;
  archived_only?: boolean;
  limit?: number;
}

const MAX_TAGS = 30;
const MAX_TAG_LENGTH = 60;
const VALID_PRIORITIES: readonly string[] = [...PRIORITY_ORDER, 'urgent'];

/** Tags: trimmed, de-duplicated case-insensitively (first spelling wins), bounded. */
export function normalizeTags(input: unknown): string[] {
  let raw: unknown[] = [];
  if (Array.isArray(input)) raw = input;
  else if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.startsWith('[')) {
      try { raw = JSON.parse(trimmed); } catch { raw = trimmed.split(','); }
    } else raw = trimmed.split(',');
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw) {
    const tag = String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_TAG_LENGTH);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

export function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function safeJsonArray(raw: string | null | undefined): any[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function str(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

/**
 * Ticket mutations shared by REST, MCP and the automatic ticket producers
 * (QA/Security failures, CI red, outreach, chat fallbacks). Owning them in one
 * place keeps "what a status change does" — terminal stamps, activity rows,
 * dispatch — identical no matter who made the change. See docs/tickets.md.
 */
@Injectable()
export class TicketService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly activityService: ActivityService,
    private readonly projects: ProjectsService,
    private readonly dispatcher: TicketDispatchService,
    private readonly duplicates: TicketDuplicateService,
  ) {}

  // ── input normalization ───────────────────────────────────────────────

  normalizeAssignee(input: unknown): { assignee: RuntimeSpec | null; assignee_key: string } {
    if (input === null || input === undefined || input === '') return { assignee: null, assignee_key: '' };
    try {
      const spec = normalizeRuntimeSpec(input, 'assignee');
      return { assignee: spec, assignee_key: runtimeIdentityKey(spec) };
    } catch (e) {
      if (e instanceof RuntimeSpecError) throw new TicketInputError(e.message);
      throw e;
    }
  }

  private parseStatusInput(value: unknown): TicketStatus {
    const status = parseTicketStatus(value);
    if (!status) throw new TicketInputError(`status must be one of ${TICKET_STATUSES.join(', ')} (got "${String(value)}")`);
    return status;
  }

  private parsePriority(value: unknown): string {
    const p = str(value).toLowerCase() || 'medium';
    if (!VALID_PRIORITIES.includes(p)) {
      throw new TicketInputError(`priority must be one of ${VALID_PRIORITIES.join(', ')} (got "${p}")`);
    }
    return p === 'urgent' ? 'critical' : p;
  }

  private async resolveProject(workspaceId: string, projectId: unknown, scope: DataSource | EntityManager = this.dataSource): Promise<Project | null> {
    const id = str(projectId);
    if (!id) return null;
    const project = await this.projects.getInWorkspace(id, workspaceId, scope);
    if (!project) throw new TicketInputError(`project ${id} not found in this workspace`, 400, 'project_not_found');
    return project;
  }

  private async nextPosition(scope: DataSource | EntityManager, workspaceId: string, status: TicketStatus): Promise<number> {
    const row = await scope.getRepository(Ticket)
      .createQueryBuilder('t')
      .select('MAX(t.position)', 'max')
      .where('t.workspace_id = :ws AND t.status = :status AND t.parent_id IS NULL', { ws: workspaceId, status })
      .getRawOne();
    const max = Number(row?.max);
    return Number.isFinite(max) ? max + 1 : 0;
  }

  // ── create ────────────────────────────────────────────────────────────

  async create(workspaceId: string, body: any, actor: TicketActor): Promise<{ ticket: Ticket; duplicate_candidates: any[] }> {
    if (!workspaceId) throw new TicketInputError('workspace_id is required');
    body = body || {};
    const title = str(body.title);
    if (!title) throw new TicketInputError('title is required');
    const status = body.status === undefined || body.status === null || body.status === ''
      ? DEFAULT_TICKET_STATUS
      : this.parseStatusInput(body.status);
    const priority = this.parsePriority(body.priority);
    const tags = normalizeTags(body.tags ?? body.labels);
    const project = await this.resolveProject(workspaceId, body.project_id);

    // Explicit `assignee: null` means "nobody"; omitted means "the project's default".
    const assigneeInput = body.assignee !== undefined ? body.assignee : (project?.default_assignee ?? null);
    const { assignee, assignee_key } = this.normalizeAssignee(assigneeInput);

    let nextTicketId: string | null = null;
    if (body.next_ticket_id !== undefined) {
      try {
        nextTicketId = await validateNextTicketId(this.dataSource, body.next_ticket_id, null, workspaceId);
      } catch (e: any) {
        throw new TicketInputError(e?.message || 'next_ticket_id rejected');
      }
    }

    const duplicateAssessment = await this.duplicates.assess(workspaceId, {
      title,
      description: str(body.description),
      tags,
      source_kind: body.source_kind,
      source_chat_room_id: body.source_chat_room_id,
      related_ticket_id: body.related_ticket_id,
    });
    // A follow-up of other work is new, actionable work — landing it in Done
    // would make it invisible to dispatch.
    if (duplicateAssessment.related_ticket_id && status === 'done') {
      throw new TicketInputError('A follow-up ticket (related_ticket_id) cannot be created as done — it would never be worked.');
    }

    const repo = this.dataSource.getRepository(Ticket);
    const position = typeof body.position === 'number' && Number.isFinite(body.position)
      ? Math.max(0, Math.floor(body.position))
      : await this.nextPosition(this.dataSource, workspaceId, status);
    const ticket = await repo.save(repo.create({
      workspace_id: workspaceId,
      title: title.slice(0, 500),
      description: body.description == null ? '' : String(body.description),
      prompt_text: body.prompt_text == null ? '' : String(body.prompt_text),
      priority,
      status,
      tags: JSON.stringify(tags),
      project_id: project?.id ?? null,
      base_branch: str(body.base_branch),
      assignee: assignee as any,
      assignee_key,
      channel_ids: JSON.stringify(Array.isArray(body.channel_ids) ? body.channel_ids : []),
      on_done_action_ids: JSON.stringify(Array.isArray(body.on_done_action_ids) ? body.on_done_action_ids : []),
      next_ticket_id: nextTicketId,
      position,
      parent_id: null,
      depth: 0,
      terminal_entered_at: status === 'done' ? new Date() : null,
      operational_dedupe_key: body.operational_dedupe_key ? String(body.operational_dedupe_key) : null,
      source_kind: duplicateAssessment.source_kind,
      source_chat_room_id: duplicateAssessment.source_chat_room_id,
      related_ticket_id: duplicateAssessment.related_ticket_id,
      canonical_ticket_id: duplicateAssessment.canonical_ticket_id,
      pending_user_action: duplicateAssessment.ambiguous || body.pending_user_action === true,
      pending_reason: duplicateAssessment.ambiguous
        ? 'Confirm whether this chat report duplicates one of the suggested tickets.'
        : (body.pending_user_action === true ? str(body.pending_reason) : ''),
      pending_set_at: duplicateAssessment.ambiguous || body.pending_user_action === true ? new Date() : null,
      pending_set_by: duplicateAssessment.ambiguous ? 'duplicate_decision_guard' : (body.pending_user_action === true ? actor.name : ''),
      created_by: actor.name,
      created_by_type: actor.type === 'system' ? 'agent' : actor.type,
      created_by_id: actor.id,
    }));
    await this.duplicates.record(ticket, duplicateAssessment, actor.name, actor.id);
    await this.activityService.logActivity({
      entity_type: 'ticket', entity_id: ticket.id, ticket_id: ticket.id, workspace_id: workspaceId,
      action: 'created', actor_id: actor.id || undefined, actor_name: actor.name,
    });
    return { ticket, duplicate_candidates: duplicateAssessment.candidates };
  }

  // ── update ────────────────────────────────────────────────────────────

  /**
   * Partial update of the editable fields. `status` is routed to move() so a
   * status change behaves the same whether it arrived via PATCH or /move.
   */
  async update(ticketId: string, body: any, actor: TicketActor): Promise<Ticket> {
    const repo = this.dataSource.getRepository(Ticket);
    const ticket = await repo.findOne({ where: { id: ticketId } });
    if (!ticket) throw new TicketInputError('Ticket not found', 404, 'ticket_not_found');
    if (ticket.archived_at) throw new TicketInputError('Ticket is archived', 409, 'ticket_archived');
    body = body || {};
    const changes: Array<{ field: string; old: string; next: string }> = [];
    const set = (field: keyof Ticket, next: any, display?: (v: any) => string) => {
      const prev = (ticket as any)[field];
      const same = typeof next === 'object' && next !== null ? JSON.stringify(prev) === JSON.stringify(next) : prev === next;
      if (same) return;
      (ticket as any)[field] = next;
      changes.push({ field: String(field), old: display ? display(prev) : String(prev ?? ''), next: display ? display(next) : String(next ?? '') });
    };

    if (body.title !== undefined) {
      const title = str(body.title);
      if (!title) throw new TicketInputError('title cannot be empty');
      set('title', title.slice(0, 500));
    }
    if (body.description !== undefined) set('description', body.description == null ? '' : String(body.description));
    if (body.prompt_text !== undefined) set('prompt_text', body.prompt_text == null ? '' : String(body.prompt_text));
    if (body.priority !== undefined) set('priority', this.parsePriority(body.priority));
    if (body.tags !== undefined || body.labels !== undefined) {
      set('tags', JSON.stringify(normalizeTags(body.tags ?? body.labels)));
    }
    if (body.project_id !== undefined) {
      const project = await this.resolveProject(ticket.workspace_id, body.project_id);
      set('project_id', project?.id ?? null);
    }
    if (body.base_branch !== undefined) set('base_branch', str(body.base_branch));
    if (body.channel_ids !== undefined) set('channel_ids', JSON.stringify(Array.isArray(body.channel_ids) ? body.channel_ids : []));
    if (body.on_done_action_ids !== undefined) {
      set('on_done_action_ids', JSON.stringify(Array.isArray(body.on_done_action_ids) ? body.on_done_action_ids.map(String) : []));
    }
    if (body.next_ticket_id !== undefined) {
      try {
        set('next_ticket_id', await validateNextTicketId(this.dataSource, body.next_ticket_id, ticket.id, ticket.workspace_id));
      } catch (e: any) {
        throw new TicketInputError(e?.message || 'next_ticket_id rejected');
      }
    }
    let assigneeChanged = false;
    if (body.assignee !== undefined) {
      const { assignee, assignee_key } = this.normalizeAssignee(body.assignee);
      if (assignee_key !== ticket.assignee_key || JSON.stringify(assignee) !== JSON.stringify(ticket.assignee)) {
        const prevLabel = parseRuntimeSpec(ticket.assignee)?.label || '';
        ticket.assignee = assignee as any;
        ticket.assignee_key = assignee_key;
        ticket.supervisor_redispatches = 0;
        changes.push({ field: 'assignee', old: prevLabel, next: assignee?.label || '' });
        assigneeChanged = true;
      }
    }

    if (changes.length) {
      await repo.save(ticket);
      for (const change of changes) {
        await this.activityService.logActivity({
          entity_type: 'ticket', entity_id: ticket.id, ticket_id: ticket.id, workspace_id: ticket.workspace_id,
          action: 'updated', field_changed: change.field, old_value: change.old.slice(0, 500), new_value: change.next.slice(0, 500),
          actor_id: actor.id || undefined, actor_name: actor.name,
        });
      }
    }
    if (assigneeChanged && ticket.status === 'in_progress' && ticket.assignee_key && !isTicketPending(ticket)) {
      await this.dispatcher.dispatch(ticket, 'reassigned');
    }
    if (body.status !== undefined && body.status !== null && body.status !== '') {
      return this.move(ticket.id, body.status, actor, { position: body.position });
    }
    return ticket;
  }

  // ── move ──────────────────────────────────────────────────────────────

  async move(ticketId: string, rawStatus: unknown, actor: TicketActor, opts: { position?: unknown } = {}): Promise<Ticket> {
    const status = this.parseStatusInput(rawStatus);
    const repo = this.dataSource.getRepository(Ticket);
    const ticket = await repo.findOne({ where: { id: ticketId } });
    if (!ticket) throw new TicketInputError('Ticket not found', 404, 'ticket_not_found');
    if (ticket.archived_at) throw new TicketInputError('Ticket is archived', 409, 'ticket_archived');
    if (ticket.parent_id) {
      // Children only track done / not done.
      const childStatus: TicketStatus = status === 'done' ? 'done' : 'todo';
      if (ticket.status !== childStatus) {
        const prev = ticket.status;
        ticket.status = childStatus;
        await repo.save(ticket);
        await this.activityService.logActivity({
          entity_type: 'ticket', entity_id: ticket.id, ticket_id: ticket.id, workspace_id: ticket.workspace_id,
          action: 'status_changed', field_changed: 'status', old_value: prev, new_value: childStatus,
          actor_id: actor.id || undefined, actor_name: actor.name,
        });
      }
      return ticket;
    }

    const prev = ticket.status;
    const position = typeof opts.position === 'number' && Number.isFinite(opts.position)
      ? Math.max(0, Math.floor(opts.position))
      : null;
    if (prev === status) {
      if (position !== null && position !== ticket.position) {
        await this.reposition(ticket, status, position);
      }
      return ticket;
    }

    ticket.status = status;
    ticket.position = position ?? await this.nextPosition(this.dataSource, ticket.workspace_id, status);
    ticket.terminal_entered_at = status === 'done' ? new Date() : null;
    if (prev === 'in_progress' || status !== 'in_progress') ticket.supervisor_redispatches = 0;
    await repo.save(ticket);
    if (position !== null) await this.reposition(ticket, status, position);
    await this.activityService.logActivity({
      entity_type: 'ticket', entity_id: ticket.id, ticket_id: ticket.id, workspace_id: ticket.workspace_id,
      action: 'moved', field_changed: 'status', old_value: prev, new_value: status,
      actor_id: actor.id || undefined, actor_name: actor.name,
    });
    // A human dropping a ticket straight into In Progress means "work on it
    // now" — send it even if the agent is at capacity.
    if (status === 'in_progress' && prev !== 'in_progress' && actor.type === 'user') {
      await this.dispatcher.dispatch(ticket, 'manual');
    }
    return ticket;
  }

  /** Place `ticket` at `position` inside its status lane, shifting the others. */
  private async reposition(ticket: Ticket, status: TicketStatus, position: number): Promise<void> {
    const repo = this.dataSource.getRepository(Ticket);
    const lane = await repo.find({
      where: { workspace_id: ticket.workspace_id, status, parent_id: IsNull(), archived_at: IsNull(), id: Not(ticket.id) },
      order: { position: 'ASC', created_at: 'ASC' },
      select: ['id', 'position'],
    });
    const ordered = lane.map((t) => t.id);
    ordered.splice(Math.min(position, ordered.length), 0, ticket.id);
    for (let i = 0; i < ordered.length; i += 1) {
      await repo.update({ id: ordered[i] }, { position: i });
    }
    ticket.position = Math.min(position, ordered.length - 1);
  }

  // ── pend / unpend ─────────────────────────────────────────────────────

  async pend(ticketId: string, reason: string, actor: TicketActor): Promise<Ticket> {
    const repo = this.dataSource.getRepository(Ticket);
    const ticket = await repo.findOne({ where: { id: ticketId } });
    if (!ticket) throw new TicketInputError('Ticket not found', 404, 'ticket_not_found');
    if (ticket.archived_at) throw new TicketInputError('Ticket is archived', 409, 'ticket_archived');
    const was = ticket.pending_user_action;
    ticket.pending_user_action = true;
    ticket.pending_reason = str(reason).slice(0, 2000);
    ticket.pending_set_at = new Date();
    ticket.pending_set_by = actor.name;
    await repo.save(ticket);
    await this.activityService.logActivity({
      entity_type: 'ticket', entity_id: ticket.id, ticket_id: ticket.id, workspace_id: ticket.workspace_id,
      action: 'updated', field_changed: 'pending_user_action', old_value: String(was), new_value: 'true',
      actor_id: actor.id || undefined, actor_name: actor.name,
    });
    return ticket;
  }

  /** Clear the human pend and wake the assignee (todo → queue, in_progress → re-send). */
  async unpend(ticketId: string, actor: TicketActor): Promise<{ ticket: Ticket; dispatched: boolean }> {
    const repo = this.dataSource.getRepository(Ticket);
    const ticket = await repo.findOne({ where: { id: ticketId } });
    if (!ticket) throw new TicketInputError('Ticket not found', 404, 'ticket_not_found');
    if (!ticket.pending_user_action) return { ticket, dispatched: false };
    ticket.pending_user_action = false;
    ticket.pending_reason = '';
    ticket.pending_set_at = null;
    ticket.pending_set_by = '';
    ticket.supervisor_redispatches = 0;
    await repo.save(ticket);
    await this.activityService.logActivity({
      entity_type: 'ticket', entity_id: ticket.id, ticket_id: ticket.id, workspace_id: ticket.workspace_id,
      action: 'updated', field_changed: 'pending_user_action', old_value: 'true', new_value: 'false',
      actor_id: actor.id || undefined, actor_name: actor.name,
    });
    const result = isTicketPending(ticket)
      ? { dispatched: false }
      : await this.dispatcher.resumeTicket(ticket.id, 'unpend');
    return { ticket, dispatched: result.dispatched };
  }

  // ── read ──────────────────────────────────────────────────────────────

  /** Root tickets of a workspace for the Tickets page / list_tickets. */
  async list(workspaceId: string, filter: TicketListFilter = {}): Promise<{ tickets: any[]; tags: Array<{ tag: string; count: number }> }> {
    const repo = this.dataSource.getRepository(Ticket);
    const qb = repo.createQueryBuilder('t')
      .where('t.workspace_id = :ws', { ws: workspaceId })
      .andWhere('t.parent_id IS NULL');
    if (filter.archived_only) qb.andWhere('t.archived_at IS NOT NULL');
    else if (!filter.include_archived) qb.andWhere('t.archived_at IS NULL');
    if (filter.status?.length) qb.andWhere('t.status IN (:...statuses)', { statuses: filter.status });
    if (filter.project_id) qb.andWhere('t.project_id = :pid', { pid: filter.project_id });
    if (filter.assignee_key) qb.andWhere('t.assignee_key = :ak', { ak: filter.assignee_key });
    if (filter.q && filter.q.trim()) {
      qb.andWhere('(LOWER(t.title) LIKE :q OR LOWER(t.description) LIKE :q)', { q: `%${filter.q.trim().toLowerCase()}%` });
    }
    qb.orderBy('t.position', 'ASC').addOrderBy('t.created_at', 'ASC');
    const limit = Math.min(Math.max(filter.limit ?? 2000, 1), 5000);
    qb.take(limit);
    let rows = await qb.getMany();

    // Tag counts are over the status/project/assignee/q-filtered set BEFORE the
    // tag filter, so the picker shows what each extra tag would narrow to.
    const counts = new Map<string, { tag: string; count: number }>();
    for (const row of rows) {
      for (const tag of parseTags(row.tags)) {
        const key = tag.toLowerCase();
        const entry = counts.get(key) || { tag, count: 0 };
        entry.count += 1;
        counts.set(key, entry);
      }
    }
    const wanted = (filter.tags || []).map((t) => t.trim().toLowerCase()).filter(Boolean);
    if (wanted.length) {
      rows = rows.filter((row) => {
        const have = new Set(parseTags(row.tags).map((t) => t.toLowerCase()));
        return wanted.every((t) => have.has(t));
      });
    }
    return {
      tickets: await this.cards(rows),
      tags: [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
    };
  }

  /** Card projection: row fields + comment projection, prerequisite count, children (2 levels). */
  async cards(rows: Ticket[]): Promise<any[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const comments = await this.dataSource.getRepository(Comment)
      .createQueryBuilder('c')
      .select(['c.id', 'c.ticket_id', 'c.type', 'c.status', 'c.created_at'])
      .where('c.ticket_id IN (:...ids)', { ids })
      .orderBy('c.created_at', 'DESC')
      .getMany();
    const commentsByTicket = new Map<string, any[]>();
    for (const c of comments) {
      const list = commentsByTicket.get(c.ticket_id) || [];
      list.push({ id: c.id, ticket_id: c.ticket_id, type: c.type, status: c.status, created_at: c.created_at });
      commentsByTicket.set(c.ticket_id, list);
    }
    const prereqs = await this.dataSource.getRepository(TicketPrerequisite)
      .createQueryBuilder('p')
      .select('p.ticket_id', 'ticket_id')
      .addSelect('COUNT(*)', 'cnt')
      .where('p.ticket_id IN (:...ids)', { ids })
      .groupBy('p.ticket_id')
      .getRawMany();
    const prereqCount = new Map<string, number>(prereqs.map((r: any) => [r.ticket_id, Number(r.cnt)]));
    const children = await this.dataSource.getRepository(Ticket).find({
      where: { parent_id: In(ids) },
      relations: ['children'],
      order: { position: 'ASC' },
    });
    const childrenByParent = new Map<string, Ticket[]>();
    for (const child of children) {
      const list = childrenByParent.get(child.parent_id!) || [];
      list.push(child);
      childrenByParent.set(child.parent_id!, list);
    }
    const projectIds = [...new Set(rows.map((r) => r.project_id).filter((v): v is string => !!v))];
    const projectRows = projectIds.length
      ? await this.dataSource.getRepository(Project).find({ where: { id: In(projectIds) } })
      : [];
    const projectById = new Map(projectRows.map((p) => [p.id, p]));
    const hostNames = await this.hostNames(rows);
    return rows.map((row) => ({
      ...this.serialize(row, { project: projectById.get(row.project_id || '') ?? null, hostNames }),
      comments: commentsByTicket.get(row.id) || [],
      prerequisite_count: prereqCount.get(row.id) || 0,
      children: (childrenByParent.get(row.id) || []).map((child) => ({
        ...this.serialize(child, { project: null, hostNames }),
        children: (child.children || []).sort((a, b) => a.position - b.position).map((gc) => this.serialize(gc, { project: null, hostNames })),
      })),
    }));
  }

  private async hostNames(rows: Ticket[]): Promise<Map<string, string>> {
    const ids = [...new Set(rows.map((r) => parseRuntimeSpec(r.assignee)?.manager_agent_id).filter((v): v is string => !!v))];
    if (ids.length === 0) return new Map();
    const hosts = await this.dataSource.getRepository(RuntimeHost).find({ where: { id: In(ids) } });
    return new Map(hosts.map((h) => [h.id, h.name]));
  }

  /**
   * The JSON shape every ticket read returns: JSON-string columns decoded,
   * the assignee as a RuntimeSpec plus a `<Host>/<label>` display name, and a
   * compact project summary.
   */
  serialize(row: Ticket, extra: { project?: Project | null; hostNames?: Map<string, string> } = {}): any {
    const spec = parseRuntimeSpec(row.assignee);
    const hostName = spec ? extra.hostNames?.get(spec.manager_agent_id) || '' : '';
    return {
      ...row,
      tags: parseTags(row.tags),
      channel_ids: safeJsonArray(row.channel_ids),
      on_done_action_ids: safeJsonArray(row.on_done_action_ids),
      assignee: spec,
      assignee_name: spec ? (hostName ? `${hostName}/${spec.label}` : spec.label) : '',
      project: extra.project ? this.projects.summary(extra.project) : (extra.project === null ? null : undefined),
    };
  }

  /** Distinct tags in use across the workspace — the tag picker's suggestions. */
  async tagSuggestions(workspaceId: string): Promise<Array<{ tag: string; count: number }>> {
    const rows = await this.dataSource.getRepository(Ticket).find({
      select: ['id', 'tags'],
      where: { workspace_id: workspaceId, archived_at: IsNull() },
    });
    const counts = new Map<string, { tag: string; count: number }>();
    for (const row of rows) {
      for (const tag of parseTags(row.tags)) {
        const key = tag.toLowerCase();
        const entry = counts.get(key) || { tag, count: 0 };
        entry.count += 1;
        counts.set(key, entry);
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }
}
