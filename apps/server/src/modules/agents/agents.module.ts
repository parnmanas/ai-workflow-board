import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Agent } from '../../entities/Agent';
import { Ticket } from '../../entities/Ticket';
import { Subagent } from '../../entities/Subagent';
import { SubagentLogLine } from '../../entities/SubagentLogLine';
import { AgentsController } from './agents.controller';
import { FsBrowserController } from './fs-browser.controller';
import { SubagentMonitorController } from './subagent-monitor.controller';
import { AgentConnectionService } from './agent-connection.service';
import { TriggerLoopService } from './trigger-loop.service';
import { AgentStatusService } from './agent-status.service';
import { AllocationService } from './allocation.service';
import { TicketSupervisorService } from './ticket-supervisor.service';
import { AgentWorkloadService } from './agent-workload.service';
import { BacklogPromotionService } from './backlog-promotion.service';
import { FsBrowserService } from '../../services/fs-browser.service';
import { SubagentMonitorService } from '../../services/subagent-monitor.service';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { AgentAuthGuard } from '../../common/guards/agent-auth.guard';
import { AgentManagerModule } from '../agent-manager/agent-manager.module';

@Module({
  // forwardRef avoids the AgentsModule ↔ AgentManagerModule cycle:
  // AgentManagerModule already imports AgentsModule (for SubagentMonitorService),
  // and now AgentsModule needs InstanceRegistryService from AgentManagerModule
  // to enrich /api/agents responses with live heartbeat data.
  imports: [
    TypeOrmModule.forFeature([Agent, Ticket, Subagent, SubagentLogLine]),
    forwardRef(() => AgentManagerModule),
  ],
  controllers: [AgentsController, FsBrowserController, SubagentMonitorController],
  providers: [
    AuthGuard, PermissionGuard, AgentAuthGuard,
    AgentConnectionService, TriggerLoopService, AgentStatusService, AllocationService,
    TicketSupervisorService,
    BacklogPromotionService,
    AgentWorkloadService,
    FsBrowserService, SubagentMonitorService,
  ],
  exports: [
    AgentConnectionService, TriggerLoopService, AgentStatusService, AllocationService,
    BacklogPromotionService,
    AgentWorkloadService,
    FsBrowserService, SubagentMonitorService,
  ],
})
export class AgentsModule {}
