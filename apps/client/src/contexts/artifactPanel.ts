/**
 * Artifact 패널 순수 로직 (에픽 bf65ca00 · Phase 1 · S1 공통 셸).
 *
 * 우측 Artifact 패널의 열림/내용 상태를 컴포넌트에서 분리해 node:test 로 직접
 * 구동한다(contexts/viewMode.ts 선례, 루트 CLAUDE.md: 레포에 jsdom 없음).
 * S1 은 프레임과 상태 전이만 제공하고, 실제 티켓 상세 내용(node)은 S3 에서
 * openArtifact() 로 주입된다 — 그때 이 리듀서는 변경 없이 재사용된다.
 */
import type { ReactNode } from 'react';

/** 패널에 표시할 대상 서술자. node 는 실제 렌더 내용(S3 의 TicketPanel 등). */
export interface ArtifactRef {
  /** 안정 식별자 — 같은 대상 재오픈 감지·딥링크 정합(S3)에 사용. */
  key: string;
  /** 패널 헤더 제목. */
  title: string;
  /** 본문 렌더 노드. 생략하면 빈 상태를 표시한다. */
  node?: ReactNode;
}

export interface ArtifactPanelState {
  open: boolean;
  artifact: ArtifactRef | null;
}

export type ArtifactPanelAction =
  | { type: 'open'; artifact: ArtifactRef }
  | { type: 'close' }
  | { type: 'toggle' };

export const initialArtifactPanelState: ArtifactPanelState = {
  open: false,
  artifact: null,
};

/**
 * 패널 상태 리듀서.
 * - open   : 패널을 열고 대상을 교체(같은 key 를 다시 열어도 최신 서술자로 갱신).
 * - close  : 숨김. artifact 는 유지해 닫힘 애니메이션/재오픈 시 빈 화면 깜빡임을 막는다.
 * - toggle : 열림 상태만 뒤집는다(대상이 없으면 빈 상태로 열림).
 */
export function artifactPanelReducer(
  state: ArtifactPanelState,
  action: ArtifactPanelAction,
): ArtifactPanelState {
  switch (action.type) {
    case 'open':
      return { open: true, artifact: action.artifact };
    case 'close':
      return state.open ? { ...state, open: false } : state;
    case 'toggle':
      return { ...state, open: !state.open };
    default:
      return state;
  }
}

/**
 * Artifact 패널 폭 조절(티켓 7815a958) — 순수 clamp 로직만 여기 둔다. 드래그
 * 이벤트·localStorage I/O 는 컴포넌트(ArtifactPanel.tsx)가 담당(컨테이너/뷰 분리 선례).
 */
export const ARTIFACT_PANEL_MIN_WIDTH = 280;
export const ARTIFACT_PANEL_MAX_WIDTH = 720;
export const ARTIFACT_PANEL_DEFAULT_WIDTH = 380;

/** 유효하지 않은 값(NaN·Infinity 등)은 기본폭으로, 그 외엔 min/max 사이로 clamp. */
export function clampArtifactPanelWidth(width: number): number {
  if (!Number.isFinite(width)) return ARTIFACT_PANEL_DEFAULT_WIDTH;
  return Math.min(ARTIFACT_PANEL_MAX_WIDTH, Math.max(ARTIFACT_PANEL_MIN_WIDTH, Math.round(width)));
}
