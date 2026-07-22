import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Agent } from '../../entities/Agent';
import { Ticket } from '../../entities/Ticket';
import { Subagent } from '../../entities/Subagent';
import { SubagentLogLine } from '../../entities/SubagentLogLine';
import { StuckTicketAlert } from '../../entities/StuckTicketAlert';
import { DispatchIntent } from '../../entities/DispatchIntent';
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
import { ClaimVerificationService } from './claim-verification.service';
import { StuckTicketDetectorService } from './stuck-ticket-detector.service';
import { RespawnStormDetectorService } from './respawn-storm-detector.service';
import { AgentUsageService } from './agent-usage.service';
import { DispatchIntentService } from './dispatch-intent.service';
import { DispatchReconcilerService } from './dispatch-reconciler.service';
import { AgentAutostartService } from './agent-autostart.service';
import { TicketPrerequisitesService } from '../tickets/ticket-prerequisites.service';
import { FsBrowserService } from '../../services/fs-browser.service';
import { SubagentMonitorService } from '../../services/subagent-monitor.service';
import { WorkspaceMoveService } from '../../services/workspace-move.service';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { AgentAuthGuard } from '../../common/guards/agent-auth.guard';
import { AgentManagerModule } from '../agent-manager/agent-manager.module';
import { ChatRoomsModule } from '../chat-rooms/chat-rooms.module';
import { ColumnPoliciesModule } from '../column-policies/column-policies.module';

@Module({
  // forwardRef avoids the AgentsModule ↔ AgentManagerModule cycle:
  // AgentManagerModule already imports AgentsModule (for SubagentMonitorService),
  // and now AgentsModule needs InstanceRegistryService from AgentManagerModule
  // to enrich /api/agents responses with live heartbeat data.
  imports: [
    TypeOrmModule.forFeature([Agent, Ticket, Subagent, SubagentLogLine, StuckTicketAlert, DispatchIntent]),
    forwardRef(() => AgentManagerModule),
    // ChatRoomsModule is the home of RoomMessagingService, which
    // StuckTicketDetectorService uses to post in-process alerts via
    // its sendSystemMessage helper. Direct import — no cycle (chat-rooms
    // does not depend on agents).
    ChatRoomsModule,
    // ColumnPoliciesModule exports ColumnRolePolicyService — read-only
    // consumer inside the stuck detector sweep (ticket f886ada7).
    ColumnPoliciesModule,
  ],
  controllers: [AgentsController, FsBrowserController, SubagentMonitorController],
  providers: [
    AuthGuard, PermissionGuard, AgentAuthGuard, AdminGuard,
    AgentConnectionService, TriggerLoopService, AgentStatusService, AllocationService,
    TicketSupervisorService,
    BacklogPromotionService,
    AgentWorkloadService,
    StuckTicketDetectorService,
    RespawnStormDetectorService,
    AgentUsageService,
    ClaimVerificationService,
    TicketPrerequisitesService,
    FsBrowserService, SubagentMonitorService,
    WorkspaceMoveService,
    DispatchIntentService,
    DispatchReconcilerService,
    AgentAutostartService,
  ],
  exports: [
    AgentConnectionService, TriggerLoopService, AgentStatusService, AllocationService,
    BacklogPromotionService,
    AgentWorkloadService,
    StuckTicketDetectorService,
    RespawnStormDetectorService,
    AgentUsageService,
    ClaimVerificationService,
    TicketPrerequisitesService,
    FsBrowserService, SubagentMonitorService,
    DispatchIntentService,
    DispatchReconcilerService,
  ],
})
export class AgentsModule {}
