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
import { WorkspaceRolesModule } from '../workspace-roles/workspace-roles.module';
import { PromptTemplatesModule } from '../prompt-templates/prompt-templates.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Workspace, Board, BoardColumn, Ticket, User, Agent]),
    WorkspaceRolesModule,
    PromptTemplatesModule,
  ],
  controllers: [WorkspacesController],
  providers: [AuthGuard],
})
export class WorkspacesModule {}
