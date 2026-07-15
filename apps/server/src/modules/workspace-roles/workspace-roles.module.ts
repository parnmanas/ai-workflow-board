import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkspaceRole } from '../../entities/WorkspaceRole';
import { TicketRoleAssignment } from '../../entities/TicketRoleAssignment';
import { Agent } from '../../entities/Agent';
import { User } from '../../entities/User';
import { Ticket } from '../../entities/Ticket';
import { WorkspaceRolesService } from './workspace-roles.service';
import { WorkspaceRolesController } from './workspace-roles.controller';
import { TicketRoleAssignmentService } from './ticket-role-assignment.service';

@Module({
  imports: [TypeOrmModule.forFeature([WorkspaceRole, TicketRoleAssignment, Agent, User, Ticket])],
  controllers: [WorkspaceRolesController],
  providers: [WorkspaceRolesService, TicketRoleAssignmentService],
  exports: [WorkspaceRolesService, TicketRoleAssignmentService],
})
export class WorkspaceRolesModule {}
