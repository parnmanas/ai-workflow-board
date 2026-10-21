import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Credential } from '../../entities/Credential';
import { Project } from '../../entities/Project';
import { ProjectHostFolder } from '../../entities/ProjectHostFolder';
import { RuntimeHost } from '../../entities/RuntimeHost';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { AgentAuthGuard } from '../../common/guards/agent-auth.guard';
import { CliMemoryController } from './cli-memory.controller';
import { CliMemoryAgentController } from './cli-memory-agent.controller';
import { CliMemoryService } from './cli-memory.service';

/**
 * CLI Memory(LLM CLI 메모리 파일) — 상태 없는 중계 모듈. 엔티티가 없다: 메모리는 Runtime Host
 * 장비의 파일이고 백업도 매니저가 그 장비에 둔다. InstanceRegistryService 는 @Global 모듈이
 * 제공한다. docs/cli-memory.md 참조.
 */
@Module({
  imports: [TypeOrmModule.forFeature([RuntimeHost, ProjectHostFolder, Project, Credential])],
  controllers: [CliMemoryController, CliMemoryAgentController],
  providers: [CliMemoryService, AuthGuard, PermissionGuard, AgentAuthGuard],
  exports: [CliMemoryService],
})
export class CliMemoryModule {}
