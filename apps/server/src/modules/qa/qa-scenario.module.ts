import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QaScenario } from '../../entities/QaScenario';
import { QaRun } from '../../entities/QaRun';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { ChatRoomMessage } from '../../entities/ChatRoomMessage';
import { TicketAttachment } from '../../entities/TicketAttachment';
import { Agent } from '../../entities/Agent';
import { Board } from '../../entities/Board';
import { QaScenarioController } from './qa-scenario.controller';
import { QaService } from './qa.service';
import { QaRunService } from './qa-run.service';
import { ChatRoomsModule } from '../chat-rooms/chat-rooms.module';
import { SharedServicesModule } from '../../services/shared-services.module';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';

/**
 * Scenario-based QA feature module (QaScenario/QaRun). Separate from the
 * self-test harness QaModule (api/admin/qa). Exports QaService + QaRunService
 * so the MCP module can dispatch runs and the agent can record results.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([QaScenario, QaRun, ChatRoom, ChatRoomParticipant, ChatRoomMessage, TicketAttachment, Agent, Board]),
    ChatRoomsModule,
    SharedServicesModule,
  ],
  controllers: [QaScenarioController],
  providers: [QaService, QaRunService, AuthGuard, PermissionGuard],
  exports: [QaService, QaRunService],
})
export class QaScenarioModule {}
