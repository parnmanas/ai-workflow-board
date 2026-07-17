import React, { useEffect, useRef } from 'react';
import { useArtifactPanel } from '../contexts/ArtifactPanelContext';
import type { ArtifactRef } from '../contexts/artifactPanel';
import { tokens } from '../tokens';
import { nextFocusableIndex, FOCUSABLE_SELECTOR } from './focusTrap';

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
 */

interface ArtifactPanelViewProps {
  open: boolean;
  artifact: ArtifactRef | null;
  isMobile: boolean;
  onClose: () => void;
  closeButtonRef?: React.Ref<HTMLButtonElement>;
  // 모바일 모달 시트의 컨테이너 ref — 컨테이너가 Tab 포커스 트랩을 걸기 위해 쓴다.
  panelRef?: React.Ref<HTMLElement>;
}

/** 순수 표현 컴포넌트 — 부수효과 없음. 상태는 전부 props 로 받는다. */
export function ArtifactPanelView({ open, artifact, isMobile, onClose, closeButtonRef, panelRef }: ArtifactPanelViewProps) {
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
  return (
    <aside
      role="complementary"
      aria-label={ariaLabel}
      style={{
        width: 380,
        flexShrink: 0,
        background: tokens.colors.surfaceCard,
        borderLeft: `1px solid ${tokens.colors.border}`,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      {header}
      {body}
    </aside>
  );
}

/** 컨텍스트 연결 + 부수효과(포커스 이동·Esc). 실제 셸에 마운트되는 컴포넌트. */
export default function ArtifactPanel({ isMobile }: { isMobile: boolean }) {
  const { open, artifact, closeArtifact } = useArtifactPanel();
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  // 패널을 연 요소(카드/토글)를 기억해 두었다가 닫힐 때 포커스를 되돌린다 — 기본 a11y.
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // 열릴 때(또는 대상이 바뀔 때) 닫기 버튼으로 포커스 이동, 닫힐 때 opener 로 복귀.
  useEffect(() => {
    if (open) {
      // opener 는 최초 열림에만 기억한다(대상 전환 시 닫기버튼으로 덮어쓰지 않도록).
      if (!restoreFocusRef.current && typeof document !== 'undefined') {
        restoreFocusRef.current = document.activeElement as HTMLElement | null;
      }
      closeBtnRef.current?.focus();
    } else {
      const opener = restoreFocusRef.current;
      restoreFocusRef.current = null;
      opener?.focus?.();
    }
  }, [open, artifact?.key]);

  // Esc 로 닫기(패널이 열려 있을 때만 바인딩).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeArtifact();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closeArtifact]);

  // 모바일 모달(role=dialog·aria-modal)에서 Tab 포커스 트랩 — 배경으로 새지 않고 시트
  // 내부 포커스 가능한 요소를 순환한다. 데스크톱 비모달 패널에는 걸지 않는다.
  useEffect(() => {
    if (!open || !isMobile) return;
    const el = panelRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const nodes = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (n) => !n.hasAttribute('disabled') && n.tabIndex !== -1,
      );
      if (nodes.length === 0) return;
      const current = nodes.indexOf(document.activeElement as HTMLElement);
      const next = nextFocusableIndex(nodes.length, current, e.shiftKey);
      e.preventDefault();
      nodes[next]?.focus();
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [open, isMobile, artifact?.key]);

  return (
    <ArtifactPanelView
      open={open}
      artifact={artifact}
      isMobile={isMobile}
      onClose={closeArtifact}
      closeButtonRef={closeBtnRef}
      panelRef={panelRef}
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
