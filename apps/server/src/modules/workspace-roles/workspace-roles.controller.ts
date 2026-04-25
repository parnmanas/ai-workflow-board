import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { AuthGuard } from '../../common/guards/auth.guard';
import { WorkspaceRolesService } from './workspace-roles.service';

/**
 * Workspace-scoped role management. Mounted under
 * `/api/workspaces/:workspaceId/roles` so URL hierarchy mirrors the data
 * ownership (every role belongs to exactly one workspace).
 *
 * Auth: AuthGuard for now. Per-route admin/permission gating is intentionally
 * not added at this layer because the existing workspace-config endpoints
 * (Workspace.update, Members PATCH, etc.) similarly rely on the workspace
 * member/owner ReBAC check inside the controller — extending that check to
 * roles can land in a follow-up without rewriting the route surface.
 */
@ApiBearerAuth('user-session')
@ApiTags('workspace-roles')
@Controller('api/workspaces/:workspaceId/roles')
@UseGuards(AuthGuard)
export class WorkspaceRolesController {
  constructor(private readonly service: WorkspaceRolesService) {}

  @Get()
  async list(@Param('workspaceId') workspaceId: string, @Res() res: Response) {
    const roles = await this.service.list(workspaceId);
    return res.json(roles);
  }

  @Post()
  async create(
    @Param('workspaceId') workspaceId: string,
    @Body() body: any,
    @Res() res: Response,
  ) {
    try {
      const role = await this.service.create(workspaceId, {
        slug: body.slug,
        name: body.name,
        role_prompt: body.role_prompt,
        description: body.description,
        position: body.position,
      });
      return res.status(201).json(role);
    } catch (err: any) {
      return res.status(err.status || 400).json({ error: err.message });
    }
  }

  @Patch(':roleId')
  async update(
    @Param('roleId') roleId: string,
    @Body() body: any,
    @Res() res: Response,
  ) {
    try {
      const role = await this.service.update(roleId, {
        slug: body.slug,
        name: body.name,
        role_prompt: body.role_prompt,
        description: body.description,
        position: body.position,
      });
      return res.json(role);
    } catch (err: any) {
      return res.status(err.status || 400).json({ error: err.message });
    }
  }

  @Delete(':roleId')
  async remove(@Param('roleId') roleId: string, @Res() res: Response) {
    try {
      await this.service.remove(roleId);
      return res.json({ ok: true });
    } catch (err: any) {
      return res.status(err.status || 400).json({ error: err.message });
    }
  }
}
