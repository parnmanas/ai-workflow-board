import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { tokens } from '../../tokens';

/**
 * 공용 헤더 액션 컴포넌트 (board-ux-guidelines §2).
 *
 * `headerActionStyle` 인라인 스타일이 Board.tsx / BenchmarkLeaderboardPage.tsx 에
 * 복제돼 있던 것을 단일 컴포넌트로 추출한 것. hover/active/disabled/state-active
 * 동작과 좁은 폭 icon-only 축약, 토큰 일관 적용을 한곳에서 책임진다.
 *
 * 렌더 타깃 추상화: `to`(라우터 Link) 또는 `onClick`(button) 중 하나를 받아
 * 동일한 시각 스타일로 렌더한다. disabled 면 둘 다 차단한다.
 */

export type HeaderActionVariant = 'default' | 'primary' | 'state-active';

export interface HeaderActionProps {
  /** emoji 식별자 (§2.3 매핑 표 기준). icon-only 축약 시에도 유지. */
  icon: string;
  /** 사람이 읽는 라벨. collapsed 여도 aria-label/title 로 항상 동반. */
  label: string;
  /** 라우터 Link 타깃. onClick 과 둘 중 하나. */
  to?: string;
  /** 버튼 클릭 핸들러. to 와 둘 중 하나. */
  onClick?: () => void;
  variant?: HeaderActionVariant;
  /**
   * state-active 강조에 쓸 채움 색. 의미에 맞는 토큰을 받는다
   * (paused → warning, danger, success 등). 기본 warning.
   */
  stateColor?: string;
  /** 좁은 폭에서 라벨을 숨기고 아이콘만 남긴다. aria-label/title 은 유지. */
  collapsed?: boolean;
  disabled?: boolean;
  /** 현재 위치한 섹션이면 aria-current + accent 보더로 표시. */
  current?: boolean;
  /** overflow 드롭다운 안의 세로 리스트 항목으로 렌더 (full-width, 좌측 정렬). */
  menuItem?: boolean;
  /** title 오버라이드 (기본은 label). */
  title?: string;
}

export function HeaderAction({
  icon,
  label,
  to,
  onClick,
  variant = 'default',
  stateColor = tokens.colors.warning,
  collapsed = false,
  disabled = false,
  current = false,
  menuItem = false,
  title,
}: HeaderActionProps) {
  const [hovered, setHovered] = useState(false);

  const baseStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: menuItem ? 'flex-start' : 'center',
    gap: tokens.spacing.sm,
    padding: menuItem ? '8px 12px' : '6px 14px',
    width: menuItem ? '100%' : undefined,
    borderRadius: menuItem ? tokens.radii.md : tokens.radii.lg,
    background: tokens.colors.surfaceCard,
    border: `1px solid ${tokens.colors.border}`,
    fontSize: tokens.typography.fontSizeMd,
    color: tokens.colors.textSecondary,
    textDecoration: 'none',
    fontWeight: 500,
    fontFamily: 'inherit',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    boxSizing: 'border-box',
    transition: 'background 0.15s, color 0.15s, border-color 0.15s, opacity 0.15s',
  };

  // menuItem 은 드롭다운 배경 위에 얹히므로 평면 배경/무보더로 둔다.
  if (menuItem) {
    baseStyle.background = 'transparent';
    baseStyle.border = '1px solid transparent';
  }

  if (variant === 'primary') {
    baseStyle.background = tokens.colors.surfaceCard;
    baseStyle.border = `1px solid ${tokens.colors.accent}`;
    baseStyle.color = tokens.colors.textPrimary;
  }

  if (variant === 'state-active') {
    // 채워진 강조 버튼: #fff 텍스트는 §2.2 명시 예외로 허용.
    baseStyle.background = stateColor;
    baseStyle.color = '#fff';
    baseStyle.border = '1px solid transparent';
    baseStyle.fontWeight = 600;
  }

  // 현재 섹션 표시 (state-active 채움보다 우선순위 낮음).
  if (current && variant !== 'state-active') {
    baseStyle.border = `1px solid ${tokens.colors.accent}`;
    baseStyle.color = tokens.colors.textPrimary;
  }

  // hover 피드백 (default/primary 한정 — 채움 버튼은 색 유지).
  if (hovered && !disabled && variant !== 'state-active') {
    baseStyle.background = tokens.colors.surfaceHover;
    baseStyle.color = tokens.colors.textPrimary;
  }

  if (disabled) {
    baseStyle.opacity = 0.5;
    baseStyle.cursor = 'not-allowed';
    baseStyle.pointerEvents = 'none';
  }

  const content = (
    <>
      <span aria-hidden="true">{icon}</span>
      {!collapsed && <span>{label}</span>}
    </>
  );

  const shared = {
    style: baseStyle,
    title: title ?? label,
    'aria-label': label,
    'aria-current': current ? ('page' as const) : undefined,
    // Link 이동 시에도 onClick 이 먼저 실행돼야 overflow 메뉴가 닫힌다.
    onClick,
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
  };

  // 라우팅 액션. disabled 면 Link 대신 비활성 버튼으로 떨궈 이동을 막는다.
  if (to && !disabled) {
    return (
      <Link to={to} {...shared}>
        {content}
      </Link>
    );
  }

  return (
    <button type="button" disabled={disabled} {...shared}>
      {content}
    </button>
  );
}
