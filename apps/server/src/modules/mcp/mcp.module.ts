import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiKey } from '../../entities/ApiKey';
import { McpController } from './mcp.controller';
import { AgentsModule } from '../agents/agents.module';
import { McpServicesModule } from './mcp-services.module';
import { ChatRoomsModule } from '../chat-rooms/chat-rooms.module';
import { WorkspaceRolesModule } from '../workspace-roles/workspace-roles.module';
import { ActionsModule } from '../actions/actions.module';
import { QaScenarioModule } from '../qa/qa-scenario.module';
import { BuildsModule } from '../builds/build-artifact.module';
import { DeploymentsModule } from '../deployments/deployment.module';
import { SecurityProfileModule } from '../security/security-profile.module';
import { BenchmarksModule } from '../benchmarks/benchmarks.module';
import { WorkspaceScheduleModule } from '../workspace-schedule/workspace-schedule.module';
import { FeaturesModule } from '../features/features.module';
import { HandoffModule } from '../handoff/handoff.module';
import { WorkflowFunctionsModule } from '../workflow-functions/workflow-functions.module';
import { ArtifactRefsModule } from '../artifact-refs/artifact-refs.module';
import { OutreachModule } from '../outreach/outreach.module';
import { OrchestrationModule } from '../orchestration/orchestration.module';
import { AgentManagerModule } from '../agent-manager/agent-manager.module';
import { OntologyModule } from '../ontology/ontology.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ApiKey]),
    AgentsModule,
    McpServicesModule,
    ChatRoomsModule,
    WorkspaceRolesModule,
    ActionsModule,
    // Provides QaService + QaRunService for the qa-tools MCP tools.
    QaScenarioModule,
    // Provides BuildArtifactService for the build-tools MCP tools (ticket 80d52250).
    BuildsModule,
    // Provides DeploymentService for the report_deployment MCP tool (ticket 8ce72b18).
    DeploymentsModule,
    // Provides SecurityProfileService + SecurityRunService for the security-tools MCP tools.
    SecurityProfileModule,
    // Provides BenchmarkService for the benchmark MCP tools (ticket 684c012b).
    BenchmarksModule,
    // Provides WorkspaceScheduleService for the workspace-schedule MCP tools (ticket 769eb260).
    WorkspaceScheduleModule,
    // Provides FeaturesService for the feature-tools MCP tools (ticket aae7644c).
    FeaturesModule,
    // Provides HandoffService for the handoff-tools MCP tools (ticket ac21a745).
    HandoffModule,
    WorkflowFunctionsModule,
    ArtifactRefsModule,
    // Provides ClassificationBridgeService for the outreach-tools MCP tool
    // (ticket 20fa0197) — record_outreach_classification must resolve
    // against the SAME singleton instance AgentDispatchClassifier awaits on.
    OutreachModule,
    // Provides the orchestration runner / mission / team services for the
    // orchestration-tools MCP tools (팀 기반 자율 업무 오케스트레이션).
    OrchestrationModule,
    // Provides AgentManagerCommandService for the keep_chat_session_alive
    // MCP tool (ticket 6ff827cb) — routes an extend/release grant to the
    // calling agent's own live manager instance over agent_manager_command.
    AgentManagerModule,
    // Provides OntologyLifecycleService + OntologyQueryService for the
    // ontology-tools MCP tools (ticket d35b7b7d, DESIGN.md 축 6).
    OntologyModule,
  ],
  controllers: [McpController],
})
export class McpModule {}
