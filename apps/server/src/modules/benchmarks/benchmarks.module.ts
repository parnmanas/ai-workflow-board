import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BenchmarkScore } from '../../entities/BenchmarkScore';
import { BenchmarksController } from './benchmarks.controller';
import { BenchmarkService } from './benchmark.service';
import { AuthGuard } from '../../common/guards/auth.guard';

/**
 * Benchmark feature module (ticket 684c012b). Exports BenchmarkService so the
 * MCP module can inject it into the ToolContext for submit_benchmark_score /
 * get_benchmark_leaderboard / create_benchmark_run.
 */
@Module({
  imports: [TypeOrmModule.forFeature([BenchmarkScore])],
  controllers: [BenchmarksController],
  providers: [BenchmarkService, AuthGuard],
  exports: [BenchmarkService],
})
export class BenchmarksModule {}
