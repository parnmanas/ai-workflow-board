import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Ticket } from '../../entities/Ticket';
import { BoardColumn } from '../../entities/BoardColumn';
import { Comment } from '../../entities/Comment';
import { Agent } from '../../entities/Agent';
import { UserMention } from '../../entities/UserMention';
import { TicketReadState } from '../../entities/TicketReadState';
import { TicketsController } from './tickets.controller';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AgentsModule } from '../agents/agents.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Ticket, BoardColumn, Comment, Agent, UserMention, TicketReadState]),
    // Exports TriggerLoopService so /api/tickets/:id/trigger can re-engage agents.
    AgentsModule,
  ],
  controllers: [TicketsController],
  providers: [AuthGuard],
})
export class TicketsModule {}
