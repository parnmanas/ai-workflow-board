import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, In } from 'typeorm';
import { Feature, FeatureChainProposal, FeatureProposedTicket } from '../../entities/Feature';
import { Ticket } from '../../entities/Ticket';
import { Board } from '../../entities/Board';
import { BoardColumn } from '../../entities/BoardColumn';
import { Agent } from '../../entities/Agent';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { ActivityService } from '../../services/activity.service';
import { LogService } from '../../services/log.service';
import { RoomMessagingService } from '../chat-rooms/room-messaging.service';
import { TicketRoleAssignmentService } from '../workspace-roles/ticket-role-assignment.service';
import { TicketPrerequisitesService } from '../tickets/ticket-prerequisites.service';
import { TriggerLoopService } from '../agents/trigger-loop.service';
import { isTerminalColumn } from '../mcp/shared/archive-helpers';
import { parseDefaultRoleAssignments } from '../../common/default-role-assignments-config';
import {
  findColumnByName,
  maxTicketPosition,
  refreshTicketWorkspaceId,
  resolveAgentIdAndName,
} from '../mcp/shared/ticket-helpers';

export interface CreateFeatureInput {
  workspace_id: string;
  board_id?: string | null;
  title: string;
  requirement: string;
  planner_agent_id?: string;
  source_chat_room_id?: string;
  created_by?: string;
  created_by_id?: string;
  // Auto-dispatch the planning round immediately after intake (default true).
  auto_plan?: boolean;
}

export interface FeatureRollup {
  total: number;
  done: number;
  tickets: Array<{
    id: string;
    title: string;
    column_id: string | null;
    column_name: string | null;
    terminal: boolean;
  }>;
}

/**
 * FeaturesService — the Feature/Epic intake pipeline (ticket aae7644c).
 *
 * Turns one requirement into a running board chain by composing EXISTING
 * mechanisms (no new execution engine):
 *   - planning dispatch reuses the WorkspaceSchedule/QA-run chat-room spawn shape
 *     (new room → seat the planner agent → send the task prompt),
 *   - the approved chain is plain tickets wired with `ticket_prerequisites`
 *     (48d14fff) so the trigger loop drives them (first ticket dispatched,
 *     dependents auto-resume when their blocker reaches a terminal column).
 */
@Injectable()
export class FeaturesService {
  constructor(
    @InjectRepository(Feature) private readonly featureRepo: Repository<Feature>,
    @InjectRepository(ChatRoom) private readonly roomRepo: Repository<ChatRoom>,
    @InjectRepository(ChatRoomParticipant) private readonly participantRepo: Repository<ChatRoomParticipant>,
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    @InjectRepository(BoardColumn) private readonly colRepo: Repository<BoardColumn>,
    @InjectRepository(Board) private readonly boardRepo: Repository<Board>,
    private readonly dataSource: DataSource,
    private readonly activityService: ActivityService,
    private readonly logService: LogService,
    private readonly messaging: RoomMessagingService,
    private readonly roleAssignmentService: TicketRoleAssignmentService,
    private readonly prereqService: TicketPrerequisitesService,
    private readonly triggerLoop: TriggerLoopService,
  ) {}

  // ── Reads ────────────────────────────────────────────────────────────────

  async list(workspaceId: string, boardId?: string | null): Promise<Feature[]> {
    const where: any = { workspace_id: workspaceId };
    if (boardId) where.board_id = boardId;
    return this.featureRepo.find({ where, order: { created_at: 'DESC' } });
  }

  async get(id: string): Promise<Feature> {
    const row = await this.featureRepo.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Feature not found');
    return row;
  }

  /**
   * Progress rollup over the generated chain. Lazily flips status → 'done' when
   * every generated ticket has reached a terminal column (kept out of a cron —
   * computed on read, persisted when it changes).
   */
  async rollup(feature: Feature): Promise<FeatureRollup> {
    const ids = feature.generated_ticket_ids || [];
    if (ids.length === 0) return { total: 0, done: 0, tickets: [] };

    const tickets = ids.length ? await this.dataSource.getRepository(Ticket).find({ where: { id: In(ids) } }) : [];
    const colIds = Array.from(new Set(tickets.map((t) => t.column_id).filter(Boolean))) as string[];
    const cols = colIds.length ? await this.colRepo.find({ where: { id: In(colIds) } }) : [];
    const colById = new Map(cols.map((c) => [c.id, c]));

    const rows = tickets.map((t) => {
      const col = t.column_id ? colById.get(t.column_id) : undefined;
      const terminal = isTerminalColumn(col || null);
      return {
        id: t.id,
        title: t.title,
        column_id: t.column_id,
        column_name: col?.name ?? null,
        terminal,
      };
    });
    const done = rows.filter((r) => r.terminal).length;

    // Persist done transition once (idempotent).
    if (rows.length > 0 && done === rows.length && feature.status === 'running') {
      feature.status = 'done';
      await this.featureRepo.save(feature);
    }

    return { total: rows.length, done, tickets: rows };
  }

  // ── Intake + planning dispatch ─────────────────────────────────────────────

  async create(input: CreateFeatureInput): Promise<Feature> {
    const title = (input.title || '').trim();
    const requirement = (input.requirement || '').trim();
    if (!title) throw new BadRequestException('title is required');
    if (!requirement) throw new BadRequestException('requirement is required');
    if (!input.workspace_id) throw new BadRequestException('workspace_id is required');

    const feature = await this.featureRepo.save(this.featureRepo.create({
      workspace_id: input.workspace_id,
      board_id: input.board_id || null,
      title,
      requirement,
      status: 'draft',
      planner_agent_id: (input.planner_agent_id || input.created_by_id || '').trim(),
      source_chat_room_id: (input.source_chat_room_id || '').trim(),
      created_by: input.created_by || '',
      proposal: null,
      generated_ticket_ids: null,
    }));

    if (input.auto_plan !== false) {
      try {
        await this.dispatchPlanning(feature.id);
      } catch (e: any) {
        // Intake still succeeds even if the dispatch fails — the UI can retry.
        this.logService.warn('Features', `auto-plan dispatch failed for ${feature.id}: ${e?.message || e}`);
      }
      return this.get(feature.id);
    }
    return feature;
  }

  /**
   * Dispatch a planning round to the planner agent — a fresh chat room seating
   * the target agent + a synthetic 'system' user, opened with the planning
   * prompt (the WorkspaceSchedule/QA-run dispatch shape). The agent is expected
   * to research, then call `propose_feature_chain` with a structured chain.
   */
  async dispatchPlanning(featureId: string): Promise<{ room_id: string; agent_id: string }> {
    const feature = await this.get(featureId);
    const plannerId = feature.planner_agent_id.trim();
    if (!plannerId) {
      throw new BadRequestException('planner_agent_id is required to dispatch planning');
    }
    const agent = await this.agentRepo.findOne({ where: { id: plannerId } });
    if (!agent) throw new BadRequestException('planner agent not found');
    if (agent.workspace_id && agent.workspace_id !== feature.workspace_id) {
      throw new BadRequestException('planner agent belongs to a different workspace');
    }

    const room = await this.roomRepo.save(this.roomRepo.create({
      workspace_id: feature.workspace_id,
      type: 'group',
      name: `Feature planning: ${feature.title}`.slice(0, 200),
      last_message_at: null,
    }));

    const joinedAt = new Date();
    await this.participantRepo.save([
      this.participantRepo.create({
        room_id: room.id,
        participant_type: 'agent',
        participant_id: agent.id,
        last_read_at: joinedAt,
        left_at: null,
      }),
      this.participantRepo.create({
        room_id: room.id,
        participant_type: 'user',
        participant_id: 'system',
        last_read_at: joinedAt,
        left_at: null,
      }),
    ]);

    const prompt = await this._buildPlanningPrompt(feature);
    try {
      await this.messaging.sendMessage(room.id, feature.workspace_id, 'user', 'system', 'Feature Intake', prompt);
    } catch (e: any) {
      this.logService.warn('Features', `planning sendMessage failed for ${feature.id}: ${e?.message || e}`);
    }

    feature.planning_room_id = room.id;
    feature.status = 'planning';
    await this.featureRepo.save(feature);
    this.logService.info('Features', `dispatched planning for feature ${feature.id} → agent ${agent.id} room ${room.id}`);
    return { room_id: room.id, agent_id: agent.id };
  }

  // ── Proposal (planner deliverable) ─────────────────────────────────────────

  /**
   * Store a structured chain proposal from the planner and move to `proposed`
   * (awaiting approval). Light validation only — the heavy prerequisite cycle
   * check runs when the chain is actually built on approval.
   */
  async proposeChain(featureId: string, proposalRaw: FeatureChainProposal): Promise<Feature> {
    const feature = await this.get(featureId);
    const proposal = this._validateProposal(proposalRaw);
    feature.proposal = proposal;
    feature.status = 'proposed';
    await this.featureRepo.save(feature);
    this.logService.info('Features', `proposal received for feature ${feature.id} (${proposal.tickets.length} tickets, ${(proposal.edges || []).length} edges)`);
    return feature;
  }

  private _validateProposal(raw: FeatureChainProposal): FeatureChainProposal {
    if (!raw || !Array.isArray(raw.tickets) || raw.tickets.length === 0) {
      throw new BadRequestException('proposal.tickets must be a non-empty array');
    }
    const keys = new Set<string>();
    const tickets: FeatureProposedTicket[] = raw.tickets.map((t, i) => {
      const key = (t.key || '').trim();
      if (!key) throw new BadRequestException(`proposal.tickets[${i}].key is required`);
      if (keys.has(key)) throw new BadRequestException(`duplicate proposal ticket key "${key}"`);
      keys.add(key);
      const title = (t.title || '').trim();
      if (!title) throw new BadRequestException(`proposal.tickets[${i}].title is required`);
      return {
        key,
        title,
        description: t.description || '',
        priority: t.priority,
        labels: Array.isArray(t.labels) ? t.labels : undefined,
        effort_preset: t.effort_preset ?? undefined,
        column_name: t.column_name || undefined,
        assignee_id: t.assignee_id || undefined,
        reporter_id: t.reporter_id || undefined,
        reviewer_id: t.reviewer_id || undefined,
      };
    });
    const edges = (raw.edges || []).map((e, i) => {
      const from = (e.from || '').trim();
      const to = (e.to || '').trim();
      if (!keys.has(from)) throw new BadRequestException(`edges[${i}].from "${from}" is not a proposal ticket key`);
      if (!keys.has(to)) throw new BadRequestException(`edges[${i}].to "${to}" is not a proposal ticket key`);
      if (from === to) throw new BadRequestException(`edges[${i}] links a ticket to itself`);
      return { from, to };
    });
    return { summary: raw.summary || '', tickets, edges };
  }

  // ── Approval → atomic chain build ──────────────────────────────────────────

  /**
   * Approve the current proposal: atomically create every proposed ticket, wire
   * prerequisite edges, then dispatch the root ticket(s) so the existing loop
   * takes over. Idempotent-ish — re-approving a `running` feature is a no-op.
   */
  async approve(featureId: string): Promise<{ feature: Feature; ticket_ids: string[] }> {
    const feature = await this.get(featureId);
    if (feature.status === 'running' || feature.status === 'done') {
      return { feature, ticket_ids: feature.generated_ticket_ids || [] };
    }
    if (feature.status !== 'proposed') {
      throw new BadRequestException(`feature must be 'proposed' to approve (is '${feature.status}')`);
    }
    const proposal = feature.proposal;
    if (!proposal || !proposal.tickets?.length) {
      throw new BadRequestException('feature has no proposal to approve');
    }
    const boardId = feature.board_id;
    if (!boardId) throw new BadRequestException('feature.board_id is required to build the chain');

    const startCol = await this._resolveDefaultStartColumn(boardId);

    // Create every ticket first (dependency wiring needs the ids to exist).
    const keyToId = new Map<string, string>();
    for (const pt of proposal.tickets) {
      const id = await this._createChainTicket(feature, pt, boardId, startCol);
      keyToId.set(pt.key, id);
    }

    // Wire prerequisite edges (backward-pull). `from` must finish before `to`.
    const hasIncoming = new Set<string>();
    for (const e of proposal.edges || []) {
      const fromId = keyToId.get(e.from);
      const toId = keyToId.get(e.to);
      if (!fromId || !toId) continue;
      try {
        await this.prereqService.addPrerequisites(toId, [fromId], {
          reason: `Feature chain: ${feature.title}`,
          actorName: 'Feature Intake',
        });
        hasIncoming.add(e.to);
      } catch (err: any) {
        this.logService.warn('Features', `prereq wire ${e.from}→${e.to} failed for feature ${feature.id}: ${err?.message || err}`);
      }
    }

    const ticketIds = proposal.tickets.map((pt) => keyToId.get(pt.key)!).filter(Boolean);
    feature.generated_ticket_ids = ticketIds;
    feature.status = 'running';
    await this.featureRepo.save(feature);

    // Dispatch the roots (no incoming prerequisite edge). Dependents stay
    // pending_on_tickets and auto-resume when their blocker reaches a terminal
    // column — the prerequisites service already flipped that flag on wiring.
    let dispatched = 0;
    for (const pt of proposal.tickets) {
      if (hasIncoming.has(pt.key)) continue;
      const id = keyToId.get(pt.key);
      if (!id) continue;
      try {
        const res = await this.triggerLoop.dispatchCurrentColumn(id, 'feature_chain', 'Feature Intake');
        dispatched += res?.emitted || 0;
      } catch (err: any) {
        this.logService.warn('Features', `dispatch root ${id} failed for feature ${feature.id}: ${err?.message || err}`);
      }
    }

    this.logService.info('Features', `approved feature ${feature.id}: created ${ticketIds.length} tickets, dispatched ${dispatched} trigger(s)`);
    return { feature, ticket_ids: ticketIds };
  }

  async reject(featureId: string, feedback: string, opts: { replan?: boolean } = {}): Promise<Feature> {
    const feature = await this.get(featureId);
    if (feature.status !== 'proposed') {
      throw new BadRequestException(`feature must be 'proposed' to reject (is '${feature.status}')`);
    }
    feature.feedback = (feedback || '').trim();
    if (opts.replan === false) {
      feature.status = 'rejected';
      await this.featureRepo.save(feature);
      return feature;
    }
    // Default: re-plan — thread the feedback back to the planner.
    await this.featureRepo.save(feature);
    try {
      await this.dispatchPlanning(feature.id);
    } catch (e: any) {
      this.logService.warn('Features', `re-plan dispatch failed for ${feature.id}: ${e?.message || e}`);
    }
    return this.get(feature.id);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async _resolveDefaultStartColumn(boardId: string): Promise<BoardColumn> {
    const cols = await this.colRepo.find({ where: { board_id: boardId }, order: { position: 'ASC' } });
    if (cols.length === 0) throw new BadRequestException('board has no columns');
    // Prefer the first non-terminal column that actually routes a role (so the
    // ticket auto-dispatches). Fall back to the first non-terminal column.
    const routed = cols.find((c) => !isTerminalColumn(c) && this._routingSlugs(c).length > 0);
    const nonTerminal = cols.find((c) => !isTerminalColumn(c));
    const chosen = routed || nonTerminal || cols[0];
    return chosen;
  }

  private _routingSlugs(col: BoardColumn): string[] {
    try {
      const parsed = JSON.parse(col.role_routing || '[]');
      return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string' && s) : [];
    } catch {
      return [];
    }
  }

  private async _createChainTicket(
    feature: Feature,
    pt: FeatureProposedTicket,
    boardId: string,
    defaultCol: BoardColumn,
  ): Promise<string> {
    let col = defaultCol;
    if (pt.column_name) {
      const named = await findColumnByName(this.dataSource, boardId, pt.column_name);
      if (named) col = named;
    }

    // Holder ids default to the planner/creator so the chain is never zero-holder.
    const fallbackHolder = (feature.planner_agent_id || '').trim();
    const assigneeId = (pt.assignee_id || fallbackHolder).trim();
    const reporterId = (pt.reporter_id || assigneeId).trim();
    const reviewerId = (pt.reviewer_id || assigneeId).trim();
    const resolved = await resolveAgentIdAndName(this.dataSource, assigneeId, '', this.logService);

    const labels = Array.isArray(pt.labels) ? pt.labels.filter((l) => typeof l === 'string' && l) : [];
    // Tag every generated ticket with the origin feature (rollup / audit).
    if (!labels.includes('feature-chain')) labels.push('feature-chain');
    labels.push(`feature:${feature.id}`);

    const effort = (pt.effort_preset || '').trim() || null;
    const priority = pt.priority || 'medium';

    const ticket = await this.dataSource.transaction(async (manager) => {
      const tRepo = manager.getRepository(Ticket);
      const position = await maxTicketPosition(manager, col.id);
      return tRepo.save(tRepo.create({
        column_id: col.id,
        title: pt.title,
        description: pt.description || '',
        priority,
        assignee: resolved.name,
        reporter: resolved.name,
        assignee_id: resolved.id || assigneeId,
        reporter_id: reporterId,
        reviewer_id: reviewerId,
        labels: JSON.stringify(labels),
        channel_ids: '[]',
        position,
        effort_preset: effort,
        terminal_entered_at: isTerminalColumn(col) ? new Date() : null,
        created_by: 'Feature Intake',
        created_by_type: 'system',
        created_by_id: '',
      }));
    });

    // Backfill workspace_id then mirror the role trio so the trigger loop /
    // focus selector see the ticket (else the assignee loop never dispatches).
    await refreshTicketWorkspaceId(this.dataSource, ticket);
    const wsId = ticket.workspace_id || feature.workspace_id;
    if (wsId) {
      await this.roleAssignmentService.syncBuiltinTrio(ticket.id, wsId, {
        assignee_id: resolved.id || assigneeId,
        reporter_id: reporterId,
        reviewer_id: reviewerId,
      });
    }

    // Board default role holders (ticket d94a1b87): fill any role still VACANT
    // after the explicit trio above from the board's default_role_assignments.
    // Only ever fills vacant roles; never clobbers an explicit chain holder.
    if (wsId) {
      try {
        const defBoard = await this.dataSource.getRepository(Board).findOne({ where: { id: col.board_id } });
        const defaults = parseDefaultRoleAssignments(defBoard?.default_role_assignments);
        if (Object.keys(defaults).length > 0) {
          await this.roleAssignmentService.applyBoardDefaults(ticket.id, wsId, defaults);
        }
      } catch { /* non-fatal — degrade to "no defaults" */ }
    }

    await this.activityService.logActivity({
      entity_type: 'ticket',
      entity_id: ticket.id,
      action: 'created',
      ticket_id: ticket.id,
      actor_name: 'Feature Intake',
    });

    return ticket.id;
  }

  private async _buildPlanningPrompt(feature: Feature): Promise<string> {
    const board = feature.board_id ? await this.boardRepo.findOne({ where: { id: feature.board_id } }) : null;
    const cols = feature.board_id
      ? await this.colRepo.find({ where: { board_id: feature.board_id }, order: { position: 'ASC' } })
      : [];
    const colLines = cols.map((c) => {
      const slugs = this._routingSlugs(c);
      const term = isTerminalColumn(c) ? ' (terminal)' : '';
      const routed = slugs.length ? ` → routes [${slugs.join(', ')}]` : '';
      return `  - "${c.name}"${term}${routed}`;
    }).join('\n');

    const feedbackBlock = feature.feedback
      ? `\n## 이전 제안 거부 피드백 (반영 필수)\n${feature.feedback}\n`
      : '';

    return [
      `# 기능 분해 요청 (Feature Intake · planner)`,
      ``,
      `아래 요구사항 1건을 **실행 가능한 티켓 체인**으로 분해하세요. 자유 텍스트 계획이 아니라,`,
      `구조화된 제안을 MCP 도구 \`propose_feature_chain\` 으로 서버에 제출해야 합니다.`,
      ``,
      `## 대상`,
      `- Feature ID: \`${feature.id}\``,
      `- Board: ${board ? `"${board.name}" (\`${feature.board_id}\`)` : '(미지정)'}`,
      `- Workspace: \`${feature.workspace_id}\``,
      ``,
      `## 요구사항 원문`,
      feature.requirement,
      feedbackBlock,
      `## 보드 컬럼 / 역할 라우팅`,
      colLines || '  (컬럼 정보 없음)',
      ``,
      `## 제안 제출 방법`,
      `조사 후 \`propose_feature_chain\` 를 다음 인자로 호출하세요:`,
      `- \`feature_id\`: "${feature.id}"`,
      `- \`tickets\`: 각 티켓 { key(제안 내 고유 참조, 예 "t1"), title, description, priority, labels, effort_preset?, column_name?, assignee_id? }`,
      `- \`edges\`: 선행조건 간선 [{ from: 선행티켓key, to: 의존티켓key }] — from 이 완료돼야 to 착수`,
      ``,
      `## 지침`,
      `- 3~5개 내외로 응집도 높게 분할하고, 의존 관계를 edges 로 명시하세요(선형이면 t1→t2→t3).`,
      `- 첫(선행조건 없는) 티켓은 승인 즉시 자동 착수됩니다. 나머지는 선행 티켓이 Done(terminal)에 도달하면 자동 재개됩니다.`,
      `- 새 실행 엔진을 만들지 마세요 — 산출물은 평범한 티켓이며 이후는 기존 보드 루프가 처리합니다.`,
      `- column_name 을 지정하지 않으면 보드의 첫 라우팅 컬럼에 배치됩니다.`,
      `- 승인 대기 상태(proposed)로 두세요. 승인/거부는 reporter(사람)가 합니다.`,
    ].join('\n');
  }
}
