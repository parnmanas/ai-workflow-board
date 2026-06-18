import React, { useEffect, useRef, useState } from 'react';
import { tokens } from '../../tokens';
import { HeaderAction } from './HeaderAction';

/**
 * 헤더 액션 overflow 드롭다운 (board-ux-guidelines §1.4).
 *
 * `⋯` 트리거를 클릭(또는 키보드 Enter/Space)하면 헤더 아래 우측 정렬로 세로
 * 리스트를 연다. 바깥 클릭 / Esc 로 닫힌다. 메뉴 항목은 동일한 HeaderAction
 * 규약(menuItem 변형)을 따른다.
 *
 * children 으로 HeaderAction(menuItem) 들을 받는다. 항목 클릭/이동 시
 * 메뉴를 자동으로 닫도록 onClick 을 한 겹 감싼다.
 */

export interface HeaderOverflowMenuProps {
  children: React.ReactNode;
  /** 접근성 라벨 (기본 "More actions"). */
  label?: string;
}

export function HeaderOverflowMenu({ children, label = 'More actions' }: HeaderOverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const triggerStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '6px 14px',
    borderRadius: tokens.radii.lg,
    background: open || hovered ? tokens.colors.surfaceHover : tokens.colors.surfaceCard,
    border: `1px solid ${open ? tokens.colors.accent : tokens.colors.border}`,
    fontSize: tokens.typography.fontSizeMd,
    color: open || hovered ? tokens.colors.textPrimary : tokens.colors.textSecondary,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    lineHeight: 1,
    transition: 'background 0.15s, color 0.15s, border-color 0.15s',
  };

  const menuStyle: React.CSSProperties = {
    position: 'absolute',
    top: 'calc(100% + 6px)',
    right: 0,
    minWidth: 180,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    padding: tokens.spacing.xs,
    background: tokens.colors.surfaceCard,
    border: `1px solid ${tokens.colors.border}`,
    borderRadius: tokens.radii.lg,
    boxShadow: tokens.shadows.dropdown,
    zIndex: 50,
  };

  // 항목 클릭 시 메뉴를 닫는다 (Link 이동/onClick 양쪽 모두).
  const wrappedChildren = React.Children.map(children, (child) => {
    if (!React.isValidElement(child)) return child;
    const childProps = child.props as { onClick?: () => void };
    return React.cloneElement(child as React.ReactElement<{ onClick?: () => void }>, {
      onClick: () => {
        childProps.onClick?.();
        setOpen(false);
      },
    });
  });

  return (
    <div ref={containerRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        style={triggerStyle}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={() => setOpen((v) => !v)}
      >
        ⋯
      </button>
      {open && (
        <div role="menu" style={menuStyle}>
          {wrappedChildren}
        </div>
      )}
    </div>
  );
}
