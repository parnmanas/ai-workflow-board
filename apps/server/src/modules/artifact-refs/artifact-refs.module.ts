import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Action, Agent, Board, BoardColumn, Ticket, WorkflowFunction, Workspace, WorkspaceSchedule } from '../../entities';
import { AuthGuard } from '../../common/guards/auth.guard';
import { ArtifactRefsController } from './artifact-refs.controller';
import { ArtifactRefsService } from './artifact-refs.service';

@Module({
  imports: [TypeOrmModule.forFeature([
    Ticket, Agent, Board, BoardColumn, Action, WorkflowFunction, Workspace, WorkspaceSchedule,
  ])],
  controllers: [ArtifactRefsController],
  providers: [ArtifactRefsService, AuthGuard],
  exports: [ArtifactRefsService],
})
export class ArtifactRefsModule {}
