import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkflowFunction } from '../../entities/WorkflowFunction';
import { WorkflowFunctionRun } from '../../entities/WorkflowFunctionRun';
import { Ticket } from '../../entities/Ticket';
import { BoardColumn } from '../../entities/BoardColumn';
import { ActionsModule } from '../actions/actions.module';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import { WorkflowFunctionsController } from './workflow-functions.controller';
import { WorkflowFunctionsService } from './workflow-functions.service';

@Module({
  imports: [TypeOrmModule.forFeature([WorkflowFunction, WorkflowFunctionRun, Ticket, BoardColumn]), ActionsModule],
  controllers: [WorkflowFunctionsController],
  providers: [WorkflowFunctionsService, AuthGuard, PermissionGuard],
  exports: [WorkflowFunctionsService],
})
export class WorkflowFunctionsModule {}
