import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BoardColumn } from '../../entities/BoardColumn';
import { ColumnsController } from './columns.controller';
import { AuthGuard } from '../../common/guards/auth.guard';

@Module({
  imports: [TypeOrmModule.forFeature([BoardColumn])],
  controllers: [ColumnsController],
  providers: [AuthGuard],
})
export class ColumnsModule {}
