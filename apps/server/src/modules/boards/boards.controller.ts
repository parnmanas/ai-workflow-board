import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, IsNull, Not, DataSource } from 'typeorm';
import { Board } from '../../entities/Board';
import { BoardColumn } from '../../entities/BoardColumn';
import { Ticket } from '../../entities/Ticket';
import { TicketPrerequisite } from '../../entities/TicketPrerequisite';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';
import { CurrentUser, CurrentUserData } from '../../common/decorators/current-user.decorator';
import { WorkspaceMoveService, WorkspaceMoveBlockedError } from '../../services/workspace-move.service';
import { DEFAULT_COLUMNS } from '../../database/database.module';
import { DEFAULT_BOARD_ROUTING } from '../../db';
import { PromptTemplatesService } from '../prompt-templates/prompt-templates.service';
import { Agent } from '../../entities/Agent';
import { TicketRoleAssignment } from '../../entities/TicketRoleAssignment';
import { WorkspaceRole } from '../../entities/WorkspaceRole';
import { TicketRoleAssignmentService } from '../workspace-roles/ticket-role-assignment.service';
import { parseHandoffSpec } from '../../common/handoff-spec-config';
import { findOrFail } from '../../common/find-or-fail';
import { Comment } from '../../entities/Comment';
import { buildArchiveCursor, parseArchiveCursor } from '../mcp/shared/archive-helpers';
import { writeRoutingConfigThrough } from './routing-config.helper';
import { AgentWorkloadService } from '../agents/agent-workload.service';
import { resolveAgentDisplayMap } from '../../utils/agent-name';
import { validateHarnessConfigInput, serializeHarnessConfig } from '../../common/harness-config';
import { validateEffortPresetsInput, serializeEffortPresets } from '../../common/effort-presets';
import { validateEnvironmentConfigInput, serializeEnvironmentConfig } from '../../common/environment-config';
import { validateMergeGateConfigInput, serializeMergeGateConfig } from '../../common/merge-gate-config';
import { validateRespawnStormConfigInput, serializeRespawnStormConfig } from '../../common/respawn-storm-config';
import { validateDefaultRoleAssignmentsInput, serializeDefaultRoleAssignments } from '../../common/default-role-assignments-config';
import { validateQaPhasesInput, serializeQaPhases } from '../qa/qa-phases';
import { BoardLesson } from '../../entities/BoardLesson';
import {
  validateBoardLessonInput,
  validateBoardLessonUpdate,
  parseLessonTags,
  serializeLessonTags,
} from '../../common/board-lessons';

// Narrow projection of a Comment as it ships on a board card. The board GET
// only needs enough to render the comment count and the stale-open-question
// badge (type/status/created_at) — never the body/author/threading — so the
// payload is lightened to these five columns (perf ticket b3812637). Typing
// the projection as a `Pick` instead of `any[]` means the SQL `.select([...])`
// below and this declared shape are checked against each other, and any
// consumer that reads a dropped field fails to compile rather than silently
// reading `undefined` at runtime (hardening ticket 24bbd0ad). The matching
// client type lives in apps/client/src/types.ts (BoardCardComment) — keep the
// two field lists in sync.
type BoardCardComment = Pick<Comment, 'id' | 'ticket_id' | 'type' | 'status' | 'created_at'>;

// Compact multi-holder role projection for a board card (T6 다중담당자 아바타).
// One entry per role that has ≥1 holder; `holders` carries every holder so the
// card can render an avatar stack with a "+N" overflow. The matching client
// type lives in apps/client/src/types.ts (BoardCardRoleHolders) — keep in sync.
type BoardCardRoleHolders = {
  role_slug: string;
  role_name: string;
  holders: Array<{ type: 'agent' | 'user'; id: string; name: string }>;
};

@ApiBearerAuth('user-session')
@ApiTags('boards')
@Controller('api/boards')
@UseGuards(AuthGuard)
export class BoardsController {
  constructor(
    @InjectRepository(Board) private readonly boardRepo: Repository<Board>,
    @InjectRepository(BoardColumn) private readonly colRepo: Repository<BoardColumn>,
    @InjectRepository(Ticket) private readonly ticketRepo: Repository<Ticket>,
    @InjectRepository(BoardLesson) private readonly lessonRepo: Repository<BoardLesson>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly promptTemplatesService: PromptTemplatesService,
    private readonly agentWorkload: AgentWorkloadService,
    private readonly workspaceMove: WorkspaceMoveService,
    private readonly ticketRoleAssignments: TicketRoleAssignmentService,
  ) {}

  @Get()
  async list(
    @Query('workspace_id') workspaceId: string,
    @Query('include_archived') includeArchived: string,
    @Res() res: Response,
  ) {
    const where: any = {};
    if (workspaceId) where.workspace_id = workspaceId;
    // Exclude archived boards by default; pass ?include_archived=true to see all
    if (includeArchived !== 'true') where.archived_at = IsNull();
    const boards = await this.boardRepo.find({ where, order: { created_at: 'DESC' } });
    return res.json(boards);
  }

  @Post()
  async create(@Body() body: any, @Res() res: Response) {
    const { name, description = '', workspace_id, benchmark_mode } = body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id is required' });
    // benchmark_mode may be set at create time (parity with the update handler);
    // validated against the same allow-list so a board can be born in benchmark mode.
    if (benchmark_mode !== undefined) {
      const allowed = ['off', 'on'];
      if (!allowed.includes(String(benchmark_mode))) {
        return res.status(400).json({
          error: `benchmark_mode must be one of: ${allowed.join(', ')}`,
        });
      }
    }

    const board = await this.boardRepo.save(this.boardRepo.create({
      name, description, workspace_id,
      routing_config: JSON.stringify(DEFAULT_BOARD_ROUTING),
      ...(benchmark_mode !== undefined ? { benchmark_mode: String(benchmark_mode) } : {}),
    }));
    const defaultCols = DEFAULT_COLUMNS.map(c => ({ ...c, board_id: board.id }));
    const savedCols = await this.colRepo.save(defaultCols.map(c => this.colRepo.create(c)));
    // v0.41 — propagate the just-written routing_config into per-column
    // role_routing so runtime dispatch reads slugs from the column rows.
    await writeRoutingConfigThrough(this.dataSource, board.id);

    // Auto-link each new column to its matching default workflow template.
    // seedDefaults is idempotent — existing workspaces (where the templates
    // were minted at workspace-create time or via the backfill migration)
    // get a no-op insert and the existing rows back.
    await this.promptTemplatesService.seedDefaults(workspace_id);
    const colPrompts = await this.promptTemplatesService.computeDefaultColumnPrompts(
      workspace_id,
      savedCols.map(c => ({ id: c.id, name: c.name })),
    );
    if (Object.keys(colPrompts).length > 0) {
      await this.boardRepo.update({ id: board.id }, { column_prompts: JSON.stringify(colPrompts) });
    }

    const result = await this.boardRepo.findOne({ where: { id: board.id } });
    return res.status(201).json(result);
  }

  @Get(':id')
  async get(
    @Param('id') id: string,
    @Query('include_archived') includeArchived: string,
    @Res() res: Response,
  ) {
    const board = await findOrFail(this.boardRepo, { where: { id } }, 'Board not found');

    // Archived tickets are excluded by default — they live behind the
    // `/api/boards/:id/archived-tickets` endpoint. `?include_archived=true`
    // opts back in (used by admin tooling that needs the full row set).
    const showArchived = includeArchived === 'true';

    const columns = await this.colRepo.find({ where: { board_id: board.id }, order: { position: 'ASC' } });
    const columnsWithTickets = await Promise.all(
      columns.map(async (col) => {
        const whereTickets: any = { column_id: col.id, parent_id: IsNull() };
        if (!showArchived) whereTickets.archived_at = IsNull();
        const tickets = await this.ticketRepo.find({
          where: whereTickets,
          // Board cards don't render comment bodies — they only show a comment
          // count and a stale-open-question badge (TicketCard reads
          // comments.length + hasStaleOpenQuestion, which needs only
          // type/status/created_at). Eager-loading the full `comments` relation
          // (content + metadata) and expanding attachments for every ticket on
          // the whole board was the dominant cost of this endpoint. We drop the
          // relation here and attach a lightweight projection below via one
          // grouped query. The full thread is served by GET /api/tickets/:id
          // (loadTicketFull) when a card is opened. Perf ticket b3812637.
          relations: ['children', 'children.children'],
          order: { position: 'ASC' },
        });
        return {
          ...col,
          tickets: tickets.map(t => ({
            ...t,
            labels: JSON.parse(t.labels || '[]'),
            channel_ids: JSON.parse(t.channel_ids || '[]'),
            on_done_action_ids: JSON.parse(t.on_done_action_ids || '[]'),
            // Cross-board handoff relay (ticket ac21a745) — decode the JSON-string
            // spec so the detail panel (which binds off the board payload) can
            // render/edit it without a second round-trip. Root-only, like the
            // handoff concept itself.
            handoff_spec: parseHandoffSpec(t.handoff_spec),
            children: (t.children || []).sort((a, b) => a.position - b.position).map(child => ({
              ...child,
              labels: JSON.parse(child.labels || '[]'),
              channel_ids: JSON.parse(child.channel_ids || '[]'),
              on_done_action_ids: JSON.parse(child.on_done_action_ids || '[]'),
              children: (child.children || []).sort((a, b) => a.position - b.position),
            })),
            // Lightweight comment projection — populated by the grouped query
            // below. Typed (not `any[]`) so the shape is enforced end-to-end.
            comments: [] as BoardCardComment[],
            prerequisite_count: 0,
            // Multi-holder role projection (T6 다중담당자 아바타) — populated by
            // the grouped query below. Empty until then.
            role_holders: [] as BoardCardRoleHolders[],
          })),
        };
      })
    );

    // Collect root ticket ids once for the two grouped follow-up queries below
    // (comment projection + prerequisite counts) so neither does N+1 lookups.
    const rootTicketIds: string[] = [];
    for (const col of columnsWithTickets) for (const t of col.tickets) rootTicketIds.push(t.id);

    if (rootTicketIds.length > 0) {
      // Lightweight comment projection for the cards: a single grouped query
      // that selects only the columns the card needs, instead of loading every
      // comment's full body + attachments for the whole board. Newest-first to
      // preserve the historic parseComments ordering. Perf ticket b3812637.
      const commentRows = await this.dataSource
        .getRepository(Comment)
        .createQueryBuilder('c')
        .select(['c.id', 'c.ticket_id', 'c.type', 'c.status', 'c.created_at'])
        .where('c.ticket_id IN (:...ids)', { ids: rootTicketIds })
        .orderBy('c.created_at', 'DESC')
        .getMany();
      const commentsByTicket = new Map<string, BoardCardComment[]>();
      for (const c of commentRows) {
        const list = commentsByTicket.get(c.ticket_id) || [];
        const projected: BoardCardComment = {
          id: c.id, ticket_id: c.ticket_id, type: c.type, status: c.status, created_at: c.created_at,
        };
        list.push(projected);
        commentsByTicket.set(c.ticket_id, list);
      }

      // Prerequisite counts (ticket 48d14fff) — one grouped query so the card
      // can render a "blocked by N" badge without N+1 lookups. Only the total
      // link count is attached; the card gates the badge on `pending_on_tickets`
      // (already on the entity), so a ticket whose prereqs are all satisfied
      // won't show it regardless.
      const counts = await this.dataSource
        .getRepository(TicketPrerequisite)
        .createQueryBuilder('p')
        .select('p.ticket_id', 'ticket_id')
        .addSelect('COUNT(*)', 'cnt')
        .where('p.ticket_id IN (:...ids)', { ids: rootTicketIds })
        .groupBy('p.ticket_id')
        .getRawMany();
      const countMap = new Map<string, number>(counts.map((r: any) => [r.ticket_id, Number(r.cnt)]));

      // Multi-holder role projection for the cards (T6 다중담당자 아바타). One
      // batched grouped read (assignments + roles + agents + users) → ticketId →
      // holders-per-role; compacted to the card shape. Same grouped-query
      // rationale as the comment/prereq projections above (no N+1 per card).
      const groupedHolders = await this.ticketRoleAssignments.resolveGroupedForTickets(rootTicketIds);

      for (const col of columnsWithTickets) {
        for (const t of col.tickets) {
          t.comments = commentsByTicket.get(t.id) || [];
          t.prerequisite_count = countMap.get(t.id) || 0;
          t.role_holders = (groupedHolders.get(t.id) || []).map(g => ({
            role_slug: g.role.slug,
            role_name: g.role.name,
            holders: g.holders,
          }));
        }
      }
    }

    return res.json({ ...board, columns: columnsWithTickets });
  }

  /**
   * GET /api/boards/:id/focus-tickets
   *
   * Returns the current focus ticket for each (agent, role) pair on this
   * board. Used by the board UI to display which ticket is the active focus
   * for each agent role, and which tickets are being skipped because another
   * ticket holds focus (ticket b55e4421).
   *
   * Response shape:
   *   { focus_tickets: Array<{ agent_id: string; agent_name: string; role: string; ticket_id: string }> }
   */
  @Get(':id/focus-tickets')
  async getFocusTickets(@Param('id') id: string, @Res() res: Response) {
    const board = await findOrFail(this.boardRepo, { where: { id } }, 'Board not found');

    // Find all unique (agent_id, role_slug) pairs that have tickets on this board.
    const assignRepo = this.dataSource.getRepository(TicketRoleAssignment);
    const roleRepo = this.dataSource.getRepository(WorkspaceRole);
    const columns = await this.colRepo.find({ where: { board_id: board.id } });
    const colIds = columns.map(c => c.id);
    if (colIds.length === 0) return res.json({ focus_tickets: [] });

    // Find all tickets on this board's columns. Archived tickets are
    // excluded — the focus selector never returns them and the UI
    // doesn't render badges for them.
    const tickets = await this.ticketRepo
      .createQueryBuilder('t')
      .where('t.column_id IN (:...colIds)', { colIds })
      .andWhere('t.archived_at IS NULL')
      .getMany();
    if (tickets.length === 0) return res.json({ focus_tickets: [] });

    const ticketIds = tickets.map(t => t.id);
    const assignments = await assignRepo
      .createQueryBuilder('ra')
      .where('ra.ticket_id IN (:...ids)', { ids: ticketIds })
      .getMany();

    // Dedupe (agent_id, role_id) pairs.
    const seen = new Set<string>();
    const pairs: Array<{ agent_id: string; role_id: string }> = [];
    for (const a of assignments) {
      if (!a.agent_id) continue;
      const key = `${a.agent_id}|${a.role_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ agent_id: a.agent_id, role_id: a.role_id });
    }

    // Resolve role slugs and agent names.
    const roles = await roleRepo.find({ where: { workspace_id: board.workspace_id } });
    const roleById = new Map(roles.map(r => [r.id, r]));

    const agentRepo = this.dataSource.getRepository(Agent);
    const agentIds = Array.from(new Set(pairs.map(p => p.agent_id)));
    const agents = agentIds.length > 0
      ? await agentRepo.createQueryBuilder('a').where('a.id IN (:...ids)', { ids: agentIds }).getMany()
      : [];
    const displayNameByAgentId = await resolveAgentDisplayMap(agentRepo, agents);

    // Per-agent FOCUS collapse (ticket 3fb0005d). Compute focus per AGENT,
    // not per (agent, role) pair: a single agent holding multiple roles on
    // this board (assignee + reviewer/reporter — 겸직) would otherwise emit
    // one FOCUS ticket per role, contradicting the agent-manager dispatch
    // cap (`max_concurrent_tickets_per_agent`, agent-unit, default 1). We
    // collapse across roles and take the top-N tickets, where N is that
    // cap — so the badge count matches what the manager actually dispatches.
    //
    // Non-겸직 is a strict no-op: an agent with one role on the board has
    // the same candidate set with or without the role filter, so top-1
    // equals the old per-role focus (verification case b — no regression).
    //
    // Once the winning ticket(s) are chosen, we label each with the role
    // slug(s) the agent holds on that ticket (a 겸직 ticket the agent owns
    // as both assignee and reviewer yields two labels on one badge — the
    // client keys the FOCUS badge by ticket_id, so it still renders once).
    const cap = board.max_concurrent_tickets_per_agent ?? 1;

    // (agent_id, ticket_id) → role slugs the agent holds on that ticket.
    const rolesByAgentTicket = new Map<string, string[]>();
    for (const a of assignments) {
      if (!a.agent_id) continue;
      const role = roleById.get(a.role_id);
      if (!role) continue;
      const key = `${a.agent_id}|${a.ticket_id}`;
      const slugs = rolesByAgentTicket.get(key);
      if (slugs) {
        if (!slugs.includes(role.slug)) slugs.push(role.slug);
      } else {
        rolesByAgentTicket.set(key, [role.slug]);
      }
    }

    // One getAgentFocusTicketIds call per distinct agent (collapsed across
    // roles). Independent reads, fanned out with Promise.all — same perf
    // rationale as the prior per-pair fan-out (ticket b3812637); the agent
    // count on a board is small and the DB pool caps real concurrency.
    const perAgent = await Promise.all(
      agentIds.map(async (agent_id) => {
        const focusIds = await this.agentWorkload.getAgentFocusTicketIds(agent_id, board.id, cap);
        const agent_name = displayNameByAgentId.get(agent_id) ?? agent_id;
        const rows: Array<{ agent_id: string; agent_name: string; role: string; ticket_id: string }> = [];
        for (const ticket_id of focusIds) {
          const slugs = rolesByAgentTicket.get(`${agent_id}|${ticket_id}`) ?? [];
          for (const role of slugs) {
            rows.push({ agent_id, agent_name, role, ticket_id });
          }
        }
        return rows;
      }),
    );
    const focusTickets = perAgent.flat();

    return res.json({ focus_tickets: focusTickets });
  }

  /**
   * GET /api/boards/:id/archived-tickets
   *
   * Paginated list of archived tickets on this board. Mirrors the MCP
   * `list_archived_tickets` tool — same cursor + q semantics. Used by the
   * dedicated Archive UI to render the board's archived ticket history with
   * search + Unarchive / View detail actions.
   *
   * Response: `{ tickets: Ticket[], next_cursor: string | null }`. Each row
   * includes `column_name` (snapshot of where the ticket was when archived).
   */
  @Get(':board_id/archived-tickets')
  async listArchivedTickets(
    @Param('board_id') boardId: string,
    @Query('cursor') cursor: string,
    @Query('limit') limitRaw: string,
    @Query('q') q: string,
    @Res() res: Response,
  ) {
    await findOrFail(this.boardRepo, { where: { id: boardId } }, 'Board not found');
    const limit = Math.max(1, Math.min(200, Number.parseInt(limitRaw || '50', 10) || 50));

    const cols = await this.colRepo.find({ where: { board_id: boardId } });
    if (cols.length === 0) return res.json({ tickets: [], next_cursor: null });
    const colIds = cols.map(c => c.id);

    // Compound (archived_at, id) sort + cursor — the archiver stamps a whole
    // batch with the same `archived_at`, so an `archived_at`-only cursor would
    // skip the rest of that batch when the page boundary lands inside it.
    // Encoded as `<isoTimestamp>|<id>`.
    let qb = this.ticketRepo.createQueryBuilder('t')
      .where('t.column_id IN (:...colIds)', { colIds })
      .andWhere('t.archived_at IS NOT NULL')
      .orderBy('t.archived_at', 'DESC')
      .addOrderBy('t.id', 'DESC')
      .take(limit + 1);

    if (cursor) {
      const { ts, id } = parseArchiveCursor(cursor);
      if (ts && id != null) {
        qb = qb.andWhere(
          '(t.archived_at < :ts) OR (t.archived_at = :ts AND t.id < :id)',
          { ts, id },
        );
      } else if (ts) {
        // Legacy bare-timestamp cursor — no tiebreak available, fall back to
        // the original `< :ts` shape so older clients keep paging forward.
        qb = qb.andWhere('t.archived_at < :ts', { ts });
      }
    }
    if (q) {
      // Title / id / label match. Labels are stored as a JSON-encoded string
      // column; a substring match on the raw JSON catches `["foo","bar"]`
      // without needing per-row deserialization in SQL.
      qb = qb.andWhere(
        '(LOWER(t.title) LIKE :q OR t.id = :exactId OR LOWER(t.labels) LIKE :labelQ)',
        {
          q: `%${q.toLowerCase()}%`,
          exactId: q,
          labelQ: `%"${q.toLowerCase()}"%`,
        },
      );
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const colById = new Map(cols.map(c => [c.id, c]));

    return res.json({
      tickets: page.map(t => ({
        ...t,
        labels: JSON.parse(t.labels || '[]'),
        channel_ids: JSON.parse(t.channel_ids || '[]'),
        column_name: colById.get(t.column_id || '')?.name ?? '',
      })),
      next_cursor: hasMore && page.length > 0
        ? buildArchiveCursor(page[page.length - 1].archived_at!, page[page.length - 1].id)
        : null,
    });
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: any, @Res() res: Response) {
    const board = await findOrFail(this.boardRepo, { where: { id } }, 'Board not found');

    const { name, description, routing_config, column_prompts, max_concurrent_tickets_per_agent, self_improvement_mode, benchmark_mode, auto_archive_days, harness_config, effort_presets, language, environment_config, qa_phases, merge_gate_config, respawn_storm_config, default_role_assignments } = body;
    if (name !== undefined) board.name = name;
    if (description !== undefined) board.description = description;
    // Board output language (i18n, ticket ae28dcaf). Human-readable name that
    // dispatch folds into system_prompt_append. Normalise empty/whitespace to
    // null so an empty form field clears the override (back to agent default).
    if (language !== undefined) {
      const trimmed = language == null ? null : String(language).trim();
      board.language = trimmed ? trimmed : null;
    }
    if (self_improvement_mode !== undefined) {
      const allowed = ['off', 'same_board', 'remote_awb', 'both'];
      if (!allowed.includes(String(self_improvement_mode))) {
        return res.status(400).json({
          error: `self_improvement_mode must be one of: ${allowed.join(', ')}`,
        });
      }
      board.self_improvement_mode = String(self_improvement_mode);
    }
    if (benchmark_mode !== undefined) {
      const allowed = ['off', 'on'];
      if (!allowed.includes(String(benchmark_mode))) {
        return res.status(400).json({
          error: `benchmark_mode must be one of: ${allowed.join(', ')}`,
        });
      }
      board.benchmark_mode = String(benchmark_mode);
    }
    const routingChanged = routing_config !== undefined;
    if (routingChanged) board.routing_config = JSON.stringify(routing_config);
    if (column_prompts !== undefined) {
      if (column_prompts === null) {
        board.column_prompts = null;
      } else if (typeof column_prompts === 'object') {
        const cleaned: Record<string, string> = {};
        for (const [colId, tplId] of Object.entries(column_prompts)) {
          if (typeof tplId === 'string' && tplId.length > 0) cleaned[colId] = tplId;
        }
        board.column_prompts = Object.keys(cleaned).length === 0 ? null : JSON.stringify(cleaned);
      }
    }
    if (max_concurrent_tickets_per_agent !== undefined) {
      const n = Math.floor(Number(max_concurrent_tickets_per_agent));
      if (!Number.isFinite(n) || n < 1) {
        return res.status(400).json({
          error: 'max_concurrent_tickets_per_agent must be a positive integer (>= 1)',
        });
      }
      board.max_concurrent_tickets_per_agent = n;
    }

    // Agent harness override (ticket 7122600c). null clears; an object is
    // zod-validated (strict keys) so a typo'd field 400s instead of being
    // silently stored. Empty objects collapse to null via the serializer.
    if (harness_config !== undefined) {
      if (harness_config === null) {
        board.harness_config = null;
      } else {
        const checked = validateHarnessConfigInput(harness_config);
        if (!checked.ok) return res.status(400).json({ error: checked.error });
        board.harness_config = serializeHarnessConfig(checked.value);
      }
    }

    // Per-board effort preset catalog (abstract ticket effort option). null
    // clears (board falls back to the built-in catalog); an object is
    // zod-validated (strict keys + default-matches-an-id) so a typo'd field
    // 400s instead of being silently stored. Empty / equal-to-builtin
    // catalogs collapse to null via the serializer.
    if (effort_presets !== undefined) {
      if (effort_presets === null) {
        board.effort_presets = null;
      } else {
        const checked = validateEffortPresetsInput(effort_presets);
        if (!checked.ok) return res.status(400).json({ error: checked.error });
        board.effort_presets = serializeEffortPresets(checked.value);
      }
    }

    if (auto_archive_days !== undefined) {
      if (auto_archive_days === null || auto_archive_days === '' || auto_archive_days === false) {
        board.auto_archive_days = null;
      } else {
        const n = Math.floor(Number(auto_archive_days));
        if (!Number.isFinite(n) || n < 1 || n > 365) {
          return res.status(400).json({
            error: 'auto_archive_days must be null or an integer between 1 and 365',
          });
        }
        board.auto_archive_days = n;
      }
    }

    // Per-board environment setup override (ticket 354d336b). null clears the
    // board override; an object is zod-validated (strict keys + each repository
    // needs a resource_id or url) so a typo'd field 400s instead of being
    // silently stored. Empty configs collapse to null via the serializer.
    if (environment_config !== undefined) {
      if (environment_config === null) {
        board.environment_config = null;
      } else {
        const checked = validateEnvironmentConfigInput(environment_config);
        if (!checked.ok) return res.status(400).json({ error: checked.error });
        board.environment_config = serializeEnvironmentConfig(checked.value);
      }
    }

    // Per-board QA multi-phase model (ticket 90cc22f7 / 38192044). null clears
    // back to legacy single-running; an object is fail-safe validated (non-empty
    // phases, unique ids, positive timeout_sec) so a typo'd config 400s instead
    // of being silently stored. Mirrors environment_config / harness_config.
    if (qa_phases !== undefined) {
      if (qa_phases === null) {
        board.qa_phases = null;
      } else {
        const checked = validateQaPhasesInput(qa_phases);
        if (!checked.ok) return res.status(400).json({ error: checked.error });
        board.qa_phases = serializeQaPhases(checked.value);
      }
    }

    // Per-board merge/integration gate (ticket c806bad3). null clears the gate
    // (board reverts to prompt-driven merge, no server checks); an object is
    // zod-validated (strict keys) so a typo'd field 400s instead of being
    // silently stored. Empty configs collapse to null via the serializer.
    if (merge_gate_config !== undefined) {
      if (merge_gate_config === null) {
        board.merge_gate_config = null;
      } else {
        const checked = validateMergeGateConfigInput(merge_gate_config);
        if (!checked.ok) return res.status(400).json({ error: checked.error });
        board.merge_gate_config = serializeMergeGateConfig(checked.value);
      }
    }

    // Per-board respawn-storm circuit breaker (ticket ab06eac2). Same shape as
    // merge_gate_config: null clears the override back to the env-folded
    // baseline; an object is zod-validated (strict keys) so a typo'd field 400s.
    if (respawn_storm_config !== undefined) {
      if (respawn_storm_config === null) {
        board.respawn_storm_config = null;
      } else {
        const checked = validateRespawnStormConfigInput(respawn_storm_config);
        if (!checked.ok) return res.status(400).json({ error: checked.error });
        board.respawn_storm_config = serializeRespawnStormConfig(checked.value);
      }
    }

    // Per-board DEFAULT role holders (ticket d94a1b87). null / {} clears the
    // config. Two-layer validation: the JSON shape (validateDefaultRoleAssignmentsInput)
    // then the DB-existence layer (every slug a real workspace role, every id a
    // real agent/user) via validateBoardDefaults — so a typo 400s instead of
    // silently manufacturing an orphan default at ticket-create time.
    if (default_role_assignments !== undefined) {
      if (default_role_assignments === null) {
        board.default_role_assignments = null;
      } else {
        const checked = validateDefaultRoleAssignmentsInput(default_role_assignments);
        if (!checked.ok) return res.status(400).json({ error: checked.error });
        const dbCheck = await this.ticketRoleAssignments.validateBoardDefaults(board.workspace_id, checked.value);
        if (!dbCheck.ok) return res.status(400).json({ error: dbCheck.error });
        board.default_role_assignments = serializeDefaultRoleAssignments(checked.value);
      }
    }

    await this.boardRepo.save(board);
    // v0.41 — fan routing_config edits through to per-column role_routing.
    // Done after the board save so the propagation reads the latest blob.
    if (routingChanged) {
      await writeRoutingConfigThrough(this.dataSource, board.id);
    }
    return res.json(board);
  }

  /**
   * POST /api/boards/:id/move-to-workspace  (admin-only)
   *
   * Cross-workspace "move house" for a board + all its workspace-scoped
   * dependencies (ticket 8882056b). Body:
   *   { target_workspace_id: string, dry_run?: boolean (default true), carry_agents?: boolean }
   *
   * dry_run=true returns the preview report (what moves / copies / remaps /
   * blocks) without writing. dry_run=false commits atomically in one
   * transaction; a blocked move returns 409 and applies nothing.
   */
  @Post(':id/move-to-workspace')
  @UseGuards(AdminGuard)
  async moveToWorkspace(
    @Param('id') id: string,
    @Body() body: any,
    @CurrentUser() user: CurrentUserData | undefined,
    @Res() res: Response,
  ) {
    const targetWorkspaceId = body?.target_workspace_id;
    if (!targetWorkspaceId) return res.status(400).json({ error: 'target_workspace_id is required' });
    const dryRun = body?.dry_run !== false; // default true — never commit unless explicitly asked
    const opts = {
      carry_agents: !!body?.carry_agents,
      // ticket 9efa643b: per-agent carry exclusion (drop_companion_agent remedy).
      exclude_agent_ids: Array.isArray(body?.exclude_agent_ids) ? body.exclude_agent_ids : undefined,
      actor_id: user?.id,
      actor_name: user?.name,
    };
    try {
      const report = dryRun
        ? await this.workspaceMove.previewBoardMove(id, targetWorkspaceId, opts)
        : await this.workspaceMove.commitBoardMove(id, targetWorkspaceId, opts);
      return res.json(report);
    } catch (e: any) {
      if (e instanceof WorkspaceMoveBlockedError) {
        // Structured blockers travel as-is; `messages` keeps the legacy string
        // surface for older clients.
        return res.status(409).json({ error: e.message, blockers: e.blockers, messages: e.messages });
      }
      return res.status(400).json({ error: e?.message || 'Cross-workspace move failed' });
    }
  }

  /**
   * POST /api/boards/:id/move-to-workspace/remedy  (admin-only)
   *
   * Execute a structured move-blocker remedy (ticket 9efa643b) so the operator
   * can clear a preview blocker inline without leaving the screen. Body:
   *   { action: string, params: object }
   * The :id board param scopes the call to the board-move UI; the remedy itself
   * operates on the agent/ticket refs the blocker reported.
   */
  @Post(':id/move-to-workspace/remedy')
  @UseGuards(AdminGuard)
  async moveToWorkspaceRemedy(
    @Param('id') id: string,
    @Body() body: any,
    @CurrentUser() user: CurrentUserData | undefined,
    @Res() res: Response,
  ) {
    const action = body?.action;
    if (!action) return res.status(400).json({ error: 'action is required' });
    try {
      const result = await this.workspaceMove.runMoveRemedy(action, body?.params || {}, { id: user?.id, name: user?.name });
      return res.json(result);
    } catch (e: any) {
      return res.status(400).json({ error: e?.message || 'Move remedy failed' });
    }
  }

  @Post(':id/archive')
  async archive(@Param('id') id: string, @Res() res: Response) {
    const board = await findOrFail(this.boardRepo, { where: { id } }, 'Board not found');
    board.archived_at = new Date();
    await this.boardRepo.save(board);
    return res.json(board);
  }

  @Post(':id/restore')
  async restore(@Param('id') id: string, @Res() res: Response) {
    const board = await findOrFail(this.boardRepo, { where: { id } }, 'Board not found');
    board.archived_at = null;
    await this.boardRepo.save(board);
    return res.json(board);
  }

  // Pause: idempotent — repeat calls just refresh paused_at to "now". Cheaper
  // than a 409 / no-op detour and keeps the audit trail (updated_at) honest
  // about who hit the button last.
  @Post(':id/pause')
  async pause(@Param('id') id: string, @Res() res: Response) {
    const board = await findOrFail(this.boardRepo, { where: { id } }, 'Board not found');
    board.paused_at = new Date();
    await this.boardRepo.save(board);
    return res.json(board);
  }

  @Post(':id/resume')
  async resume(@Param('id') id: string, @Res() res: Response) {
    const board = await findOrFail(this.boardRepo, { where: { id } }, 'Board not found');
    board.paused_at = null;
    await this.boardRepo.save(board);
    return res.json(board);
  }

  @Delete(':id')
  async delete(@Param('id') id: string, @Res() res: Response) {
    const result = await this.boardRepo.delete(id);
    if (result.affected === 0) return res.status(404).json({ error: 'Board not found' });
    return res.json({ success: true });
  }

  // ── Board Lessons / Runbook (ticket 9d0d6ac4) ────────────────────────────
  // Board-scoped knowledge base. Active lessons are auto-injected into the
  // board's dispatch prompts (TriggerLoopService._emitTrigger). These endpoints
  // back the Board Settings > Lessons UI and mirror the MCP tools
  // (add/list/update_board_lesson). tags decode to an array on the wire.

  private projectLesson(row: BoardLesson) {
    return {
      id: row.id,
      workspace_id: row.workspace_id,
      board_id: row.board_id,
      title: row.title,
      body: row.body,
      tags: parseLessonTags(row.tags),
      source_ticket_id: row.source_ticket_id,
      active: row.active,
      hit_count: row.hit_count,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  @Get(':id/lessons')
  async listLessons(
    @Param('id') id: string,
    @Query('include_inactive') includeInactive: string,
    @Res() res: Response,
  ) {
    const where: any = { board_id: id };
    if (includeInactive !== 'true') where.active = true;
    const rows = await this.lessonRepo.find({ where, order: { updated_at: 'DESC' } });
    return res.json(rows.map((r) => this.projectLesson(r)));
  }

  @Post(':id/lessons')
  async createLesson(
    @Param('id') id: string,
    @Body() body: any,
    @CurrentUser() user: CurrentUserData | undefined,
    @Res() res: Response,
  ) {
    const board = await this.boardRepo.findOne({ where: { id } });
    if (!board) return res.status(404).json({ error: 'Board not found' });

    const checked = validateBoardLessonInput({
      title: body?.title,
      body: body?.body,
      tags: body?.tags,
      source_ticket_id: body?.source_ticket_id,
    });
    if (!checked.ok) return res.status(400).json({ error: checked.error });

    const row = this.lessonRepo.create({
      workspace_id: board.workspace_id ?? null,
      board_id: id,
      title: checked.value.title,
      body: checked.value.body,
      tags: serializeLessonTags(checked.value.tags),
      source_ticket_id: checked.value.source_ticket_id || null,
      active: true,
      hit_count: 0,
      created_by: user?.name || 'user',
    });
    const saved = await this.lessonRepo.save(row);
    return res.status(201).json(this.projectLesson(saved));
  }

  @Patch(':id/lessons/:lessonId')
  async updateLesson(
    @Param('id') id: string,
    @Param('lessonId') lessonId: string,
    @Body() body: any,
    @Res() res: Response,
  ) {
    const row = await this.lessonRepo.findOne({ where: { id: lessonId, board_id: id } });
    if (!row) return res.status(404).json({ error: 'Lesson not found' });

    // Only validate the fields actually supplied.
    const patch: Record<string, unknown> = {};
    if (body?.title !== undefined) patch.title = body.title;
    if (body?.body !== undefined) patch.body = body.body;
    if (body?.tags !== undefined) patch.tags = body.tags;
    if (body?.source_ticket_id !== undefined) patch.source_ticket_id = body.source_ticket_id;
    if (body?.active !== undefined) patch.active = body.active;
    const checked = validateBoardLessonUpdate(patch);
    if (!checked.ok) return res.status(400).json({ error: checked.error });

    const v = checked.value;
    if (v.title !== undefined) row.title = v.title;
    if (v.body !== undefined) row.body = v.body;
    if (v.tags !== undefined) row.tags = serializeLessonTags(v.tags);
    if (v.source_ticket_id !== undefined) row.source_ticket_id = v.source_ticket_id || null;
    if (v.active !== undefined) row.active = v.active;

    const saved = await this.lessonRepo.save(row);
    return res.json(this.projectLesson(saved));
  }

  @Delete(':id/lessons/:lessonId')
  async deleteLesson(
    @Param('id') id: string,
    @Param('lessonId') lessonId: string,
    @Res() res: Response,
  ) {
    const result = await this.lessonRepo.delete({ id: lessonId, board_id: id });
    if (result.affected === 0) return res.status(404).json({ error: 'Lesson not found' });
    return res.json({ success: true });
  }
}
