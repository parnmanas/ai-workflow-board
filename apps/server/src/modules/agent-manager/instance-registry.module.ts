import { Global, Module } from '@nestjs/common';
import { InstanceRegistryService } from './instance-registry.service';

/**
 * ticket c3b767c6 — InstanceRegistryService extracted into its own @Global()
 * module so the dispatch-capability gate (TriggerLoopService in AgentsModule,
 * RoomMessagingService in ChatRoomsModule) can inject it directly, the same
 * way AgentConnectivityRegistry (services/shared-services.module.ts) reaches
 * both its producer (EventsController) and consumer (AgentAutostartService)
 * without a module cycle — see that class's doc comment for the identical
 * rationale. AgentsModule already has a forwardRef cycle with
 * AgentManagerModule (for SubagentMonitorService); ChatRoomsModule has none,
 * and folding it into that cycle just to reach one boolean lookup was worse
 * than lifting the lookup out to its own leaf module.
 *
 * AgentManagerModule still owns the CONTROLLER that writes to this registry
 * (agent-manager.controller.ts's instance-heartbeat handler) and imports this
 * module unchanged for its existing consumers — only the provider's *home*
 * module moved, not its identity, constructor, or existing behavior.
 */
@Global()
@Module({
  providers: [InstanceRegistryService],
  exports: [InstanceRegistryService],
})
export class InstanceRegistryModule {}
