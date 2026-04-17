import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentErrorLog } from '../../entities/AgentErrorLog';
import { Agent } from '../../entities/Agent';
import { AgentLogsUploadController } from './agent-logs-upload.controller';
import { AgentLogsAdminController } from './agent-logs-admin.controller';
import { AgentLogsService } from './agent-logs.service';
import { AgentAuthGuard } from '../../common/guards/agent-auth.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';

@Module({
  imports: [TypeOrmModule.forFeature([AgentErrorLog, Agent])],
  controllers: [AgentLogsUploadController, AgentLogsAdminController],
  providers: [AgentLogsService, AgentAuthGuard, AuthGuard, AdminGuard],
})
export class AgentLogsModule {}
