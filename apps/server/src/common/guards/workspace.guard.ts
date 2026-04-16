import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { ReBACService } from '../../services/rebac.service';

@Injectable()
export class WorkspaceGuard implements CanActivate {
  constructor(private readonly rebacService: ReBACService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const user = req.currentUser;

    // Admin bypass — per D-09: admins can access any workspace without a tuple
    if (user?.role === 'admin') {
      const wsId = req.headers['x-workspace-id'] || req.query['workspace_id'];
      req.currentWorkspaceId = wsId || null;
      return true;
    }

    // Header or query param — SSE uses ?workspace_id= because EventSource cannot send headers
    const workspaceId = req.headers['x-workspace-id'] || req.query['workspace_id'];
    if (!workspaceId) {
      throw new UnauthorizedException('workspace_required');
    }

    // Check both 'member' and 'owner' relations
    const isMember = await this.rebacService.check(
      { type: 'user', id: user.id },
      'member',
      { type: 'workspace', id: workspaceId },
    );
    const isOwner = !isMember && await this.rebacService.check(
      { type: 'user', id: user.id },
      'owner',
      { type: 'workspace', id: workspaceId },
    );

    if (!isMember && !isOwner) {
      throw new ForbiddenException('workspace_access_denied');
    }

    req.currentWorkspaceId = workspaceId;
    return true;
  }
}
