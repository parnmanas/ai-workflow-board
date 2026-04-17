import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Workspace } from '../../entities/Workspace';
import { Board } from '../../entities/Board';
import { BoardColumn } from '../../entities/BoardColumn';
import { Ticket } from '../../entities/Ticket';
import { User } from '../../entities/User';
import { Agent } from '../../entities/Agent';
import { WorkspacesController } from './workspaces.controller';
import { AuthGuard } from '../../common/guards/auth.guard';

@Module({
  imports: [TypeOrmModule.forFeature([Workspace, Board, BoardColumn, Ticket, User, Agent])],
  controllers: [WorkspacesController],
  providers: [AuthGuard],
})
export class WorkspacesModule {}
