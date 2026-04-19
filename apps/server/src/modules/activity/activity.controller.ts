import { ApiTags } from '@nestjs/swagger';
import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { ActivityService } from '../../services/activity.service';

// Phase 3 D-46 — workspace-wide recent activity feed for the dashboard.
// Single-workspace assumption per REQUIREMENTS.md §Out of Scope — no per-workspace
// scoping on getRecentActivity. Multi-tenant scoping is deferred.
@ApiTags('activity')
@Controller('api')
@UseGuards(PermissionGuard)
@RequirePermission(PERMISSIONS.VIEW_ACTIVITY)
export class ActivityController {
  constructor(private readonly activityService: ActivityService) {}

  @Get('tickets/:ticketId/activity')
  async getTicketActivity(@Param('ticketId') ticketId: string, @Query('limit') limitRaw: string, @Res() res: Response) {
    const limit = Math.min(Math.max(parseInt(limitRaw) || 50, 1), 200);
    const logs = await this.activityService.getTicketActivity(ticketId, limit);
    return res.json(logs);
  }

  @Get('activity')
  async getRecentActivity(@Query('limit') limitRaw: string, @Res() res: Response) {
    const limit = Math.min(Math.max(parseInt(limitRaw) || 50, 1), 200);
    const logs = await this.activityService.getRecentActivity(limit);
    return res.json(logs);
  }
}
