import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QaScenario } from '../../entities/QaScenario';
import { QaRun } from '../../entities/QaRun';
import { QaRunBatch } from '../../entities/QaRunBatch';
import { QaSchedule } from '../../entities/QaSchedule';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { ChatRoomMessage } from '../../entities/ChatRoomMessage';
import { TicketAttachment } from '../../entities/TicketAttachment';
import { RuntimeHost } from '../../entities/RuntimeHost';
import { Ticket } from '../../entities/Ticket';
import { Comment } from '../../entities/Comment';
import { Resource } from '../../entities/Resource';
import { QaScenarioController } from './qa-scenario.controller';
import { QaService } from './qa.service';
import { QaRunService } from './qa-run.service';
import { QaRunReaperService } from './qa-run-reaper.service';
import { QaRunBatchReaperService } from './qa-run-batch-reaper.service';
import { QaFailureTicketService } from './qa-failure-ticket.service';
import { QaRerunOnFixService } from './qa-rerun-on-fix.service';
import { QaScheduleService } from './qa-schedule.service';
import { ChatRoomsModule } from '../chat-rooms/chat-rooms.module';
// TicketService (failure tickets, on-pass auto-close) lives in AgentsModule.
// No cycle: AgentsModule does not import this module.
import { AgentsModule } from '../agents/agents.module';
import { SharedServicesModule } from '../../services/shared-services.module';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';

/**
 * Scenario-based QA feature module (QaScenario/QaRun). Separate from the
 * self-test harness QaModule (api/admin/qa). Exports QaService + QaRunService
 * so the MCP module can dispatch runs and the agent can record results.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([QaScenario, QaRun, QaRunBatch, QaSchedule, ChatRoom, ChatRoomParticipant, ChatRoomMessage, TicketAttachment, RuntimeHost, Ticket, Comment, Resource]),
    ChatRoomsModule,
    AgentsModule,
    SharedServicesModule,
  ],
  controllers: [QaScenarioController],
  providers: [QaService, QaRunService, QaRunReaperService, QaRunBatchReaperService, QaFailureTicketService, QaRerunOnFixService, QaScheduleService, AuthGuard, PermissionGuard],
  exports: [QaService, QaRunService, QaRunReaperService, QaRunBatchReaperService, QaFailureTicketService, QaScheduleService],
})
export class QaScenarioModule {}
