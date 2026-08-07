import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutreachChannel } from '../../entities/OutreachChannel';
import { OutreachInboundItem } from '../../entities/OutreachInboundItem';
import { Credential } from '../../entities/Credential';
import { Board } from '../../entities/Board';
import { BoardColumn } from '../../entities/BoardColumn';
import { Ticket } from '../../entities/Ticket';
import { Agent } from '../../entities/Agent';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { WorkspaceRolesModule } from '../workspace-roles/workspace-roles.module';
import { ChatRoomsModule } from '../chat-rooms/chat-rooms.module';
import { OutreachIngestService } from './outreach-ingest.service';
import { OutreachPollingService } from './outreach-polling.service';
import { OutreachChannelService } from './outreach-channel.service';
import { OutreachController } from './outreach.controller';
import { OUTREACH_CLASSIFIER } from './classifier/types';
import { AgentDispatchClassifier } from './classifier/agent-dispatch.classifier';
import { ClassificationBridgeService } from './classifier/classification-bridge.service';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([OutreachChannel, OutreachInboundItem, Credential, Board, BoardColumn, Ticket, Agent, ChatRoom, ChatRoomParticipant]),
    // TicketRoleAssignmentService (board default_role_assignments backfill on
    // auto-created tickets) is NOT @Global — must import explicitly.
    WorkspaceRolesModule,
    // AgentDispatchClassifier's chat-room dispatch needs RoomMessagingService.
    ChatRoomsModule,
  ],
  controllers: [OutreachController],
  providers: [
    OutreachIngestService,
    OutreachPollingService,
    OutreachChannelService,
    ClassificationBridgeService,
    AgentDispatchClassifier,
    // AgentDispatchClassifier falls back to RuleBasedClassifier internally
    // (no configured agent, dispatch failure, or timeout) — binding it here
    // is a strict superset of the old RuleBasedClassifier-only behavior.
    { provide: OUTREACH_CLASSIFIER, useClass: AgentDispatchClassifier },
    AuthGuard,
    PermissionGuard,
  ],
  // ClassificationBridgeService must be the SAME singleton instance the MCP
  // module's record_outreach_classification tool resolves against — see
  // that service's docstring for why (in-process bridge, one Map per process).
  exports: [ClassificationBridgeService],
})
export class OutreachModule {}
