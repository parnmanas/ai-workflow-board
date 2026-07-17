import React, { createContext, useCallback, useContext, useState } from 'react';
import { ViewMode, readInitialMode, persistMode } from './viewMode';

/**
 * ViewMode React 레이어 (에픽 bf65ca00 · Phase 1 · S1 공통 셸).
 *
 * 기본 경험을 대화 중심(Chat-first)으로 두고, 기존 Board 중심 경험은 Advanced 로
 * 유지·전환한다. 순수 로직(지속·기본값·기본 섹션)은 ./viewMode 에 분리되어 있고
 * 여기서는 프로바이더/훅만 담당한다. 소비자 편의를 위해 순수 헬퍼를 재노출한다.
 */

export type { ViewMode } from './viewMode';
export { readInitialMode, persistMode, defaultSectionForMode } from './viewMode';

interface ViewModeContextValue {
  mode: ViewMode;
  setMode: (m: ViewMode) => void;
  toggle: () => void;
}

const ViewModeContext = createContext<ViewModeContextValue | undefined>(undefined);

export function ViewModeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ViewMode>(readInitialMode);

  const setMode = useCallback((m: ViewMode) => {
    setModeState(m);
    persistMode(m);
  }, []);

  const toggle = useCallback(() => {
    setModeState((prev) => {
      const next: ViewMode = prev === 'chat' ? 'advanced' : 'chat';
      persistMode(next);
      return next;
    });
  }, []);

  return (
    <ViewModeContext.Provider value={{ mode, setMode, toggle }}>
      {children}
    </ViewModeContext.Provider>
  );
}

export function useViewMode(): ViewModeContextValue {
  const ctx = useContext(ViewModeContext);
  if (!ctx) throw new Error('useViewMode must be used within a ViewModeProvider');
  return ctx;
}
