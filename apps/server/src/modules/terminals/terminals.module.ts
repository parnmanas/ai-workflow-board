import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Agent } from '../../entities/Agent';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { AgentAuthGuard } from '../../common/guards/agent-auth.guard';
import { TerminalsController } from './terminals.controller';
import { TerminalsAgentController } from './terminals-agent.controller';
import { TerminalsService } from './terminals.service';

/**
 * Terminal(Runtime Host 셸) — 상태 없는 중계 모듈. 엔티티가 없다: 터미널은 매니저의
 * PTY 프로세스이고 살아 있는 동안만 존재한다. InstanceRegistryService 는 @Global 모듈이
 * 제공한다. docs/terminals.md 참조.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Agent])],
  controllers: [TerminalsController, TerminalsAgentController],
  providers: [TerminalsService, AuthGuard, PermissionGuard, AgentAuthGuard],
  exports: [TerminalsService],
})
export class TerminalsModule {}
