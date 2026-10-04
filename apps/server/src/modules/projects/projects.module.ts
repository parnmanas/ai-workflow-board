import { Global, Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { AuthGuard } from '../../common/guards/auth.guard';

// Global: tickets, dispatch, QA/Security/Actions, orchestration, ontology and
// MCP tools all resolve repositories through ProjectsService.
@Global()
@Module({
  controllers: [ProjectsController],
  providers: [AuthGuard, ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
