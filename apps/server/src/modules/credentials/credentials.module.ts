import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Credential } from '../../entities/Credential';
import { CliLoginSession } from '../../entities/CliLoginSession';
import { CredentialsController } from './credentials.controller';
import { CliLoginAgentController } from './cli-login-agent.controller';
import { CliLoginSessionService } from './cli-login-session.service';
import { CliLoginSessionReaperService } from './cli-login-session-reaper.service';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { AdminGuard } from '../../common/guards/admin.guard';
import { AgentAuthGuard } from '../../common/guards/agent-auth.guard';
import { AgentManagerModule } from '../agent-manager/agent-manager.module';

@Module({
  // AgentManagerModule exports InstanceRegistryService (live Runtime Host
  // lookup) + AgentManagerCommandService (issue cli_login_start/cancel over
  // the existing agent_manager_command SSE channel) — CliLoginSessionService
  // needs both to dispatch a device-auth login to a specific manager instance.
  imports: [TypeOrmModule.forFeature([Credential, CliLoginSession]), AgentManagerModule],
  controllers: [CredentialsController, CliLoginAgentController],
  providers: [
    AuthGuard,
    PermissionGuard,
    AdminGuard,
    AgentAuthGuard,
    CliLoginSessionService,
    CliLoginSessionReaperService,
  ],
})
export class CredentialsModule {}
