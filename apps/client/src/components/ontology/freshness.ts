// Ontology Graph 프레시니스 배지 순수 로직 (ticket d22b83b4, DESIGN.md 축 5).
//
// research-ontology.md §8.6 point 6: "Track dirty_ratio per graph; the UI
// shows 'graph is 96% fresh as of <sha>'" — 이 카피 패턴은 재사용하되,
// dirty_ratio는 incremental scheduler(ticket 964014f5)가 아직 어떤 실
// 트리거에도 배선돼 있지 않아(그 서비스 파일 헤더 코멘트 참고) 오늘은
// 거의 항상 null/0으로 나온다. dirty_ratio 하나만으로 "N% fresh"를 표시하면
// 실제로는 수십 커밋 뒤처진 그래프도 "100% fresh"로 보이는, DESIGN.md 축5가
// 명시적으로 경계하는 "조용히 stale한데 신뢰할 만해 보이는" 상황을 만든다.
// 그래서 이 모듈은 두 신호를 분리해서 보여준다 — dirty_ratio 기반 헤드라인
// (있을 때만) + countBehindAhead 기반 커밋 드리프트(있을 때만, 완료조건 2가
// 요구하는 "실제 HEAD 대비 커밋 차이") — 하나의 가짜 통합 퍼센트로 뭉개지
// 않는다.
export type OntologyGraphStatusValue = 'building' | 'ready' | 'stale' | 'error';

export interface FreshnessInput {
  status: OntologyGraphStatusValue;
  indexedAt: string | null;
  commit: string;
  behind: number | null;
  ahead: number | null;
  dirtyRatio: number | null;
  freshnessError: string | null;
}

export type FreshnessTone = 'building' | 'fresh' | 'stale' | 'error' | 'unknown';

export interface FreshnessBadge {
  tone: FreshnessTone;
  /** 항상 표시하는 한 줄 헤드라인. */
  headline: string;
  /** 있을 때만 보조로 표시하는 둘째 줄(예: 커밋 드리프트). */
  detail: string | null;
}

function shortSha(commit: string): string {
  return commit ? commit.slice(0, 7) : '';
}

/** dirty_ratio(0..1, stale 엣지 비율) → "N% fresh" 정수 퍼센트. */
export function dirtyRatioToFreshPercent(dirtyRatio: number): number {
  return Math.round((1 - dirtyRatio) * 100);
}

export function freshnessBadge(input: FreshnessInput): FreshnessBadge {
  if (input.status === 'error') {
    return { tone: 'error', headline: 'Graph build failed', detail: null };
  }
  if (input.status === 'building' || !input.commit) {
    return { tone: 'building', headline: 'Building graph…', detail: null };
  }

  const sha = shortSha(input.commit);
  const driftDetail = input.freshnessError
    ? `Unable to check current HEAD (${input.freshnessError})`
    : input.behind == null
    ? null
    : input.behind === 0
    ? 'Up to date with current HEAD'
    : `${input.behind} commit${input.behind === 1 ? '' : 's'} behind current HEAD`;

  if (input.dirtyRatio != null) {
    const pct = dirtyRatioToFreshPercent(input.dirtyRatio);
    return {
      tone: input.dirtyRatio > 0 || (input.behind ?? 0) > 0 ? 'stale' : 'fresh',
      headline: `Graph is ${pct}% fresh as of ${sha}`,
      detail: driftDetail,
    };
  }

  // dirty_ratio를 아직 측정할 수 없다(엣지가 없거나 스케줄러 미배선) —
  // 커밋 드리프트만으로 헤드라인을 구성한다.
  if (input.behind == null) {
    return { tone: 'unknown', headline: `Indexed at ${sha}`, detail: driftDetail };
  }
  if (input.behind === 0) {
    return { tone: 'fresh', headline: `Graph is up to date as of ${sha}`, detail: null };
  }
  return {
    tone: 'stale',
    headline: `Graph is ${input.behind} commit${input.behind === 1 ? '' : 's'} behind HEAD (indexed at ${sha})`,
    detail: null,
  };
}
