import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Workspace } from '../../entities/Workspace';
import { Ticket } from '../../entities/Ticket';
import { User } from '../../entities/User';
import { WorkspacesController } from './workspaces.controller';
import { AuthGuard } from '../../common/guards/auth.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([Workspace, Ticket, User]),
  ],
  controllers: [WorkspacesController],
  providers: [AuthGuard],
})
export class WorkspacesModule {}
