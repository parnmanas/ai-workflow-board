import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Board } from '../../entities/Board';
import { BoardColumn } from '../../entities/BoardColumn';
import { Ticket } from '../../entities/Ticket';
import { Comment } from '../../entities/Comment';
import { AgentApiController } from './agent-api.controller';
import { AgentAuthGuard } from '../../common/guards/agent-auth.guard';

@Module({
  imports: [TypeOrmModule.forFeature([Board, BoardColumn, Ticket, Comment])],
  controllers: [AgentApiController],
  providers: [AgentAuthGuard],
})
export class AgentApiModule {}
