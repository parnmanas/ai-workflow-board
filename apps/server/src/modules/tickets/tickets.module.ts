import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Ticket } from '../../entities/Ticket';
import { BoardColumn } from '../../entities/BoardColumn';
import { Comment } from '../../entities/Comment';
import { Agent } from '../../entities/Agent';
import { Board } from '../../entities/Board';
import { UserMention } from '../../entities/UserMention';
import { TicketReadState } from '../../entities/TicketReadState';
import { TicketAttachment } from '../../entities/TicketAttachment';
import { CommentSummaryRun } from '../../entities/CommentSummaryRun';
import { TicketsController } from './tickets.controller';
import { TicketArchiverService } from './ticket-archiver.service';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AgentsModule } from '../agents/agents.module';
import { WorkspaceRolesModule } from '../workspace-roles/workspace-roles.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Ticket, BoardColumn, Comment, CommentSummaryRun, Agent, Board, UserMention, TicketReadState, TicketAttachment]),
    // Exports TriggerLoopService so /api/tickets/:id/trigger can re-engage agents.
    AgentsModule,
    WorkspaceRolesModule,
  ],
  controllers: [TicketsController],
  providers: [AuthGuard, TicketArchiverService],
})
export class TicketsModule {}
