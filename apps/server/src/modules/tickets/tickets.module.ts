import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Ticket } from '../../entities/Ticket';
import { BoardColumn } from '../../entities/BoardColumn';
import { Comment } from '../../entities/Comment';
import { Agent } from '../../entities/Agent';
import { TicketsController } from './tickets.controller';
import { AuthGuard } from '../../common/guards/auth.guard';

@Module({
  imports: [TypeOrmModule.forFeature([Ticket, BoardColumn, Comment, Agent])],
  controllers: [TicketsController],
  providers: [AuthGuard],
})
export class TicketsModule {}
