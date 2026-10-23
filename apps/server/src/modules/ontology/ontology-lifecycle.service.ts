// Graph lifecycle 진입점(ticket d35b7b7d, DESIGN.md 축 6 "Graph lifecycle &
// discovery" / REVIEW-NOTES.md A1). graph_status MCP 툴과, (resource_id,
// folder_path)로 호출된 나머지 5개 그래프 툴이 공유하는 단일 provisioning
// helper — 어느 쪽으로 들어와도 최초 참조는 항상 이 서비스를 거쳐 같은
// OntologyGraph 행을 원자적으로 선점하고 같은 빌드 파이프라인을 킥오프한다
// (A1이 지적한 "agent가 graph_id를 얻을 방법이 없어 막히는" 상황을
// 원천 차단).
import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, In } from 'typeorm';
import { AppOntologyDataSource } from '../../db';
import { OntologyGraph } from '../../entities/OntologyGraph';
import { OntologyNode } from '../../entities/OntologyNode';
import { OntologyEdge } from '../../entities/OntologyEdge';
import { OntologyReverseEdgeIndex } from '../../entities/OntologyReverseEdgeIndex';
import { deleteChunked, NODE_CHUNK_SIZE, EDGE_CHUNK_SIZE } from './persist';
import { LogService } from '../../services/log.service';
import { OntologyExtractionService } from './ontology-extraction.service';
import { OntologyResolverService } from './ontology-resolver.service';

// outreach-ingest.service.ts의 isUniqueConstraintError()와 동일한 패턴(운영
// 교훈: 외부 입력 idempotency는 부수효과 전에 DB 유니크 제약으로 선점) —
// (account_id, resource_id, folder_path) 유니크 인덱스가 동시 최초-참조
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

/** failInterruptedBuilds()가 끊긴 빌드에 남기는 error — graph_status · 화면에 그대로 보인다. */
const INTERRUPTED_BUILD_ERROR = 'graph build was interrupted by a server restart — refresh the graph to rebuild';

/** releaseAbandonedBuild()가 lease 가 지난 빌드에 남기는 error. */
const ABANDONED_BUILD_ERROR = 'graph build was abandoned — the server running it stopped (restart or crash) or the build hung — refresh the graph to rebuild';

/**
 * 빌드의 lease(ticket 461d210a). claim 이 lease 를 주고, 빌드가 도는 동안
 * heartbeat 가 미룬다. 빌드를 돌리던 서버가 사라지면(재기동 · 크래시) 마지막
 * 연장에서 이만큼 뒤에 그 building 이 풀린다. 자기 서버가 돌리는 빌드는 lease 와
 * 상관없이 liveBuilds 가 지키므로, 이 값은 다른 서버가 기다리는 시간이자 재기동 뒤
 * Refresh 를 다시 받기까지의 시간이다.
 */
const BUILD_LEASE_MS = 2 * 60_000;
/** lease 안에 여러 번 연장해 DB 가 잠깐 쓰기를 못 받아도 lease 를 잃지 않게 한다. */
const BUILD_HEARTBEAT_MS = 30_000;
/** 연장이 실패했을 때(DB 가 잠깐 못 받음) 다음 시도까지 — 주기 전체를 기다리지 않는다. */
const BUILD_RENEW_RETRY_MS = 5_000;
/**
 * 빌드가 교체를 시작하기까지 쥘 수 있는 가장 긴 시간. 추출은 git 명령과 파일마다 시간
 * 상한이 있지만 빌드 전체에는 없다 — 여기를 넘긴 빌드는 멈춘 것으로 보고 더 지키지
 * 않는다(연장을 멈추고 liveBuilds 도 놓는다). 그 뒤 lease 가 지나면 읽기가 풀고, 늦게
 * 교체에 닿은 빌드는 교체하지 않고 실패로 끝난다. 교체 트랜잭션을 시작한 빌드는 끝날
 * 때까지 지킨다 — 트랜잭션 도중에 풀면 그 결과를 통째로 버리게 된다. 시계는 단조
 * 시계(performance.now)다 — NTP 보정 · 절전 복귀에 창이 움직이지 않게.
 */
const BUILD_MAX_MS = 2 * 60 * 60_000;
const MAX_DURATION_ERROR = 'graph build ran past its maximum duration before it could replace the graph — refresh the graph to rebuild';

/** lease 가 지났거나 없는(이 컬럼 전에 남은) building — 해제 · 재claim 의 조건. `:nowMs` 를 넘긴다. */
const BUILD_LEASE_EXPIRED_SQL = '(build_lease_until_ms IS NULL OR build_lease_until_ms < :nowMs)';

interface LiveBuild {
  /** performance.now() 기준. */
  startedAt: number;
  /** 교체 트랜잭션을 시작했다 — BUILD_MAX_MS 와 상관없이 끝날 때까지 지킨다. */
  replacing: boolean;
}

/** 빌드가 끝내기 전에 주인 자리(build_id)를 잃었다 — 결과를 버리고 조용히 끝낸다. */
class SupersededBuildError extends Error {
  constructor() {
    super('graph build lost its claim before it finished');
  }
}

export type GraphRefResolutionErrorCode = 'missing_ref' | 'not_found';

export class GraphRefResolutionError extends Error {
  constructor(message: string, public readonly code: GraphRefResolutionErrorCode) {
    super(message);
  }
}

export interface GraphRefInput {
  accountId: string;
  graphId?: string;
  /** Project id. 그래프 테이블 컬럼 이름(`resource_id`)을 따르지만 값은 저장소
   *  Resource 가 같은 id 로 이관된 Project 의 id 다(docs/tickets.md). */
  resourceId?: string;
  folderPath?: string;
}

@Injectable()
export class OntologyLifecycleService implements OnApplicationBootstrap {
  private buildLeaseMs = BUILD_LEASE_MS;
  private buildHeartbeatMs = BUILD_HEARTBEAT_MS;
  private buildMaxMs = BUILD_MAX_MS;
  private buildRenewRetryMs = BUILD_RENEW_RETRY_MS;
  /**
   * 주기 연장은 다른 서버가 이 서버의 빌드를 보는 Postgres 에서만 한다. sql.js DB 는
   * 이 프로세스에만 있어 살아 있는 빌드는 liveBuilds 가 지키고 끊긴 빌드는 부팅 때
   * 풀린다 — 거기서 연장은 ontology.db 를 dirty 로 만들어 flush 마다 전체 export 만
   * 부른다.
   */
  private renewPeriodically = !AppOntologyDataSource;
  /**
   * 이 서버가 지금 돌리는 빌드(build_id → 시작 시각 · 교체 중인지). 읽기와 Refresh 는
   * 여기 있는 빌드를 lease 와 상관없이 끊긴 것으로 보지 않는다 — 이 프로세스가 잠깐
   * 멈췄거나(sql.js 큐 · 이벤트 루프 · 커넥션 풀) 연장이 늦어 lease 가 지나 보여도,
   * 자기 빌드를 스스로 풀어 결과를 버리지 않게(리뷰 지적). 서버마다 이 서비스는
   * 하나다(OntologyModule 만 provide 한다). 빌드가 끝나면 runInitialBuild 가 지운다.
   */
  private readonly liveBuilds = new Map<string, LiveBuild>();

  constructor(
    @InjectDataSource() private readonly nestDataSource: DataSource,
    private readonly extractionService: OntologyExtractionService,
    private readonly resolverService: OntologyResolverService,
    private readonly logService: LogService,
  ) {}

  /** 테스트 전용 — lease 가 지나는 것과 heartbeat 를 실제로 몇 분씩 기다리지 않고 본다. */
  __setBuildLeaseForTests(timing: {
    leaseMs?: number; heartbeatMs?: number; renewRetryMs?: number; maxBuildMs?: number; renewPeriodically?: boolean;
  }): void {
    if (timing.leaseMs !== undefined) this.buildLeaseMs = timing.leaseMs;
    if (timing.heartbeatMs !== undefined) this.buildHeartbeatMs = timing.heartbeatMs;
    if (timing.renewRetryMs !== undefined) this.buildRenewRetryMs = timing.renewRetryMs;
    if (timing.maxBuildMs !== undefined) this.buildMaxMs = timing.maxBuildMs;
    if (timing.renewPeriodically !== undefined) this.renewPeriodically = timing.renewPeriodically;
  }

  /** 이 서버가 돌리는 빌드이고, 교체 중이거나 아직 BUILD_MAX_MS 를 넘기지 않았다. */
  private isLiveHere(buildId: string | null | undefined): boolean {
    const live = buildId ? this.liveBuilds.get(buildId) : undefined;
    return live !== undefined && (live.replacing || !this.pastMaxDuration(live));
  }

  private pastMaxDuration(live: LiveBuild): boolean {
    return performance.now() - live.startedAt >= this.buildMaxMs;
  }

  /**
   * lease 를 쓰거나 견주는 문장은 짧은 트랜잭션 안에서, 그 문장이 실제로 돌 차례에
   * 잰 시각으로 만든다. sql.js 에서는 쓰기가 큐에서, Postgres 에서는 커넥션 풀에서
   * 기다리는데, 기다리기 전에 시각을 재 두면 오래 기다린 연장이 이미 지난 lease 를
   * 쓰고 그 뒤의 해제 CAS 에 걸린다(리뷰 지적). transaction() 은 차례 · 커넥션을
   * 받은 뒤에 콜백을 부른다. 다른 트랜잭션 안에서 부르지 말 것 — sql.js 에서는 그
   * 트랜잭션의 SAVEPOINT 가 되어 그 롤백에 함께 지워지고, Postgres 에서는 다른
   * 커넥션으로 그 트랜잭션이 쥔 행을 기다리며 멈출 수 있다.
   */
  private atWriteTime<T>(work: (manager: EntityManager, nowMs: number) => Promise<T>): Promise<T> {
    return this.resolveOntologyDataSource().transaction((manager) => work(manager, Date.now()));
  }

  /** 온톨로지 엔티티가 실제로 synchronize된 DataSource — 다른 온톨로지
   *  서비스와 동일한 자세(축 3). */
  private resolveOntologyDataSource(): DataSource {
    return AppOntologyDataSource ?? this.nestDataSource;
  }

  async onApplicationBootstrap(): Promise<void> {
    // 정리가 실패해도 서버 부팅은 막지 않는다 — 남는 것은 그 그래프의 building 뿐이다.
    try {
      await this.failInterruptedBuilds();
    } catch (e) {
      this.logService.error('Ontology', 'failed to release graph builds interrupted by a restart', { err: String(e) });
    }
  }

  /**
   * sql.js에서 부팅 때 남아 있는 building 그래프를 error로 돌린다. 추출이
   * 트랜잭션 밖에서 도는 동안 주기 flush가 building을 파일에 쓰므로, 빌드
   * 도중 재기동하면(nest --watch 재시작 포함) building만 남고 그 빌드는
   * 사라진다 — forceRebuild의 CAS가 building을 영영 거부해 Refresh로도 다시
   * 못 띄운다. sql.js DB는 한 프로세스의 메모리에만 있으니(두 프로세스가 같은
   * 파일을 쓰면 서로 덮어쓴다) 부팅 시점의 building은 전부 끊긴 빌드다.
   * 교체는 원자적이라 행은 마지막 ready 스냅샷 그대로고, 실패한 빌드와 같은
   * 상태(error, 이전 commit 보존)로 둔다. Postgres는 여러 서버가 한 DB를 쓸
   * 수 있어 부팅만으로는 끊긴 빌드를 가려낼 수 없다 — 거기서는 빌드의 lease 가
   * 지나야 풀린다(releaseAbandonedBuild, ticket 461d210a).
   */
  async failInterruptedBuilds(): Promise<number> {
    if (!AppOntologyDataSource?.isInitialized) return 0;
    const result = await AppOntologyDataSource.getRepository(OntologyGraph).update(
      { status: 'building' },
      { status: 'error', error: INTERRUPTED_BUILD_ERROR, build_id: '', build_lease_until_ms: null },
    );
    const count = result.affected ?? 0;
    if (count > 0) this.logService.warn('Ontology', 'graph builds interrupted by a restart marked as error', { count });
    return count;
  }

  /**
   * (account_id, resource_id, folder_path) 당 정확히 하나의 OntologyGraph
   * 행을 보장한다. 먼저 조회하고, 없으면 INSERT를 시도한다 — 동시 호출이
   * 경쟁하면 유니크 인덱스가 패자의 INSERT를 거부하므로, 패자는 승자가
   * 만든 행을 그대로 재조회해서 돌려준다(둘 다 같은 graph_id를 본다).
   * `created=true`인 호출자만 최초 빌드를 킥오프해야 한다 — 새 행은 그 빌드의
   * build_id 와 lease 를 이미 싣고 있다.
   */
  async getOrCreateGraph(input: { accountId: string; resourceId: string; folderPath: string }): Promise<{ graph: OntologyGraph; created: boolean }> {
    const repo = this.resolveOntologyDataSource().getRepository(OntologyGraph);
    const where = { account_id: input.accountId, resource_id: input.resourceId, folder_path: input.folderPath };
    const existing = await repo.findOne({ where });
    if (existing) return { graph: existing, created: false };

    try {
      const created = await this.atWriteTime((manager, nowMs) => manager.save(manager.create(OntologyGraph, {
        ...where, status: 'building', build_id: randomUUID(), build_lease_until_ms: nowMs + this.buildLeaseMs,
      })));
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
   * 툴이 공유하는 단일 해소 지점. graph_id가 주어지면 그 행을 account
   * 경계까지 확인해 반환한다(다른 계정 소유 그래프는 not_found로
   * 취급 — 존재 여부를 흘리지 않는다). graph_id가 없으면 resource_id(+
   * folder_path)로 찾거나-없으면-만든다 — 새로 만들어졌으면 최초 빌드를
   * fire-and-forget으로 킥오프한다(DESIGN.md A1: 이 경로 덕분에 어떤
   * 그래프 툴로 들어와도 최초 참조가 항상 프로비저닝을 트리거한다).
   * 이미 있던 그래프가 lease 가 지난 building 이면 error 로 풀어서 돌려준다
   * (releaseAbandonedBuild).
   */
  async resolveOrProvision(input: GraphRefInput): Promise<OntologyGraph> {
    const repo = this.resolveOntologyDataSource().getRepository(OntologyGraph);
    if (input.graphId) {
      const graph = await repo.findOne({ where: { id: input.graphId } });
      if (!graph || graph.account_id !== input.accountId) {
        throw new GraphRefResolutionError('Ontology graph not found in this account', 'not_found');
      }
      return this.releaseAbandonedBuild(graph);
    }
    if (!input.resourceId) {
      throw new GraphRefResolutionError('Provide graph_id, or resource_id (optionally with folder_path)', 'missing_ref');
    }
    const { graph, created } = await this.getOrCreateGraph({
      accountId: input.accountId,
      resourceId: input.resourceId,
      folderPath: input.folderPath ?? '',
    });
    if (created) {
      this.kickOffInitialBuild(graph);
      return graph;
    }
    return this.releaseAbandonedBuild(graph);
  }

  /**
   * lease 가 지난 building 을 error 로 돌린다 — 그 빌드를 돌리던 서버가 사라졌거나
   * (재기동 · 크래시) 빌드가 BUILD_MAX_MS 를 넘겨 멈췄다. claim 은 빌드 트랜잭션
   * 전에 커밋되므로 빌드가 사라져도 building 은 남고, 그대로 두면 Refresh
   * (forceRebuild 의 CAS)도 화면(building 동안 Refresh 를 막는다)도 다시 띄울 길이
   * 없다. 부팅 때 일괄로 풀 수 없는 Postgres 를 위한 길이다(sql.js 는
   * failInterruptedBuilds 가 부팅 때 먼저 푼다). 실패한 빌드와 같은 상태로 둔다:
   * 교체는 원자적이라 행은 마지막 ready 스냅샷과 그 commit 그대로다.
   *
   * 살아 있는 빌드는 건드리지 않는다 — 다른 서버의 빌드는 heartbeat 가 lease 를
   * 미루고, 이 서버의 빌드는 liveBuilds 가 지킨다. 그래서 이 서버가 자기 빌드의
   * 교체 트랜잭션 뒤에 해제 UPDATE 를 줄 세워 읽기를 붙잡는 일도 없다(sql.js 큐).
   * 판정은 CAS 의 결과로 한다 — 읽은 행이 낡았어도(그 사이 주인이 연장했거나, 빌드가
   * 끝났거나, 다른 빌드가 다시 claim 했어도) 맞지 않는다.
   */
  private async releaseAbandonedBuild(graph: OntologyGraph): Promise<OntologyGraph> {
    if (graph.status !== 'building' || this.isLiveHere(graph.build_id)) return graph;
    if (graph.build_lease_until_ms != null && graph.build_lease_until_ms >= Date.now()) return graph;

    // build_id 까지 맞춰 본다 — 읽은 뒤 다른 빌드가 다시 claim 했으면, 그 빌드가 이
    // 서버에서 돌고 있어 lease 와 상관없이 살아 있을 수 있다(sql.js 는 주기 연장이 없다).
    const released = await this.atWriteTime((manager, nowMs) => manager
      .createQueryBuilder()
      .update(OntologyGraph)
      .set({ status: 'error', error: ABANDONED_BUILD_ERROR, build_id: '', build_lease_until_ms: null })
      .where('id = :id AND build_id = :buildId', { id: graph.id, buildId: graph.build_id ?? '' })
      .andWhere("status = 'building'")
      .andWhere(BUILD_LEASE_EXPIRED_SQL, { nowMs })
      .execute());
    if ((released.affected ?? 0) > 0) {
      this.logService.warn('Ontology', 'abandoned graph build released — its lease expired', {
        graphId: graph.id, buildId: graph.build_id, leaseUntilMs: graph.build_lease_until_ms,
      });
    }
    return (await this.resolveOntologyDataSource().getRepository(OntologyGraph).findOne({ where: { id: graph.id } })) ?? graph;
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
   * Tier 1(extractRepo → persistExtraction) → Tier 1.5(resolveGraph, 전체
   * 그래프 스코프 — scopeFilePaths를 넘기지 않는다) 전체 파이프라인을
   * 실행하고 OntologyGraph 행을 ready/error로 갱신한다. kickOffInitialBuild()가
   * 실제로 호출하는 실제 구현이지 테스트 전용 분기가 아니다 —
   * runFileChange와 같은 자세로 공개돼 있어 E2E 테스트가 직접 await할 수
   * 있다.
   *
   * 추출(git clone/fetch + 워커 파싱)은 DB에 쓰지 않으므로 트랜잭션 밖에서
   * 먼저 끝낸다. 트랜잭션이 열린 동안 sql.js에서는 이 DataSource의 다른
   * 쓰기(새 그래프 프로비저닝, Refresh claim, 다른 빌드의 상태 갱신)가 전부
   * 큐에서 기다리고, Postgres에서도 커넥션 하나를 쥔다 — 추출을 안에 두면
   * 워커 하나가 멈출 때 그 쓰기들도 함께 멈춘다(ticket dc6dfb15). 빌드 중
   * 표시와 동시 빌드 방지는 트랜잭션이 아니라 status='building' 선점
   * (getOrCreateGraph의 유니크 insert, forceRebuild의 CAS)이 맡는다. 그
   * building은 이 메서드가 ready/error로 끝내야 풀린다 — 재기동으로 끊긴
   * 빌드는 sql.js에서 failInterruptedBuilds()가 부팅 때 풀고, 어느 백엔드든
   * lease 가 지나면 releaseAbandonedBuild()가 푼다.
   *
   * 빌드는 claim 이 준 build_id 의 주인으로 돈다(ticket 461d210a). 도는 동안
   * heartbeat 로 lease 를 미루고, 끝내는 쓰기(ready 교체 · error)는 행이 아직 그
   * build_id 일 때만 한다 — lease 가 지나 다른 빌드가 다시 claim 했으면 이
   * 빌드의 결과는 버린다(교체 트랜잭션은 끝에서 확인하고 통째로 되돌린다).
   */
  async runInitialBuild(graph: OntologyGraph): Promise<void> {
    const dataSource = this.resolveOntologyDataSource();
    const buildId = graph.build_id;
    // 빌드는 언제나 claim 아래에서 돈다 — 빈 토큰은 빌드가 없는 행(ready · error)에도 맞아 fence 가 되지 않는다.
    if (!buildId) throw new Error('graph build needs a claim (build_id) — start it through getOrCreateGraph or forceRebuild');
    const live: LiveBuild = { startedAt: performance.now(), replacing: false };
    this.liveBuilds.set(buildId, live);
    const heartbeat = this.renewPeriodically ? this.startBuildHeartbeat(graph.id, buildId, live) : { stop() {} };
    try {
      const extraction = await this.extractionService.extractRepo({
        accountId: graph.account_id,
        resourceId: graph.resource_id,
        folderPath: graph.folder_path,
      });
      // 교체 직전에 lease 를 한 번 더 미룬다 — 트랜잭션이 lease 전체를 쓰게 한다(sql.js
      // 에서는 트랜잭션이 도는 동안 연장이 큐에서 기다린다). 이미 주인 자리를 잃었으면
      // 교체를 시작하지 않는다.
      if (!(await this.renewBuildLease(graph.id, buildId))) throw new SupersededBuildError();
      // 최대 시간을 넘겨 교체에 닿은 빌드는 교체하지 않는다 — 더는 지키지 않으므로
      // 트랜잭션 도중에 풀려 결과를 버릴 수 있다. 넘기지 않았으면 교체가 끝날 때까지 지킨다.
      if (this.pastMaxDuration(live)) throw new Error(MAX_DURATION_ERROR);
      live.replacing = true;
      // 리뷰 지적(d22b83b4, "Refresh Graph" 승인 블로커) — 이 메서드는
      // 원래 그래프당 최초 1회만 호출된다는 암묵 전제로 짜여 있었다.
      // forceRebuild()가 이제 같은 그래프에 대해 재호출하므로, 저장 전
      // 기존 행을 먼저 지워 (a) OntologyNode의 (graph_id, symbol_id)
      // 유니크 인덱스 충돌, (b) 유니크 제약이 없는 OntologyEdge/
      // OntologyReverseEdgeIndex의 조용한 중복 적재를 둘 다 막는다. 최초
      // 빌드에서는 지울 행이 없어 사실상 no-op. 삭제부터 ready까지 한
      // 트랜잭션이라, 저장이나 resolve가 실패하면 마지막 ready 스냅샷이
      // 그대로 남는다.
      await dataSource.transaction(async (manager) => {
        await this.clearExistingGraphRows(graph.id, manager);
        const persisted = await this.extractionService.persistExtraction(extraction, graph.id, manager);
        const resolveResult = await this.resolverService.resolveGraph({
          graphId: graph.id,
          accountId: graph.account_id,
          commit: extraction.commit,
          extractionRunId: randomUUID(),
        }, manager);
        // 이 아래는 끝내는 쓰기다 — 그 뒤에 도착한 연장이 "주인을 잃었다"로 보이지 않게 먼저 멈춘다.
        heartbeat.stop();
        const finished = await manager
          .createQueryBuilder()
          .update(OntologyGraph)
          .set({
            status: 'ready',
            indexed_at: new Date(),
            commit: extraction.commit,
            progress: JSON.stringify({
              files_discovered: extraction.filesDiscovered,
              files_failed_extraction: extraction.filesFailedExtraction,
              nodes_inserted: persisted.nodesInserted,
              edges_inserted: persisted.edgesInserted + resolveResult.edgesInserted,
            }),
            error: '',
            build_id: '',
            build_lease_until_ms: null,
          })
          .where('id = :id AND build_id = :buildId', { id: graph.id, buildId })
          .execute();
        // 그 사이 다른 빌드가 다시 claim 했다 — 던져서 지우고 쓴 것까지 되돌린다.
        if ((finished.affected ?? 0) === 0) throw new SupersededBuildError();
      });
    } catch (e) {
      heartbeat.stop();
      if (e instanceof SupersededBuildError) {
        this.logService.warn('Ontology', 'graph build lost its claim before it finished — its result was discarded', {
          graphId: graph.id, buildId,
        });
        return;
      }
      await this.failBuild(graph.id, buildId, e);
      throw e;
    } finally {
      heartbeat.stop();
      this.liveBuilds.delete(buildId);
    }
  }

  /**
   * 빌드 실패를 error 로 남긴다 — 행이 아직 이 빌드의 것일 때만. 그 사이 lease 가
   * 지나 끊긴 빌드로 풀렸거나 다른 빌드가 다시 claim 했으면 그 상태를 덮지 않는다.
   */
  private async failBuild(graphId: string, buildId: string, e: unknown): Promise<void> {
    const failed = await this.resolveOntologyDataSource()
      .getRepository(OntologyGraph)
      .createQueryBuilder()
      .update(OntologyGraph)
      .set({ status: 'error', error: String((e as Error)?.message || e).slice(0, 500), build_id: '', build_lease_until_ms: null })
      .where('id = :id AND build_id = :buildId', { id: graphId, buildId })
      .execute();
    if ((failed.affected ?? 0) === 0) {
      this.logService.warn('Ontology', 'graph build failed after losing its claim — left the newer state alone', {
        graphId, buildId, err: String(e),
      });
    }
  }

  /** 이 빌드의 lease 를 미룬다. 주인 자리(build_id)를 이미 잃었으면 false. */
  private async renewBuildLease(graphId: string, buildId: string): Promise<boolean> {
    const renewed = await this.atWriteTime((manager, nowMs) => manager
      .createQueryBuilder()
      .update(OntologyGraph)
      .set({ build_lease_until_ms: nowMs + this.buildLeaseMs })
      .where('id = :id AND build_id = :buildId', { id: graphId, buildId })
      .execute());
    return (renewed.affected ?? 0) > 0;
  }

  /**
   * 빌드가 도는 동안 buildHeartbeatMs 마다 lease 를 미룬다(Postgres — renewPeriodically).
   * 연장은 한 번에 하나씩 — 앞 연장이 끝나야 다음 연장을 건다(교체 트랜잭션 동안
   * 기다리는 연장이 쌓이지 않게). 연장이 실패해도(DB 가 잠깐 못 받음) 주기를 다
   * 기다리지 않고 곧 다시 하고(BUILD_RENEW_RETRY_MS), 주인 자리를 잃었거나 교체 전에
   * 빌드가 BUILD_MAX_MS 를 넘겼으면 멈춘다. 빌드를 막지 않도록 어떤 경우에도 던지지
   * 않는다.
   */
  private startBuildHeartbeat(graphId: string, buildId: string, live: LiveBuild): { stop(): void } {
    let stopped = false;
    let failing = false;
    let timer: NodeJS.Timeout | null = null;
    const schedule = (delayMs = this.buildHeartbeatMs) => {
      timer = setTimeout(tick, delayMs);
      timer.unref?.();
    };
    const tick = () => {
      timer = null;
      if (stopped) return;
      if (!live.replacing && this.pastMaxDuration(live)) {
        stopped = true;
        this.logService.warn('Ontology', 'graph build ran past its maximum duration — stopped renewing its lease', {
          graphId, buildId, maxBuildMs: this.buildMaxMs,
        });
        return;
      }
      this.renewBuildLease(graphId, buildId)
        .then(
          (held) => {
            if (stopped) return;
            failing = false;
            if (held) {
              schedule();
              return;
            }
            stopped = true;
            this.logService.warn('Ontology', 'graph build lost its claim — stopped renewing its lease', { graphId, buildId });
          },
          (e: unknown) => {
            if (stopped) return;
            if (!failing) this.logService.warn('Ontology', 'graph build lease renewal failed — retrying', { graphId, buildId, err: String(e) });
            failing = true;
            schedule(Math.min(this.buildRenewRetryMs, this.buildHeartbeatMs));
          },
        )
        .catch(() => { /* 로그 실패까지 삼킨다 — 연장은 빌드의 부수 작업이다 */ });
    };
    schedule();
    return {
      stop: () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        timer = null;
      },
    };
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

  /** runInitialBuild()를 재호출해도 안전하도록 이 그래프의 기존
   *  OntologyNode/Edge/ReverseEdgeIndex 행을 전부 지운다 — status 무관하게
   *  전부(stale/removed도 (graph_id, symbol_id) 유니크 인덱스와 여전히
   *  충돌하므로 active만 지우는 걸로는 부족하다). insertChunked와 대칭인
   *  deleteChunked로 청크 단위 삭제 — 설계상 30만+ 노드 규모 그래프에서
   *  단일 DELETE 문이 sql.js 이벤트 루프를 오래 막지 않게(같은 우려로
   *  insertChunked 자체가 청크+양보 계약을 지킨다, persist.ts 파일 헤더
   *  참고). */
  private async clearExistingGraphRows(graphId: string, ds: Pick<DataSource, 'getRepository'> = this.resolveOntologyDataSource()): Promise<void> {
    const nodeRepo = ds.getRepository(OntologyNode);
    const edgeRepo = ds.getRepository(OntologyEdge);
    const reverseRepo = ds.getRepository(OntologyReverseEdgeIndex);

    const nodeIds = (await nodeRepo.find({ where: { graph_id: graphId }, select: ['id'] })).map((n) => n.id);
    const edgeIds = (await edgeRepo.find({ where: { graph_id: graphId }, select: ['id'] })).map((e) => e.id);
    const reverseIds = (await reverseRepo.find({ where: { graph_id: graphId }, select: ['id'] })).map((r) => r.id);

    await deleteChunked(nodeRepo, nodeIds, NODE_CHUNK_SIZE);
    await deleteChunked(edgeRepo, edgeIds, EDGE_CHUNK_SIZE);
    await deleteChunked(reverseRepo, reverseIds, EDGE_CHUNK_SIZE);
  }

  /**
   * "Build/Refresh Graph" 액션의 refresh 절반(ticket d22b83b4, 리뷰 지적 —
   * 승인 블로커). resolveOrProvision()은 그래프가 이미 존재하면(created
   * ===false) kickOffInitialBuild를 부르지 않으므로, ready/stale/error
   * 그래프에 대한 "Refresh"가 실제로는 아무것도 재시작하지 않았다 — 특히
   * 실패한 최초 빌드는 UI에서 영구히 재시도 불가능했다. 이 메서드는 기존
   * 그래프도 무조건 building으로 되돌리고 재빌드를 킥오프한다.
   *
   * actions.service.ts의 원자적 단일-승자 UPDATE 패턴과 같은 자세 —
   * `status != 'building'` 가드 UPDATE 하나로 동시 두 클릭(또는 이미 진행
   * 중인 백그라운드 빌드) 중 정확히 하나만 kickOffInitialBuild를 부르게
   * 한다. `affected`는 Postgres·sql.js 둘 다 채워준다(actions.service.ts
   * 리뷰 코멘트 참고) — undefined/null이면 승자가 아니라고 fail-closed
   * 처리(?? 0).
   *
   * lease 가 지난 building 도 다시 claim 한다(ticket 461d210a) — 그 빌드를 돌리던
   * 서버는 사라졌다. 살아 있는 빌드는 그대로 started=false 다: 다른 서버의 빌드는
   * heartbeat 가 lease 를 미루고, 이 서버의 빌드는 liveBuilds 가 지킨다. 이긴 claim 은
   * 새 build_id 를 쓰므로, 사라진 줄 알았던 옛 빌드가 나중에 끝나도 그 결과는
   * 버려진다(runInitialBuild).
   */
  async forceRebuild(input: { graphId: string; accountId: string }): Promise<{ graph: OntologyGraph; started: boolean }> {
    const repo = this.resolveOntologyDataSource().getRepository(OntologyGraph);
    const graph = await repo.findOne({ where: { id: input.graphId } });
    if (!graph || graph.account_id !== input.accountId) {
      throw new GraphRefResolutionError('Ontology graph not found in this account', 'not_found');
    }

    const buildId = randomUUID();
    // 이 서버가 돌리는 빌드는 lease 가 지나 보여도 다시 claim 하지 않는다(liveBuilds).
    const liveHere = [...this.liveBuilds.keys()].filter((id) => this.isLiveHere(id));
    const claim = await this.atWriteTime((manager, nowMs) => manager
      .createQueryBuilder()
      .update(OntologyGraph)
      .set({ status: 'building', error: '', build_id: buildId, build_lease_until_ms: nowMs + this.buildLeaseMs })
      .where('id = :id', { id: graph.id })
      .andWhere(
        `(status != 'building' OR (${BUILD_LEASE_EXPIRED_SQL}${liveHere.length ? ' AND build_id NOT IN (:...liveHere)' : ''}))`,
        { nowMs, liveHere },
      )
      .execute());
    const won = (claim.affected ?? 0) > 0;

    if (!won) {
      const latest = await repo.findOne({ where: { id: graph.id } });
      return { graph: latest ?? graph, started: false };
    }

    // 띄우는 빌드는 방금 claim 한 build_id 의 주인이다 — 다시 읽은 행의 build_id 를 쓰지
    // 않는다. 그 사이 다른 빌드가 다시 claim 했다면 그 토큰으로 두 빌드가 함께 돌게 된다.
    const updated = await repo.findOne({ where: { id: graph.id } });
    const started = Object.assign(updated ?? graph, { status: 'building' as const, error: '', build_id: buildId });
    this.kickOffInitialBuild(started);
    return { graph: started, started: true };
  }
}
