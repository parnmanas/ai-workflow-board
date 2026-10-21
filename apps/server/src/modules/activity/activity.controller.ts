import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { ActivityService } from '../../services/activity.service';

// Activity feeds use the same account boundary as their source work.
@ApiBearerAuth('user-session')
@ApiTags('activity')
@Controller('api')
@UseGuards(PermissionGuard)
@RequirePermission(PERMISSIONS.VIEW_ACTIVITY)
export class ActivityController {
  constructor(private readonly activityService: ActivityService) {}

  @Get('tickets/:ticketId/activity')
  async getTicketActivity(@Param('ticketId') ticketId: string, @Query('limit') limitRaw: string, @Res() res: Response, @Req() req: any) {
    const limit = Math.min(Math.max(parseInt(limitRaw) || 50, 1), 200);
    const logs = await this.activityService.getTicketActivity(ticketId, req.accessibleAccountIds || [], limit);
    return res.json(logs);
  }

  @Get('activity')
  async getRecentActivity(@Query('limit') limitRaw: string, @Res() res: Response, @Req() req: any) {
    const limit = Math.min(Math.max(parseInt(limitRaw) || 50, 1), 200);
    const logs = await this.activityService.getRecentActivity(req.accessibleAccountIds || [], limit);
    return res.json(logs);
  }
}
