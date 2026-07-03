import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Deployment } from '../../entities/Deployment';
import { DeploymentService } from './deployment.service';
import { DeploymentController } from './deployment.controller';

/**
 * Deployment-awareness module (ticket 8ce72b18). Exports DeploymentService so the
 * MCP module can inject it into the ToolContext for `report_deployment`, and
 * main.ts can resolve it for the boot-time self-report.
 *
 * The service is stateless over the DataSource (mirrors BuildArtifactService), so
 * the standalone (non-DI) MCP path constructs it directly. LogService is @Global.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Deployment])],
  controllers: [DeploymentController],
  providers: [DeploymentService],
  exports: [DeploymentService],
})
export class DeploymentsModule {}
