import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Agent } from '../../entities/Agent';
import { ApiKey } from '../../entities/ApiKey';
import { Credential } from '../../entities/Credential';
import { Ticket } from '../../entities/Ticket';
import { Resource } from '../../entities/Resource';
import { Workspace } from '../../entities/Workspace';
import { AgentsModule } from '../agents/agents.module';
import { AgentAuthGuard } from '../../common/guards/agent-auth.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { AgentManagerController } from './agent-manager.controller';
import { InstanceRegistryModule } from './instance-registry.module';
import { PairingService } from './pairing.service';
import { CommandLedgerService } from './command-ledger.service';
import { AgentManagerCommandService } from './agent-manager-command.service';
import { ManagerDriftMonitorService } from './manager-drift-monitor.service';
import { SkillsModule } from '../skills/skills.module';

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
  // forwardRef around AgentsModule: AgentsModule also imports this module (for
  // AgentManagerCommandService/PairingService). NestJS resolves the cycle via
  // forwardRef on both sides.
  //
  // InstanceRegistryModule (ticket c3b767c6): InstanceRegistryService moved
  // there and is now @Global() — importing it here keeps this module's own
  // controller/ManagerDriftMonitorService resolving it exactly as before,
  // while ChatRoomsModule/AgentsModule reach it too without either needing an
  // import edge onto this module. See that module's doc comment.
  imports: [
    forwardRef(() => AgentsModule),
    InstanceRegistryModule,
    SkillsModule,
    TypeOrmModule.forFeature([Agent, ApiKey, Credential, Ticket, Resource, Workspace]),
  ],
  controllers: [AgentManagerController],
  providers: [
    PairingService,
    CommandLedgerService,
    AgentManagerCommandService,
    // version-drift / stale self-update health monitor (ticket 7485df07). Runs
    // its own sweep timer; consumes InstanceRegistryService (now global via
    // InstanceRegistryModule above). No HTTP surface, so it isn't in
    // `controllers`/`exports`.
    ManagerDriftMonitorService,
    AgentAuthGuard,
    AuthGuard,
    PermissionGuard,
    WorkspaceGuard,
  ],
  exports: [PairingService, AgentManagerCommandService],
})
export class AgentManagerModule {}
