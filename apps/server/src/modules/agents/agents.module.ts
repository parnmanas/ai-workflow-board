import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RuntimeHost } from '../../entities/RuntimeHost';
import { ApiKey } from '../../entities/ApiKey';
import { Ticket } from '../../entities/Ticket';
import { Subagent } from '../../entities/Subagent';
import { SubagentLogLine } from '../../entities/SubagentLogLine';
import { AgentUsageDailyRollup } from '../../entities/AgentUsageDailyRollup';
import { CiRedAlert } from '../../entities/CiRedAlert';
import { ChildRun } from '../../entities/ChildRun';
import { FsBrowserController } from './fs-browser.controller';
import { SubagentMonitorController } from './subagent-monitor.controller';
import { AgentConnectionService } from './agent-connection.service';
import { AgentStatusService } from './agent-status.service';
import { CiHealthMonitorService } from './ci-health-monitor.service';
import { CiWaitResumeService } from './ci-wait-resume.service';
import { AgentUsageService } from './agent-usage.service';
import { AgentAutostartService } from './agent-autostart.service';
import { ChildRunService } from './child-run.service';
import { AgentChildRunsController, ChildRunsController } from './child-runs.controller';
import { TicketPrerequisitesService } from '../tickets/ticket-prerequisites.service';
import { CiWaitService } from '../tickets/ci-wait.service';
import { TicketService } from '../tickets/ticket.service';
import { TicketDuplicateService } from '../tickets/ticket-duplicate.service';
import { TicketDispatchService } from './ticket-dispatch.service';
import { FsBrowserService } from '../../services/fs-browser.service';
import { SubagentMonitorService } from '../../services/subagent-monitor.service';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { AgentAuthGuard } from '../../common/guards/agent-auth.guard';
import { AgentManagerModule } from '../agent-manager/agent-manager.module';
import { ChatRoomsModule } from '../chat-rooms/chat-rooms.module';
import { SkillsModule } from '../skills/skills.module';

@Module({
  // forwardRef avoids the AgentsModule ↔ AgentManagerModule cycle:
  // AgentManagerModule already imports AgentsModule (for SubagentMonitorService),
  // and now AgentsModule needs InstanceRegistryService from AgentManagerModule
  // to enrich /api/agents responses with live heartbeat data.
  imports: [
    TypeOrmModule.forFeature([RuntimeHost, ApiKey, Ticket, Subagent, SubagentLogLine, AgentUsageDailyRollup, CiRedAlert, ChildRun]),
    forwardRef(() => AgentManagerModule),
    // ChatRoomsModule is the home of RoomMessagingService, which
    // CiHealthMonitorService uses to post in-process alerts. No cycle
    // (chat-rooms does not depend on agents).
    ChatRoomsModule,
    SkillsModule,
  ],
  controllers: [
    // P4c-4: AgentsController (Agent-row CRUD) removed with the Agent table.
    FsBrowserController,
    SubagentMonitorController,
    ChildRunsController,
    AgentChildRunsController,
  ],
  providers: [
    AuthGuard, PermissionGuard, AgentAuthGuard, AdminGuard,
    AgentConnectionService, AgentStatusService,
    TicketDispatchService,
    TicketService,
    TicketDuplicateService,
    CiHealthMonitorService,
    CiWaitService,
    CiWaitResumeService,
    AgentUsageService,
    TicketPrerequisitesService,
    FsBrowserService, SubagentMonitorService,
    AgentAutostartService,
    ChildRunService,
  ],
  exports: [
    AgentConnectionService, AgentStatusService,
    TicketDispatchService,
    TicketService,
    TicketDuplicateService,
    CiHealthMonitorService,
    CiWaitService,
    CiWaitResumeService,
    AgentUsageService,
    TicketPrerequisitesService,
    FsBrowserService, SubagentMonitorService,
    ChildRunService,
  ],
})
export class AgentsModule {}
