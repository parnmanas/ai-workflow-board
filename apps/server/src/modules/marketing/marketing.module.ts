import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MarketingCampaign } from '../../entities/MarketingCampaign';
import { MarketingAuditEvent } from '../../entities/MarketingAuditEvent';
import { MarketingChannel } from '../../entities/MarketingChannel';
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

/**
 * Marketing — 에이전트 기반 제품 마케팅 루프(docs/marketing.md). MCP 모듈이 이것을 import 해
 * marketing-tools 에 서비스를 넘긴다.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      MarketingCampaign, MarketingAuditEvent, MarketingChannel,
      Project, RuntimeHost, OutreachChannel, Credential,
    ]),
    SharedServicesModule,
    // 채널 승인이 새 OutreachChannel 을 OutreachChannelService 로 만든다(그쪽 검증을 그대로 탄다).
    OutreachModule,
  ],
  controllers: [MarketingCampaignsController, MarketingChannelsController],
  providers: [
    MarketingAuditService,
    MarketingCampaignHooks,
    MarketingCampaignService,
    MarketingChannelService,
    MarketingAgentService,
    AuthGuard,
    PermissionGuard,
  ],
  exports: [MarketingAuditService, MarketingCampaignService, MarketingChannelService, MarketingAgentService],
})
export class MarketingModule {}
