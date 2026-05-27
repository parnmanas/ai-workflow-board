import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../../entities/User';
import { Workspace } from '../../entities/Workspace';
import { Board } from '../../entities/Board';
import { BoardColumn } from '../../entities/BoardColumn';
import { SystemSetting } from '../../entities/SystemSetting';
import { LogsController } from './logs.controller';
import { PendingUsersController } from './pending-users.controller';
import { SettingsController } from './settings.controller';
import { StuckTicketsController } from './stuck-tickets.controller';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { AgentsModule } from '../agents/agents.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Workspace, Board, BoardColumn, SystemSetting]),
    // AgentsModule exports StuckTicketDetectorService, which the new
    // /api/admin/stuck-tickets controller consults for current alert
    // rows / re-alert / dismiss. forwardRef defends against any future
    // cycle if AgentsModule starts importing AdminModule symbols.
    forwardRef(() => AgentsModule),
  ],
  controllers: [LogsController, PendingUsersController, SettingsController, StuckTicketsController],
  providers: [AuthGuard, AdminGuard, PermissionGuard],
})
export class AdminModule {}
