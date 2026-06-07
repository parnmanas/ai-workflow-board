import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BenchmarkScore } from '../../entities/BenchmarkScore';
import { BenchmarksController } from './benchmarks.controller';
import { BenchmarkService } from './benchmark.service';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AgentsModule } from '../agents/agents.module';
import { WorkspaceRolesModule } from '../workspace-roles/workspace-roles.module';

/**
 * Benchmark feature module (ticket 684c012b). Exports BenchmarkService so the
 * MCP module can inject it into the ToolContext for submit_benchmark_score /
 * get_benchmark_leaderboard / create_benchmark_run.
 *
 * Run lifecycle (ticket 5eb459c4) needs TriggerLoopService (candidate dispatch)
 * and TicketRoleAssignmentService (assignee role sync) — pulled in via
 * AgentsModule + WorkspaceRolesModule. These are @Optional() on BenchmarkService
 * so the standalone (non-DI) MCP path still constructs it with the DataSource
 * alone. No cycle: AgentsModule does not import BenchmarksModule (TriggerLoop's
 * benchmark dispatch is inlined, not delegated to BenchmarkService).
 */
@Module({
  imports: [TypeOrmModule.forFeature([BenchmarkScore]), AgentsModule, WorkspaceRolesModule],
  controllers: [BenchmarksController],
  providers: [BenchmarkService, AuthGuard],
  exports: [BenchmarkService],
})
export class BenchmarksModule {}
