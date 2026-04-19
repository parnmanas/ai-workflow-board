import { ApiTags } from '@nestjs/swagger';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { LogService } from '../../services/log.service';

@ApiTags('logs')
@Controller('api/admin')
@UseGuards(PermissionGuard)
@RequirePermission(PERMISSIONS.ADMIN_ACCESS)
export class LogsController {
  constructor(private readonly logService: LogService) {}

  @Get('logs')
  getLogs(
    @Query('level') level?: string,
    @Query('category') category?: string,
    @Query('since') since?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.logService.query({
      level,
      category,
      since,
      limit: limit ? parseInt(limit) : 200,
      search,
    });
  }

  @Get('logs/stats')
  getStats() {
    return this.logService.getStats();
  }

  @Get('logs/categories')
  getCategories() {
    return this.logService.getCategories();
  }
}
