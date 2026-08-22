// Graph lifecycle 진입점(ticket d35b7b7d, DESIGN.md 축 6 "Graph lifecycle &
// discovery" / REVIEW-NOTES.md A1). graph_status MCP 툴과, (resource_id,
// folder_path)로 호출된 나머지 5개 그래프 툴이 공유하는 단일 provisioning
// helper — 어느 쪽으로 들어와도 최초 참조는 항상 이 서비스를 거쳐 같은
// OntologyGraph 행을 원자적으로 선점하고 같은 빌드 파이프라인을 킥오프한다
// (A1이 지적한 "agent가 graph_id를 얻을 방법이 없어 막히는" 상황을
// 원천 차단).
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, In } from 'typeorm';
import { AppOntologyDataSource } from '../../db';
import { OntologyGraph } from '../../entities/OntologyGraph';
import { OntologyEdge } from '../../entities/OntologyEdge';
import { LogService } from '../../services/log.service';
import { OntologyExtractionService } from './ontology-extraction.service';
import { OntologyResolverService } from './ontology-resolver.service';

// outreach-ingest.service.ts의 isUniqueConstraintError()와 동일한 패턴(board
// lesson: 외부 입력 idempotency는 부수효과 전에 DB 유니크 제약으로 선점) —
// (workspace_id, resource_id, folder_path) 유니크 인덱스가 동시 최초-참조
// 호출 중 정확히 하나만 승자가 되게 강제한다.
function isUniqueConstraintError(error: unknown): boolean {
  const value = error as {
    code?: string;
    errno?: number;
    message?: string;
    driverError?: { code?: string; errno?: number; message?: string };
  } | null;
  const driverError = value?.driverError;
  const code = driverError?.code ?? value?.code;
  const errno = driverError?.errno ?? value?.errno;
  const message = driverError?.message ?? value?.message ?? '';
  return code === '23505'
    || code === 'SQLITE_CONSTRAINT_UNIQUE'
    || code === 'ER_DUP_ENTRY'
    || errno === 1062
    || /unique constraint failed/i.test(message);
}

export type GraphRefResolutionErrorCode = 'missing_ref' | 'not_found';

export class GraphRefResolutionError extends Error {
  constructor(message: string, public readonly code: GraphRefResolutionErrorCode) {
    super(message);
  }
}

export interface GraphRefInput {
  workspaceId: string;
  graphId?: string;
  resourceId?: string;
  folderPath?: string;
}

@Injectable()
export class OntologyLifecycleService {
  constructor(
    @InjectDataSource() private readonly nestDataSource: DataSource,
    private readonly extractionService: OntologyExtractionService,
    private readonly resolverService: OntologyResolverService,
    private readonly logService: LogService,
  ) {}

  /** 온톨로지 엔티티가 실제로 synchronize된 DataSource — 다른 온톨로지
   *  서비스와 동일한 자세(축 3). */
  private resolveOntologyDataSource(): DataSource {
    return AppOntologyDataSource ?? this.nestDataSource;
  }

  /**
   * (workspace_id, resource_id, folder_path) 당 정확히 하나의 OntologyGraph
   * 행을 보장한다. 먼저 조회하고, 없으면 INSERT를 시도한다 — 동시 호출이
   * 경쟁하면 유니크 인덱스가 패자의 INSERT를 거부하므로, 패자는 승자가
   * 만든 행을 그대로 재조회해서 돌려준다(둘 다 같은 graph_id를 본다).
   * `created=true`인 호출자만 최초 빌드를 킥오프해야 한다.
   */
  async getOrCreateGraph(input: { workspaceId: string; resourceId: string; folderPath: string }): Promise<{ graph: OntologyGraph; created: boolean }> {
    const repo = this.resolveOntologyDataSource().getRepository(OntologyGraph);
    const where = { workspace_id: input.workspaceId, resource_id: input.resourceId, folder_path: input.folderPath };
    const existing = await repo.findOne({ where });
    if (existing) return { graph: existing, created: false };

    try {
      const created = await repo.save(repo.create({ ...where, status: 'building' }));
      return { graph: created, created: true };
    } catch (e) {
      if (!isUniqueConstraintError(e)) throw e;
      const winner = await repo.findOne({ where });
      if (!winner) throw e; // 유니크 위반이었다면 승자 행이 반드시 존재해야 함 — 도달 시 상위 재시도가 낫다
      return { graph: winner, created: false };
    }
  }

  /**
   * graph_status와, (resource_id, folder_path)로 호출된 나머지 5개 그래프
   * 툴이 공유하는 단일 해소 지점. graph_id가 주어지면 그 행을 workspace
   * 경계까지 확인해 반환한다(다른 워크스페이스 소유 그래프는 not_found로
   * 취급 — 존재 여부를 흘리지 않는다). graph_id가 없으면 resource_id(+
   * folder_path)로 찾거나-없으면-만든다 — 새로 만들어졌으면 최초 빌드를
   * fire-and-forget으로 킥오프한다(DESIGN.md A1: 이 경로 덕분에 어떤
   * 그래프 툴로 들어와도 최초 참조가 항상 프로비저닝을 트리거한다).
   */
  async resolveOrProvision(input: GraphRefInput): Promise<OntologyGraph> {
    const repo = this.resolveOntologyDataSource().getRepository(OntologyGraph);
    if (input.graphId) {
      const graph = await repo.findOne({ where: { id: input.graphId } });
      if (!graph || graph.workspace_id !== input.workspaceId) {
        throw new GraphRefResolutionError('Ontology graph not found in this workspace', 'not_found');
      }
      return graph;
    }
    if (!input.resourceId) {
      throw new GraphRefResolutionError('Provide graph_id, or resource_id (optionally with folder_path)', 'missing_ref');
    }
    const { graph, created } = await this.getOrCreateGraph({
      workspaceId: input.workspaceId,
      resourceId: input.resourceId,
      folderPath: input.folderPath ?? '',
    });
    if (created) this.kickOffInitialBuild(graph);
    return graph;
  }

  /**
   * fire-and-forget 래퍼 — 호출자는 완료를 기다리지 않는다(진행은
   * graph_status 재조회로 관찰). incremental-scheduler.service.ts의
   * scheduleFileChange/runFileChange와 같은 자세: 실제 빌드 로직
   * (runInitialBuild)은 별도 공개 메서드라, 테스트는 fire-and-forget을
   * 기다리지 않고 그 메서드를 직접 호출해 검증할 수 있다.
   */
  kickOffInitialBuild(graph: OntologyGraph): void {
    this.runInitialBuild(graph).catch((e: unknown) => {
      this.logService.error('Ontology', 'initial graph build failed', { graphId: graph.id, err: String(e) });
    });
  }

  /**
   * Tier 1(extractRepo) → Tier 1.5(resolveGraph, 전체 그래프 스코프 —
   * scopeFilePaths를 넘기지 않는다) 전체 파이프라인을 실행하고
   * OntologyGraph 행을 ready/error로 갱신한다. kickOffInitialBuild()가
   * 실제로 호출하는 실제 구현이지 테스트 전용 분기가 아니다 —
   * runFileChange와 같은 자세로 공개돼 있어 E2E 테스트가 직접 await할 수
   * 있다.
   */
  async runInitialBuild(graph: OntologyGraph): Promise<void> {
    const repo = this.resolveOntologyDataSource().getRepository(OntologyGraph);
    try {
      const extractResult = await this.extractionService.extractRepo({
        workspaceId: graph.workspace_id,
        resourceId: graph.resource_id,
        folderPath: graph.folder_path,
        graphId: graph.id,
      });
      const resolveResult = await this.resolverService.resolveGraph({
        graphId: graph.id,
        workspaceId: graph.workspace_id,
        commit: extractResult.commit,
        extractionRunId: randomUUID(),
      });
      await repo.update({ id: graph.id }, {
        status: 'ready',
        indexed_at: new Date(),
        commit: extractResult.commit,
        progress: JSON.stringify({
          files_discovered: extractResult.filesDiscovered,
          files_failed_extraction: extractResult.filesFailedExtraction,
          nodes_inserted: extractResult.nodesInserted,
          edges_inserted: extractResult.edgesInserted + resolveResult.edgesInserted,
        }),
        error: '',
      });
    } catch (e) {
      await repo.update({ id: graph.id }, {
        status: 'error',
        error: String((e as Error)?.message || e).slice(0, 500),
      });
      throw e;
    }
  }

  /**
   * research-ontology.md §8.6 point 6의 dirty_ratio — 이 그래프의 활성
   * (active+stale) 엣지 중 status='stale'(phase-c.ts의 soft-edge
   * invalidation) 비율. 엣지가 아직 하나도 없으면(building 등) null —
   * "0% dirty"와 "아직 측정 불가"를 구분한다. 인간 프레시니스 배지
   * (ticket d22b83b4)가 소비. incremental-scheduler.service.ts가 아직
   * 어떤 실 트리거(파일 저장 웹훅 등)에도 배선돼 있지 않아(그 파일 헤더
   * 코멘트 참고) 오늘은 항상 0에 가깝게 나오지만, 이미 스키마에 있는
   * OntologyEdge.status 값을 그대로 집계할 뿐이라 스케줄러가 배선되는
   * 순간 자동으로 의미 있어진다.
   */
  async computeDirtyRatio(graphId: string): Promise<number | null> {
    const repo = this.resolveOntologyDataSource().getRepository(OntologyEdge);
    const total = await repo.count({ where: { graph_id: graphId, status: In(['active', 'stale']) } });
    if (total === 0) return null;
    const stale = await repo.count({ where: { graph_id: graphId, status: 'stale' } });
    return stale / total;
  }
}
