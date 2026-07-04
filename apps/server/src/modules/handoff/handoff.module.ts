import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Ticket } from '../../entities/Ticket';
import { Board } from '../../entities/Board';
import { BoardColumn } from '../../entities/BoardColumn';
import { Comment } from '../../entities/Comment';
import { TicketAttachment } from '../../entities/TicketAttachment';
import { Agent } from '../../entities/Agent';
import { HandoffService } from './handoff.service';
import { HandoffController } from './handoff.controller';
import { WorkspaceRolesModule } from '../workspace-roles/workspace-roles.module';
import { AgentsModule } from '../agents/agents.module';
import { SharedServicesModule } from '../../services/shared-services.module';
import { AuthGuard } from '../../common/guards/auth.guard';

/**
 * Cross-board handoff pipeline module (ticket ac21a745) — the relay engine that
 * turns a ticket's `handoff_spec` into a multi-board ticket relay.
 *
 * Composes existing mechanisms only (no new execution engine):
 *   - WorkspaceRolesModule (TicketRoleAssignmentService) for follow-up role wiring,
 *   - AgentsModule (TicketPrerequisitesService for reverse-rejection re-block +
 *     TriggerLoopService for dispatching the defect ticket),
 *   - SharedServicesModule (ActivityService/LogService).
 *
 * HandoffService self-subscribes to the shared `activityEvents` bus in
 * onModuleInit — the same terminal-entry edge-hook pattern as
 * OnTicketDoneActionService / QaRerunOnFixService. Exported so the MCP module
 * can drive reject_handoff / get_handoff_pipeline.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Ticket, Board, BoardColumn, Comment, TicketAttachment, Agent]),
    WorkspaceRolesModule,
    AgentsModule,
    SharedServicesModule,
  ],
  controllers: [HandoffController],
  providers: [HandoffService, AuthGuard],
  exports: [HandoffService],
})
export class HandoffModule {}
