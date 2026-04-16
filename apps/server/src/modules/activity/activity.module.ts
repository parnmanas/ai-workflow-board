import { Module } from '@nestjs/common';
import { ActivityController } from './activity.controller';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';

@Module({
  controllers: [ActivityController],
  providers: [AuthGuard, PermissionGuard],
})
export class ActivityModule {}
