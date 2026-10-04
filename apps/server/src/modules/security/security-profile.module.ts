import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SecurityProfile } from '../../entities/SecurityProfile';
import { SecurityRun } from '../../entities/SecurityRun';
import { SecurityRunBatch } from '../../entities/SecurityRunBatch';
import { SecuritySchedule } from '../../entities/SecuritySchedule';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { ChatRoomMessage } from '../../entities/ChatRoomMessage';
import { TicketAttachment } from '../../entities/TicketAttachment';
import { RuntimeHost } from '../../entities/RuntimeHost';
import { Ticket } from '../../entities/Ticket';
import { Comment } from '../../entities/Comment';
import { Resource } from '../../entities/Resource';
import { SecurityProfileController } from './security-profile.controller';
import { SecurityProfileService } from './security-profile.service';
import { SecurityRunService } from './security-run.service';
import { SecurityRunReaperService } from './security-run-reaper.service';
import { SecurityFailureTicketService } from './security-failure-ticket.service';
import { SecurityScheduleService } from './security-schedule.service';
import { ChatRoomsModule } from '../chat-rooms/chat-rooms.module';
// TicketService (failure tickets) lives in AgentsModule. No cycle: AgentsModule
// does not import this module.
import { AgentsModule } from '../agents/agents.module';
import { SharedServicesModule } from '../../services/shared-services.module';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';

/**
 * Security-inspection feature module (SecurityProfile/SecurityRun). Sibling of
 * the scenario-QA module (QaScenarioModule); reuses the ChatRoom dispatch +
 * artifact pipeline. Exports SecurityProfileService + SecurityRunService so the
 * MCP module can dispatch runs and the agent can record findings.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([SecurityProfile, SecurityRun, SecurityRunBatch, SecuritySchedule, ChatRoom, ChatRoomParticipant, ChatRoomMessage, TicketAttachment, RuntimeHost, Ticket, Comment, Resource]),
    ChatRoomsModule,
    AgentsModule,
    SharedServicesModule,
  ],
  controllers: [SecurityProfileController],
  providers: [SecurityProfileService, SecurityRunService, SecurityRunReaperService, SecurityFailureTicketService, SecurityScheduleService, AuthGuard, PermissionGuard],
  exports: [SecurityProfileService, SecurityRunService, SecurityRunReaperService, SecurityFailureTicketService, SecurityScheduleService],
})
export class SecurityProfileModule {}
