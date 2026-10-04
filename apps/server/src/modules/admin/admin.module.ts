import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../../entities/User';
import { Workspace } from '../../entities/Workspace';
import { SystemSetting } from '../../entities/SystemSetting';
import { DiagnosticsController, PublicDiagnosticsController } from './diagnostics.controller';
import { LogsController } from './logs.controller';
import { PendingUsersController } from './pending-users.controller';
import { SettingsController } from './settings.controller';
import { WorkflowHealthController } from './workflow-health.controller';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { AgentsModule } from '../agents/agents.module';
import { ClaudeBackendProfileCatalogController, ClaudeBackendProfilesController } from './claude-backend-profiles.controller';
import { ClaudeBackendProfile } from '../../entities/ClaudeBackendProfile';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Workspace, SystemSetting, ClaudeBackendProfile]),
    // AgentsModule exports AgentUsageService, which the workflow-health
    // controller reads. forwardRef defends against any future cycle if
    // AgentsModule starts importing AdminModule symbols.
    forwardRef(() => AgentsModule),
  ],
  controllers: [
    DiagnosticsController,
    PublicDiagnosticsController,
    LogsController,
    PendingUsersController,
    SettingsController,
    WorkflowHealthController,
    ClaudeBackendProfilesController,
    ClaudeBackendProfileCatalogController,
  ],
  providers: [AuthGuard, AdminGuard, PermissionGuard],
})
export class AdminModule {}
