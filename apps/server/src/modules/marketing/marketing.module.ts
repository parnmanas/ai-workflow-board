import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MarketingCampaign } from '../../entities/MarketingCampaign';
import { MarketingAuditEvent } from '../../entities/MarketingAuditEvent';
import { MarketingChannel } from '../../entities/MarketingChannel';
import { MarketingBudgetAllocation } from '../../entities/MarketingBudgetAllocation';
import { MarketingSpendRequest } from '../../entities/MarketingSpendRequest';
import { MarketingLedgerEntry } from '../../entities/MarketingLedgerEntry';
import { MarketingPost } from '../../entities/MarketingPost';
import { MarketingLink } from '../../entities/MarketingLink';
import { MarketingMetric } from '../../entities/MarketingMetric';
import { OutreachInboundItem } from '../../entities/OutreachInboundItem';
import { MarketingFeedback } from '../../entities/MarketingFeedback';
import { Ticket } from '../../entities/Ticket';
import { MarketingContact } from '../../entities/MarketingContact';
import { MarketingEmailSend } from '../../entities/MarketingEmailSend';
import { MarketingCycle } from '../../entities/MarketingCycle';
import { MarketingApprovalNotice } from '../../entities/MarketingApprovalNotice';
import { MarketingListHold } from '../../entities/MarketingListHold';
import { MarketingConsentNotice } from '../../entities/MarketingConsentNotice';
import { MarketingConsentNoticeSetting } from '../../entities/MarketingConsentNoticeSetting';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { OutreachChannel } from '../../entities/OutreachChannel';
import { Credential } from '../../entities/Credential';
import { Project } from '../../entities/Project';
import { RuntimeHost } from '../../entities/RuntimeHost';
import { SharedServicesModule } from '../../services/shared-services.module';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { MarketingAuditService } from './marketing-audit.service';
import { MarketingCampaignHooks } from './marketing-campaign-hooks';
import { MarketingCampaignService } from './marketing-campaign.service';
import { MarketingCampaignsController } from './marketing-campaigns.controller';
import { MarketingAgentService } from './marketing-agent.service';
import { MarketingChannelService } from './marketing-channel.service';
import { MarketingChannelsController } from './marketing-channels.controller';
import { OutreachModule } from '../outreach/outreach.module';
import { MarketingBudgetService } from './marketing-budget.service';
import { MarketingSpendService } from './marketing-spend.service';
import { MarketingBudgetController } from './marketing-budget.controller';
import { MarketingPostService } from './marketing-post.service';
import { MarketingPostsController } from './marketing-posts.controller';
import { MarketingAnalyticsService } from './marketing-analytics.service';
import { MarketingAnalyticsController } from './marketing-analytics.controller';
import { MarketingPublicController } from './marketing-public.controller';
import { MarketingFeedbackService } from './marketing-feedback.service';
import { MarketingFeedbackController } from './marketing-feedback.controller';
import { AgentsModule } from '../agents/agents.module';
import { MarketingContactService } from './marketing-contact.service';
import { MarketingEmailService } from './marketing-email.service';
import { MarketingContactsController } from './marketing-contacts.controller';
import { MarketingCycleService } from './marketing-cycle.service';
import { ChatRoomsModule } from '../chat-rooms/chat-rooms.module';
import { MarketingInboxService } from './marketing-inbox.service';
import { MarketingInboxController } from './marketing-inbox.controller';
import { MarketingApprovalNotifyService } from './marketing-approval-notify.service';
import { MarketingListHoldService } from './marketing-list-hold.service';
import { MarketingEmailEventsService } from './marketing-email-events.service';
import { MarketingEmailWebhooksController } from './marketing-email-webhooks.controller';
import { MarketingConsentNoticeService } from './marketing-consent-notice.service';
import { MarketingConsentNoticesController } from './marketing-consent-notices.controller';

/**
 * Marketing — 에이전트 기반 제품 마케팅 루프(docs/marketing.md). MCP 모듈이 이것을 import 해
 * marketing-tools 에 서비스를 넘긴다.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      MarketingCampaign, MarketingAuditEvent, MarketingChannel,
      MarketingBudgetAllocation, MarketingSpendRequest, MarketingLedgerEntry, MarketingPost,
      MarketingLink, MarketingMetric, OutreachInboundItem, MarketingFeedback, Ticket,
      MarketingContact, MarketingEmailSend, MarketingCycle, ChatRoom, ChatRoomParticipant,
      Project, RuntimeHost, OutreachChannel, Credential, MarketingApprovalNotice, MarketingListHold,
      MarketingConsentNotice, MarketingConsentNoticeSetting,
    ]),
    SharedServicesModule,
    // 채널 승인이 새 OutreachChannel 을 OutreachChannelService 로 만든다(그쪽 검증을 그대로 탄다).
    OutreachModule,
    // 피드백 → 제품 티켓은 TicketService 로만 만든다(docs/tickets.md).
    AgentsModule,
    // 사이클은 방을 열고 RoomMessagingService 로 첫 메시지를 보낸다(QA/Automation 과 같은 디스패치).
    ChatRoomsModule,
  ],
  controllers: [
    MarketingCampaignsController, MarketingChannelsController, MarketingBudgetController, MarketingPostsController,
    MarketingAnalyticsController, MarketingPublicController, MarketingFeedbackController, MarketingContactsController,
    MarketingInboxController, MarketingEmailWebhooksController, MarketingConsentNoticesController,
  ],
  providers: [
    MarketingAuditService,
    MarketingCampaignHooks,
    MarketingCampaignService,
    MarketingChannelService,
    MarketingBudgetService,
    MarketingSpendService,
    MarketingPostService,
    MarketingAnalyticsService,
    MarketingFeedbackService,
    MarketingContactService,
    MarketingEmailService,
    MarketingAgentService,
    MarketingCycleService,
    MarketingInboxService,
    MarketingApprovalNotifyService,
    MarketingListHoldService,
    MarketingEmailEventsService,
    MarketingConsentNoticeService,
    AuthGuard,
    PermissionGuard,
  ],
  exports: [
    MarketingAuditService, MarketingCampaignService, MarketingChannelService, MarketingBudgetService,
    MarketingSpendService, MarketingPostService, MarketingAnalyticsService, MarketingFeedbackService,
    MarketingContactService, MarketingEmailService, MarketingAgentService, MarketingCycleService,
    MarketingListHoldService, MarketingEmailEventsService, MarketingConsentNoticeService,
  ],
})
export class MarketingModule {}
