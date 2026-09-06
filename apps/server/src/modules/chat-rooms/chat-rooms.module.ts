import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { ChatRoomMessage } from '../../entities/ChatRoomMessage';
import { User } from '../../entities/User';
import { Agent } from '../../entities/Agent';
import { Ticket } from '../../entities/Ticket';
import { UserMention } from '../../entities/UserMention';
import { TicketAttachment } from '../../entities/TicketAttachment';
import { Workspace } from '../../entities/Workspace';
// 발화 게이트가 미션의 `user_chat_mode` 를 직접 읽는다(티켓 9cfd8161). 엔티티 저장소만
// 가져오므로 OrchestrationModule(이미 ChatRoomsModule 을 import 한다)과 순환하지 않는다.
import { OrchestrationMission } from '../../entities/OrchestrationMission';
import { ChatRoomsController } from './chat-rooms.controller';
import { RoomCrudService } from './room-crud.service';
import { RoomMembershipService } from './room-membership.service';
import { RoomMessagingService } from './room-messaging.service';
import { SharedServicesModule } from '../../services/shared-services.module';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { ArtifactRefsModule } from '../artifact-refs/artifact-refs.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ChatRoom, ChatRoomParticipant, ChatRoomMessage, User, Agent, Ticket, UserMention, TicketAttachment, Workspace, OrchestrationMission]),
    SharedServicesModule,
    ArtifactRefsModule,
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
