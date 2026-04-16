import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Board } from '../../entities/Board';
import { BoardColumn } from '../../entities/BoardColumn';
import { Ticket } from '../../entities/Ticket';
import { BoardsController } from './boards.controller';
import { AuthGuard } from '../../common/guards/auth.guard';

@Module({
  imports: [TypeOrmModule.forFeature([Board, BoardColumn, Ticket])],
  controllers: [BoardsController],
  providers: [AuthGuard],
})
export class BoardsModule {}
