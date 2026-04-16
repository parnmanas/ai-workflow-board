import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiKey } from '../../entities/ApiKey';
import { McpController } from './mcp.controller';
import { AgentsModule } from '../agents/agents.module';

@Module({
  imports: [TypeOrmModule.forFeature([ApiKey]), AgentsModule],
  controllers: [McpController],
})
export class McpModule {}
