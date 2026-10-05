import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { ChildRunService } from './child-run.service';

@ApiTags('child-runs')
@ApiBearerAuth('user-session')
@UseGuards(AuthGuard, PermissionGuard)
@RequirePermission(PERMISSIONS.VIEW_ACTIVITY)
@Controller('api/accounts/:accountId/runs/:runId/children')
export class ChildRunsController {
  constructor(private readonly childRuns: ChildRunService) {}

  @Get()
  list(
    @Param('accountId') accountId: string,
    @Param('runId') runId: string,
  ) {
    return this.childRuns.list(accountId, runId);
  }
}

@ApiTags('child-runs')
@ApiBearerAuth('user-session')
@UseGuards(AuthGuard, PermissionGuard)
@RequirePermission(PERMISSIONS.VIEW_ACTIVITY)
@Controller('api/accounts/:accountId/agents/:agentId/child-runs')
export class AgentChildRunsController {
  constructor(private readonly childRuns: ChildRunService) {}

  @Get()
  list(
    @Param('accountId') accountId: string,
    @Param('agentId') agentId: string,
  ) {
    return this.childRuns.listForAgent(accountId, agentId);
  }
}
