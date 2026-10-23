import { Module } from '@nestjs/common';
import { SharedServicesModule } from '../../services/shared-services.module';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { BusinessController } from './business.controller';
import { BusinessFormationService } from './business-formation.service';
import { BusinessService } from './business.service';
import { AgentsModule } from '../agents/agents.module';
import { BusinessTrademarkController } from './business-trademark.controller';
import { BusinessTrademarkService } from './business-trademark.service';
import { BusinessTrademarkIntegrationsService } from './business-trademark-integrations.service';
import { BusinessTrademarkIntegrationsController, BusinessTrademarkIntegrationCallbacksController } from './business-trademark-integrations.controller';

@Module({ imports: [SharedServicesModule, AgentsModule], controllers: [BusinessController, BusinessTrademarkController, BusinessTrademarkIntegrationsController, BusinessTrademarkIntegrationCallbacksController], providers: [AuthGuard, PermissionGuard, BusinessService, BusinessFormationService, BusinessTrademarkService, BusinessTrademarkIntegrationsService], exports: [BusinessService, BusinessFormationService, BusinessTrademarkService, BusinessTrademarkIntegrationsService] })
export class BusinessModule {}
