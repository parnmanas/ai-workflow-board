import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Agent } from '../../entities/Agent';
import { AgentSessionCliSetting } from '../../entities/AgentSessionCliSetting';
import { ClaudeBackendProfile } from '../../entities/ClaudeBackendProfile';
import { Credential } from '../../entities/Credential';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { AgentAuthGuard } from '../../common/guards/agent-auth.guard';
import { AgentSessionsController } from './agent-sessions.controller';
import { AgentSessionsAgentController } from './agent-sessions-agent.controller';
import { AgentSessionsService } from './agent-sessions.service';
import { AgentManagerModule } from '../agent-manager/agent-manager.module';

/**
 * Agent Session(CLI 직접 세션) — 상태 없는 중계 모듈. 엔티티가 없다: 세션 목록과
 * 기록은 Runtime Host 장비의 CLI 홈에 있고(reverse RPC 로 읽음), 라이브 상태만 메모리.
 * InstanceRegistryService 는 @Global 모듈이 제공한다. docs/agent-sessions.md 참조.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Agent, AgentSessionCliSetting, Credential, ClaudeBackendProfile]),
    // 모델 목록의 단일 출처(HostModelsService)를 **공유**하기 위해서다 — providers 에
    // 넣으면 이 모듈만의 인스턴스가 생겨 세션이 관측한 모델이 다른 화면에 전달되지 않는다.
    forwardRef(() => AgentManagerModule),
  ],
  controllers: [AgentSessionsController, AgentSessionsAgentController],
  providers: [AgentSessionsService, AuthGuard, PermissionGuard, AgentAuthGuard],
  exports: [AgentSessionsService],
})
export class AgentSessionsModule {}
