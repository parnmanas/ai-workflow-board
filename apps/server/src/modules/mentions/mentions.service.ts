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
      // Subtasks (depth > 0) carry no column_id — only the root ancestor does.
      // Resolving from column_id alone therefore returned board_id=null for
      // every mention on a subtask comment, and the inbox fell back to a
      // board-less URL that no page consumed (the click went nowhere). Walk
      // the parent chain the same bounded way tickets.controller does.
      const byId = new Map<string, { column_id: string | null; parent_id: string | null }>();
      let frontier: string[] = ticketIds.slice();
      for (let hop = 0; frontier.length > 0 && hop < 6; hop++) {
        const missing = frontier.filter(id => !byId.has(id));
        if (missing.length === 0) break;
        const rows = await this.ticketRepo.find({
          where: { id: In(missing) },
          select: ['id', 'column_id', 'parent_id'] as any,
        });
        for (const t of rows) byId.set(t.id, { column_id: t.column_id, parent_id: t.parent_id });
        frontier = rows
          .map(t => t.parent_id)
          .filter((pid): pid is string => !!pid && !byId.has(pid));
      }
      const resolveColumn = (startId: string): string | null => {
        let cursor = byId.get(startId);
        for (let i = 0; cursor && !cursor.column_id && cursor.parent_id && i < 5; i++) {
          cursor = byId.get(cursor.parent_id);
        }
        return cursor?.column_id ?? null;
      };

      const colIds = Array.from(new Set(
        ticketIds.map(resolveColumn).filter(Boolean) as string[],
      ));
      const cols = colIds.length > 0
        ? await this.colRepo.find({ where: { id: In(colIds) }, select: ['id', 'board_id'] as any })
        : [];
      const boardByCol = new Map(cols.map(c => [c.id, c.board_id]));
      for (const id of ticketIds) {
        const colId = resolveColumn(id);
        boardByTicket.set(id, colId ? boardByCol.get(colId) ?? null : null);
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
   * The user's unread mentions inside ONE source (a ticket thread or a chat
   * room), projected down to `{ id, source_id }`.
   *
   * `source_id` is the comment / chat-message the mention lives in, which is
   * what the client matches against the rows it has on screen: a mention is
   * only cleared once its own comment actually enters the viewport. Opening
   * the thread is not evidence the user saw a mention buried in it, and a
   * chat room opens scrolled to the newest message — which says nothing about
   * a mention 200 messages up.
   *
   * Unbounded on purpose (unlike listUnread's 50-row inbox cap): this is a
   * two-column projection scoped to a single ticket / room, and a cap here
   * would silently leave mentions unclearable in a long thread.
   */
  async listUnreadBySource(
    userId: string,
    source: { ticketId?: string; roomId?: string },
  ): Promise<Array<{ id: string; source_id: string }>> {
    if (!source.ticketId && !source.roomId) return [];
    const qb = this.repo
      .createQueryBuilder('m')
      .select(['m.id AS id', 'm.source_id AS source_id'])
      .where('m.user_id = :uid AND m.read_at IS NULL', { uid: userId });
    if (source.ticketId) qb.andWhere('m.ticket_id = :tid', { tid: source.ticketId });
    if (source.roomId) qb.andWhere('m.room_id = :rid', { rid: source.roomId });
    const rows = await qb.getRawMany();
    return rows.map(r => ({ id: String(r.id), source_id: String(r.source_id) }));
  }

  /**
   * Mark several of this user's mentions read in one round-trip. The viewport
   * reader batches whatever became visible in the same flush, so this avoids
   * N requests when a screenful contains several mentions.
   *
   * Scoped to `userId` and to still-unread rows, so a caller cannot clear
   * someone else's inbox by guessing ids, and an already-read row keeps its
   * original read_at.
   */
  async markManyRead(mentionIds: string[], userId: string): Promise<number> {
    const ids = Array.from(new Set(mentionIds.filter(id => typeof id === 'string' && id)));
    if (ids.length === 0) return 0;
    const result = await this.repo
      .createQueryBuilder()
      .update()
      .set({ read_at: () => 'CURRENT_TIMESTAMP' })
      .where('id IN (:...ids)', { ids })
      .andWhere('user_id = :uid AND read_at IS NULL', { uid: userId })
      .execute();
    return result.affected ?? 0;
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
