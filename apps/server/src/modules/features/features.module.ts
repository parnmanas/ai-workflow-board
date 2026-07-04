import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Feature } from '../../entities/Feature';
import { Ticket } from '../../entities/Ticket';
import { Board } from '../../entities/Board';
import { BoardColumn } from '../../entities/BoardColumn';
import { Agent } from '../../entities/Agent';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { FeaturesController } from './features.controller';
import { FeaturesService } from './features.service';
import { ChatRoomsModule } from '../chat-rooms/chat-rooms.module';
import { WorkspaceRolesModule } from '../workspace-roles/workspace-roles.module';
import { AgentsModule } from '../agents/agents.module';
import { SharedServicesModule } from '../../services/shared-services.module';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';

/**
 * Feature/Epic intake module (ticket aae7644c) — the entry point of the
 * one-stop automated development loop. Composes existing mechanisms only:
 *   - ChatRoomsModule (RoomMessagingService) for the planning dispatch spawn,
 *   - WorkspaceRolesModule (TicketRoleAssignmentService) for role wiring,
 *   - AgentsModule (TicketPrerequisitesService + TriggerLoopService) for the
 *     atomic chain build + first-ticket dispatch.
 * Exports FeaturesService so the MCP module can drive intake/propose/approve.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Feature, Ticket, Board, BoardColumn, Agent, ChatRoom, ChatRoomParticipant]),
    ChatRoomsModule,
    WorkspaceRolesModule,
    AgentsModule,
    SharedServicesModule,
  ],
  controllers: [FeaturesController],
  providers: [FeaturesService, AuthGuard, PermissionGuard],
  exports: [FeaturesService],
})
export class FeaturesModule {}
