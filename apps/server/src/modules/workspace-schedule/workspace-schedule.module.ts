import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkspaceSchedule } from '../../entities/WorkspaceSchedule';
import { Action } from '../../entities/Action';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { Agent } from '../../entities/Agent';
import { Board } from '../../entities/Board';
import { WorkspaceScheduleService } from './workspace-schedule.service';
import { WorkspaceScheduleController } from './workspace-schedule.controller';
import { ChatRoomsModule } from '../chat-rooms/chat-rooms.module';
import { ActionsModule } from '../actions/actions.module';
import { SharedServicesModule } from '../../services/shared-services.module';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';

/**
 * General-purpose agent-task scheduler (ticket 8845be79). Owns WorkspaceSchedule
 * CRUD + the background tick that dispatches due tasks to a single target agent
 * via a fresh chat room (QA/Security RUN dispatch shape). ChatRoomsModule is
 * imported for RoomMessagingService; the MCP module imports this to expose the
 * schedule tools. The REST controller (ticket 1927ed4a) backs the Workspace
 * Settings editor UI — same CRUD surface, admin-gated.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([WorkspaceSchedule, ChatRoom, ChatRoomParticipant, Agent, Board, Action]),
    ChatRoomsModule,
    // Action 형태 스케줄이 ActionsService.dispatch 로 발화한다. 단방향 —
    // ActionsModule 은 이 모듈을 import 하지 않는다.
    ActionsModule,
    SharedServicesModule,
  ],
  controllers: [WorkspaceScheduleController],
  providers: [WorkspaceScheduleService, AuthGuard, PermissionGuard],
  exports: [WorkspaceScheduleService],
})
export class WorkspaceScheduleModule {}
