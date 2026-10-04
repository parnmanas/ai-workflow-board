/**
 * ToolContext — the runtime context passed to each MCP tool registration
 * function. Carries the shared DataSource plus the services that tools need,
 * so every tool file can be plain module-scope code (no globals, no
 * getRepository side-imports).
 *
 * Two construction paths:
 *
 *   1. NestJS integrated (apps/server/src/modules/mcp/mcp.controller.ts):
 *      The controller builds a ToolContext out of the DI-injected services
 *      and passes it to `registerAllTools(server, ctx)`.
 *
 *   2. Standalone (apps/server/src/mcp-server.ts):
 *      The standalone entry point calls `createStandaloneContext(dataSource)`
 *      which manually instantiates thin services (no DI) on top of the
 *      DataSource.
 *
 * Historic globals (`AppDataSource`, inline `logActivity`, inline
 * `createApiKey`, etc.) are now removed — every tool goes through `ctx`.
 */

import type { DataSource } from 'typeorm';
import { ActivityLog } from '../../../entities/ActivityLog';
import { ApiKey } from '../../../entities/ApiKey';
import { ChatRoom } from '../../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../../entities/ChatRoomParticipant';
import { ChatRoomMessage } from '../../../entities/ChatRoomMessage';
import { User } from '../../../entities/User';
import { Ticket } from '../../../entities/Ticket';
import { UserMention } from '../../../entities/UserMention';
import { TicketAttachment } from '../../../entities/TicketAttachment';
import { Workspace } from '../../../entities/Workspace';
import { SystemSetting } from '../../../entities/SystemSetting';
import { ActivityService } from '../../../services/activity.service';
import { ApiKeyService } from '../../../services/api-key.service';
import { InstanceQuiesceService } from '../../../services/instance-quiesce.service';
import { LogService } from '../../../services/log.service';
import { EmbeddingService } from '../../../services/embedding.service';
import { GitHubConnectorService } from '../../../services/github-connector.service';
import { MentionService } from '../../../services/mention.service';
import type { AgentStatusService } from '../../agents/agent-status.service';
import type { RoomCrudService } from '../../chat-rooms/room-crud.service';
import { RoomMembershipService } from '../../chat-rooms/room-membership.service';
import { RoomMessagingService } from '../../chat-rooms/room-messaging.service';
import { AgentConnectivityRegistry } from '../../../services/agent-connectivity.registry';
import { MemoryMetricsRegistry } from '../../../services/memory-metrics.registry';
import type { ActionsService } from '../../actions/actions.service';
import type { QaService } from '../../qa/qa.service';
import type { QaRunService } from '../../qa/qa-run.service';
import { BuildArtifactService } from '../../builds/build-artifact.service';
import { DeploymentService } from '../../deployments/deployment.service';
import type { QaScheduleService } from '../../qa/qa-schedule.service';
import type { SecurityProfileService } from '../../security/security-profile.service';
import type { SecurityRunService } from '../../security/security-run.service';
import type { SecurityScheduleService } from '../../security/security-schedule.service';
import type { WorkspaceScheduleService } from '../../workspace-schedule/workspace-schedule.service';
import { TicketPrerequisitesService } from '../../tickets/ticket-prerequisites.service';
import { CiWaitService } from '../../tickets/ci-wait.service';
import { TicketService } from '../../tickets/ticket.service';
import { TicketDuplicateService } from '../../tickets/ticket-duplicate.service';
import type { TicketDispatchService } from '../../agents/ticket-dispatch.service';
import { ProjectsService } from '../../projects/projects.service';
import type { PrivilegedCommandService } from '../../agent-manager/privileged-command.service';
import type { InstanceRegistryService } from '../../agent-manager/instance-registry.service';
import type { PendingTicketRefAccumulator } from './ticket-ref-session';
import type { WorkflowFunctionsService } from '../../workflow-functions/workflow-functions.service';
import type { ArtifactRefsService } from '../../artifact-refs/artifact-refs.service';
import type { ClassificationBridgeService } from '../../outreach/classifier/classification-bridge.service';
import type { OrchestrationRunnerService } from '../../orchestration/orchestration-runner.service';
import type { OrchestrationMissionService } from '../../orchestration/orchestration-mission.service';
import { OrchestrationMission as OrchestrationMissionEntity } from '../../../entities/OrchestrationMission';
import type { OrchestrationTeamService } from '../../orchestration/orchestration-team.service';
import type { AgentManagerCommandService } from '../../agent-manager/agent-manager-command.service';
import type { OntologyLifecycleService } from '../../ontology/ontology-lifecycle.service';
import type { OntologyQueryService } from '../../ontology/ontology-query.service';
import type { OperatorDecisionService } from '../../voice/operator-decision.service';

/**
 * Minimal surface that MCP tools need from the logging subsystem.
 * NestJS LogService satisfies this; the standalone console shim below
 * satisfies it too.
 */
export interface McpLogger {
  info(category: string, message: string, meta?: Record<string, any>): any;
  warn(category: string, message: string, meta?: Record<string, any>): any;
  error(category: string, message: string, meta?: Record<string, any>): any;
}

/**
 * Context passed to every tool registration function.
 *
 * Kept deliberately small: `dataSource` for repositories, the three domain
 * services (activity/apiKey/logger), and that's it. More services can be
 * added here as tools require them.
 */
export interface ToolContext {
  dataSource: DataSource;
  activityService: ActivityService;
  apiKeyService: ApiKeyService;
  embeddingService: EmbeddingService;
  githubService: GitHubConnectorService;
  mentionService: MentionService;
  // 인스턴스 전역 fleet quiesce 조회(ticket 0f638509) — comment_mention
  // 디스패치 지점(add_comment/ask_question)이 quiesce 상태를
  // 확인하는 데 필요하다. activityService처럼 stateless-over-DataSource라
  // 두 생성 경로 모두 항상 채운다(standalone도 optional이 아님).
  instanceQuiesceService: InstanceQuiesceService;
  logger: McpLogger;
  // Optional — present in NestJS integrated mode; undefined when invoked from
  // the standalone mcp-server entry point (no DI). Tools that depend on it
  // must degrade gracefully.
  agentStatusService?: AgentStatusService;
  roomCrudService?: RoomCrudService;
  roomMembershipService?: RoomMembershipService;
  // v0.33: shared message-send entry point. Required for the MCP
  // send_chat_room_message tool so it goes through the same dispatch path
  // (mention parsing, DM auto-route, chat_room_message emit with
  // agent_chain_depth) as the REST endpoints. Standalone context omits it —
  // the tool degrades to an explicit error in that mode.
  roomMessagingService?: RoomMessagingService;
  // Ticket mutations (docs/tickets.md) — every ticket create/update/move/pend
  // goes through it so MCP, REST and automatic producers share side effects.
  // Present in both modes; standalone wires a dispatcher stub (no live SSE).
  ticketService: TicketService;
  // Ticket dispatch — present in NestJS mode only. Tools that re-wake an
  // assignee (unpend, duplicate correction, manual run) degrade to a no-op
  // without it.
  ticketDispatchService?: TicketDispatchService;
  // Projects (repositories + per-host main clone folders). Present in both modes.
  projectsService: ProjectsService;
  // Actions feature: required by `run_action` MCP tool which needs to dispatch
  // a Run (create room, add participants, send first message). The CRUD tools
  // operate directly on repositories and don't need this.
  actionsService?: ActionsService;
  // Scenario-based QA feature. Required by the qa-tools MCP tools.
  // `qaService` handles scenario CRUD (also doable over repos, but the service
  // centralizes validation); `qaRunService` is required for start_qa_run +
  // record/complete since those touch the chat-room dispatch + run lifecycle.
  // Standalone context omits both — the tools degrade to an explicit error.
  qaService?: QaService;
  qaRunService?: QaRunService;
  // Build & Artifact Registry (ticket 80d52250). Required by the build-tools MCP
  // tools. Stateless over the DataSource, so BOTH modes provide it — the
  // standalone builder constructs a thin instance directly.
  buildArtifactService?: BuildArtifactService;
  // Deployment awareness (ticket 8ce72b18). Required by the deployment-tools MCP
  // tool (report_deployment). Stateless over the DataSource, so BOTH modes
  // provide it — the standalone builder constructs a thin instance directly.
  deploymentService?: DeploymentService;
  // QA scheduler (ticket b6bb7efd) — automatic batch trigger layer. Required by
  // the qa-schedule MCP tools (CRUD + run-now). Standalone context omits it; the
  // tools degrade to an explicit error (no background tick in standalone mode).
  qaScheduleService?: QaScheduleService;
  // Security-inspection feature (SecurityProfile/SecurityRun). Required by the
  // security-tools MCP tools. `securityProfileService` handles profile CRUD;
  // `securityRunService` is required for start_security_run + record/complete
  // since those touch the chat-room dispatch + run lifecycle. Standalone context
  // omits both — the tools degrade to an explicit error.
  securityProfileService?: SecurityProfileService;
  securityRunService?: SecurityRunService;
  // Security scheduler — automatic batch trigger layer. Required by the
  // security-schedule MCP tools (CRUD + run-now). Standalone context omits it;
  // the tools degrade to an explicit error (no background tick in standalone mode).
  securityScheduleService?: SecurityScheduleService;
  // Workspace scheduler (ticket 769eb260, foundation 8845be79) — general-purpose
  // agent-task trigger layer. Required by the workspace-schedule MCP tools (CRUD +
  // run-now). Standalone context omits it; the tools degrade to an explicit error
  // (no background tick in standalone mode).
  workspaceScheduleService?: WorkspaceScheduleService;
  artifactRefsService?: ArtifactRefsService;
  // Ticket 48d14fff: prerequisite ("blocked-by ticket") mutations. Present in
  // both modes — the standalone builder constructs a thin instance directly
  // on the DataSource since the service is stateless over dataSource +
  // activityService. Used by ticket-prerequisite-tools.
  ticketPrerequisitesService?: TicketPrerequisitesService;
  // Ticket 778b6dc7: durable "blocked-on-one-external-CI-run" wait. Present
  // in both modes — stateless over dataSource + activityService, same
  // standalone-instantiation shape as ticketPrerequisitesService above. Used
  // by ci-wait-tools (await_ci_run / cancel_ci_wait).
  ciWaitService?: CiWaitService;
  // 권한 상승 승인 대기(세션/채팅). `request_privileged_command` /
  // `get_privileged_command_result` 가 쓴다. standalone(stdio) 모드에는 매니저
  // 인스턴스 레지스트리 자체가 없으므로 둘 다 optional 이고, 없으면 그 툴은
  // "이 서버에서는 쓸 수 없다" 로 명확히 실패한다(조용히 성공하지 않는다).
  privilegedCommandService?: PrivilegedCommandService;
  instanceRegistryService?: InstanceRegistryService;
  workflowFunctionsService?: WorkflowFunctionsService;
  // Ticket 20fa0197: AgentDispatchClassifier's in-process wait bridge.
  // Required by outreach-tools' record_outreach_classification — that tool
  // call is what unblocks the classify() await sitting in the SAME process
  // (see ClassificationBridgeService's docstring for why this is a narrow
  // exception to the usual decoupled dispatch/complete pattern). Standalone
  // context omits it — there is no OutreachModule instance to share a
  // singleton with in that mode, so the tool degrades to an explicit error.
  classificationBridgeService?: ClassificationBridgeService;
  // Orchestration mode. Required by orchestration-tools: the orchestrator's
  // plan/step/complete calls and the members' progress/result reports all go
  // through the runner, and `get_orchestration_mission` reads through the
  // mission service. Standalone context omits all three — the dispatch engine
  // posts into chat rooms and wakes agents over SSE, neither of which exists in
  // the standalone MCP entry point, so the tools degrade to an explicit error
  // rather than silently recording state nobody will ever act on.
  orchestrationRunnerService?: OrchestrationRunnerService;
  orchestrationMissionService?: OrchestrationMissionService;
  orchestrationTeamService?: OrchestrationTeamService;
  // ticket 6ff827cb: keep_chat_session_alive routes an extend/release grant
  // to the calling agent's own live agent-manager instance over the same
  // agent_manager_command SSE channel spawn_agent/stop_agent already use.
  // Standalone context omits it — the tool degrades to an explicit error
  // (there is no live manager instance concept without the DI-wired
  // InstanceRegistry this service wraps).
  agentManagerCommandService?: AgentManagerCommandService;
  // Ontology Graph (ticket d35b7b7d, DESIGN.md 축 6). Required by
  // ontology-tools.ts's six graph_ tools: `ontologyLifecycleService` resolves
  // graph_id from (resource_id, folder_path) and auto-provisions +
  // kicks off the initial Tier 1/1.5 build on first reference (graph_status);
  // `ontologyQueryService` answers the bounded traversal/lookup queries. Both
  // depend on a worker-pool/git-repo-cache-backed extraction service, so —
  // same posture as orchestration* above — standalone context
  // omits them and the tools degrade to an explicit error.
  ontologyLifecycleService?: OntologyLifecycleService;
  ontologyQueryService?: OntologyQueryService;
  // 말로 답하기(docs/voice-operator.md) — operator 세션이 사용자의 말로 받은 답을 승인·질문을 기다리는
  // 세션에 전한다(operator-tools.ts). 라이브 세션 상태가 NestJS 프로세스 메모리에 있으므로 standalone
  // context 에는 없다 — 도구가 그 사유로 거절한다.
  operatorDecisionService?: OperatorDecisionService;
  // Session-scoped bridge from successful create/update tools to the final
  // send_chat_room_message call. Initialized by createMcpServerForContext.
  pendingTicketRefs?: PendingTicketRefAccumulator;
}

/**
 * Build a ToolContext for the standalone MCP server. Services are
 * instantiated directly against the given DataSource (no NestJS DI).
 *
 * Safe to call with the mutable `AppDataSource` that the standalone entry
 * creates via `initDb()` — TypeORM repositories resolve at call time.
 */
export function createStandaloneContext(dataSource: DataSource): ToolContext {
  const logger: McpLogger = {
    info: (category, message, meta) => { console.log(`[${category}]`, message, meta || ''); },
    warn: (category, message, meta) => { console.warn(`[${category}]`, message, meta || ''); },
    error: (category, message, meta) => { console.error(`[${category}]`, message, meta || ''); },
  };

  // Standalone ActivityService needs a LogService-compatible dependency. We
  // instantiate a real LogService for it (in-memory log buffer is harmless;
  // console output is already covered by our own `logger`).
  const logService = new LogService();

  const activityService = new ActivityService(
    dataSource.getRepository(ActivityLog),
    dataSource,
    logService,
  );
  const apiKeyService = new ApiKeyService(dataSource.getRepository(ApiKey));
  const instanceQuiesceService = new InstanceQuiesceService(dataSource.getRepository(SystemSetting));
  const embeddingService = new EmbeddingService(dataSource);
  const githubService = new GitHubConnectorService(dataSource);
  const mentionService = new MentionService();

  // v0.33: standalone chat support. Required for send_chat_room_message.
  const roomMembershipService = new RoomMembershipService(
    dataSource.getRepository(ChatRoom),
    dataSource.getRepository(ChatRoomParticipant),
    dataSource.getRepository(User),
    dataSource,
    // 발화 게이트가 미션의 `user_chat_mode` 를 읽는다(티켓 9cfd8161). standalone MCP 도
    // 같은 판정을 받아야 하므로 여기서도 넘긴다 — 빠지면 MCP 경로만 옵션을 무시한다.
    dataSource.getRepository(OrchestrationMissionEntity),
    // DM → group 승격 로그(티켓 70e62a9d). MCP `add_chat_participants` 도 승격을
    // 일으키므로 그 경로만 추적이 비면 안 된다.
    logService,
  );
  const roomMessagingService = new RoomMessagingService(
    dataSource.getRepository(ChatRoom),
    dataSource.getRepository(ChatRoomParticipant),
    dataSource.getRepository(ChatRoomMessage),
    dataSource.getRepository(Ticket),
    dataSource.getRepository(UserMention),
    dataSource.getRepository(TicketAttachment),
    dataSource.getRepository(Workspace),
    dataSource,
    logService,
    roomMembershipService,
    mentionService,
    // Standalone MCP mode has no live SSE server, so this registry stays empty
    // (isReachable → false). That's correct: the auto-start hub / feedback
    // listeners live in the NestJS server process, not here.
    new AgentConnectivityRegistry(new MemoryMetricsRegistry()),
  );

  // Prerequisite service — stateless over dataSource + activityService, so a
  // direct instantiation matches the DI singleton's behavior in standalone mode.
  const ticketPrerequisitesService = new TicketPrerequisitesService(dataSource as any, activityService);

  // CI-wait service — likewise stateless over dataSource + activityService,
  // same standalone-instantiation shape as the prereq service above.
  const ciWaitService = new CiWaitService(dataSource as any, activityService);

  // Ticket mutations without the live dispatcher: standalone (stdio) MCP has
  // no SSE stream to deliver an agent_trigger on, so dispatch is a recorded
  // no-op — the server process's own sweep starts queued tickets.
  const projectsService = new ProjectsService(dataSource);
  const standaloneDispatcher = {
    dispatch: async () => ({ dispatched: false, reason: 'standalone' }),
    resumeTicket: async () => ({ dispatched: false, reason: 'standalone' }),
    manualTrigger: async () => ({ dispatched: false, reason: 'standalone' }),
    startQueued: async () => 0,
  } as unknown as TicketDispatchService;
  const ticketService = new TicketService(
    dataSource,
    activityService,
    projectsService,
    standaloneDispatcher,
    new TicketDuplicateService(dataSource),
  );

  // BuildArtifactService is likewise stateless over the DataSource (+ LogService),
  // so the build-tools work in standalone MCP mode too (ticket 80d52250).
  const buildArtifactService = new BuildArtifactService(dataSource, logService);

  // DeploymentService — stateless over the DataSource (+ LogService), so
  // report_deployment works in standalone MCP mode too (ticket 8ce72b18).
  const deploymentService = new DeploymentService(dataSource, logService);

  return {
    dataSource,
    activityService,
    apiKeyService,
    embeddingService,
    githubService,
    mentionService,
    instanceQuiesceService,
    logger,
    roomMembershipService,
    roomMessagingService,
    ticketPrerequisitesService,
    ciWaitService,
    ticketService,
    projectsService,
    buildArtifactService,
    deploymentService,
  };
}
