import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Agent } from '../../entities/Agent';
import { AgentChannelIdentity } from '../../entities/AgentChannelIdentity';
import { AgentTrigger } from '../../entities/AgentTrigger';
import { Ticket } from '../../entities/Ticket';
import { AgentsController } from './agents.controller';
import { AgentConnectionService } from './agent-connection.service';
import { TriggerLoopService } from './trigger-loop.service';
import { AgentStatusService } from './agent-status.service';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';

@Module({
  imports: [TypeOrmModule.forFeature([Agent, AgentChannelIdentity, AgentTrigger, Ticket])],
  controllers: [AgentsController],
  providers: [AuthGuard, PermissionGuard, AgentConnectionService, TriggerLoopService, AgentStatusService],
  exports: [AgentConnectionService, TriggerLoopService, AgentStatusService],
})
export class AgentsModule {}
