import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Agent } from '../../entities/Agent';
import { AgentChannelIdentity } from '../../entities/AgentChannelIdentity';
import { Ticket } from '../../entities/Ticket';
import { AgentsController } from './agents.controller';
import { AgentConnectionService } from './agent-connection.service';
import { TriggerLoopService } from './trigger-loop.service';
import { AgentStatusService } from './agent-status.service';
import { AllocationService } from './allocation.service';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';

@Module({
  imports: [TypeOrmModule.forFeature([Agent, AgentChannelIdentity, Ticket])],
  controllers: [AgentsController],
  providers: [AuthGuard, PermissionGuard, AgentConnectionService, TriggerLoopService, AgentStatusService, AllocationService],
  exports: [AgentConnectionService, TriggerLoopService, AgentStatusService, AllocationService],
})
export class AgentsModule {}
