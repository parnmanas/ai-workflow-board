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
import { ensureRepoCache, listTree, getFileContent, listCommits } from '../mcp/shared/git-repo-cache';
import { resolveGitCredential } from '../mcp/shared/git-branches';
import { AppOntologyDataSource } from '../../db';
import { langForPath, type ExtractionTask } from './extraction/types';
import { runExtractionPool } from './extraction/pool';
import { persistFactBundles, type PersistSummary } from './persist';
import type { DecoratorFact } from './extraction/decorator-rules';

const FETCH_CONCURRENCY = 16;

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
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

export interface ExtractRepoResult extends PersistSummary {
  commit: string;
  filesDiscovered: number;
  filesSkippedByExtension: number;
  filesSkippedTooLargeOrBinary: number;
  treeWalkMs: number;
  fetchMs: number;
  extractMs: number;
  totalLines: number;
  endToEndLinesPerSecond: number;
}

@Injectable()
export class OntologyExtractionService {
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

  private async walkTree(repoPath: string, ref: string, rootPath: string): Promise<{ files: string[]; skippedByExtension: number }> {
    const files: string[] = [];
    let skippedByExtension = 0;
    const queue: string[] = [rootPath];
    while (queue.length > 0) {
      const dir = queue.shift()!;
      const entries = await listTree(repoPath, ref, dir);
      for (const entry of entries) {
        if (entry.type === 'tree') {
          queue.push(entry.path);
        } else if (entry.type === 'blob') {
          if (langForPath(entry.path)) files.push(entry.path);
          else skippedByExtension += 1;
        }
      }
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

    const credential = await resolveGitCredential(this.credentialRepo, resource.credential_id, opts.workspaceId);
    const repoPath = await ensureRepoCache({ resourceId: opts.resourceId, url: resource.url, credential });
    const ref = opts.ref || resource.default_branch || 'HEAD';

    const commits = await listCommits({ repoPath, ref, limit: 1 });
    const commit = commits[0]?.sha ?? ref;

    const treeStart = Date.now();
    const { files, skippedByExtension } = await this.walkTree(repoPath, ref, opts.folderPath);
    const treeWalkMs = Date.now() - treeStart;

    const fetchStart = Date.now();
    const fetched = await mapWithConcurrency(files, FETCH_CONCURRENCY, (filePath) => getFileContent(repoPath, ref, filePath));
    const fetchMs = Date.now() - fetchStart;

    let skippedTooLargeOrBinary = 0;
    let totalLines = 0;
    const tasks: ExtractionTask[] = [];
    for (let i = 0; i < files.length; i++) {
      const content = fetched[i];
      if (content.binary || content.too_large) {
        skippedTooLargeOrBinary += 1;
        continue;
      }
      const lang = langForPath(files[i]);
      if (!lang) continue; // walkTree가 이미 걸렀지만 타입 좁히기를 위해 방어적으로 재확인
      tasks.push({ path: files[i], content: content.content, lang });
      totalLines += content.content.length === 0 ? 0 : content.content.split('\n').length;
    }

    const extractStart = Date.now();
    const results = await runExtractionPool(tasks, { poolSize: opts.poolSize });
    const extractMs = Date.now() - extractStart;

    const bundles = results.filter((r) => r.bundle).map((r) => r.bundle!);
    const decoratorFactsByPath = new Map<string, DecoratorFact[]>();
    for (const r of results) {
      if (r.bundle) decoratorFactsByPath.set(r.path, r.decoratorFacts);
    }

    const dataSource = this.resolveOntologyDataSource();
    const summary = await persistFactBundles(dataSource, {
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
      treeWalkMs,
      fetchMs,
      extractMs,
      totalLines,
      endToEndLinesPerSecond: endToEndMs > 0 ? Math.round((totalLines / endToEndMs) * 1000) : 0,
    };
  }
}
