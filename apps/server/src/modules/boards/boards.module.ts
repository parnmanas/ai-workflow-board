import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Board } from '../../entities/Board';
import { BoardColumn } from '../../entities/BoardColumn';
import { Ticket } from '../../entities/Ticket';
import { BoardsController } from './boards.controller';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PromptTemplatesModule } from '../prompt-templates/prompt-templates.module';

@Module({
  imports: [TypeOrmModule.forFeature([Board, BoardColumn, Ticket]), PromptTemplatesModule],
  controllers: [BoardsController],
  providers: [AuthGuard],
})
export class BoardsModule {}
