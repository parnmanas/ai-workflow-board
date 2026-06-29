import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkspaceSchedule } from '../../entities/WorkspaceSchedule';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { Agent } from '../../entities/Agent';
import { WorkspaceScheduleService } from './workspace-schedule.service';
import { ChatRoomsModule } from '../chat-rooms/chat-rooms.module';
import { SharedServicesModule } from '../../services/shared-services.module';

/**
 * General-purpose agent-task scheduler (ticket 8845be79). Owns WorkspaceSchedule
 * CRUD + the background tick that dispatches due tasks to a single target agent
 * via a fresh chat room (QA/Security RUN dispatch shape). ChatRoomsModule is
 * imported for RoomMessagingService; the MCP module imports this to expose the
 * schedule tools (follow-up ticket).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([WorkspaceSchedule, ChatRoom, ChatRoomParticipant, Agent]),
    ChatRoomsModule,
    SharedServicesModule,
  ],
  providers: [WorkspaceScheduleService],
  exports: [WorkspaceScheduleService],
})
export class WorkspaceScheduleModule {}
