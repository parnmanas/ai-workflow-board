import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Board } from '../../entities/Board';
import { BoardColumn } from '../../entities/BoardColumn';
import { Ticket } from '../../entities/Ticket';
import { Comment } from '../../entities/Comment';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { ChatRoomMessage } from '../../entities/ChatRoomMessage';
import { User } from '../../entities/User';
import { Agent } from '../../entities/Agent';
import { AgentApiController } from './agent-api.controller';
import { AgentAuthGuard } from '../../common/guards/agent-auth.guard';
import { ChatRoomsService } from '../chat-rooms/chat-rooms.service';
import { RoomMembershipService } from '../chat-rooms/room-membership.service';
import { RoomMessagingService } from '../chat-rooms/room-messaging.service';

@Module({
  imports: [TypeOrmModule.forFeature([Board, BoardColumn, Ticket, Comment, ChatRoom, ChatRoomParticipant, ChatRoomMessage, User, Agent])],
  controllers: [AgentApiController],
  providers: [AgentAuthGuard, ChatRoomsService, RoomMembershipService, RoomMessagingService],
})
export class AgentApiModule {}
