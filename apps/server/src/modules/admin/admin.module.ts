import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../../entities/User';
import { Workspace } from '../../entities/Workspace';
import { SystemSetting } from '../../entities/SystemSetting';
import { LogsController } from './logs.controller';
import { PendingUsersController } from './pending-users.controller';
import { SettingsController } from './settings.controller';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';

@Module({
  imports: [TypeOrmModule.forFeature([User, Workspace, SystemSetting])],
  controllers: [LogsController, PendingUsersController, SettingsController],
  providers: [AuthGuard, AdminGuard, PermissionGuard],
})
export class AdminModule {}
