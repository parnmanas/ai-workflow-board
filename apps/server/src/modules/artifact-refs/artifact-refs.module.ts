import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Action, Ticket, WorkflowFunction, Account, AutomationSchedule } from '../../entities';
import { AuthGuard } from '../../common/guards/auth.guard';
import { ArtifactRefsController } from './artifact-refs.controller';
import { ArtifactRefsService } from './artifact-refs.service';

@Module({
  imports: [TypeOrmModule.forFeature([
    Ticket, Action, WorkflowFunction, Account, AutomationSchedule,
  ])],
  controllers: [ArtifactRefsController],
  providers: [ArtifactRefsService, AuthGuard],
  exports: [ArtifactRefsService],
})
export class ArtifactRefsModule {}
