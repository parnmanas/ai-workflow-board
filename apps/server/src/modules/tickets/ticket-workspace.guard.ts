import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Ticket } from '../../entities/Ticket';
import { isUuidShapedId } from '../../utils/agent-name';

/**
 * Runs after WorkspaceGuard on every `/tickets/:id/...` route: a non-admin may
 * only touch a ticket of the workspace WorkspaceGuard verified. A ticket of
 * another workspace answers 404, the same as one that does not exist, so ids
 * cannot be probed. Missing tickets pass through to the handler's own 404.
 */
@Injectable()
export class TicketWorkspaceGuard implements CanActivate {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    if (req.currentUser?.role === 'admin') return true;
    const ticketId = req.params?.id || req.params?.parentId || req.params?.ticketId;
    if (!ticketId) return true;
    if (!isUuidShapedId(ticketId)) throw new NotFoundException('Ticket not found');
    const ticket = await this.dataSource.getRepository(Ticket).findOne({
      where: { id: ticketId },
      select: ['id', 'workspace_id'],
    });
    if (ticket && ticket.workspace_id !== req.currentWorkspaceId) throw new NotFoundException('Ticket not found');
    return true;
  }
}
