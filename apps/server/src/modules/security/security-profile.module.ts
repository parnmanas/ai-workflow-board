import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SecurityProfile } from '../../entities/SecurityProfile';
import { SecurityRun } from '../../entities/SecurityRun';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { ChatRoomMessage } from '../../entities/ChatRoomMessage';
import { TicketAttachment } from '../../entities/TicketAttachment';
import { Agent } from '../../entities/Agent';
import { Board } from '../../entities/Board';
import { SecurityProfileController } from './security-profile.controller';
import { SecurityProfileService } from './security-profile.service';
import { SecurityRunService } from './security-run.service';
import { SecurityRunReaperService } from './security-run-reaper.service';
import { ChatRoomsModule } from '../chat-rooms/chat-rooms.module';
import { SharedServicesModule } from '../../services/shared-services.module';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';

/**
 * Security-inspection feature module (SecurityProfile/SecurityRun). Sibling of
 * the scenario-QA module (QaScenarioModule); reuses the ChatRoom dispatch +
 * artifact pipeline. Exports SecurityProfileService + SecurityRunService so the
 * MCP module can dispatch runs and the agent can record findings.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([SecurityProfile, SecurityRun, ChatRoom, ChatRoomParticipant, ChatRoomMessage, TicketAttachment, Agent, Board]),
    ChatRoomsModule,
    SharedServicesModule,
  ],
  controllers: [SecurityProfileController],
  providers: [SecurityProfileService, SecurityRunService, SecurityRunReaperService, AuthGuard, PermissionGuard],
  exports: [SecurityProfileService, SecurityRunService, SecurityRunReaperService],
})
export class SecurityProfileModule {}
