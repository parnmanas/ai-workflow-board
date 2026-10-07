import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { tokens } from '../../tokens';

/**
 * 세션 헤더의 햄버거 메뉴.
 *
 * 헤더에는 매 턴 보는 것(상태 · mode · model · effort)만 남기고, 가끔 보는 정보(폴더 · 세션 id ·
 * 로그인)와 가끔 쓰는 동작(재시작 · 다시 읽기 · 새 세션 …)은 여기로 접는다 — 예전엔 전부 한 줄에
 * 늘어놓아 제목·폴더 길이와 화면 폭에 따라 헤더가 매번 다른 모양으로 접혔다.
 *
 * HeaderOverflowMenu 와 달리 안에 설정 컨트롤이 있어서 항목을 누를 때마다 닫지 않는다.
 * 동작 항목은 넘겨받은 `close` 로 스스로 닫는다. 바깥 클릭 · Esc 로 닫힌다.
 */
export default function SessionHeaderMenu({ children, label = 'Session menu' }: {
  children: (close: () => void) => React.ReactNode;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: Event) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="awb-session-menu">
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((v) => !v)}
        className="awb-session-menu-trigger"
        style={{
          background: open ? tokens.colors.surfaceHover : 'transparent',
          border: `1px solid ${open ? tokens.colors.accent : tokens.colors.border}`,
          borderRadius: tokens.radii.md,
          color: open ? tokens.colors.textPrimary : tokens.colors.textSecondary,
        }}
      >
        <span aria-hidden="true">☰</span>
      </button>
      {open && (
        <div
          id={panelId}
          aria-label={label}
          className="awb-session-menu-panel"
          style={{
            background: tokens.colors.surfaceCard,
            border: `1px solid ${tokens.colors.border}`,
            borderRadius: tokens.radii.lg,
            boxShadow: tokens.shadows.dropdown,
          }}
        >
          {children(close)}
        </div>
      )}
    </div>
  );
}

/** 메뉴 안의 구획 — 제목 한 줄 + 내용. */
export function SessionMenuSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="awb-session-menu-section" style={{ borderBottom: `1px solid ${tokens.colors.border}` }}>
      <h3 style={{ color: tokens.colors.textMuted }}>{title}</h3>
      {children}
    </section>
  );
}

/** 메뉴의 동작 한 줄 — 누르면 메뉴를 닫고 실행한다. */
export function SessionMenuItem({ icon, label, title, disabled, pressed, onSelect }: {
  icon: string;
  label: string;
  title?: string;
  disabled?: boolean;
  pressed?: boolean;
  onSelect(): void;
}) {
  return (
    <button
      type="button"
      className="awb-session-menu-item"
      title={title}
      disabled={disabled}
      aria-pressed={pressed}
      onClick={onSelect}
      style={{ color: disabled ? tokens.colors.textMuted : tokens.colors.textPrimary }}
    >
      <span aria-hidden="true" className="awb-session-menu-icon">{icon}</span>
      {label}
    </button>
  );
}
