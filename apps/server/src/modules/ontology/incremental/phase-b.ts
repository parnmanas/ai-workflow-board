// Phase B(ticket 964014f5, DESIGN.md 축 4) — Phase A의 판정을 받아 필요할
// 때만(시그니처 변경, 또는 rename/신규파일이면 무조건 — REVIEW-NOTES.md
// I2) reverse-index로 영향받는 파일을 찾고, resolve.ts의 scopeFilePaths로
// 그 파일들 + (rename/신규파일이면) 변경된 파일 자신의 outgoing refs만
// 재해소한다. Phase A가 shortCircuit=true를 반환했으면 이 함수 자체를
// 호출할 필요가 없다(완료조건 1 — "다른 파일 안 건드리고 조기 종료").
import type { DataSource } from 'typeorm';
import { findAffectedFilePaths } from './reverse-lookup';
import { resolveCrossFileEdges, type ResolveSummary } from '../resolver/resolve';
import type { PhaseAResult } from './phase-a';

export interface PhaseBInput {
  graphId: string;
  workspaceId: string;
  commit: string;
  extractionRunId: string;
  /** Phase A가 방금 처리한 파일의 현재(새) 경로. */
  changedFilePath: string;
  phaseA: PhaseAResult;
}

export interface PhaseBResult {
  ran: boolean;
  scopeFilePaths: string[];
  summary: ResolveSummary | null;
}

export async function runPhaseB(dataSource: DataSource, input: PhaseBInput): Promise<PhaseBResult> {
  const { phaseA } = input;
  if (phaseA.shortCircuit) return { ran: false, scopeFilePaths: [], summary: null };

  const scope = new Set<string>();
  // REVIEW-NOTES.md I2 — rename/신규파일은 signature_hash 변화와 무관하게
  // 자기 자신의 outgoing refs를 무조건 재해소한다(same-module/import-suffix
  // 캐스케이드 tier가 파일 위치 상대적이라, 내용이 안 바뀌어도 이동만으로
  // 해소 대상이 조용히 달라질 수 있다).
  if (phaseA.isRename || phaseA.isNewFile) scope.add(input.changedFilePath);

  if (phaseA.changedSymbolIds.length > 0) {
    const affected = await findAffectedFilePaths(dataSource, input.graphId, phaseA.changedSymbolIds, {
      changeOriginatesInDurablePartition: phaseA.fileDurability !== 'volatile',
    });
    for (const p of affected) scope.add(p);
  }

  if (scope.size === 0) return { ran: false, scopeFilePaths: [], summary: null };

  const summary = await resolveCrossFileEdges(dataSource, {
    graphId: input.graphId,
    workspaceId: input.workspaceId,
    commit: input.commit,
    extractionRunId: input.extractionRunId,
    scopeFilePaths: scope,
  });
  return { ran: true, scopeFilePaths: [...scope], summary };
}
