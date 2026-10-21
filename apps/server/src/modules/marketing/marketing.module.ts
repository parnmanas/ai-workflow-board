import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MarketingCampaign } from '../../entities/MarketingCampaign';
import { MarketingAuditEvent } from '../../entities/MarketingAuditEvent';
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

/**
 * Marketing — 에이전트 기반 제품 마케팅 루프(docs/marketing.md). MCP 모듈이 이것을 import 해
 * marketing-tools 에 서비스를 넘긴다.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([MarketingCampaign, MarketingAuditEvent, Project, RuntimeHost]),
    SharedServicesModule,
  ],
  controllers: [MarketingCampaignsController],
  providers: [
    MarketingAuditService,
    MarketingCampaignHooks,
    MarketingCampaignService,
    MarketingAgentService,
    AuthGuard,
    PermissionGuard,
  ],
  exports: [MarketingAuditService, MarketingCampaignService, MarketingAgentService],
})
export class MarketingModule {}
