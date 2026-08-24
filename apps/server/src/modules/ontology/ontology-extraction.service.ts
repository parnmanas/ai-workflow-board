// Ontology Graph 추출 워커의 NestJS 진입점 (ticket e14ef1c9, DESIGN.md 축 1).
// git-repo-cache.ts(scout-server.md §3b)를 재구현하지 않고 직접 소비해
// repo 폴더 → worker_threads 풀 추출 → OntologyNode/Edge 영속화까지
// 잇는다. 이 티켓 범위에는 MCP 툴이 없다 — agent-driven 트리거가 아니라
// 서버 사이드 job(NestJS 서비스)이라는 판단(scout-server.md §7 "extraction
// runs as an agent... / server-side job..." 분기의 후자)이고, graph_status
// 같은 lifecycle/자동 프로비저닝 배선은 ticket #6(미배정)의 몫이라 이
// 서비스는 (workspaceId, resourceId, folderPath, graphId)를 호출자가 이미
// 안다고 가정한다.
import { Injectable } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { Resource } from '../../entities/Resource';
import { Credential } from '../../entities/Credential';
import { findOrFail } from '../../common/find-or-fail';
import { ensureRepoCache, listTreeRecursive, getFileContentsBatch, listCommits, type TreeFileEntry } from '../mcp/shared/git-repo-cache';
import { resolveGitCredential } from '../mcp/shared/git-branches';
import { AppOntologyDataSource } from '../../db';
import { langForPath, type ExtractionTask, type FactBundle } from './extraction/types';
import { runExtractionPool } from './extraction/pool';
import { persistFactBundles, type PersistSummary } from './persist';
import type { DecoratorFact } from './extraction/decorator-rules';

const MAX_ERROR_MESSAGE_LENGTH = 300;
// 워커가 대량 동시 크래시하는 병리적 상황(예: worker.js 자체 결함)에서도
// 반환 페이로드가 무한정 커지지 않도록 상세 목록만 캡한다 —
// filesFailedExtraction 카운트 자체는 캡 없이 항상 정확하므로, 목록 길이가
// 카운트보다 작으면 "더 있음"을 그 자체로 알 수 있다.
const MAX_REPORTED_EXTRACTION_FAILURES = 100;

function redactWorkerError(raw: string): string {
  return raw.length > MAX_ERROR_MESSAGE_LENGTH ? `${raw.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…` : raw;
}

export interface ExtractRepoOptions {
  workspaceId: string;
  resourceId: string;
  /** 빈 문자열 = 저장소 루트. */
  folderPath: string;
  /** 이 (workspace_id, resource_id, folder_path) 그래프의 graph_id — 이
   *  서비스는 lifecycle/프로비저닝을 하지 않는다(ticket #6 범위), 호출자가
   *  이미 갖고 있는 값을 그대로 받는다. */
  graphId: string;
  /** 생략하면 Resource.default_branch, 그것도 비어 있으면 저장소 HEAD. */
  ref?: string;
  poolSize?: number;
}

export interface ExtractionFailure {
  path: string;
  /** 워커가 보고한 에러 메시지 — 길이만 절단(redact)한다, 원인 판별에
   *  필요한 예외 메시지 자체는 지우지 않는다. */
  error: string;
}

export interface ExtractRepoResult extends PersistSummary {
  commit: string;
  filesDiscovered: number;
  filesSkippedByExtension: number;
  filesSkippedTooLargeOrBinary: number;
  /** worker_threads 풀이 에러/비정상 exit로 회수한 파일 수 — bundle=null이라
   *  persist 입력에서 조용히 빠진 파일들. pool.ts는 이런 실패를 파일별 에러
   *  값으로 의도적으로 복구해 풀 전체 Promise를 정상 resolve시키므로, 이
   *  카운트가 없으면 부분 그래프가 완전한 성공처럼 보인다(리뷰 지적 — 이
   *  필드 없이는 filesDiscovered와의 차분만으로 extension/large/binary/
   *  quarantine/worker-failure 원인을 구분할 수 없었다). */
  filesFailedExtraction: number;
  /** filesFailedExtraction의 상세 — MAX_REPORTED_EXTRACTION_FAILURES개까지만
   *  담는다(카운트 자체는 캡 없음). */
  extractionFailures: ExtractionFailure[];
  treeWalkMs: number;
  fetchMs: number;
  extractMs: number;
  totalLines: number;
  endToEndLinesPerSecond: number;
}

@Injectable()
export class OntologyExtractionService {
  // 아래 필드들은 실제 구현이 기본값이다 — 테스트에서만 재할당해 git-repo-cache/
  // 실제 워커 풀/DB 없이 extractRepo() 자신의 조합 로직(특히 풀 실패 →
  // ExtractRepoResult 전파)을 검증한다
  // (test/ontology-extraction-service-failure-propagation.test.mjs). 프로덕션
  // 코드 경로는 이 필드들을 재할당하지 않는다 — Nest DI가 생성한 인스턴스는
  // 항상 아래 기본값(실제 구현)을 그대로 쓴다.
  private ensureRepoCache = ensureRepoCache;
  private listTreeRecursive = listTreeRecursive;
  private getFileContentsBatch = getFileContentsBatch;
  private listCommits = listCommits;
  private resolveGitCredential = resolveGitCredential;
  private runExtractionPool = runExtractionPool;
  private persistFactBundles = persistFactBundles;

  constructor(
    @InjectRepository(Resource) private readonly resourceRepo: Repository<Resource>,
    @InjectRepository(Credential) private readonly credentialRepo: Repository<Credential>,
    @InjectDataSource() private readonly nestDataSource: DataSource,
  ) {}

  /** 온톨로지 엔티티가 실제로 synchronize된 DataSource — sql.js는
   *  AppOntologyDataSource(db.ts, 독립 파일/큐/flush), Postgres는
   *  AppOntologyDataSource가 null이라 NestJS가 관리하는 단일 primary
   *  DataSource로 폴백한다(축 3: Postgres는 변경 없음). */
  private resolveOntologyDataSource(): DataSource {
    return AppOntologyDataSource ?? this.nestDataSource;
  }

  private async walkTree(repoPath: string, ref: string, rootPath: string): Promise<{ files: TreeFileEntry[]; skippedByExtension: number }> {
    const entries = await this.listTreeRecursive(repoPath, ref, rootPath);
    const files: TreeFileEntry[] = [];
    let skippedByExtension = 0;
    for (const entry of entries) {
      if (langForPath(entry.path)) files.push(entry);
      else skippedByExtension += 1;
    }
    return { files, skippedByExtension };
  }

  async extractRepo(opts: ExtractRepoOptions): Promise<ExtractRepoResult> {
    const resource = await findOrFail(this.resourceRepo, { where: { id: opts.resourceId } }, 'Resource not found');
    if (resource.workspace_id !== null && resource.workspace_id !== opts.workspaceId) {
      throw new Error('Resource not found in workspace');
    }
    if (resource.type !== 'repository') {
      throw new Error(`resource type must be 'repository' (got '${resource.type}')`);
    }
    if (!resource.url) {
      throw new Error("resource has no URL — set the repository's URL before extracting its ontology graph");
    }

    const credential = await this.resolveGitCredential(this.credentialRepo, resource.credential_id, opts.workspaceId);
    const repoPath = await this.ensureRepoCache({ resourceId: opts.resourceId, url: resource.url, credential });
    const ref = opts.ref || resource.default_branch || 'HEAD';

    const commits = await this.listCommits({ repoPath, ref, limit: 1 });
    const commit = commits[0]?.sha ?? ref;

    const treeStart = Date.now();
    const { files, skippedByExtension } = await this.walkTree(repoPath, ref, opts.folderPath);
    const treeWalkMs = Date.now() - treeStart;

    const fetchStart = Date.now();
    const fetched = await this.getFileContentsBatch(repoPath, files);
    const fetchMs = Date.now() - fetchStart;

    let skippedTooLargeOrBinary = 0;
    let totalLines = 0;
    const tasks: ExtractionTask[] = [];
    for (const entry of files) {
      const content = fetched.get(entry.path)!;
      if (content.binary || content.too_large) {
        skippedTooLargeOrBinary += 1;
        continue;
      }
      const lang = langForPath(entry.path);
      if (!lang) continue; // walkTree가 이미 걸렀지만 타입 좁히기를 위해 방어적으로 재확인
      tasks.push({ path: entry.path, content: content.content, lang });
      totalLines += content.content.length === 0 ? 0 : content.content.split('\n').length;
    }

    const extractStart = Date.now();
    const results = await this.runExtractionPool(tasks, { poolSize: opts.poolSize });
    const extractMs = Date.now() - extractStart;

    // 리뷰 지적 — pool.ts는 워커 에러/비정상 exit를 파일별 에러 값으로
    // 의도적으로 복구해 풀 전체 Promise를 정상 resolve시킨다(배치 하나가
    // 파일 하나의 결함으로 멈추지 않게 하려고). 그래서 bundle===null인
    // 항목을 그냥 걸러내기만 하면(이전 구현) 그 정보가 이 서비스 경계에서
    // 완전히 사라져, 워커 OOM/모듈 에러가 나도 호출자는 부분 그래프를 완전한
    // 성공으로 오인한다 — 아래에서 명시적으로 집계해 반환값에 싣는다.
    const bundles: FactBundle[] = [];
    const decoratorFactsByPath = new Map<string, DecoratorFact[]>();
    const extractionFailures: ExtractionFailure[] = [];
    let filesFailedExtraction = 0;
    for (const r of results) {
      if (r.bundle) {
        bundles.push(r.bundle);
        decoratorFactsByPath.set(r.path, r.decoratorFacts);
        continue;
      }
      filesFailedExtraction += 1;
      if (extractionFailures.length < MAX_REPORTED_EXTRACTION_FAILURES) {
        extractionFailures.push({ path: r.path, error: redactWorkerError(r.error ?? 'unknown worker failure') });
      }
    }

    const dataSource = this.resolveOntologyDataSource();
    const summary = await this.persistFactBundles(dataSource, {
      graphId: opts.graphId,
      workspaceId: opts.workspaceId,
      resourceId: opts.resourceId,
      folderPath: opts.folderPath,
      commit,
      extractionRunId: randomUUID(),
      bundles,
      decoratorFactsByPath,
    });

    // treeWalkMs/fetchMs를 포함한 종단간(end-to-end) 처리량 — git 원격 fetch가
    // 섞여 있어 research-extraction.md §1의 "81.7k lines/s" 순수 파싱+추출
    // 수치와 직접 비교할 대상이 아니다(그 수치는 git I/O 없이 로컬 디스크를
    // 직접 읽어 측정됐다). 순수 추출 처리량 비교는
    // scripts/benchmark-ontology-extraction.mjs(로컬 디스크 직접 읽기, 이
    // extractMs와 같은 pool.ts 경로 재사용)가 전담한다 — 완료조건 1은 그
    // 스크립트의 산출물로 충족한다.
    const endToEndMs = treeWalkMs + fetchMs + extractMs;
    return {
      ...summary,
      commit,
      filesDiscovered: files.length,
      filesSkippedByExtension: skippedByExtension,
      filesSkippedTooLargeOrBinary: skippedTooLargeOrBinary,
      filesFailedExtraction,
      extractionFailures,
      treeWalkMs,
      fetchMs,
      extractMs,
      totalLines,
      endToEndLinesPerSecond: endToEndMs > 0 ? Math.round((totalLines / endToEndMs) * 1000) : 0,
    };
  }
}
