/**
 * Ontology Graph MCP tools — wave 1 (ticket d35b7b7d, DESIGN.md 축 6).
 *
 * Tools: graph_status, graph_find_symbol, graph_module_summary,
 *        graph_neighbors, graph_blast_radius, graph_call_path
 *
 * All six are read-only, 'caller' authz tier (see tool-authz-gate.ts) —
 * any resolvable MCP identity may call them; the real scoping is the
 * explicit workspace_id/graph_id boundary check inside resolveGraph()
 * below, not the gate. Every tool accepts EITHER a previously-obtained
 * `graph_id` OR `(resource_id, folder_path)` — the latter resolves through
 * the SAME provisioning helper `graph_status` exposes explicitly, so no
 * tool ever presupposes a graph that doesn't exist yet (DESIGN.md 축 6,
 * REVIEW-NOTES.md A1).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, err } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import { callerCanAccessWorkspace } from '../shared/authz';
import { GraphRefResolutionError } from '../../ontology/ontology-lifecycle.service';
import type { OntologyGraph } from '../../../entities/OntologyGraph';
import type { OntologyNode } from '../../../entities/OntologyNode';
import { confidenceBucket } from '../../ontology/query/symbol-query';
import type { GraphCallPathStep } from '../../ontology/query/graph-query';
import type { ToolContext } from './context';

const UNAVAILABLE_MESSAGE =
  'Ontology graph tools are unavailable in standalone MCP server mode — use the NestJS-integrated server.';

const WORKSPACE_SCOPE_ERROR =
  'Unauthorized: the caller is not a member of this workspace_id — cross-workspace graph access is denied.';

// 리뷰 지적(critical, d35b7b7d 1차 반려) — TOOL_AUTHZ_TABLE의 'caller' tier는
// "세션리스가 아닌 어떤 caller든" 통과시킬 뿐, 그 caller가 요청한
// workspace_id에 실제로 속하는지는 전혀 검증하지 않는다(skill 문서의 (c)
// "게이트는 하한선"이 정확히 이 얘기). resolveOrProvision()도 graph row의
// workspace_id를 입력값 자기 자신과만 비교할 뿐(A1의 idempotent-provisioning
// 로직), caller의 진짜 workspace와는 무관하다 — 그래서 워크스페이스 A의
// 정상 caller가 워크스페이스 B의 resource_id/graph_id를 알기만 하면 B의
// 그래프를 조회하거나(graph_status라면) B 소유 리소스의 clone/추출까지
// 기동시킬 수 있었다. workflow-function-tools.ts의 scopeAllowed() 선례를
// 그대로 따른다 — 매 핸들러 진입에서 검증하고, 실패하면 어떤 DB 조회도
// 실행하기 전에 즉시 거부한다.
async function checkWorkspaceScope(ctx: ToolContext, extra: { sessionId?: string }, workspaceId: string): Promise<ReturnType<typeof err> | null> {
  const caller = getCallerAgent(extra);
  const allowed = await callerCanAccessWorkspace(ctx.dataSource, caller, workspaceId);
  return allowed ? null : err(WORKSPACE_SCOPE_ERROR);
}

const GRAPH_REF_PARAMS = {
  graph_id: z.string().optional().describe('graph_id obtained from a prior graph_status call. Alternative to resource_id/folder_path.'),
  resource_id: z.string().optional().describe('Repository Resource ID. Alternative to graph_id — resolves (and auto-provisions, same as graph_status) the graph for this (resource_id, folder_path).'),
  folder_path: z.string().optional().describe('Folder scope within the repo (empty/omitted = repo root). Only used together with resource_id.'),
};

function logGraphToolCall(ctx: ToolContext, extra: { sessionId?: string }, tool: string, meta: Record<string, unknown>): void {
  const caller = getCallerAgent(extra);
  // Done-when 텔레메트리(REVIEW-NOTES.md A4/A5/A6) — 에이전트별/티켓별
  // graph_ 툴 호출 빈도. subagentTicketId는 agent-manager가 세션 스폰 시
  // pin하는 값(session-store.ts McpAgentContext) — add_comment 등 다른
  // 툴이 role/ticket을 암묵적으로 attribute하는 것과 같은 메커니즘을
  // 재사용한다. 네이티브 Grep/Read/Bash 호출 빈도는 이 서버 프로세스에
  // 도달하지 않는 CLI 로컬 툴이라 여기서 관측 불가 — 비교 로깅은
  // agent-manager 쪽 세션 stream-json 관측 지점(별도 티켓 스코프)이 필요.
  ctx.logger.info('Ontology', 'graph tool call', {
    tool,
    agent_id: caller?.agentId ?? null,
    agent_name: caller?.agentName ?? null,
    ticket_id: caller?.subagentTicketId ?? null,
    ...meta,
  });
}

interface GraphRefArgs {
  workspace_id: string;
  graph_id?: string;
  resource_id?: string;
  folder_path?: string;
}

type ResolveGraphResult =
  | { ok: true; graph: OntologyGraph }
  | { ok: false; response: ReturnType<typeof err> };

async function resolveGraph(ctx: ToolContext, extra: { sessionId?: string }, args: GraphRefArgs): Promise<ResolveGraphResult> {
  if (!ctx.ontologyLifecycleService) return { ok: false, response: err(UNAVAILABLE_MESSAGE) };
  const scopeError = await checkWorkspaceScope(ctx, extra, args.workspace_id);
  if (scopeError) return { ok: false, response: scopeError };
  try {
    const graph = await ctx.ontologyLifecycleService.resolveOrProvision({
      workspaceId: args.workspace_id,
      graphId: args.graph_id,
      resourceId: args.resource_id,
      folderPath: args.folder_path,
    });
    return { ok: true, graph };
  } catch (e) {
    if (e instanceof GraphRefResolutionError) {
      return { ok: false, response: err(e.message, { code: e.code }) };
    }
    throw e;
  }
}

/** DESIGN.md 축 6 "mandatory-bound" 응답 계약 (1)(2) — path/start_line/
 *  end_line로 소스 검증 가능하게, {source, confidence, indexed_at, commit}
 *  + confidence_bucket으로 신뢰도를 절대 bare float으로 남기지 않게. */
function toSymbolRef(node: OntologyNode, graph: OntologyGraph) {
  return {
    id: node.id,
    symbol_id: node.symbol_id,
    name: node.name,
    qualified_name: node.qualified_name,
    type: node.type,
    kind: node.kind,
    layer: node.layer,
    path: node.path,
    start_line: node.start_line,
    end_line: node.end_line,
    confidence: node.confidence,
    confidence_bucket: confidenceBucket(node.confidence),
    source: 'ontology_graph',
    indexed_at: graph.indexed_at,
    commit: graph.commit,
  };
}

export function registerOntologyTools(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'graph_status',
    'Resolve (or auto-provision) the Ontology Graph for a (resource_id, folder_path) and report its build status. ' +
    'Callable by any authenticated agent — read-only, no ownership restriction. ' +
    'If this is the first time this repo+folder pair has ever been referenced, this call creates the OntologyGraph ' +
    'row and kicks off Tier 1 (tree-sitter extraction) + Tier 1.5 (cross-file resolver) as an async background job — ' +
    'the response returns immediately with status="building"; call again later to poll for "ready" (or "error"). ' +
    'This is the entry point every other graph_ tool\'s graph_id ultimately comes from: pass its graph_id to them, ' +
    'or just pass the same (resource_id, folder_path) and they resolve it the same way internally.',
    {
      workspace_id: z.string().describe('Workspace ID'),
      resource_id: z.string().describe('Repository Resource ID to build/inspect the graph for'),
      folder_path: z.string().optional().default('').describe('Folder scope within the repo (empty = repo root)'),
    },
    async ({ workspace_id, resource_id, folder_path }, extra) => {
      if (!ctx.ontologyLifecycleService) return err(UNAVAILABLE_MESSAGE);
      const scopeError = await checkWorkspaceScope(ctx, extra, workspace_id);
      if (scopeError) return scopeError;
      const graph = await ctx.ontologyLifecycleService.resolveOrProvision({
        workspaceId: workspace_id, resourceId: resource_id, folderPath: folder_path,
      });
      logGraphToolCall(ctx, extra, 'graph_status', { workspace_id, resource_id, folder_path, graph_id: graph.id, status: graph.status });
      return ok({
        graph_id: graph.id,
        status: graph.status,
        indexed_at: graph.indexed_at,
        commit: graph.commit,
        progress: JSON.parse(graph.progress || '{}'),
        error: graph.error || undefined,
      });
    },
  );

  server.tool(
    'graph_find_symbol',
    'Resolve a symbol by name inside an Ontology Graph — exact name, then exact qualified_name, then a bounded ' +
    'fuzzy substring match, each tier filtered by confidence_min (default 0.75). Read-only, any authenticated ' +
    'agent may call. On a unique match, the response includes suggested_next_calls pre-filled with this symbol\'s ' +
    'node_id for graph_neighbors/graph_blast_radius — the usual next step. Provide graph_id (from graph_status) ' +
    'or resource_id/folder_path (auto-provisions like graph_status if the graph does not exist yet).',
    {
      workspace_id: z.string().describe('Workspace ID'),
      ...GRAPH_REF_PARAMS,
      name: z.string().describe('Symbol name, qualified name, or a fragment to fuzzy-match'),
      confidence_min: z.number().min(0).max(1).optional().describe('Minimum edge/node confidence to include (default 0.75)'),
    },
    async ({ workspace_id, graph_id, resource_id, folder_path, name, confidence_min }, extra) => {
      const resolved = await resolveGraph(ctx, extra, { workspace_id, graph_id, resource_id, folder_path });
      if (!resolved.ok) return resolved.response;
      if (!ctx.ontologyQueryService) return err(UNAVAILABLE_MESSAGE);
      const { graph } = resolved;

      const result = await ctx.ontologyQueryService.findSymbol({ graphId: graph.id, name, confidenceMin: confidence_min });
      logGraphToolCall(ctx, extra, 'graph_find_symbol', { workspace_id, graph_id: graph.id, name, match_count: result.matches.length });

      const matches = result.matches.map((m) => ({ ...toSymbolRef(m.node, graph), match_kind: m.matchKind }));
      const response: Record<string, unknown> = { matches, unique: result.unique, confidence_min: result.confidenceMin };
      // 리뷰 지적(high, d35b7b7d 1차 반려) — "unique"만으로는 "고신뢰"를
      // 보장하지 못한다: 호출자가 confidence_min을 0으로 낮추면 confidence
      // 0.1짜리 단일 fuzzy match도 unique=true가 되어 suggested_next_calls를
      // 냈었다. DESIGN.md의 고정 ordinal bucket(asserted/likely/speculative,
      // speculative<0.6)을 caller가 넘긴 confidence_min과 무관하게 별도로
      // 적용 — "고신뢰"는 이 매치 하나가 unique할 뿐 아니라
      // speculative(<0.6)가 아닐 때만 성립한다.
      const isHighConfidence = result.unique && confidenceBucket(result.matches[0].node.confidence) !== 'speculative';
      if (isHighConfidence) {
        const nodeId = result.matches[0].node.id;
        response.detail = matches[0];
        response.suggested_next_calls = [
          { tool: 'graph_neighbors', args: { workspace_id, graph_id: graph.id, node_id: nodeId } },
          { tool: 'graph_blast_radius', args: { workspace_id, graph_id: graph.id, node_id: nodeId } },
        ];
      }
      return ok(response);
    },
  );

  server.tool(
    'graph_module_summary',
    'Compact, aggregated summary of one directory/module/file in an Ontology Graph: top symbols by centrality ' +
    '(pagerank, then degree), plus aggregated (never per-edge) dependency/dependent counts. Mirrors the ' +
    'get_board_summary convention. Read-only, any authenticated agent may call. Provide graph_id or ' +
    'resource_id/folder_path (auto-provisions if needed, same as graph_status).',
    {
      workspace_id: z.string().describe('Workspace ID'),
      ...GRAPH_REF_PARAMS,
      path: z.string().describe('Directory/module/file path to summarize, relative to repo root (empty string = whole repo)'),
      confidence_min: z.number().min(0).max(1).optional().describe('Minimum edge confidence for dependency/dependent aggregation (default 0.75)'),
      top_n: z.number().optional().describe('Max top symbols to return by centrality (default 20, max 50)'),
    },
    async ({ workspace_id, graph_id, resource_id, folder_path, path, confidence_min, top_n }, extra) => {
      const resolved = await resolveGraph(ctx, extra, { workspace_id, graph_id, resource_id, folder_path });
      if (!resolved.ok) return resolved.response;
      if (!ctx.ontologyQueryService) return err(UNAVAILABLE_MESSAGE);
      const { graph } = resolved;

      const result = await ctx.ontologyQueryService.moduleSummary({ graphId: graph.id, path, confidenceMin: confidence_min, topN: top_n });
      logGraphToolCall(ctx, extra, 'graph_module_summary', { workspace_id, graph_id: graph.id, path, symbol_count: result.symbolCount });

      return ok({
        path: result.path,
        symbol_count: result.symbolCount,
        top_symbols: result.topSymbols.map((n) => toSymbolRef(n, graph)),
        dependency_count: result.dependencyCount,
        dependent_count: result.dependentCount,
        confidence_min: result.confidenceMin,
        indexed_at: graph.indexed_at,
        commit: graph.commit,
      });
    },
  );

  server.tool(
    'graph_neighbors',
    'Bounded forward reachability from a node in an Ontology Graph (src->dst, depth-capped, confidence-floored). ' +
    'Read-only, any authenticated agent may call. Returns completeness ("complete"/"incomplete"/"no_assertion") so ' +
    'a zero-result response is distinguishable from a zero-result response with known-incomplete coverage (e.g. a ' +
    'target only reachable via reflection/DI edges below the default confidence floor). Provide graph_id or ' +
    'resource_id/folder_path.',
    {
      workspace_id: z.string().describe('Workspace ID'),
      ...GRAPH_REF_PARAMS,
      node_id: z.string().describe('OntologyNode id to start from (e.g. from graph_find_symbol)'),
      edge_types: z.array(z.string()).optional().describe('Restrict traversal to these edge types (e.g. ["CALLS"])'),
      max_depth: z.number().optional().describe('Max hops (default 4, hard ceiling 6)'),
      confidence_min: z.number().min(0).max(1).optional().describe('Minimum edge confidence to traverse (default 0.75)'),
      row_cap: z.number().optional().describe('Max rows returned (default 1000, hard ceiling 5000)'),
    },
    async ({ workspace_id, graph_id, resource_id, folder_path, node_id, edge_types, max_depth, confidence_min, row_cap }, extra) => {
      const resolved = await resolveGraph(ctx, extra, { workspace_id, graph_id, resource_id, folder_path });
      if (!resolved.ok) return resolved.response;
      if (!ctx.ontologyQueryService) return err(UNAVAILABLE_MESSAGE);
      const { graph } = resolved;

      const result = await ctx.ontologyQueryService.neighbors({
        graphId: graph.id, nodeId: node_id, edgeTypes: edge_types, maxDepth: max_depth, confidenceMin: confidence_min, rowCap: row_cap,
      });
      logGraphToolCall(ctx, extra, 'graph_neighbors', { workspace_id, graph_id: graph.id, node_id, result_count: result.rows.length });

      return ok({
        matches: result.rows.map((r) => ({ ...toSymbolRef(r.node, graph), depth: r.depth })),
        truncated: result.truncated,
        completeness: result.completeness,
        max_depth: result.maxDepth,
        confidence_min: result.confidenceMin,
        duration_ms: result.durationMs,
      });
    },
  );

  server.tool(
    'graph_blast_radius',
    'Bounded reverse reachability from a node in an Ontology Graph ("what depends on this", dst->src, depth-capped, ' +
    'confidence-floored). Read-only, any authenticated agent may call. Returns completeness ' +
    '("complete"/"incomplete"/"no_assertion") — see graph_neighbors for what that distinguishes. Provide graph_id ' +
    'or resource_id/folder_path.',
    {
      workspace_id: z.string().describe('Workspace ID'),
      ...GRAPH_REF_PARAMS,
      node_id: z.string().describe('OntologyNode id to start from (e.g. from graph_find_symbol)'),
      edge_types: z.array(z.string()).optional().describe('Restrict traversal to these edge types (e.g. ["CALLS"])'),
      max_depth: z.number().optional().describe('Max hops (default 4, hard ceiling 6)'),
      confidence_min: z.number().min(0).max(1).optional().describe('Minimum edge confidence to traverse (default 0.75)'),
      row_cap: z.number().optional().describe('Max rows returned (default 1000, hard ceiling 5000)'),
    },
    async ({ workspace_id, graph_id, resource_id, folder_path, node_id, edge_types, max_depth, confidence_min, row_cap }, extra) => {
      const resolved = await resolveGraph(ctx, extra, { workspace_id, graph_id, resource_id, folder_path });
      if (!resolved.ok) return resolved.response;
      if (!ctx.ontologyQueryService) return err(UNAVAILABLE_MESSAGE);
      const { graph } = resolved;

      const result = await ctx.ontologyQueryService.blastRadius({
        graphId: graph.id, nodeId: node_id, edgeTypes: edge_types, maxDepth: max_depth, confidenceMin: confidence_min, rowCap: row_cap,
      });
      logGraphToolCall(ctx, extra, 'graph_blast_radius', { workspace_id, graph_id: graph.id, node_id, result_count: result.rows.length });

      return ok({
        matches: result.rows.map((r) => ({ ...toSymbolRef(r.node, graph), depth: r.depth })),
        truncated: result.truncated,
        completeness: result.completeness,
        max_depth: result.maxDepth,
        confidence_min: result.confidenceMin,
        duration_ms: result.durationMs,
      });
    },
  );

  server.tool(
    'graph_call_path',
    'Shortest confidence-floored path between two nodes in an Ontology Graph, via application-orchestrated ' +
    'bidirectional BFS (never a single unbounded recursive CTE). Read-only, any authenticated agent may call. ' +
    'Returns a single labelled path_confidence (min-along-path — never multiplied) instead of per-edge confidence ' +
    'an agent would have to roll up itself. Provide graph_id or resource_id/folder_path.',
    {
      workspace_id: z.string().describe('Workspace ID'),
      ...GRAPH_REF_PARAMS,
      from_id: z.string().describe('OntologyNode id to start from'),
      to_id: z.string().describe('OntologyNode id to reach'),
      edge_types: z.array(z.string()).optional().describe('Restrict traversal to these edge types (e.g. ["CALLS"])'),
      confidence_min: z.number().min(0).max(1).optional().describe('Minimum edge confidence to traverse (default 0.75)'),
      max_hops: z.number().optional().describe('Max total path length (default/hard ceiling 10)'),
    },
    async ({ workspace_id, graph_id, resource_id, folder_path, from_id, to_id, edge_types, confidence_min, max_hops }, extra) => {
      const resolved = await resolveGraph(ctx, extra, { workspace_id, graph_id, resource_id, folder_path });
      if (!resolved.ok) return resolved.response;
      if (!ctx.ontologyQueryService) return err(UNAVAILABLE_MESSAGE);
      const { graph } = resolved;

      const result = await ctx.ontologyQueryService.callPath({
        graphId: graph.id, fromId: from_id, toId: to_id, edgeTypes: edge_types, confidenceMin: confidence_min, maxHops: max_hops,
      });
      logGraphToolCall(ctx, extra, 'graph_call_path', { workspace_id, graph_id: graph.id, from_id, to_id, found: result.found });

      // path:line 그라운딩(DESIGN.md 축 6 mandatory-bound (1)) — path steps는
      // edge 양끝 id만 갖고 있으므로, 관련된 모든 노드를 한 번에 하이드레이트한다.
      const nodeIds = new Set<string>();
      for (const step of result.path) { nodeIds.add(step.srcId); nodeIds.add(step.dstId); }
      const nodesById = nodeIds.size > 0 ? await ctx.ontologyQueryService.hydrateNodesById(graph.id, [...nodeIds]) : new Map();
      const toStepRef = (step: GraphCallPathStep) => ({
        edge_id: step.edgeId,
        type: step.type,
        confidence: step.confidence,
        confidence_bucket: confidenceBucket(step.confidence),
        src: nodesById.has(step.srcId) ? toSymbolRef(nodesById.get(step.srcId)!, graph) : { id: step.srcId },
        dst: nodesById.has(step.dstId) ? toSymbolRef(nodesById.get(step.dstId)!, graph) : { id: step.dstId },
      });

      return ok({
        found: result.found,
        path: result.path.map(toStepRef),
        path_confidence: result.pathConfidence,
        hops: result.hops,
        nodes_visited: result.nodesVisited,
        truncated: result.truncated,
        confidence_min: result.confidenceMin,
        duration_ms: result.durationMs,
      });
    },
  );
}
