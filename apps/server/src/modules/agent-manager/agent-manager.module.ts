import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Agent } from '../../entities/Agent';
import { AgentSessionCliSetting } from '../../entities/AgentSessionCliSetting';
import { ApiKey } from '../../entities/ApiKey';
import { Credential } from '../../entities/Credential';
import { Ticket } from '../../entities/Ticket';
import { Resource } from '../../entities/Resource';
import { Workspace } from '../../entities/Workspace';
import { AgentsModule } from '../agents/agents.module';
import { AgentAuthGuard } from '../../common/guards/agent-auth.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { AgentManagerController } from './agent-manager.controller';
import { InstanceRegistryModule } from './instance-registry.module';
import { PairingService } from './pairing.service';
import { CommandLedgerService } from './command-ledger.service';
import { SudoTicketService } from './sudo-ticket.service';
import { PrivilegedCommandService } from './privileged-command.service';
import { AgentManagerCommandService } from './agent-manager-command.service';
import { ManagerDriftMonitorService } from './manager-drift-monitor.service';
import { HostModelsService } from './host-models.service';
import { HostModelsController } from './host-models.controller';
import { SkillsModule } from '../skills/skills.module';

@Module({
  // AgentsModule re-exports SubagentMonitorService so the same singleton that
  // backs SubagentMonitorController (used by /api/subagent-monitor/*) also
  // serves the per-instance subagents view here. Sharing the singleton avoids
  // a split brain between the two routes.
  //
  // ApiKey row repository is needed locally because pair/redeem creates a
  // bearer for the freshly-paired manager. Agent repo is needed for both
  // pair/redeem (manager identity) and createManagedAgent (CLI-typed agent).
  //
  // forwardRef around AgentsModule: AgentsModule also imports this module (for
  // AgentManagerCommandService/PairingService). NestJS resolves the cycle via
  // forwardRef on both sides.
  //
  // InstanceRegistryModule (ticket c3b767c6): InstanceRegistryService moved
  // there and is now @Global() — importing it here keeps this module's own
  // controller/ManagerDriftMonitorService resolving it exactly as before,
  // while ChatRoomsModule/AgentsModule reach it too without either needing an
  // import edge onto this module. See that module's doc comment.
  imports: [
    forwardRef(() => AgentsModule),
    InstanceRegistryModule,
    SkillsModule,
    // AgentSessionCliSetting: HostModelsService 가 ACP 가 보고한 모델 목록(영속)을 읽는다 —
    // 모델 목록의 단일 출처가 재시작 후에도 같은 답을 하게 하는 데 필요하다.
    TypeOrmModule.forFeature([Agent, AgentSessionCliSetting, ApiKey, Credential, Ticket, Resource, Workspace]),
  ],
  controllers: [AgentManagerController, HostModelsController],
  providers: [
    PairingService,
    CommandLedgerService,
    SudoTicketService,
    PrivilegedCommandService,
    AgentManagerCommandService,
    // Runtime Host 별 모델 목록의 단일 출처(읽기 + 재열거). 모든 모델 화면이 쓴다.
    HostModelsService,
    // version-drift / stale self-update health monitor (ticket 7485df07). Runs
    // its own sweep timer; consumes InstanceRegistryService (now global via
    // InstanceRegistryModule above). No HTTP surface, so it isn't in
    // `controllers`/`exports`.
    ManagerDriftMonitorService,
    AgentAuthGuard,
    AuthGuard,
    PermissionGuard,
    WorkspaceGuard,
  ],
  exports: [
    PairingService,
    AgentManagerCommandService,
    // MCP 툴(`request_privileged_command`)이 승인 대기를 만들고 조회한다.
    // InstanceRegistryService 는 @Global() 이라 여기서 다시 내보낼 필요가 없다.
    PrivilegedCommandService,
    // 오케스트레이션 로스터가 커맨드 ack 를 **서버측에서** 기다리는 데 쓴다. 그쪽
    // 모델 재열거는 MANAGE_ACTIONS 이라 admin 전용 outcome 엔드포인트를 폴링할 수
    // 없다 — 원장을 직접 읽는 편이 권한 이야기를 하나로 유지한다.
    CommandLedgerService,
    HostModelsService,
  ],
})
export class AgentManagerModule {}
