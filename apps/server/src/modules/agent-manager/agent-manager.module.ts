import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Agent } from '../../entities/Agent';
import { ApiKey } from '../../entities/ApiKey';
import { Credential } from '../../entities/Credential';
import { Ticket } from '../../entities/Ticket';
import { Resource } from '../../entities/Resource';
import { AgentsModule } from '../agents/agents.module';
import { AgentAuthGuard } from '../../common/guards/agent-auth.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { AgentManagerController } from './agent-manager.controller';
import { InstanceRegistryService } from './instance-registry.service';
import { PairingService } from './pairing.service';
import { CommandLedgerService } from './command-ledger.service';
import { ManagerDriftMonitorService } from './manager-drift-monitor.service';

@Module({
  // AgentsModule re-exports SubagentMonitorService so the same singleton that
  // backs SubagentMonitorController (used by /api/subagent-monitor/*) also
  // serves the per-instance subagents view here. Sharing the singleton avoids
  // a split brain between the two routes.
  //
  // ApiKey row repository is needed locally because pair/redeem creates a
  // bearer for the freshly-paired manager. Agent repo is needed for both
  // pair/redeem (manager identity) and createManagedAgent (CLI-typed agent).
  //
  // forwardRef around AgentsModule: AgentsModule now also imports this module
  // (to inject InstanceRegistryService into AgentsController for live-data
  // enrichment of /api/agents). NestJS resolves the cycle via forwardRef on
  // both sides.
  imports: [forwardRef(() => AgentsModule), TypeOrmModule.forFeature([Agent, ApiKey, Credential, Ticket, Resource])],
  controllers: [AgentManagerController],
  providers: [
    InstanceRegistryService,
    PairingService,
    CommandLedgerService,
    // version-drift / stale self-update health monitor (ticket 7485df07). Runs
    // its own sweep timer; consumes InstanceRegistryService — same module, no
    // extra wiring. No HTTP surface, so it isn't in `controllers`/`exports`.
    ManagerDriftMonitorService,
    AgentAuthGuard,
    AuthGuard,
    PermissionGuard,
    WorkspaceGuard,
  ],
  exports: [InstanceRegistryService, PairingService],
})
export class AgentManagerModule {}
