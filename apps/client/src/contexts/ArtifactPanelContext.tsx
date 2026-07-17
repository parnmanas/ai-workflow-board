import React, { createContext, useCallback, useContext, useMemo, useReducer } from 'react';
import {
  ArtifactRef,
  artifactPanelReducer,
  initialArtifactPanelState,
} from './artifactPanel';

/**
 * Artifact 패널 React 레이어 (에픽 bf65ca00 · Phase 1 · S1 공통 셸).
 *
 * 전역 셸(AppLayout) 하나만 이 프로바이더를 마운트하고, 채팅 카드(S2/S3)·딥링크가
 * openArtifact() 로 우측 패널을 구동한다. 순수 상태 전이는 ./artifactPanel 에 있고
 * 여기서는 프로바이더/훅만 담당한다.
 */

export type { ArtifactRef } from './artifactPanel';

interface ArtifactPanelContextValue {
  open: boolean;
  artifact: ArtifactRef | null;
  /** 대상을 지정해 패널을 연다(같은 key 재오픈 시 내용 갱신). */
  openArtifact: (artifact: ArtifactRef) => void;
  /** 패널을 접는다(내용은 유지). */
  closeArtifact: () => void;
  /** 열림 토글(빈 상태로도 열 수 있음 — 셸 상단 토글 버튼용). */
  toggleArtifact: () => void;
}

const ArtifactPanelContext = createContext<ArtifactPanelContextValue | undefined>(undefined);

export function ArtifactPanelProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(artifactPanelReducer, initialArtifactPanelState);

  const openArtifact = useCallback((artifact: ArtifactRef) => dispatch({ type: 'open', artifact }), []);
  const closeArtifact = useCallback(() => dispatch({ type: 'close' }), []);
  const toggleArtifact = useCallback(() => dispatch({ type: 'toggle' }), []);

  const value = useMemo(
    () => ({ open: state.open, artifact: state.artifact, openArtifact, closeArtifact, toggleArtifact }),
    [state.open, state.artifact, openArtifact, closeArtifact, toggleArtifact],
  );

  return <ArtifactPanelContext.Provider value={value}>{children}</ArtifactPanelContext.Provider>;
}

export function useArtifactPanel(): ArtifactPanelContextValue {
  const ctx = useContext(ArtifactPanelContext);
  if (!ctx) throw new Error('useArtifactPanel must be used within an ArtifactPanelProvider');
  return ctx;
}
