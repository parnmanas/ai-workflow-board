import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Action } from '../../entities/Action';
import { ActionRun } from '../../entities/ActionRun';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { ChatRoomMessage } from '../../entities/ChatRoomMessage';
import { TicketAttachment } from '../../entities/TicketAttachment';
import { Agent } from '../../entities/Agent';
import { Board } from '../../entities/Board';
import { Workspace } from '../../entities/Workspace';
import { User } from '../../entities/User';
import { Ticket } from '../../entities/Ticket';
import { BoardColumn } from '../../entities/BoardColumn';
import { Comment } from '../../entities/Comment';
import { ActivityLog } from '../../entities/ActivityLog';
import { ActionsController } from './actions.controller';
import { ActionsService } from './actions.service';
import { ActionSchedulerService } from './action-scheduler.service';
import { OnTicketDoneActionService } from './on-ticket-done-action.service';
import { ChatRoomsModule } from '../chat-rooms/chat-rooms.module';
import { SharedServicesModule } from '../../services/shared-services.module';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([Action, ActionRun, ChatRoom, ChatRoomParticipant, ChatRoomMessage, TicketAttachment, Agent, Board, Workspace, User, Ticket, BoardColumn, Comment, ActivityLog]),
    ChatRoomsModule,
    SharedServicesModule,
  ],
  controllers: [ActionsController],
  providers: [ActionsService, ActionSchedulerService, OnTicketDoneActionService, AuthGuard, PermissionGuard],
  exports: [ActionsService],
})
export class ActionsModule {}
