import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Board } from '../../entities/Board';
import { BoardColumn } from '../../entities/BoardColumn';
import { Ticket } from '../../entities/Ticket';
import { BoardsController } from './boards.controller';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PromptTemplatesModule } from '../prompt-templates/prompt-templates.module';
import { AgentsModule } from '../agents/agents.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Board, BoardColumn, Ticket]),
    PromptTemplatesModule,
    // AgentsModule provides AgentWorkloadService for the focus-tickets
    // endpoint (ticket b55e4421). forwardRef avoids potential cycles
    // if AgentsModule ever imports BoardsModule.
    forwardRef(() => AgentsModule),
  ],
  controllers: [BoardsController],
  providers: [AuthGuard],
})
export class BoardsModule {}
