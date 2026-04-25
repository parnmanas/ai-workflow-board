import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiKey } from '../../entities/ApiKey';
import { McpController } from './mcp.controller';
import { AgentsModule } from '../agents/agents.module';
import { McpServicesModule } from './mcp-services.module';
import { ChatRoomsModule } from '../chat-rooms/chat-rooms.module';
import { WorkspaceRolesModule } from '../workspace-roles/workspace-roles.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ApiKey]),
    AgentsModule,
    McpServicesModule,
    ChatRoomsModule,
    WorkspaceRolesModule,
  ],
  controllers: [McpController],
})
export class McpModule {}
