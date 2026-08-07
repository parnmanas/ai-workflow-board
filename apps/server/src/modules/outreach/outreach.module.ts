import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutreachChannel } from '../../entities/OutreachChannel';
import { OutreachInboundItem } from '../../entities/OutreachInboundItem';
import { Credential } from '../../entities/Credential';
import { Board } from '../../entities/Board';
import { BoardColumn } from '../../entities/BoardColumn';
import { Ticket } from '../../entities/Ticket';
import { WorkspaceRolesModule } from '../workspace-roles/workspace-roles.module';
import { OutreachIngestService } from './outreach-ingest.service';
import { OutreachPollingService } from './outreach-polling.service';
import { OutreachChannelService } from './outreach-channel.service';
import { OutreachController } from './outreach.controller';
import { OUTREACH_CLASSIFIER } from './classifier/types';
import { RuleBasedClassifier } from './classifier/rule-based.classifier';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([OutreachChannel, OutreachInboundItem, Credential, Board, BoardColumn, Ticket]),
    // TicketRoleAssignmentService (board default_role_assignments backfill on
    // auto-created tickets) is NOT @Global — must import explicitly.
    WorkspaceRolesModule,
  ],
  controllers: [OutreachController],
  providers: [
    OutreachIngestService,
    OutreachPollingService,
    OutreachChannelService,
    { provide: OUTREACH_CLASSIFIER, useClass: RuleBasedClassifier },
    AuthGuard,
    PermissionGuard,
  ],
})
export class OutreachModule {}
