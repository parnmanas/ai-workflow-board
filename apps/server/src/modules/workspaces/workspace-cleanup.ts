import type { DataSource } from 'typeorm';
import { Ticket } from '../../entities/Ticket';
import { Project } from '../../entities/Project';
import { ProjectHostFolder } from '../../entities/ProjectHostFolder';

/**
 * Tickets and projects reference their workspace by a plain varchar (no FK),
 * so deleting a workspace must remove them explicitly — the board → column →
 * ticket cascade that used to do it is gone. Comments, attachments and
 * prerequisite links cascade from the ticket rows.
 */
export async function deleteWorkspaceContent(dataSource: DataSource, workspaceId: string): Promise<void> {
  await dataSource.transaction(async (manager) => {
    // Children first: their parent FK is ON DELETE CASCADE, but deleting the
    // whole set in one statement is portable only when nothing points at a
    // row already gone.
    await manager.getRepository(Ticket).createQueryBuilder().delete()
      .where('workspace_id = :ws AND parent_id IS NOT NULL', { ws: workspaceId }).execute();
    await manager.getRepository(Ticket).createQueryBuilder().delete()
      .where('workspace_id = :ws', { ws: workspaceId }).execute();
    const projects = await manager.getRepository(Project).find({ where: { workspace_id: workspaceId }, select: ['id'] });
    for (const project of projects) {
      await manager.getRepository(ProjectHostFolder).delete({ project_id: project.id });
    }
    await manager.getRepository(Project).delete({ workspace_id: workspaceId });
  });
}
