import { Module } from '@nestjs/common';
import { SharedServicesModule } from '../../services/shared-services.module';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { BusinessController } from './business.controller';
import { BusinessFormationService } from './business-formation.service';
import { BusinessService } from './business.service';
import { AgentsModule } from '../agents/agents.module';

@Module({ imports: [SharedServicesModule, AgentsModule], controllers: [BusinessController], providers: [AuthGuard, PermissionGuard, BusinessService, BusinessFormationService] })
export class BusinessModule {}
