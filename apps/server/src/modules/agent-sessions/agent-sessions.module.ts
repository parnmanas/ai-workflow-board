import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Agent } from '../../entities/Agent';
import { AgentSession } from '../../entities/AgentSession';
import { AgentSessionEvent } from '../../entities/AgentSessionEvent';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { AgentAuthGuard } from '../../common/guards/agent-auth.guard';
import { AgentSessionsController } from './agent-sessions.controller';
import { AgentSessionsAgentController } from './agent-sessions-agent.controller';
import { AgentSessionsService } from './agent-sessions.service';

/**
 * Agent Session(CLI 직접 세션) — ChatRoomsModule 과 의도적으로 독립된 모듈.
 * 사용자 컨트롤러(/api/agent-sessions)와 agent-manager 컨트롤러(/api/agent/sessions)
 * 가 같은 서비스 싱글턴을 공유한다. docs/agent-sessions.md 참조.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AgentSession, AgentSessionEvent, Agent])],
  controllers: [AgentSessionsController, AgentSessionsAgentController],
  providers: [AgentSessionsService, AuthGuard, PermissionGuard, AgentAuthGuard],
  exports: [AgentSessionsService],
})
export class AgentSessionsModule {}
