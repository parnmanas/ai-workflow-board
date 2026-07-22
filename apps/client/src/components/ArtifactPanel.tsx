import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useArtifactPanel } from '../contexts/ArtifactPanelContext';
import type { ArtifactRef } from '../contexts/artifactPanel';
import {
  ARTIFACT_PANEL_DEFAULT_WIDTH,
  clampArtifactPanelWidth,
} from '../contexts/artifactPanel';
import { tokens } from '../tokens';
import { useDialogFocus } from './useDialogFocus';

/**
 * 우측 Artifact 패널 프레임 (에픽 bf65ca00 · Phase 1 · S1 공통 셸).
 *
 * 대화 맥락을 유지한 채 티켓/결과물 상세를 여는 우측 패널의 셸이다. S1 은
 * 프레임(열림/접힘)·반응형·기본 접근성과 빈 상태를 제공하고, 실제 티켓 상세
 * 내용은 S3 에서 openArtifact({ node }) 로 주입된다.
 *
 * - 데스크톱: 본문 오른쪽에 나란히 놓이는 영역(role=complementary). 대화 폭을
 *   밀어 좁히되 대화는 계속 보인다(비모달).
 * - 모바일: 우측에서 슬라이드되는 오버레이 시트(role=dialog·백드롭·Esc).
 *
 * 컨테이너/뷰 분리: 렌더는 순수 <ArtifactPanelView>(상태를 props 로 받음)로 빼서
 * react-dom/server 로 상태별 렌더 계약을 회귀 테스트한다(jsdom 없이). 포커스·Esc
 * 같은 부수효과와 컨텍스트 연결은 이 컨테이너가 담당한다.
 *
 * 창 크기 조절(티켓 7815a958): 데스크톱 비모달 패널만 좌측 가장자리 드래그로 폭을
 * 조절한다(모바일은 오버레이 시트라 대상 아님). 드래그 상태·localStorage 영속은
 * 컨테이너가 담당하고, 뷰는 현재 폭과 핸들 이벤트 콜백만 props 로 받는다.
 */

interface ArtifactPanelViewProps {
  open: boolean;
  artifact: ArtifactRef | null;
  isMobile: boolean;
  onClose: () => void;
  closeButtonRef?: React.Ref<HTMLButtonElement>;
  // 모바일 모달 시트의 컨테이너 ref — 컨테이너가 Tab 포커스 트랩을 걸기 위해 쓴다.
  panelRef?: React.Ref<HTMLElement>;
  // 데스크톱 패널 폭(px). 모바일에선 쓰이지 않는다(고정 오버레이 시트).
  width?: number;
  onResizeHandleMouseDown?: (e: React.MouseEvent) => void;
  onResizeHandleDoubleClick?: () => void;
  onResizeHandleKeyDown?: (e: React.KeyboardEvent) => void;
}

/** 순수 표현 컴포넌트 — 부수효과 없음. 상태는 전부 props 로 받는다. */
export function ArtifactPanelView({
  open,
  artifact,
  isMobile,
  onClose,
  closeButtonRef,
  panelRef,
  width = ARTIFACT_PANEL_DEFAULT_WIDTH,
  onResizeHandleMouseDown,
  onResizeHandleDoubleClick,
  onResizeHandleKeyDown,
}: ArtifactPanelViewProps) {
  if (!open) return null;

  const ariaLabel = artifact?.title ? `${artifact.title} 상세` : 'Artifact 패널';

  const header = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing.sm,
        padding: '12px 16px',
        borderBottom: `1px solid ${tokens.colors.border}`,
        flexShrink: 0,
      }}
    >
      <div
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: tokens.typography.fontSizeLg,
          fontWeight: 700,
          color: tokens.colors.textPrimary,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {artifact?.title ?? 'Artifact'}
      </div>
      <button
        ref={closeButtonRef}
        type="button"
        onClick={onClose}
        aria-label="Artifact 패널 닫기"
        style={{
          width: 28,
          height: 28,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'transparent',
          border: `1px solid ${tokens.colors.border}`,
          borderRadius: tokens.radii.md,
          color: tokens.colors.textSecondary,
          cursor: 'pointer',
          fontSize: 16,
          lineHeight: 1,
          fontFamily: 'inherit',
          flexShrink: 0,
        }}
      >
        {'×'}
      </button>
    </div>
  );

  const body = (
    <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
      {artifact?.node ?? (
        <div
          style={{
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: tokens.spacing.sm,
            padding: tokens.spacing.xl,
            textAlign: 'center',
          }}
        >
          <div
            aria-hidden="true"
            style={{
              width: 40,
              height: 40,
              borderRadius: tokens.radii.lg,
              background: `${tokens.colors.border}60`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 18,
              color: tokens.colors.textSecondary,
            }}
          >
            {'◫'}
          </div>
          <div style={{ fontSize: tokens.typography.fontSizeLg, fontWeight: 600, color: tokens.colors.textSecondary }}>
            선택된 항목이 없습니다
          </div>
          <div
            style={{
              fontSize: tokens.typography.fontSizeMd,
              color: tokens.colors.textMuted,
              lineHeight: tokens.typography.lineHeightBody,
              maxWidth: 260,
            }}
          >
            채팅에서 티켓이나 결과물을 선택하면 여기에서 상세를 확인·처리할 수 있습니다.
          </div>
        </div>
      )}
    </div>
  );

  if (isMobile) {
    // 모바일: 모달 오버레이 시트. 백드롭 클릭·Esc 로 닫힌다.
    return (
      <>
        <div
          onClick={onClose}
          aria-hidden="true"
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1199 }}
        />
        <aside
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label={ariaLabel}
          style={{
            position: 'fixed',
            top: 0,
            right: 0,
            bottom: 0,
            width: 'min(420px, 92vw)',
            zIndex: 1200,
            background: tokens.colors.surfaceCard,
            borderLeft: `1px solid ${tokens.colors.border}`,
            boxShadow: tokens.shadows.panel,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {header}
          {body}
        </aside>
      </>
    );
  }

  // 데스크톱: 본문 옆 비모달 영역. 대화는 좁아지되 계속 보인다.
  // maxWidth: '80vw' 는 localStorage 에 저장된 폭이 이후 더 좁은 화면에서 복원돼도
  // 본문(awb-main)이 찌그러지지 않게 하는 안전판(수용기준 #6) — width 자체의
  // min/max clamp(ARTIFACT_PANEL_MIN/MAX_WIDTH)와는 별개로 항상 적용된다.
  return (
    <aside
      role="complementary"
      aria-label={ariaLabel}
      style={{
        position: 'relative',
        width,
        maxWidth: '80vw',
        flexShrink: 0,
        background: tokens.colors.surfaceCard,
        borderLeft: `1px solid ${tokens.colors.border}`,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      {onResizeHandleMouseDown && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Artifact 패널 폭 조절"
          aria-valuenow={Math.round(width)}
          tabIndex={0}
          onMouseDown={onResizeHandleMouseDown}
          onDoubleClick={onResizeHandleDoubleClick}
          onKeyDown={onResizeHandleKeyDown}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: 6,
            cursor: 'col-resize',
            zIndex: 1,
          }}
        />
      )}
      {header}
      {body}
    </aside>
  );
}

// 폭 영속 키. 세션 내 유지는 React state 로 이미 되고, 여기 저장은 "다음 방문에도
// 유지"(수용기준 #5) 담당 — NotificationContext 의 loadPrefs/savePrefs 와 동일하게
// 브라우저 전역 localStorage 를 직접 쓰고 quota/private-mode 는 조용히 무시한다.
const WIDTH_STORAGE_KEY = 'awb.artifactPanel.width';

function loadStoredWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_STORAGE_KEY);
    return raw ? clampArtifactPanelWidth(Number(raw)) : ARTIFACT_PANEL_DEFAULT_WIDTH;
  } catch {
    return ARTIFACT_PANEL_DEFAULT_WIDTH;
  }
}

function saveStoredWidth(width: number) {
  try {
    localStorage.setItem(WIDTH_STORAGE_KEY, String(width));
  } catch {
    /* quota / private mode — 세션 내 React state 는 계속 유지되니 무시해도 안전 */
  }
}

/** 컨텍스트 연결 + 부수효과(포커스 이동·Esc·리사이즈). 실제 셸에 마운트되는 컴포넌트. */
export default function ArtifactPanel({ isMobile }: { isMobile: boolean }) {
  const { open, artifact, closeArtifact } = useArtifactPanel();
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState<number>(loadStoredWidth);

  // 좌측 가장자리 드래그로 폭 조절. 패널이 화면 우측에 고정돼 있어 포인터가 왼쪽으로
  // 갈수록(startX - clientX 가 커질수록) 폭이 늘어난다. useDragToScroll(보드 가로
  // 스크롤 팬)과 동일하게 순수 클로저 변수 + window 리스너로 구동하고, mouseup 에서만
  // localStorage 에 쓴다(매 프레임 쓰기는 낭비 + 불필요한 I/O).
  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    let latest = startWidth;
    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (ev: MouseEvent) => {
      latest = clampArtifactPanelWidth(startWidth + (startX - ev.clientX));
      setWidth(latest);
    };
    const onMouseUp = () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      saveStoredWidth(latest);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, [width]);

  // 더블클릭으로 기본폭 복귀 — react-resizable-panels Separator 의 관례(Board/Chat
  // 리사이저)와 동일한 기대치를 준다.
  const handleResizeDoubleClick = useCallback(() => {
    setWidth(ARTIFACT_PANEL_DEFAULT_WIDTH);
    saveStoredWidth(ARTIFACT_PANEL_DEFAULT_WIDTH);
  }, []);

  // 키보드 접근성 — 좌/우 화살표로 16px 씩 조절(ARIA separator 관례).
  const handleResizeKeyDown = useCallback((e: React.KeyboardEvent) => {
    const STEP = 16;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const sign = e.key === 'ArrowLeft' ? 1 : -1;
    setWidth((w) => {
      const next = clampArtifactPanelWidth(w + sign * STEP);
      saveStoredWidth(next);
      return next;
    });
  }, []);

  // 초기 포커스(닫기 버튼)·opener 복귀·모바일 Tab 트랩을 공용 훅으로 통일한다(F2-5).
  // 데스크톱 비모달 패널에는 트랩을 걸지 않는다(trap=isMobile). artifact.key 전환 시
  // opener 는 유지한 채 닫기 버튼으로 재포커스.
  useDialogFocus({
    active: open,
    trap: isMobile,
    containerRef: panelRef,
    initialFocusRef: closeBtnRef,
    focusKey: artifact?.key,
  });

  // Esc 로 닫기(패널이 열려 있을 때만 바인딩).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeArtifact();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closeArtifact]);

  return (
    <ArtifactPanelView
      open={open}
      artifact={artifact}
      isMobile={isMobile}
      onClose={closeArtifact}
      closeButtonRef={closeBtnRef}
      panelRef={panelRef}
      width={width}
      onResizeHandleMouseDown={isMobile ? undefined : handleResizeMouseDown}
      onResizeHandleDoubleClick={isMobile ? undefined : handleResizeDoubleClick}
      onResizeHandleKeyDown={isMobile ? undefined : handleResizeKeyDown}
    />
  );
}

/**
 * 셸 상단(Chat-first 톱바)에서 Artifact 패널을 열고 닫는 토글.
 * 반드시 <ArtifactPanelProvider> 하위에서 렌더된다.
 */
export function ArtifactToggleButton() {
  const { open, toggleArtifact } = useArtifactPanel();
  return (
    <button
      type="button"
      onClick={toggleArtifact}
      aria-pressed={open}
      aria-label="Artifact 패널 열기/닫기"
      title="Artifact 패널"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 28,
        padding: '0 10px',
        background: open ? tokens.colors.accent : 'transparent',
        color: open ? '#fff' : tokens.colors.textSecondary,
        border: `1px solid ${open ? tokens.colors.accent : tokens.colors.border}`,
        borderRadius: tokens.radii.md,
        cursor: 'pointer',
        fontSize: 14,
        fontWeight: 600,
        fontFamily: 'inherit',
        flexShrink: 0,
      }}
    >
      <span aria-hidden="true">{'◫'}</span>
    </button>
  );
}
