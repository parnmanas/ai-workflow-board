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
import { ChatRoomsModule } from '../chat-rooms/chat-rooms.module';
import { ActionsModule } from '../actions/actions.module';
import { SharedServicesModule } from '../../services/shared-services.module';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { OrchestrationController } from './orchestration.controller';
import { OrchestrationTeamService } from './orchestration-team.service';
import { OrchestrationMissionService } from './orchestration-mission.service';
import { OrchestrationConfirmNotifyService } from './orchestration-confirm-notify.service';
import { OrchestrationRunnerService } from './orchestration-runner.service';
import { OrchestrationReaperService } from './orchestration-reaper.service';

/**
 * Orchestration mode — a Team of Agents led by one orchestrator plans a Mission
 * at runtime and delegates its Steps to members.
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
    ]),
    ChatRoomsModule,
    ActionsModule,
    SharedServicesModule,
  ],
  controllers: [OrchestrationController],
  providers: [
    OrchestrationTeamService,
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
