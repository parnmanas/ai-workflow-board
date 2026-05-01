import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { AgentAuthGuard } from '../../common/guards/agent-auth.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { AgentManagerController } from './agent-manager.controller';
import { InstanceRegistryService } from './instance-registry.service';

@Module({
  // AgentsModule re-exports SubagentMonitorService so the same singleton that
  // backs SubagentMonitorController (used by /api/subagent-monitor/*) also
  // serves the per-instance subagents view here. Sharing the singleton avoids
  // a split brain between the two routes.
  imports: [AgentsModule],
  controllers: [AgentManagerController],
  providers: [
    InstanceRegistryService,
    AgentAuthGuard,
    AuthGuard,
    PermissionGuard,
  ],
  exports: [InstanceRegistryService],
})
export class AgentManagerModule {}
