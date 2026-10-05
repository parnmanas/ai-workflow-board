import type { DataSource } from 'typeorm';
import { Ticket } from '../../entities/Ticket';
import { Project } from '../../entities/Project';
import { ProjectHostFolder } from '../../entities/ProjectHostFolder';
import { AgentSessionExecution } from '../../entities/AgentSessionExecution';
import { AgentSessionCliSetting } from '../../entities/AgentSessionCliSetting';
import { activityEvents } from '../../services/activity.service';

/**
 * Tickets and projects reference their workspace by a plain varchar (no FK),
 * so deleting a workspace must remove them explicitly — the board → column →
 * ticket cascade that used to do it is gone. Comments, attachments and
 * prerequisite links cascade from the ticket rows.
 */
export async function deleteAccountContent(dataSource: DataSource, accountId: string): Promise<void> {
  await dataSource.transaction(async (manager) => {
    await manager.getRepository(AgentSessionExecution).delete({ account_id: accountId });
    await manager.getRepository(AgentSessionCliSetting).delete({ account_id: accountId });
    // Children first: their parent FK is ON DELETE CASCADE, but deleting the
    // whole set in one statement is portable only when nothing points at a
    // row already gone.
    await manager.getRepository(Ticket).createQueryBuilder().delete()
      .where('account_id = :ws AND parent_id IS NOT NULL', { ws: accountId }).execute();
    await manager.getRepository(Ticket).createQueryBuilder().delete()
      .where('account_id = :ws', { ws: accountId }).execute();
    const projects = await manager.getRepository(Project).find({ where: { account_id: accountId }, select: ['id'] });
    for (const project of projects) {
      await manager.getRepository(ProjectHostFolder).delete({ project_id: project.id });
    }
    await manager.getRepository(Project).delete({ account_id: accountId });
  });
  activityEvents.emit('account_membership_changed', { account_id: accountId });
}
