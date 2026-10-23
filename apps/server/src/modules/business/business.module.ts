import { Module } from '@nestjs/common';
import { SharedServicesModule } from '../../services/shared-services.module';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { BusinessController } from './business.controller';
import { BusinessFormationService } from './business-formation.service';
import { BusinessService } from './business.service';
import { BusinessCashbookService } from './business-cashbook.service';
import { BusinessCashbookController } from './business-cashbook.controller';
import { AgentsModule } from '../agents/agents.module';
import { BusinessTrademarkController } from './business-trademark.controller';
import { BusinessTrademarkService } from './business-trademark.service';
import { BusinessTrademarkIntegrationsService } from './business-trademark-integrations.service';
import { BusinessTrademarkIntegrationsController, BusinessTrademarkIntegrationCallbacksController } from './business-trademark-integrations.controller';

@Module({ imports: [SharedServicesModule, AgentsModule], controllers: [BusinessController, BusinessCashbookController, BusinessTrademarkController, BusinessTrademarkIntegrationsController, BusinessTrademarkIntegrationCallbacksController], providers: [AuthGuard, PermissionGuard, BusinessService, BusinessCashbookService, BusinessFormationService, BusinessTrademarkService, BusinessTrademarkIntegrationsService], exports: [BusinessService, BusinessCashbookService, BusinessFormationService, BusinessTrademarkService, BusinessTrademarkIntegrationsService] })
export class BusinessModule {}
