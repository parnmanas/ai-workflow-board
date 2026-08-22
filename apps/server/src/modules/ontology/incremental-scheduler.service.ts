// 증분 갱신 스케줄러 진입점(ticket 964014f5, DESIGN.md 축 4). Phase A/B/C를
// 두 트리거로 노출한다 — ① 디바운스 단일 파일 저장(scheduleFileChange,
// research-incremental.md §5.3), ② git diff 스코프 배치
// (runGitDiffBatch, incremental/git-diff-batch.ts). ontology-extraction.
// service.ts/ontology-resolver.service.ts와 같은 자세로 이 모듈에는 아직
// 컨트롤러/MCP 툴이 없다 — graph_status 같은 lifecycle 배선(ticket #6,
// 미배정)이 이 서비스를 실제로 트리거하기 전까지는 DI 대기 상태다.
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AppOntologyDataSource } from '../../db';
import { activityEvents } from '../../services/activity.service';
import { LogService } from '../../services/log.service';
import { runPhaseA, runPhaseADeletion, type PhaseAResult } from './incremental/phase-a';
import { runPhaseB, type PhaseBResult } from './incremental/phase-b';
import { runPhaseC } from './incremental/phase-c';
import { runGitDiffScopedBatch, type GitDiffBatchInput, type GitDiffBatchResult } from './incremental/git-diff-batch';
import type { ExtractionLang } from './extraction/types';

// research-incremental.md §5.3: "AWB's own measured numbers make the
// debounce window an easy choice... a 1-2 second debounce window is
// generous headroom" — 1.5초로 중간값을 택함.
const DEFAULT_DEBOUNCE_MS = 1500;

export interface ScheduleFileChangeInput {
  workspaceId: string;
  resourceId: string;
  folderPath: string;
  graphId: string;
  /** 파일의 현재(새) 경로. */
  newPath: string;
  /** rename이면 이전 경로 — 생략하면 newPath와 동일(일반 편집). */
  oldPath?: string;
  lang: ExtractionLang;
  /** null이면 파일 삭제. */
  content: string | null;
  commit: string;
}

export interface FileChangeRunResult {
  jobId: string;
  phaseA: PhaseAResult;
  phaseB: PhaseBResult | null;
  phaseC: Awaited<ReturnType<typeof runPhaseC>>;
}

@Injectable()
export class OntologyIncrementalSchedulerService {
  // 파일 경로별(정확히는 graphId+newPath별) 디바운스 타이머 — 같은 파일에
  // 대한 연속 저장이 짧은 시간 안에 여러 번 와도 마지막 것만 실제
  // Phase A/B/C를 돈다(research-incremental.md §5.3, "ten keystrokes in
  // ten seconds coalesce into one Phase-A run"). 이 코드베이스의 다른
  // 백그라운드 서비스(qa-run-reaper.service.ts 등)와 같은 자세로
  // @Cron/외부 스케줄러 의존 없이 plain setTimeout + unref.
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  private debounceMs = DEFAULT_DEBOUNCE_MS;

  constructor(
    @InjectDataSource() private readonly nestDataSource: DataSource,
    private readonly logService: LogService,
  ) {}

  /** 온톨로지 엔티티가 실제로 synchronize된 DataSource — 다른 온톨로지
   *  서비스와 동일한 자세(축 3). */
  private resolveOntologyDataSource(): DataSource {
    return AppOntologyDataSource ?? this.nestDataSource;
  }

  /** 테스트 전용 — 디바운스 창을 줄여 실제로 기다리지 않고 검증한다. */
  __setDebounceMsForTests(ms: number): void {
    this.debounceMs = ms;
  }

  private emitProgress(payload: {
    workspaceId: string;
    graphId: string;
    resourceId: string;
    jobId: string;
    phase: 'phase_a' | 'phase_b' | 'phase_c' | 'sweep';
    graphStatus: 'building' | 'ready' | 'stale' | 'error';
    filesProcessed: number;
    edgesExtracted: number;
    edgesTotal: number | null;
    nodesExtracted: number;
    shortCircuited: boolean;
    error: string | null;
  }): void {
    activityEvents.emit('ontology_graph_progress', {
      workspace_id: payload.workspaceId,
      graph_id: payload.graphId,
      resource_id: payload.resourceId,
      job_id: payload.jobId,
      phase: payload.phase,
      graph_status: payload.graphStatus,
      files_processed: payload.filesProcessed,
      edges_extracted: payload.edgesExtracted,
      edges_total: payload.edgesTotal,
      nodes_extracted: payload.nodesExtracted,
      short_circuited: payload.shortCircuited,
      error: payload.error,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * 디바운스 저장 트리거 — fire-and-forget API(호출자는 완료를 기다리지
   * 않는다, 진행은 `ontology_graph_progress` SSE로 관찰). 같은
   * (graphId, newPath) 키의 연속 호출은 타이머를 리셋해 마지막 호출만
   * 실행된다.
   */
  scheduleFileChange(input: ScheduleFileChangeInput): void {
    const key = `${input.graphId}:${input.newPath}`;
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      this.runFileChange(input).catch((e: unknown) => {
        this.logService.error('Ontology', 'incremental file-change job failed', { path: input.newPath, err: String(e) });
        this.emitProgress({
          workspaceId: input.workspaceId,
          graphId: input.graphId,
          resourceId: input.resourceId,
          jobId: randomUUID(),
          phase: 'phase_a',
          graphStatus: 'error',
          filesProcessed: 0,
          edgesExtracted: 0,
          edgesTotal: null,
          nodesExtracted: 0,
          shortCircuited: false,
          error: String((e as Error)?.message || e),
        });
      });
    }, this.debounceMs);
    timer.unref?.();
    this.debounceTimers.set(key, timer);
  }

  /** scheduleFileChange()가 디바운스 뒤 호출하는 실제 실행부 — 테스트는
   *  디바운스를 기다리지 않고 이 메서드를 직접 호출해도 된다. */
  async runFileChange(input: ScheduleFileChangeInput): Promise<FileChangeRunResult> {
    const dataSource = this.resolveOntologyDataSource();
    const jobId = randomUUID();
    const extractionRunId = randomUUID();

    this.emitProgress({
      workspaceId: input.workspaceId,
      graphId: input.graphId,
      resourceId: input.resourceId,
      jobId,
      phase: 'phase_a',
      graphStatus: 'building',
      filesProcessed: 0,
      edgesExtracted: 0,
      edgesTotal: null,
      nodesExtracted: 0,
      shortCircuited: false,
      error: null,
    });

    const phaseA =
      input.content === null
        ? await runPhaseADeletion(dataSource, { graphId: input.graphId, commit: input.commit, filePath: input.newPath })
        : await runPhaseA(dataSource, {
            graphId: input.graphId,
            workspaceId: input.workspaceId,
            resourceId: input.resourceId,
            folderPath: input.folderPath,
            commit: input.commit,
            extractionRunId,
            newPath: input.newPath,
            oldPath: input.oldPath ?? input.newPath,
            lang: input.lang,
            content: input.content,
          });

    const phaseB = phaseA.shortCircuit
      ? null
      : await runPhaseB(dataSource, {
          graphId: input.graphId,
          workspaceId: input.workspaceId,
          commit: input.commit,
          extractionRunId,
          changedFilePath: input.newPath,
          phaseA,
        });

    // research-incremental.md §6 recommended architecture, step 5 — Phase C
    // (evidence-hash staleness 플립)는 Phase B 실행 여부와 무관하게 "매
    // 디바운스 저장마다" 도는 세 번째 단계다(이 티켓 설명 "Phase A(...) /
    // Phase B(...) / Phase C(...)"도 같은 나열). semantic/derived 엣지가
    // 인용하는 evidence_ref는 이번에 저장된 파일이 아닌 다른 파일의
    // content_hash를 가리킬 수도 있어 Phase A/B의 결과와 독립적으로 항상
    // 그래프 전체를 스캔해야 한다 — 오늘의 실제 데이터엔 semantic/derived
    // 엣지 자체가 없어(Tier 1/1.5만 구현) 이 스캔은 사실상 무비용(0행)이다.
    const phaseC = await runPhaseC(dataSource, input.graphId);

    this.emitProgress({
      workspaceId: input.workspaceId,
      graphId: input.graphId,
      resourceId: input.resourceId,
      jobId,
      phase: phaseA.shortCircuit ? 'phase_a' : 'phase_b',
      // 이번 저장이 이 그래프에 새로 stale 표시를 남겼으면(오늘은 사실상
      // 항상 0) ready 대신 stale로 정직하게 보고한다 — S5의 "정직하게
      // 노출" 원칙, git-diff 배치 경로(runGitDiffBatch)와 동일한 판정.
      graphStatus: phaseC.edgesFlippedStale > 0 ? 'stale' : 'ready',
      filesProcessed: phaseA.shortCircuit ? 1 : phaseB?.scopeFilePaths.length ?? 0,
      edgesExtracted: phaseB?.summary?.edgesInserted ?? 0,
      edgesTotal: phaseA.shortCircuit ? 0 : phaseB?.summary?.edgesInserted ?? 0,
      nodesExtracted: 0,
      shortCircuited: phaseA.shortCircuit,
      error: null,
    });

    return { jobId, phaseA, phaseB, phaseC };
  }

  /**
   * git diff 스코프 배치 트리거(브랜치 전환/대량 외부 편집) — 호출자가
   * 완료까지 기다리는 동기 API. incremental/git-diff-batch.ts가 파일마다
   * Phase A/B를 돌고 배치 끝에 Phase C까지 한 번 실행한다.
   */
  async runGitDiffBatch(
    input: GitDiffBatchInput & { workspaceId: string },
  ): Promise<GitDiffBatchResult> {
    const dataSource = this.resolveOntologyDataSource();
    const jobId = randomUUID();
    this.emitProgress({
      workspaceId: input.workspaceId,
      graphId: input.graphId,
      resourceId: input.resourceId,
      jobId,
      phase: 'phase_a',
      graphStatus: 'building',
      filesProcessed: 0,
      edgesExtracted: 0,
      edgesTotal: null,
      nodesExtracted: 0,
      shortCircuited: false,
      error: null,
    });

    const result = await runGitDiffScopedBatch(dataSource, input);

    this.emitProgress({
      workspaceId: input.workspaceId,
      graphId: input.graphId,
      resourceId: input.resourceId,
      jobId,
      phase: 'phase_c',
      // 이번 배치가 semantic/derived 엣지를 stale로 뒤집었으면(오늘의
      // Tier 1/1.5-only 데이터에선 사실상 0) 정직하게 stale로 보고한다 —
      // "완료했지만 알려진 backlog가 남음"을 ready와 구분(축 4 Decision,
      // S5의 "정직하게 노출" 원칙).
      graphStatus: result.phaseC.edgesFlippedStale > 0 ? 'stale' : 'ready',
      filesProcessed: result.filesChanged,
      edgesExtracted: result.phaseBRuns,
      edgesTotal: result.filesChanged,
      nodesExtracted: 0,
      shortCircuited: false,
      error: null,
    });

    return result;
  }
}
