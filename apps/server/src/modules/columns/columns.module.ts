import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Board } from '../../entities/Board';
import { BoardColumn } from '../../entities/BoardColumn';
import { ColumnsController } from './columns.controller';
import { AuthGuard } from '../../common/guards/auth.guard';

@Module({
  // Board is needed by ColumnsController.create() so it can read the parent
  // board's routing_config and seed BoardColumn.role_routing on column-create
  // (v0.41 — runtime dispatch reads role_routing only).
  imports: [TypeOrmModule.forFeature([BoardColumn, Board])],
  controllers: [ColumnsController],
  providers: [AuthGuard],
})
export class ColumnsModule {}
