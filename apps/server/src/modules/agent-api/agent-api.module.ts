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
import { UserMention } from '../../entities/UserMention';
import { AgentApiController } from './agent-api.controller';
import { AgentAuthGuard } from '../../common/guards/agent-auth.guard';
import { ChatRoomsModule } from '../chat-rooms/chat-rooms.module';

@Module({
  // Chat-room services are imported via ChatRoomsModule so AgentApiController
  // and ChatRoomsController share the same singleton instances (previously
  // each module re-provided the services, which risked state divergence for
  // any per-instance caches).
  imports: [
    TypeOrmModule.forFeature([Board, BoardColumn, Ticket, Comment, ChatRoom, ChatRoomParticipant, ChatRoomMessage, User, Agent, UserMention]),
    ChatRoomsModule,
  ],
  controllers: [AgentApiController],
  providers: [AgentAuthGuard],
})
export class AgentApiModule {}
