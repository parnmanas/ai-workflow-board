/**
 * REST surface for the Ontology Graph UI shell (ticket d22b83b4, DESIGN.md
 * 축 5). 브라우저는 MCP 세션이 없어 `graph_status` MCP 툴(ontology-tools.ts,
 * ticket d35b7b7d)을 직접 부를 수 없다 — 이 컨트롤러는 같은 provisioning
 * helper(`OntologyLifecycleService.resolveOrProvision`)를 그대로 호출하는
 * 얇은 래퍼일 뿐, 별도 인가/생명주기 로직을 두지 않는다(OntologyModule에는
 * 지금까지 컨트롤러가 없었다 — ontology.module.ts 코멘트 참고).
 *
 * 권한: resources.controller.ts의 git-read 엔드포인트(_prepRepo 등)와 같은
 * 자세로 PermissionGuard + MANAGE_RESOURCES를 쓴다 — 둘 다 결국 같은 종류의
 * 작업(리포지토리 clone/read, 여기서는 그 위에 신선도 계산까지)이라 같은
 * 게이트를 재사용한다. `Sidebar.tsx`의 Knowledge 항목 자체는 다른 항목들과
 * 마찬가지로 라우트 레벨 가드가 없다 — 실제 접근 제어는 이 컨트롤러가 진다
 * (Resources/Prompt Templates가 이미 이 자세다).
 */
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Body, Controller, Get, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DataSource } from 'typeorm';
import { Resource } from '../../entities/Resource';
import { Credential } from '../../entities/Credential';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { findOrFail } from '../../common/find-or-fail';
import { resolveGitCredential } from '../mcp/shared/git-branches';
import { ensureRepoCache, countBehindAhead } from '../mcp/shared/git-repo-cache';
import { OntologyLifecycleService, GraphRefResolutionError } from './ontology-lifecycle.service';
import { LogService } from '../../services/log.service';
import { AppOntologyDataSource } from '../../db';
import { OntologyNode } from '../../entities/OntologyNode';
import { OntologyEdge } from '../../entities/OntologyEdge';

const GRAPH_NODE_LIMIT = 5_000;
const GRAPH_EDGE_LIMIT = 10_000;

@ApiBearerAuth('user-session')
@ApiTags('ontology')
@Controller('api/ontology')
@UseGuards(PermissionGuard)
@RequirePermission(PERMISSIONS.MANAGE_RESOURCES)
export class OntologyController {
  constructor(
    @InjectRepository(Resource) private readonly resourceRepo: Repository<Resource>,
    @InjectRepository(Credential) private readonly credentialRepo: Repository<Credential>,
    private readonly lifecycleService: OntologyLifecycleService,
    private readonly logService: LogService,
    private readonly dataSource: DataSource,
  ) {}

  private get ontologyDataSource(): DataSource {
    return AppOntologyDataSource ?? this.dataSource;
  }

  /** 그래프가 참조하는 Resource의 캐시 클론 경로 — 프레시니스(behind/ahead)
   *  계산 전용, resources.controller.ts._prepRepo와 같은 검증. 이 호출의
   *  실패는 호출부에서 항상 `freshness_error`로만 흡수한다(그래프 자체의
   *  status/indexed_at/commit은 DB에만 의존하므로 git 접근 실패가 전체
   *  응답을 깨서는 안 된다). */
  private async resolveRepoPath(resourceId: string, workspaceId: string): Promise<string> {
    const resource = await findOrFail(
      this.resourceRepo,
      { where: { id: resourceId } },
      'Resource not found in workspace',
    );
    if (resource.workspace_id !== null && resource.workspace_id !== workspaceId) {
      throw new Error('Resource not found in workspace');
    }
    if (resource.type !== 'repository') {
      throw new Error(`resource type must be 'repository' (got '${resource.type}')`);
    }
    if (!resource.url) {
      throw new Error("resource has no URL — set the repository's URL before checking freshness");
    }
    const credential = await resolveGitCredential(this.credentialRepo, resource.credential_id, workspaceId);
    return ensureRepoCache({ resourceId, url: resource.url, credential });
  }

  // graph_status MCP 툴과 동일한 계약(graph_id 또는 resource_id[+folder_path])
  // + 이 UI 전용 필드(dirty_ratio/behind/ahead) 추가. 최초 (resource_id,
  // folder_path) 참조라면 resolveOrProvision이 그 자리에서 OntologyGraph
  // 행을 만들고 빌드를 킥오프한다 — "Build Graph"/"Refresh Graph" 액션도
  // 이 동일한 엔드포인트를 다시 부르는 것뿐이다(DESIGN.md 축 5: "같은
  // provisioning helper가 Build/Refresh 둘 다를 지원한다").
  @Get('status')
  async status(
    @Query('workspace_id') workspaceId: string,
    @Query('graph_id') graphId: string | undefined,
    @Query('resource_id') resourceId: string | undefined,
    @Query('folder_path') folderPath: string | undefined,
    @Res() res: Response,
  ) {
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id query parameter is required' });
    if (!graphId && !resourceId) {
      return res.status(400).json({ error: 'graph_id or resource_id is required' });
    }

    let graph;
    try {
      graph = await this.lifecycleService.resolveOrProvision({ workspaceId, graphId, resourceId, folderPath });
    } catch (e: any) {
      if (e instanceof GraphRefResolutionError) {
        return res.status(e.code === 'not_found' ? 404 : 400).json({ error: e.message, code: e.code });
      }
      throw e;
    }

    const dirtyRatio = await this.lifecycleService.computeDirtyRatio(graph.id);

    let behind: number | null = null;
    let ahead: number | null = null;
    let freshnessError: string | null = null;
    if (graph.commit) {
      try {
        const repoPath = await this.resolveRepoPath(graph.resource_id, workspaceId);
        // countBehindAhead(repoPath, baseRef, headRef)의 behind/ahead는
        // "baseRef 쪽에만 있는 커밋 수 / headRef 쪽에만 있는 커밋 수"다
        // (merge-gate.ts의 base-vs-feature 자세와 동일). 여기서 baseRef는
        // 현재 HEAD, headRef는 인덱싱 시점 커밋으로 넣는다 — 그래야
        // behind가 "그래프가 HEAD보다 몇 커밋 뒤처졌는가"라는 자연스러운
        // 프레시니스 의미가 된다. ahead는 정상적으로는 0이어야 하고, 0이
        // 아니면 인덱싱된 커밋이 이 브랜치의 조상이 아니라는(리베이스/
        // force-push로 역사가 바뀌었다는) 신호다.
        const result = await countBehindAhead(repoPath, 'HEAD', graph.commit);
        behind = result.behind;
        ahead = result.ahead;
      } catch (e: any) {
        freshnessError = String(e?.message || e);
      }
    }

    return res.json({
      graph_id: graph.id,
      status: graph.status,
      indexed_at: graph.indexed_at,
      commit: graph.commit,
      progress: JSON.parse(graph.progress || '{}'),
      error: graph.error || undefined,
      dirty_ratio: dirtyRatio,
      behind,
      ahead,
      freshness_error: freshnessError,
    });
  }

  // "Refresh Graph" 액션의 실제 재빌드 트리거(리뷰 지적, 승인 블로커) —
  // GET /status는 조회(+최초 참조 시 프로비저닝)일 뿐 기존 그래프를
  // 재빌드하지 않는다(OntologyLifecycleService.forceRebuild 코멘트 참고).
  // 조회(GET)와 명령(POST)을 분리 — actions.service.ts류의 커맨드
  // 엔드포인트와 같은 자세.
  @Post('refresh')
  async refresh(@Body() body: any, @Res() res: Response) {
    const workspaceId = body?.workspace_id;
    const graphId = body?.graph_id;
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id is required' });
    if (!graphId) return res.status(400).json({ error: 'graph_id is required' });
    try {
      const { graph, started } = await this.lifecycleService.forceRebuild({ graphId, workspaceId });
      return res.json({ graph_id: graph.id, status: graph.status, started });
    } catch (e: any) {
      if (e instanceof GraphRefResolutionError) {
        return res.status(e.code === 'not_found' ? 404 : 400).json({ error: e.message, code: e.code });
      }
      throw e;
    }
  }

  /** 브라우저 렌더링 전용 유계 스냅샷. 중심성이 높은 노드를 먼저 고르고,
   * 선택된 노드 사이의 활성 엣지만 반환해 대형 저장소에서도 응답 크기와
   * Graphology 메모리 사용량이 예측 가능하게 유지된다. */
  @Get('graph')
  async graph(
    @Query('workspace_id') workspaceId: string,
    @Query('graph_id') graphId: string,
    @Res() res: Response,
  ) {
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id query parameter is required' });
    if (!graphId) return res.status(400).json({ error: 'graph_id query parameter is required' });

    let graph;
    try {
      graph = await this.lifecycleService.resolveOrProvision({ workspaceId, graphId });
    } catch (e: any) {
      if (e instanceof GraphRefResolutionError) {
        return res.status(e.code === 'not_found' ? 404 : 400).json({ error: e.message, code: e.code });
      }
      throw e;
    }
    if (graph.status !== 'ready' && graph.status !== 'stale') {
      return res.status(409).json({ error: 'graph is not ready', status: graph.status });
    }

    const ds = this.ontologyDataSource;
    const nodeRepo = ds.getRepository(OntologyNode);
    const edgeRepo = ds.getRepository(OntologyEdge);
    const [totalNodes, totalEdges, nodes] = await Promise.all([
      nodeRepo.count({ where: { graph_id: graph.id, status: 'active' } }),
      edgeRepo.count({ where: { graph_id: graph.id, status: 'active' } }),
      nodeRepo.find({
        where: { graph_id: graph.id, status: 'active' },
        order: { pagerank: 'DESC', degree: 'DESC', id: 'ASC' },
        take: GRAPH_NODE_LIMIT,
        select: ['id', 'type', 'kind', 'name', 'qualified_name', 'path', 'start_line', 'end_line', 'layer', 'degree', 'pagerank'],
      }),
    ]);
    const selected = new Set(nodes.map((node) => node.id));
    const edges = selected.size === 0
      ? []
      : (await edgeRepo.find({
          where: { graph_id: graph.id, status: 'active' },
          order: { confidence: 'DESC', id: 'ASC' },
          take: GRAPH_EDGE_LIMIT * 3,
          select: ['id', 'src_id', 'dst_id', 'type', 'layer', 'confidence'],
        })).filter((edge) => selected.has(edge.src_id) && selected.has(edge.dst_id)).slice(0, GRAPH_EDGE_LIMIT);

    return res.json({
      graph_id: graph.id,
      nodes,
      edges,
      total_nodes: totalNodes,
      total_edges: totalEdges,
      truncated: totalNodes > nodes.length || totalEdges > edges.length,
      limits: { nodes: GRAPH_NODE_LIMIT, edges: GRAPH_EDGE_LIMIT },
    });
  }

  // 휴먼 그래프뷰 재방문 텔레메트리(Done-when, ticket d22b83b4) —
  // ontology-tools.ts의 logGraphToolCall과 같은 메커니즘(LogService,
  // 'Ontology' 카테고리)을 재사용한다. status 폴링마다가 아니라 페이지가
  // 실제로 마운트될 때 클라이언트가 1회만 호출 — 그래야 "재방문 횟수"가
  // 폴링 빈도가 아니라 실제 사람의 방문 횟수를 반영한다.
  @Post('view-opened')
  async viewOpened(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    const workspaceId = body?.workspace_id;
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id is required' });
    const user = (req as any).currentUser;
    this.logService.info('Ontology', 'graph view opened', {
      workspace_id: workspaceId,
      resource_id: body?.resource_id || null,
      folder_path: typeof body?.folder_path === 'string' ? body.folder_path : '',
      user_id: user?.id || null,
    });
    return res.json({ ok: true });
  }
}
