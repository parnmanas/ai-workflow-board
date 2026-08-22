import { ApiTags } from '@nestjs/swagger';
import { Controller, All, Req, Res, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { type ToolContext, type ToolProfile } from './tools';
import { OrchestrationRunnerService } from '../orchestration/orchestration-runner.service';
import { OrchestrationMissionService } from '../orchestration/orchestration-mission.service';
import { OrchestrationTeamService } from '../orchestration/orchestration-team.service';
import { AgentManagerCommandService } from '../agent-manager/agent-manager-command.service';
import { createMcpServerForContext } from './internal/create-mcp-server';
import { expressToWebRequest, sendWebResponse } from './internal/express-bridge';
import { sessionStore } from './internal/session-store';
import { authenticateMcpRequest } from './shared/mcp-http-auth';
import { SystemSetting } from '../../entities/SystemSetting';
import { ApiKeyService } from '../../services/api-key.service';
import { LogService } from '../../services/log.service';
import { MemoryMetricsRegistry } from '../../services/memory-metrics.registry';
import { AgentConnectionService } from '../agents/agent-connection.service';
import { TriggerLoopService } from '../agents/trigger-loop.service';
import { AgentStatusService } from '../agents/agent-status.service';
import { AllocationService } from '../agents/allocation.service';
import { RoomCrudService } from '../chat-rooms/room-crud.service';
import { RoomMembershipService } from '../chat-rooms/room-membership.service';
import { RoomMessagingService } from '../chat-rooms/room-messaging.service';
import { TicketRoleAssignmentService } from '../workspace-roles/ticket-role-assignment.service';
import { ActionsService } from '../actions/actions.service';
import { QaService } from '../qa/qa.service';
import { QaRunService } from '../qa/qa-run.service';
import { BuildArtifactService } from '../builds/build-artifact.service';
import { DeploymentService } from '../deployments/deployment.service';
import { QaScheduleService } from '../qa/qa-schedule.service';
import { SecurityProfileService } from '../security/security-profile.service';
import { SecurityRunService } from '../security/security-run.service';
import { SecurityScheduleService } from '../security/security-schedule.service';
import { WorkspaceScheduleService } from '../workspace-schedule/workspace-schedule.service';
import { FeaturesService } from '../features/features.service';
import { TicketPrerequisitesService } from '../tickets/ticket-prerequisites.service';
import { CiWaitService } from '../tickets/ci-wait.service';
import { HandoffService } from '../handoff/handoff.service';
import { BenchmarkService } from '../benchmarks/benchmark.service';
import { MentionService } from '../../services/mention.service';
import { ActivityService } from '../../services/activity.service';
import { EmbeddingService } from '../../services/embedding.service';
import { GitHubConnectorService } from '../../services/github-connector.service';
import { WorkflowFunctionsService } from '../workflow-functions/workflow-functions.service';
import { ArtifactRefsService } from '../artifact-refs/artifact-refs.service';
import { ClassificationBridgeService } from '../outreach/classifier/classification-bridge.service';

// Module-level log reference, set from McpController.onModuleInit
let logService: LogService | null = null;
function mcpLog(message: string, meta?: Record<string, any>) {
  if (logService) {
    logService.info('MCP', message, meta);
  } else {
    console.log('[MCP]', message, meta || '');
  }
}
function mcpLogError(message: string, meta?: Record<string, any>) {
  if (logService) {
    logService.error('MCP', message, meta);
  } else {
    console.error('[MCP]', message, meta || '');
  }
}

// Bridge logger options that route through the controller's logService-aware mcpLog.
const bridgeLogOpts = { log: mcpLog, logError: mcpLogError };

/**
 * tools/list response cache. Tool registration is static per profile
 * (registerAllTools runs once per session via createMcpServerForContext, but
 * every session of the SAME profile registers the same set), so the
 * JSON-RPC result body is identical across sessions of that profile and
 * across time — only the request `id` varies. We cache the body produced by
 * the first call for each profile with a placeholder where the id sits and
 * substitute the real id for every subsequent call of that profile. Skips
 * the SDK's tool registry walk + zod-to-JSON-schema serialization on every
 * cached hit; for a 205-tool registry that's a ~250KB body otherwise
 * rebuilt per session.
 *
 * Keyed by ToolProfile (ticket ee26302d) — 'full' and 'compact' sessions
 * register different tool sets, so a single shared body would leak one
 * profile's response into the other's session (a compact session served
 * 'full' defeats the reduction; a full session served 'compact' silently
 * loses tools). Cache fill (captureToolsListBodyIfFirst) and cache read
 * (buildCachedToolsListResponse) MUST be called with the same profile key.
 */
const TOOLS_LIST_ID_PLACEHOLDER = '__AWB_TOOLS_LIST_ID__';
const cachedToolsListBodies = new Map<ToolProfile, string>();

function buildCachedToolsListResponse(profile: ToolProfile, reqId: unknown): string | null {
  const cached = cachedToolsListBodies.get(profile);
  if (!cached) return null;
  return cached.replace(
    `"${TOOLS_LIST_ID_PLACEHOLDER}"`,
    JSON.stringify(reqId ?? null),
  );
}

function captureToolsListBodyIfFirst(profile: ToolProfile, bodyStr: string): void {
  if (cachedToolsListBodies.has(profile)) return;
  // Body shape: {"jsonrpc":"2.0","id":<X>,"result":{"tools":[...]}}
  // Replace the id field with our placeholder string. Only replace the
  // first id occurrence to avoid clobbering an id nested in a tool's
  // schema (paranoid, but safe). normalizeJsonRpcBody puts id second
  // in the JSON output — the regex anchors to that location.
  const placeheld = bodyStr.replace(
    /"id":\s*(?:-?\d+|"[^"]*"|null)/,
    `"id":"${TOOLS_LIST_ID_PLACEHOLDER}"`,
  );
  // Sanity check: the placeholder must have landed and the body must look
  // like a tools/list result. If anything is off, skip caching — better
  // to re-run SDK than to serve a malformed response forever.
  if (!placeheld.includes(TOOLS_LIST_ID_PLACEHOLDER)) return;
  if (!placeheld.includes('"tools":')) return;
  cachedToolsListBodies.set(profile, placeheld);
}

@ApiTags('mcp')
@Controller()
export class McpController implements OnModuleInit {
  constructor(
    private readonly apiKeyService: ApiKeyService,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly _logService: LogService,
    private readonly agentConnectionService: AgentConnectionService,
    private readonly activityService: ActivityService,
    private readonly embeddingService: EmbeddingService,
    private readonly githubService: GitHubConnectorService,
    private readonly triggerLoopService: TriggerLoopService,
    private readonly mentionService: MentionService,
    private readonly agentStatusService: AgentStatusService,
    private readonly allocationService: AllocationService,
    private readonly roomCrudService: RoomCrudService,
    private readonly roomMembershipService: RoomMembershipService,
    private readonly roomMessagingService: RoomMessagingService,
    private readonly ticketRoleAssignmentService: TicketRoleAssignmentService,
    private readonly actionsService: ActionsService,
    private readonly qaService: QaService,
    private readonly qaRunService: QaRunService,
    private readonly buildArtifactService: BuildArtifactService,
    private readonly deploymentService: DeploymentService,
    private readonly qaScheduleService: QaScheduleService,
    private readonly securityProfileService: SecurityProfileService,
    private readonly securityRunService: SecurityRunService,
    private readonly securityScheduleService: SecurityScheduleService,
    private readonly workspaceScheduleService: WorkspaceScheduleService,
    private readonly featuresService: FeaturesService,
    private readonly ticketPrerequisitesService: TicketPrerequisitesService,
    private readonly ciWaitService: CiWaitService,
    private readonly handoffService: HandoffService,
    private readonly benchmarkService: BenchmarkService,
    private readonly workflowFunctionsService: WorkflowFunctionsService,
    private readonly artifactRefsService: ArtifactRefsService,
    private readonly classificationBridgeService: ClassificationBridgeService,
    private readonly orchestrationRunnerService: OrchestrationRunnerService,
    private readonly orchestrationMissionService: OrchestrationMissionService,
    private readonly orchestrationTeamService: OrchestrationTeamService,
    private readonly metricsRegistry: MemoryMetricsRegistry,
    private readonly agentManagerCommandService: AgentManagerCommandService,
  ) {}

  onModuleInit() {
    logService = this._logService;

    // Memory observability: expose the MCP session store's live size. Since
    // the leaking agentId→McpServer map and MCP execution-push path were
    // removed, so sessionStore is the single source of truth for tool sessions —
    // `mcp.sessions` is raw transport count, `mcp.connectedAgents` collapses
    // reconnect-overlap duplicates to distinct agents. A climbing
    // sessions-vs-agents gap under reconnect churn is exactly the #1-leak
    // signature this ticket exists to make visible.
    this.metricsRegistry.register('mcp.sessions', () => sessionStore.size);
    this.metricsRegistry.register('mcp.connectedAgents', () => sessionStore.distinctAgentCount());

    // Register eviction hook to mark agents offline when their session idles out.
    // (Normal close handles this via transport.onclose — this covers abnormal
    // disconnects that never fire onclose.)
    //
    // Guard against false offlines on reconnect: if another live session for
    // the same agent exists (typical when a client reconnects before the old
    // session's 10-min TTL expires), leave it alone. The AgentStatusService's
    // 90s heartbeat-gap sweep is the authoritative offline detector anyway;
    // this hook is just a fast-path for the common clean case.
    sessionStore.onEviction((_sid, entry) => {
      const agentId = entry.auth?.agentId;
      if (!agentId) return;
      if (sessionStore.hasAgentSession(agentId)) {
        // Still connected on another session — do nothing.
        return;
      }
      this.agentConnectionService.markOffline(agentId).catch((e) => {
        mcpLogError(`Failed to mark agent offline on idle eviction: ${e}`);
      });
    });

    // Start the unified idle-cleanup sweep (idempotent; no-op if already running).
    sessionStore.ensureCleanupStarted((removed, remaining) => {
      mcpLog(`Session cleanup: removed ${removed} idle sessions (active: ${remaining})`);
    });

    // Pull the configured `mcp.max_sessions` cap from system_settings so the
    // LRU evict ceiling matches the admin UI without a restart. Failures are
    // non-fatal — the store keeps DEFAULT_MAX_SESSIONS until the next PATCH
    // pushes a new value via SettingsController.
    this.loadMcpMaxSessions().catch((err) => {
      mcpLog(`Failed to load mcp.max_sessions from DB: ${err.message}`);
    });
  }

  private async loadMcpMaxSessions(): Promise<void> {
    const repo = this.dataSource.getRepository(SystemSetting);
    const row = await repo.findOne({ where: { key: 'mcp.max_sessions' } });
    if (!row || !row.value) return;
    const n = parseInt(row.value, 10);
    if (Number.isFinite(n) && n > 0) {
      sessionStore.setMaxSessions(n);
      mcpLog(`MCP session cap loaded from settings: ${n}`);
    }
  }

  private buildToolContext(): ToolContext {
    return {
      dataSource: this.dataSource,
      activityService: this.activityService,
      apiKeyService: this.apiKeyService,
      embeddingService: this.embeddingService,
      githubService: this.githubService,
      logger: this._logService,
      mentionService: this.mentionService,
      agentStatusService: this.agentStatusService,
      allocationService: this.allocationService,
      roomCrudService: this.roomCrudService,
      roomMembershipService: this.roomMembershipService,
      roomMessagingService: this.roomMessagingService,
      ticketRoleAssignmentService: this.ticketRoleAssignmentService,
      actionsService: this.actionsService,
      qaService: this.qaService,
      qaRunService: this.qaRunService,
      buildArtifactService: this.buildArtifactService,
      deploymentService: this.deploymentService,
      qaScheduleService: this.qaScheduleService,
      securityProfileService: this.securityProfileService,
      securityRunService: this.securityRunService,
      securityScheduleService: this.securityScheduleService,
      workspaceScheduleService: this.workspaceScheduleService,
      artifactRefsService: this.artifactRefsService,
      featuresService: this.featuresService,
      triggerLoopService: this.triggerLoopService,
      ticketPrerequisitesService: this.ticketPrerequisitesService,
      ciWaitService: this.ciWaitService,
      handoffService: this.handoffService,
      benchmarkService: this.benchmarkService,
      workflowFunctionsService: this.workflowFunctionsService,
      classificationBridgeService: this.classificationBridgeService,
      orchestrationRunnerService: this.orchestrationRunnerService,
      orchestrationMissionService: this.orchestrationMissionService,
      orchestrationTeamService: this.orchestrationTeamService,
      agentManagerCommandService: this.agentManagerCommandService,
    };
  }

  private createMcpServer(profile: ToolProfile = 'full'): McpServer {
    return createMcpServerForContext(this.buildToolContext(), profile);
  }

  @All('mcp')
  async handleMcp(@Req() req: Request, @Res() res: Response) {
    try {
      const mcpAuthInfo = await authenticateMcpRequest(req, res, this.apiKeyService, mcpLogError);
      if (!mcpAuthInfo) return; // Response already sent

      // Inject workspace_id from API key into request context for downstream use
      (req as any).currentWorkspaceId = mcpAuthInfo.workspaceId ?? null;

      // schemaVersion:2 validation for general MCP clients. Runtime children
      // receive a Host-authenticated, run-scoped MCP configuration and bypass
      // the AWB client-extension check because third-party runtimes do not
      // advertise AWB-specific initialize capabilities. Supported headers:
      //   - 'subagent'         : SubagentManager one-shots (Claude CLI native MCP)
      //   - 'managed-subagent' : BaseSessionManager persistent chat / ticket
      //                          sessions for managed agents (also Claude CLI
      //                          native MCP).
      //   - 'runtime-child'    : protocol runtimes such as Hermes ACP.
      if (req.method === 'POST' && req.body?.method === 'initialize') {
        const clientName = req.body?.params?.clientInfo?.name;
        const clientTypeHeader = String(req.headers['x-awb-client-type'] || '').toLowerCase();
        const schemaVerRaw = req.body?.params?.capabilities?.experimental?.['awb/schemaVersion'];
        // Accept both { version: 2 } (MCP-compliant object) and bare 2 (legacy)
        const schemaVer = typeof schemaVerRaw === 'object' && schemaVerRaw !== null
          ? schemaVerRaw.version
          : schemaVerRaw;
        const isInternalClient = clientName === 'awb-presence-heartbeat';
        const isRuntimeChild =
          clientTypeHeader === 'subagent'
          || clientTypeHeader === 'managed-subagent'
          || clientTypeHeader === 'runtime-child';
        if (schemaVer !== 2 && !isInternalClient && !isRuntimeChild) {
          return res.status(200).json({
            jsonrpc: '2.0',
            id: req.body.id ?? null,
            error: {
              code: -32000,
              message: 'MCP schemaVersion mismatch — use schemaVersion 2',
            },
          });
        }
      }

      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      mcpLog(`${req.method} /mcp`, {
        sessionId: sessionId || '(none)',
        contentType: req.headers['content-type'],
        accept: req.headers['accept'],
        bodyPreview: req.method === 'POST' ? JSON.stringify(req.body)?.slice(0, 300) : '(n/a)',
      });

      // DELETE: terminate session
      if (req.method === 'DELETE') {
        if (sessionId && sessionStore.has(sessionId)) {
          const session = sessionStore.get(sessionId)!;
          await session.transport.close();
          sessionStore.remove(sessionId);
          res.status(200).end();
        } else {
          res.status(404).json({ error: 'Session not found' });
        }
        return;
      }

      const webReq = expressToWebRequest(req);

      // Existing session
      if (sessionId && sessionStore.has(sessionId)) {
        const session = sessionStore.get(sessionId)!;
        sessionStore.touch(sessionId);
        const sessionToolProfile: ToolProfile = session.auth?.toolProfile === 'compact' ? 'compact' : 'full';

        // Cache hit: skip the SDK pipeline entirely for tools/list. The
        // result body is invariant across sessions OF THE SAME PROFILE, so
        // substituting the request id into the cached body yields a
        // byte-equivalent response without serializing 205 tool schemas
        // again. Keyed by this session's own profile — see
        // cachedToolsListBodies' doc comment for why that keying matters.
        if (req.method === 'POST' && req.body?.method === 'tools/list') {
          const cachedBody = buildCachedToolsListResponse(sessionToolProfile, req.body.id);
          if (cachedBody) {
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.setHeader('content-length', Buffer.byteLength(cachedBody));
            res.status(200).end(cachedBody);
            return;
          }
        }

        const isFirstToolsList =
          req.method === 'POST' && req.body?.method === 'tools/list'
          && !cachedToolsListBodies.has(sessionToolProfile);
        const webRes = await this.activityService.runWithTriggerSource(
          session.auth?.subagentTriggerSource,
          () => session.transport.handleRequest(webReq, { parsedBody: req.body }),
        );
        await sendWebResponse(webRes, res, {
          ...bridgeLogOpts,
          onJsonBody: isFirstToolsList
            ? (bodyStr: string) => captureToolsListBodyIfFirst(sessionToolProfile, bodyStr)
            : undefined,
        });
        return;
      }

      // Stale session ID — tell client to re-initialize (MCP Streamable HTTP spec)
      if (sessionId) {
        mcpLog(`Stale session rejected: ${sessionId}`);
        res.status(404).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Session not found. Please re-initialize.' },
          id: null,
        });
        return;
      }

      // Role + ticket context pinned per-spawn by the plugin subagent-manager.
      // Runtime Host writes one MCP config per (ticket, role) child and
      // injects these headers there, so every tool call from that child
      // process carries them. Stashing on the session lets add_comment and
      // friends attribute work to the correct role without each tool needing
      // a role argument.
      const subagentRoleHeader = String(req.headers['x-awb-subagent-role'] || '').toLowerCase().trim() || undefined;
      const subagentTicketIdHeader = String(req.headers['x-awb-subagent-ticket-id'] || '').trim() || undefined;
      const subagentTriggerSourceHeader = String(req.headers['x-awb-subagent-trigger-source'] || '').trim() || undefined;
      const subagentTriggerIdHeader = String(req.headers['x-awb-subagent-trigger-id'] || '').trim() || undefined;
      const subagentSessionIdHeader = String(req.headers['x-awb-subagent-session-id'] || '').trim() || undefined;
      const clientTypeRaw = String(req.headers['x-awb-client-type'] || '').toLowerCase().trim();
      const clientTypeHeader =
        clientTypeRaw === 'subagent'
        || clientTypeRaw === 'managed-subagent'
        || clientTypeRaw === 'runtime-child'
          ? clientTypeRaw
          : undefined;
      const runtimeRunIdHeader = String(req.headers['x-awb-run-id'] || '').trim().slice(0, 256) || undefined;
      const strategyRaw = String(req.headers['x-awb-execution-strategy'] || '').toLowerCase().trim();
      const executionStrategyHeader =
        strategyRaw === 'single' || strategyRaw === 'delegated' || strategyRaw === 'swarm'
          ? strategyRaw
          : undefined;
      // Ticket ee26302d: opt-in reduced tool surface. Any value other than
      // exactly 'compact' (including absent — every pre-existing client)
      // resolves to 'full', so this can only ever narrow the tool surface,
      // never widen it — see shared/tool-profiles.ts's security note.
      const toolProfileRaw = String(req.headers['x-awb-tool-profile'] || '').toLowerCase().trim();
      const toolProfile: ToolProfile = toolProfileRaw === 'compact' ? 'compact' : 'full';

      // New session (initialization request — no session ID)
      if (req.method === 'POST') {
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            // Register transport + auth context atomically in the unified store.
            sessionStore.register(id, transport, mcpServer, {
              agentId: mcpAuthInfo.agentId,
              agentName: mcpAuthInfo.agentName,
              workspaceId: mcpAuthInfo.workspaceId,
              scope: mcpAuthInfo.scope,
              source: mcpAuthInfo.source,
              subagentRole: subagentRoleHeader,
              subagentTicketId: subagentTicketIdHeader,
              subagentTriggerSource: subagentTriggerSourceHeader,
              subagentTriggerId: subagentTriggerIdHeader,
              subagentSessionId: subagentSessionIdHeader,
              clientType: clientTypeHeader,
              runtimeRunId: runtimeRunIdHeader,
              executionStrategy: executionStrategyHeader,
              toolProfile,
            });
            // No separate agentId → server map or execution-push lookup: the
            // McpServer is referenced only by this tool session's store entry.
            const who = mcpAuthInfo?.agentName || mcpAuthInfo?.keyHint || 'anonymous';
            mcpLog(`New session: ${id} by [${who}] toolProfile=${toolProfile}  (active: ${sessionStore.size})`);
          },
        });

        transport.onerror = (err) => {
          // SSE duplicate stream is a normal client behavior, not a real error
          if (err.message?.includes('Only one SSE')) {
            mcpLog(`SSE duplicate stream attempt (session: ${transport.sessionId})`);
          } else {
            mcpLogError(`Transport error: ${err.message}`);
          }
        };
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            sessionStore.remove(sid);
            mcpLog(`Session closed: ${sid}  (active: ${sessionStore.size})`);
          }
          // Mark the agent offline, BUT only if no other live session for this
          // agent remains (reconnect guard — see the eviction-hook comment
          // above). The McpServer needs no explicit cleanup here: removing the
          // session entry above drops the store's only reference to it, and the
          // SDK's transport close already severs the transport↔server link.
          if (mcpAuthInfo?.agentId && !sessionStore.hasAgentSession(mcpAuthInfo.agentId)) {
            this.agentConnectionService.markOffline(mcpAuthInfo.agentId).catch((e) => {
              mcpLogError(`Failed to mark agent offline: ${e}`);
            });
          }
        };

        const mcpServer = this.createMcpServer(toolProfile);
        await mcpServer.connect(transport);

        const webRes = await transport.handleRequest(webReq, { parsedBody: req.body });
        await sendWebResponse(webRes, res, bridgeLogOpts);
        return;
      }

      // GET without session
      if (req.method === 'GET') {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: No valid session. Send an initialize request first (POST).' },
          id: null,
        });
        return;
      }

      res.status(405).json({ error: 'Method not allowed' });
    } catch (err) {
      mcpLogError('Unhandled error in /mcp', { error: String(err) });
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  }
}
