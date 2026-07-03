import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BuildArtifact } from '../../entities/BuildArtifact';
import { BuildArtifactService } from './build-artifact.service';

/**
 * Build & Artifact Registry module (ticket 80d52250). Exports BuildArtifactService
 * so the MCP module can inject it into the ToolContext for register_build_artifact
 * / get_latest_artifact / report_build_failure.
 *
 * The service is stateless over the DataSource (uses @InjectDataSource, mirroring
 * BenchmarkService), so the standalone (non-DI) MCP path constructs it directly.
 * LogService is @Global, so no extra import is needed for it.
 */
@Module({
  imports: [TypeOrmModule.forFeature([BuildArtifact])],
  providers: [BuildArtifactService],
  exports: [BuildArtifactService],
})
export class BuildsModule {}
