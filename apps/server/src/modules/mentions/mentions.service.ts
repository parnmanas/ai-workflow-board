import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { UserMention } from '../../entities/UserMention';

@Injectable()
export class MentionsService {
  constructor(
    @InjectRepository(UserMention) private readonly repo: Repository<UserMention>,
  ) {}

  /**
   * List the given user's unread mentions in one workspace, newest first.
   */
  async listUnread(workspaceId: string, userId: string, limit = 50): Promise<UserMention[]> {
    return this.repo.find({
      where: { workspace_id: workspaceId, user_id: userId, read_at: IsNull() },
      order: { created_at: 'DESC' },
      take: Math.min(limit, 200),
    });
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
