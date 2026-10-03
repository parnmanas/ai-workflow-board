import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventsController } from './events.controller';
import { Ticket } from '../../entities/Ticket';
import { BoardColumn } from '../../entities/BoardColumn';
import { Board } from '../../entities/Board';
import { Workspace } from '../../entities/Workspace';
import { RuntimeHost } from '../../entities/RuntimeHost';
import { ApiKey } from '../../entities/ApiKey';
import { AgentManagerModule } from '../agent-manager/agent-manager.module';

@Module({
  // AgentManagerModule re-exports InstanceRegistryService so EventsController
  // can synthesize manager-source rows for the SESSIONS panel without
  // duplicating the registry singleton.
  // Board + Workspace (ticket 112ea3c5): resolveTicketRepositoryResourceId의
  // board-env 폴백이 dispatch 경로의 백필을 그대로 따라가려면 둘 다 필요하다.
  imports: [TypeOrmModule.forFeature([Ticket, BoardColumn, Board, Workspace, RuntimeHost, ApiKey]), AgentManagerModule],
  controllers: [EventsController],
})
export class EventsModule {}
