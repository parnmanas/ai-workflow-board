import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiKey } from '../../entities/ApiKey';
import { McpController } from './mcp.controller';
import { AgentsModule } from '../agents/agents.module';
import { McpServicesModule } from './mcp-services.module';

@Module({
  imports: [TypeOrmModule.forFeature([ApiKey]), AgentsModule, McpServicesModule],
  controllers: [McpController],
})
export class McpModule {}
