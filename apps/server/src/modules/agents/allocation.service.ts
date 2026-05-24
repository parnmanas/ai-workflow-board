import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { ActivityLog } from '../../entities/ActivityLog';
import { Agent } from '../../entities/Agent';
import { BoardColumn } from '../../entities/BoardColumn';
import { Comment } from '../../entities/Comment';
import { Ticket } from '../../entities/Ticket';
import { WorkspaceRole } from '../../entities/WorkspaceRole';
import { TicketRoleAssignment } from '../../entities/TicketRoleAssignment';
import { priorityIndex } from './priority';

export interface AllocatedTicketRow {
  ticket_id: string;
  /** Role slug — workspace-scoped (was hardcoded enum pre-v0.34). */
  role: string;
  column_id: string;
  column_position: number;
  priority: string;
  priority_index: number;
  title: string;
  my_last_update_at: string | null;
}

function safeJsonParse<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

/**
 * Computes the "what tickets should this agent be working on right now" set.
 *
 * Shared between the MCP `get_allocated_tickets` tool and the REST
 * `GET /api/agents/:id/allocated-tickets` endpoint so both return identical
 * rows. See trigger-tools.ts for the MCP wrapper.
 */
@Injectable()
export class AllocationService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async getAllocatedTickets(agentId: string, workspaceId: string): Promise<{ error: string } | AllocatedTicketRow[]> {
    const agent = await this.dataSource.getRepository(Agent).findOne({ where: { id: agentId } });
    if (!agent) return { error: 'Agent not found' };
    if (agent.workspace_id && agent.workspace_id !== workspaceId) {
      return { error: 'Agent does not belong to the requested workspace' };
    }

    // v0.34: tickets-where-this-agent-holds-a-role lookup goes through
    // TicketRoleAssignment instead of the legacy assignee_id/reporter_id/
    // reviewer_id columns. Build the candidate ticket set from assignment
    // rows first so custom workspace roles are picked up automatically.
    const assignRepo = this.dataSource.getRepository(TicketRoleAssignment);
    const myAssignments = await assignRepo.find({ where: { agent_id: agentId } });
    if (myAssignments.length === 0) return [];

    const assignedTicketIds = Array.from(new Set(myAssignments.map(a => a.ticket_id)));
    const ticketRepo = this.dataSource.getRepository(Ticket);
    const tickets = await ticketRepo.createQueryBuilder('t')
      .innerJoin('columns', 'col', 'col.id = t.column_id')
      .innerJoin('boards', 'b', 'b.id = col.board_id')
      .where('b.workspace_id = :workspaceId', { workspaceId })
      .andWhere('t.id IN (:...ticketIds)', { ticketIds: assignedTicketIds })
      .getMany();

    if (tickets.length === 0) return [];

    // Index assignments by ticket → set of role IDs for which this agent is
    // the holder. Used inside the per-ticket loop to decide which roles
    // contribute rows.
    const myRoleIdsByTicket = new Map<string, Set<string>>();
    for (const a of myAssignments) {
      const set = myRoleIdsByTicket.get(a.ticket_id) ?? new Set<string>();
      set.add(a.role_id);
      myRoleIdsByTicket.set(a.ticket_id, set);
    }

    // Resolve role slugs once for the workspace — keys for routing_config.
    const roleRepo = this.dataSource.getRepository(WorkspaceRole);
    const roles = await roleRepo.find({ where: { workspace_id: workspaceId } });
    const roleBySlug = new Map(roles.map(r => [r.slug, r]));

    const colIds = Array.from(new Set(tickets.map(t => t.column_id).filter(Boolean) as string[]));
    if (colIds.length === 0) return [];

    const columns = await this.dataSource.getRepository(BoardColumn)
      .createQueryBuilder('col')
      .where('col.id IN (:...ids)', { ids: colIds })
      .getMany();
    const colById = new Map(columns.map(c => [c.id, c]));

    const rows: AllocatedTicketRow[] = [];
    const rowTicketIds = new Set<string>();

    for (const ticket of tickets) {
      if (!ticket.column_id) continue;
      const col = colById.get(ticket.column_id);
      if (!col) continue;
      // Terminal columns never trigger — kind='terminal' OR is_terminal=true
      // (the boolean is the legacy parallel field; both must hold for the
      // backfill to converge but checking either is defensive).
      if ((col as any).is_terminal === true) continue;
      if ((col as any).kind === 'terminal') continue;

      // v0.41 — read role slugs straight off the column row. Replaces the
      // old `Board.routing_config[col.name.toLowerCase()]` lookup.
      const slugList = safeJsonParse<string[]>((col as any).role_routing, []);
      if (!Array.isArray(slugList) || slugList.length === 0) continue;

      const myRoleIds = myRoleIdsByTicket.get(ticket.id) ?? new Set<string>();
      for (const slug of slugList) {
        const role = roleBySlug.get(slug);
        if (!role) continue;
        if (!myRoleIds.has(role.id)) continue;
        rows.push({
          ticket_id: ticket.id,
          role: slug,
          column_id: ticket.column_id,
          column_position: col.position,
          priority: ticket.priority || 'medium',
          priority_index: priorityIndex(ticket.priority),
          title: ticket.title,
          my_last_update_at: null,
        });
        rowTicketIds.add(ticket.id);
      }
    }

    if (rows.length === 0) return [];

    const ticketIdsArr = Array.from(rowTicketIds);

    const latestComments = await this.dataSource.getRepository(Comment)
      .createQueryBuilder('c')
      .select('c.ticket_id', 'ticket_id')
      .addSelect('MAX(c.created_at)', 'latest')
      .where('c.ticket_id IN (:...ids)', { ids: ticketIdsArr })
      .andWhere(`c.author_type = 'agent' AND c.author_id = :agentId`, { agentId })
      .groupBy('c.ticket_id')
      .getRawMany<{ ticket_id: string; latest: string | Date | null }>();

    // Exclude lock-lifecycle bookkeeping (agent_claim / agent_release) from
    // my_last_update_at. These rows are server-emitted — including on the
    // death-triggered force-release when a manager crashes mid-session — so
    // counting them resets the supervisor's staleness clock to the lock-
    // death moment and silences the resend cadence for a full staleness
    // window (default 30 min) right when supervisor should be re-firing.
    const latestActivity = await this.dataSource.getRepository(ActivityLog)
      .createQueryBuilder('a')
      .select('a.ticket_id', 'ticket_id')
      .addSelect('MAX(a.created_at)', 'latest')
      .where('a.ticket_id IN (:...ids)', { ids: ticketIdsArr })
      .andWhere('a.actor_id = :agentId', { agentId })
      .andWhere('a.trigger_source NOT IN (:...lifecycleSources)', {
        lifecycleSources: ['agent_claim', 'agent_release'],
      })
      .groupBy('a.ticket_id')
      .getRawMany<{ ticket_id: string; latest: string | Date | null }>();

    const maxByTicket = new Map<string, number>();
    const fold = (row: { ticket_id: string; latest: string | Date | null }) => {
      if (!row.latest) return;
      const ts = row.latest instanceof Date ? row.latest.getTime() : new Date(row.latest).getTime();
      if (!Number.isFinite(ts)) return;
      const prev = maxByTicket.get(row.ticket_id) ?? 0;
      if (ts > prev) maxByTicket.set(row.ticket_id, ts);
    };
    latestComments.forEach(fold);
    latestActivity.forEach(fold);

    for (const r of rows) {
      const ts = maxByTicket.get(r.ticket_id);
      r.my_last_update_at = ts ? new Date(ts).toISOString() : null;
    }

    // v0.41 — sort by priority_index ASC so callers (supervisor re-push,
    // diagnostic dashboards) see highest-priority first. Within the same
    // priority, oldest-stale row first by my_last_update_at — stale items
    // are the ones supervisor cares about, sorting them first makes the
    // re-push cadence pick them up before fresher rows.
    rows.sort((a, b) => {
      if (a.priority_index !== b.priority_index) return a.priority_index - b.priority_index;
      const ta = a.my_last_update_at ? Date.parse(a.my_last_update_at) : 0;
      const tb = b.my_last_update_at ? Date.parse(b.my_last_update_at) : 0;
      return ta - tb;
    });

    return rows;
  }
}
