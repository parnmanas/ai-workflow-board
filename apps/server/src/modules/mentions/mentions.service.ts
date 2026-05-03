import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { UserMention } from '../../entities/UserMention';
import { Ticket } from '../../entities/Ticket';
import { BoardColumn } from '../../entities/BoardColumn';

// API surface — UserMention plus the resolved board_id for comment-type rows.
// Chat-type rows always carry board_id=null (deep link uses room_id).
export type UserMentionRow = UserMention & { board_id: string | null };

@Injectable()
export class MentionsService {
  constructor(
    @InjectRepository(UserMention) private readonly repo: Repository<UserMention>,
    @InjectRepository(Ticket) private readonly ticketRepo: Repository<Ticket>,
    @InjectRepository(BoardColumn) private readonly colRepo: Repository<BoardColumn>,
  ) {}

  /**
   * List the given user's unread mentions in one workspace, newest first.
   *
   * Comment-type rows are decorated with `board_id` (resolved via
   * Ticket → BoardColumn) so the inbox can build a deep link to
   * `/ws/<wsId>/boards/<boardId>?ticket=<id>&comment=<id>` without
   * extra round-trips. SSE rows already carry `board_id` at emit time —
   * this path covers cold loads where we never saw the SSE event.
   */
  async listUnread(workspaceId: string, userId: string, limit = 50): Promise<UserMentionRow[]> {
    const rows = await this.repo.find({
      where: { workspace_id: workspaceId, user_id: userId, read_at: IsNull() },
      order: { created_at: 'DESC' },
      take: Math.min(limit, 200),
    });

    const ticketIds = Array.from(new Set(
      rows
        .filter(r => r.source_type === 'comment' && r.ticket_id)
        .map(r => r.ticket_id as string),
    ));
    const boardByTicket = new Map<string, string | null>();
    if (ticketIds.length > 0) {
      const tickets = await this.ticketRepo.find({
        where: { id: In(ticketIds) },
        select: ['id', 'column_id'] as any,
      });
      const colIds = Array.from(new Set(tickets.map(t => t.column_id).filter(Boolean) as string[]));
      const cols = colIds.length > 0
        ? await this.colRepo.find({ where: { id: In(colIds) }, select: ['id', 'board_id'] as any })
        : [];
      const boardByCol = new Map(cols.map(c => [c.id, c.board_id]));
      for (const t of tickets) {
        boardByTicket.set(t.id, t.column_id ? boardByCol.get(t.column_id) ?? null : null);
      }
    }

    return rows.map(r => ({
      ...r,
      board_id: r.source_type === 'comment' && r.ticket_id
        ? boardByTicket.get(r.ticket_id) ?? null
        : null,
    }));
  }

  /**
   * Count the given user's unread mentions in one workspace.
   */
  async countUnread(workspaceId: string, userId: string): Promise<number> {
    return this.repo.count({
      where: { workspace_id: workspaceId, user_id: userId, read_at: IsNull() },
    });
  }

  /**
   * Mark one mention as read. Returns the updated row, or null if the mention
   * doesn't exist or belongs to a different user.
   */
  async markRead(mentionId: string, userId: string): Promise<UserMention | null> {
    const row = await this.repo.findOne({ where: { id: mentionId } });
    if (!row || row.user_id !== userId) return null;
    if (row.read_at) return row;
    row.read_at = new Date();
    return this.repo.save(row);
  }

  /**
   * Mark every unread mention in a workspace as read for this user.
   * Returns the number of rows advanced.
   */
  async markAllRead(workspaceId: string, userId: string): Promise<number> {
    const result = await this.repo
      .createQueryBuilder()
      .update()
      .set({ read_at: () => 'CURRENT_TIMESTAMP' })
      .where('workspace_id = :wsId AND user_id = :uid AND read_at IS NULL', { wsId: workspaceId, uid: userId })
      .execute();
    return result.affected ?? 0;
  }
}
