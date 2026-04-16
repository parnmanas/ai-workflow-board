import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../../entities/User';
import { Workspace } from '../../entities/Workspace';
import { LogsController } from './logs.controller';
import { PendingUsersController } from './pending-users.controller';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';

@Module({
  imports: [TypeOrmModule.forFeature([User, Workspace])],
  controllers: [LogsController, PendingUsersController],
  providers: [AuthGuard, AdminGuard, PermissionGuard],
})
export class AdminModule {}
