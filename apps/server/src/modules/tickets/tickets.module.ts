import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Ticket } from '../../entities/Ticket';
import { Comment } from '../../entities/Comment';
import { UserMention } from '../../entities/UserMention';
import { TicketReadState } from '../../entities/TicketReadState';
import { TicketAttachment } from '../../entities/TicketAttachment';
import { TicketsController } from './tickets.controller';
import { TicketArchiverService } from './ticket-archiver.service';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AgentsModule } from '../agents/agents.module';
import { ArtifactRefsModule } from '../artifact-refs/artifact-refs.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Ticket, Comment, UserMention, TicketReadState, TicketAttachment]),
    // TicketService / TicketDispatchService / TicketDuplicateService live in
    // AgentsModule (the dispatcher and the mutation layer share one DI graph).
    AgentsModule,
    ArtifactRefsModule,
  ],
  controllers: [TicketsController],
  providers: [AuthGuard, TicketArchiverService],
})
export class TicketsModule {}
