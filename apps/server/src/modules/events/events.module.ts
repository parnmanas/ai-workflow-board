import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventsController } from './events.controller';
import { Ticket } from '../../entities/Ticket';
import { Workspace } from '../../entities/Workspace';
import { RuntimeHost } from '../../entities/RuntimeHost';
import { ApiKey } from '../../entities/ApiKey';
import { AgentManagerModule } from '../agent-manager/agent-manager.module';

@Module({
  // AgentManagerModule re-exports InstanceRegistryService so EventsController
  // can synthesize manager-source rows for the SESSIONS panel without
  // duplicating the registry singleton.
  imports: [TypeOrmModule.forFeature([Ticket, Workspace, RuntimeHost, ApiKey]), AgentManagerModule],
  controllers: [EventsController],
})
export class EventsModule {}
