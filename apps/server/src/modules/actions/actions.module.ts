import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Action } from '../../entities/Action';
import { ActionRun } from '../../entities/ActionRun';
import { ActionApproval } from '../../entities/ActionApproval';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { ChatRoomMessage } from '../../entities/ChatRoomMessage';
import { TicketAttachment } from '../../entities/TicketAttachment';
import { RuntimeHost } from '../../entities/RuntimeHost';
import { Workspace } from '../../entities/Workspace';
import { User } from '../../entities/User';
import { Ticket } from '../../entities/Ticket';
import { Comment } from '../../entities/Comment';
import { ActivityLog } from '../../entities/ActivityLog';
import { ActionsController } from './actions.controller';
import { ActionsService } from './actions.service';
import { ActionRunReaperService } from './action-run-reaper.service';
import { OnTicketDoneActionService } from './on-ticket-done-action.service';
import { ChatRoomsModule } from '../chat-rooms/chat-rooms.module';
import { SharedServicesModule } from '../../services/shared-services.module';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
// ActionRunReaperService needs TicketDispatchService.resumeTicket to resume a
// stuck run's source ticket — same precedent TicketsModule uses to reach the
// dispatcher from outside AgentsModule. No cycle: AgentsModule does not import
// ActionsModule.
import { AgentsModule } from '../agents/agents.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Action, ActionRun, ActionApproval, ChatRoom, ChatRoomParticipant, ChatRoomMessage, TicketAttachment, RuntimeHost, Workspace, User, Ticket, Comment, ActivityLog]),
    ChatRoomsModule,
    SharedServicesModule,
    AgentsModule,
  ],
  controllers: [ActionsController],
  providers: [ActionsService, ActionRunReaperService, OnTicketDoneActionService, AuthGuard, PermissionGuard],
  exports: [ActionsService],
})
export class ActionsModule {}
