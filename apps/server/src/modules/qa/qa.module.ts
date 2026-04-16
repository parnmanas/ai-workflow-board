import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Workspace } from '../../entities/Workspace';
import { Board } from '../../entities/Board';
import { BoardColumn } from '../../entities/BoardColumn';
import { Ticket } from '../../entities/Ticket';
import { Comment } from '../../entities/Comment';
import { User } from '../../entities/User';
import { Agent } from '../../entities/Agent';
import { AgentChannelIdentity } from '../../entities/AgentChannelIdentity';
import { Channel } from '../../entities/Channel';
import { ApiKey } from '../../entities/ApiKey';
import { ActivityLog } from '../../entities/ActivityLog';
import { QaController } from './qa.controller';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';

@Module({
  imports: [TypeOrmModule.forFeature([Workspace, Board, BoardColumn, Ticket, Comment, User, Agent, AgentChannelIdentity, Channel, ApiKey, ActivityLog])],
  controllers: [QaController],
  providers: [AuthGuard, AdminGuard],
})
export class QaModule {}
