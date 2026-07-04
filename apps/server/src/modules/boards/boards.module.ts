import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Board } from '../../entities/Board';
import { BoardColumn } from '../../entities/BoardColumn';
import { Ticket } from '../../entities/Ticket';
import { BoardLesson } from '../../entities/BoardLesson';
import { BoardsController } from './boards.controller';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';
import { PromptTemplatesModule } from '../prompt-templates/prompt-templates.module';
import { AgentsModule } from '../agents/agents.module';
import { WorkspaceRolesModule } from '../workspace-roles/workspace-roles.module';
import { WorkspaceMoveService } from '../../services/workspace-move.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Board, BoardColumn, Ticket, BoardLesson]),
    PromptTemplatesModule,
    // AgentsModule provides AgentWorkloadService for the focus-tickets
    // endpoint (ticket b55e4421). forwardRef avoids potential cycles
    // if AgentsModule ever imports BoardsModule.
    forwardRef(() => AgentsModule),
    // WorkspaceRolesModule provides TicketRoleAssignmentService for the
    // board-card multi-holder projection (T6 role_holders).
    WorkspaceRolesModule,
  ],
  controllers: [BoardsController],
  providers: [AuthGuard, AdminGuard, WorkspaceMoveService],
})
export class BoardsModule {}
