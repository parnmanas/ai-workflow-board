// git diff 스코프 배치(ticket 964014f5, DESIGN.md 축 4) — 디바운스 저장
// 트리거(단일 파일, incremental-scheduler.service.ts)와 나란한 두 번째
// 트리거: `git diff <last_indexed_commit>..HEAD --name-status -M`로 브랜치
// 전환/대량 외부 편집(에디터 밖에서 일어나 디바운스 저장 이벤트 자체가
// 없는 경우) 이후의 누적 변경을 한 번에 Phase A/B/C로 흘려보낸다. rename
// 감지(`-M`)가 정확히 이 배치 경로에서 나온다 — git-repo-cache.ts의
// `diffChangedPathsWithStatus()`가 R<similarity>\t<old>\t<new> 줄을
// {status:'R', oldPath, path} 로 파싱해 준다(scout-server.md §3b).
import type { DataSource } from 'typeorm';
import { diffChangedPathsWithStatus, getFileContent, listCommits } from '../../mcp/shared/git-repo-cache';
import { langForPath } from '../extraction/types';
import { yieldToEventLoop } from '../persist';
import { runPhaseA, runPhaseADeletion, type PhaseAResult } from './phase-a';
import { runPhaseB } from './phase-b';
import { runPhaseC, type PhaseCResult } from './phase-c';

export interface GitDiffBatchInput {
  graphId: string;
  workspaceId: string;
  resourceId: string;
  folderPath: string;
  extractionRunId: string;
  repoPath: string;
  /** 지난 실행이 성공적으로 인덱싱한 커밋 — 이 커밋 이후의 변경만 처리. */
  lastIndexedCommit: string;
  /** 보통 'HEAD' — 브랜치 전환 직후에도 그 시점의 HEAD를 그대로 쓰면 된다. */
  headRef: string;
}

export interface GitDiffBatchResult {
  headCommit: string;
  filesChanged: number;
  filesSkippedNoLangOrBinary: number;
  phaseAShortCircuits: number;
  phaseBRuns: number;
  phaseC: PhaseCResult;
}

async function processOneChange(
  dataSource: DataSource,
  input: GitDiffBatchInput,
  headCommit: string,
  change: { status: string; path: string; oldPath: string | null },
): Promise<{ skipped: boolean; phaseA: PhaseAResult | null; phaseBRan: boolean }> {
  if (change.status === 'D') {
    const phaseA = await runPhaseADeletion(dataSource, { graphId: input.graphId, commit: headCommit, filePath: change.path });
    if (phaseA.shortCircuit) return { skipped: false, phaseA, phaseBRan: false };
    const b = await runPhaseB(dataSource, {
      graphId: input.graphId,
      workspaceId: input.workspaceId,
      commit: headCommit,
      extractionRunId: input.extractionRunId,
      changedFilePath: change.path,
      phaseA,
    });
    return { skipped: false, phaseA, phaseBRan: b.ran };
  }

  const lang = langForPath(change.path);
  if (!lang) return { skipped: true, phaseA: null, phaseBRan: false };
  const fileContent = await getFileContent(input.repoPath, input.headRef, change.path);
  if (fileContent.binary || fileContent.too_large) return { skipped: true, phaseA: null, phaseBRan: false };

  const oldPath = change.status === 'R' ? change.oldPath ?? change.path : change.path;
  const phaseA = await runPhaseA(dataSource, {
    graphId: input.graphId,
    workspaceId: input.workspaceId,
    resourceId: input.resourceId,
    folderPath: input.folderPath,
    commit: headCommit,
    extractionRunId: input.extractionRunId,
    newPath: change.path,
    oldPath,
    lang,
    content: fileContent.content,
  });
  if (phaseA.shortCircuit) return { skipped: false, phaseA, phaseBRan: false };
  const b = await runPhaseB(dataSource, {
    graphId: input.graphId,
    workspaceId: input.workspaceId,
    commit: headCommit,
    extractionRunId: input.extractionRunId,
    changedFilePath: change.path,
    phaseA,
  });
  return { skipped: false, phaseA, phaseBRan: b.ran };
}

/** `git diff <lastIndexedCommit>..headRef --name-status -M` 스코프 배치.
 *  변경된 파일마다 Phase A -> (필요하면) Phase B를 순차 실행하고, 배치
 *  전체가 끝난 뒤 그래프 하나에 Phase C를 한 번 돌린다(evidence-hash
 *  staleness는 파일 단위가 아니라 그래프 단위 개념이라 배치당 한 번이면
 *  충분 — 파일마다 반복해도 결과는 같지만 낭비다). */
export async function runGitDiffScopedBatch(dataSource: DataSource, input: GitDiffBatchInput): Promise<GitDiffBatchResult> {
  const changes = await diffChangedPathsWithStatus(input.repoPath, input.lastIndexedCommit, input.headRef);
  const commits = await listCommits({ repoPath: input.repoPath, ref: input.headRef, limit: 1 });
  const headCommit = commits[0]?.sha ?? input.headRef;

  let filesSkippedNoLangOrBinary = 0;
  let phaseAShortCircuits = 0;
  let phaseBRuns = 0;

  for (const change of changes) {
    const result = await processOneChange(dataSource, input, headCommit, change);
    if (result.skipped) {
      filesSkippedNoLangOrBinary += 1;
    } else if (result.phaseA?.shortCircuit) {
      phaseAShortCircuits += 1;
    } else if (result.phaseBRan) {
      phaseBRuns += 1;
    }
    // 파일 단위 순회 — persist.ts/resolve.ts와 같은 명시적 매크로태스크
    // 양보 계약(대량 외부 편집 배치는 파일 수가 많을 수 있다).
    await yieldToEventLoop();
  }

  const phaseC = await runPhaseC(dataSource, input.graphId);

  return {
    headCommit,
    filesChanged: changes.length,
    filesSkippedNoLangOrBinary,
    phaseAShortCircuits,
    phaseBRuns,
    phaseC,
  };
}
