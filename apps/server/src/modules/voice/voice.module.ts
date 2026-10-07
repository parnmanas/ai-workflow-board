import { Module } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { AgentSessionsModule } from '../agent-sessions/agent-sessions.module';
import { VoiceController, VoiceLabController, VoiceOperatorsController, VoiceProposalsController } from './voice.controller';
import { VoiceAnnouncerService } from './voice-announcer.service';
import { OperatorReportService } from './operator-report.service';
import { OperatorDecisionService } from './operator-decision.service';
import { OperatorProposalService } from './operator-proposal.service';
import { VoicePresenceService } from './voice-presence.service';
import { VoiceService } from './voice.service';

/**
 * 음성 게이트웨이. 설정은 SystemSettings `voice.*`(voice-config.ts), 오디오는
 * 저장하지 않고 공급자와 화면 사이를 지나가기만 한다. 저장하는 것은 operator 의 작업 제안
 * (`AgentSessionPromptProposal` — 사용자 승인을 기다리므로 배포 재시작에도 남아야 한다)뿐이다. 음성 알림(VoiceAnnouncerService)·작업 보고 줄
 * (OperatorReportService)·화면 보기 상태(VoicePresenceService)도 메모리에만 두고, 소리는 요청될 때 한 번
 * 합성한다. docs/voice-operator.md 참조.
 */
@Module({
  // 작업 보고는 operator 세션에 서버가 대신 프롬프트를 보낸다(AgentSessionsService.promptOnBehalf).
  imports: [AgentSessionsModule],
  controllers: [VoiceController, VoiceLabController, VoiceOperatorsController, VoiceProposalsController],
  providers: [VoiceService, VoiceAnnouncerService, OperatorReportService, OperatorDecisionService, OperatorProposalService, VoicePresenceService, AuthGuard, AdminGuard, PermissionGuard],
  // OperatorDecisionService · OperatorProposalService — MCP 의 operator 도구(말로 받은 답 전하기 · 작업 제안)가 쓴다.
  exports: [VoiceService, VoiceAnnouncerService, OperatorDecisionService, OperatorProposalService],
})
export class VoiceModule {}
