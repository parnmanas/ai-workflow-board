import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Action } from '../../entities/Action';
import { ActionRun } from '../../entities/ActionRun';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { ChatRoomMessage } from '../../entities/ChatRoomMessage';
import { Agent } from '../../entities/Agent';
import { Board } from '../../entities/Board';
import { Workspace } from '../../entities/Workspace';
import { User } from '../../entities/User';
import { ActionsController } from './actions.controller';
import { ActionsService } from './actions.service';
import { ActionSchedulerService } from './action-scheduler.service';
import { ChatRoomsModule } from '../chat-rooms/chat-rooms.module';
import { SharedServicesModule } from '../../services/shared-services.module';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([Action, ActionRun, ChatRoom, ChatRoomParticipant, ChatRoomMessage, Agent, Board, Workspace, User]),
    ChatRoomsModule,
    SharedServicesModule,
  ],
  controllers: [ActionsController],
  providers: [ActionsService, ActionSchedulerService, AuthGuard, PermissionGuard],
  exports: [ActionsService],
})
export class ActionsModule {}
