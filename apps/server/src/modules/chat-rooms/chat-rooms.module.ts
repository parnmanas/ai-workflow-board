import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { ChatRoomMessage } from '../../entities/ChatRoomMessage';
import { User } from '../../entities/User';
import { Agent } from '../../entities/Agent';
import { Ticket } from '../../entities/Ticket';
import { UserMention } from '../../entities/UserMention';
import { ChatRoomsController } from './chat-rooms.controller';
import { RoomCrudService } from './room-crud.service';
import { RoomMembershipService } from './room-membership.service';
import { RoomMessagingService } from './room-messaging.service';
import { SharedServicesModule } from '../../services/shared-services.module';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([ChatRoom, ChatRoomParticipant, ChatRoomMessage, User, Agent, Ticket, UserMention]),
    SharedServicesModule,
  ],
  controllers: [ChatRoomsController],
  providers: [
    RoomCrudService,
    RoomMembershipService,
    RoomMessagingService,
    AuthGuard,
    PermissionGuard,
  ],
  exports: [RoomCrudService, RoomMembershipService, RoomMessagingService],
})
export class ChatRoomsModule {}
