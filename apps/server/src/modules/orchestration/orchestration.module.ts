import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrchestrationTeam } from '../../entities/OrchestrationTeam';
import { OrchestrationTeamMember } from '../../entities/OrchestrationTeamMember';
import { OrchestrationMission } from '../../entities/OrchestrationMission';
import { OrchestrationStep } from '../../entities/OrchestrationStep';
import { OrchestrationEvent } from '../../entities/OrchestrationEvent';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { ChatRoomMessage } from '../../entities/ChatRoomMessage';
import { Agent } from '../../entities/Agent';
import { Action } from '../../entities/Action';
import { ActionRun } from '../../entities/ActionRun';
import { Workspace } from '../../entities/Workspace';
import { Credential } from '../../entities/Credential';
import { ChatRoomsModule } from '../chat-rooms/chat-rooms.module';
import { AgentManagerModule } from '../agent-manager/agent-manager.module';
import { ActionsModule } from '../actions/actions.module';
import { SharedServicesModule } from '../../services/shared-services.module';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { OrchestrationController } from './orchestration.controller';
import { OrchestrationTeamService } from './orchestration-team.service';
import { OrchestrationAgentProvisionerService } from './orchestration-agent-provisioner.service';
import { OrchestrationMissionService } from './orchestration-mission.service';
import { OrchestrationConfirmNotifyService } from './orchestration-confirm-notify.service';
import { OrchestrationRunnerService } from './orchestration-runner.service';
import { OrchestrationReaperService } from './orchestration-reaper.service';

/**
 * Orchestration mode — a Team led by one orchestrator plans a Mission at runtime
 * and delegates its Steps to members.
 *
 * A roster slot is declared as Runtime Host + CLI + model + working folder;
 * OrchestrationAgentProvisionerService materializes the Agent identity each slot
 * needs, so no Agent has to exist before a team can be built.
 *
 * Exports the three services the MCP module needs: the runner (plan intake,
 * step reports, mission completion), the mission service (the orchestrator's
 * state read), and the team service (roster resolution for validation).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      OrchestrationTeam,
      OrchestrationTeamMember,
      OrchestrationMission,
      OrchestrationStep,
      OrchestrationEvent,
      ChatRoom,
      ChatRoomParticipant,
      ChatRoomMessage,
      Agent,
      Action,
      ActionRun,
      Workspace,
      // Credential: the roster provisioner validates a slot's optional per-agent
      // CLI credential before stamping it onto the identity it creates.
      Credential,
    ]),
    ChatRoomsModule,
    // AgentManagerModule exports AgentManagerCommandService — the roster
    // provisioner issues `spawn_agent` / `set_working_dir` on it so a live
    // Runtime Host picks up a new or edited team slot without a restart.
    // No cycle: nothing AgentManagerModule pulls in imports this module
    // (its own AgentsModule edge is already a forwardRef pair with itself).
    // InstanceRegistryService (the heartbeat snapshot the Runtime Host
    // catalogue reads) is @Global() and needs no import edge.
    AgentManagerModule,
    ActionsModule,
    SharedServicesModule,
  ],
  controllers: [OrchestrationController],
  providers: [
    OrchestrationTeamService,
    // Owns the Agent identity behind each roster slot — the team editor writes
    // a runtime spec, this turns it into something dispatch can address.
    OrchestrationAgentProvisionerService,
    OrchestrationMissionService,
    // confirm 게이트 대기 알림(티켓 a78cb566). 의존하는 UserChannelDispatcherService 와
    // ReBACService 는 이미 import 중인 SharedServicesModule 이 export 한다 —
    // 새 모듈 배선이 필요 없다.
    OrchestrationConfirmNotifyService,
    OrchestrationRunnerService,
    OrchestrationReaperService,
    AuthGuard,
    PermissionGuard,
  ],
  exports: [OrchestrationTeamService, OrchestrationMissionService, OrchestrationRunnerService],
})
export class OrchestrationModule {}
