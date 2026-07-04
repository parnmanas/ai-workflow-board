import React, { useEffect, useRef, useState } from 'react';
import { tokens } from '../tokens';
import { HeaderAction, HeaderOverflowMenu } from './common';

/**
 * Board 헤더 sub-menu (board-ux-guidelines §1).
 *
 * 헤더 액션을 두 부류로 분리한다:
 *  - 상태 액션(Pause/Resume) — 항상 노출, overflow 로 숨기지 않음.
 *  - 섹션 nav — 1급(QA/Resources) 노출 + 나머지(Benchmark/Archive/Settings)는
 *    `⋯` overflow 드롭다운.
 *
 * 좁은 폭에서는 progressive collapse(§1.4)로 단계적으로 접는다:
 *  full  → 1급 nav 라벨 노출
 *  icon  → 1급 nav 아이콘만 (aria-label 유지)
 *  narrow→ 1급 nav 까지 overflow 로 흡수 (Pause 만 아이콘으로 남음)
 */

export interface BoardSubMenuProps {
  wsId?: string;
  boardId?: string;
  paused: boolean;
  benchmarkMode: boolean;
  onTogglePause: () => void;
}

type CollapseLevel = 'full' | 'icon' | 'narrow';

// 헤더 전체 폭 기준 브레이크포인트 (px). 픽셀 하드코딩 대신 컨테이너 폭
// 기준으로 판단 — actions 가 타이틀과 겹치기 전에 단계적으로 접는다.
const FULL_MIN = 680;
const ICON_MIN = 520;

function levelForWidth(width: number): CollapseLevel {
  if (width >= FULL_MIN) return 'full';
  if (width >= ICON_MIN) return 'icon';
  return 'narrow';
}

export default function BoardSubMenu({
  wsId,
  boardId,
  paused,
  benchmarkMode,
  onTogglePause,
}: BoardSubMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [level, setLevel] = useState<CollapseLevel>('full');

  // 가장 가까운 헤더 폭을 관찰해 collapse 레벨을 정한다.
  useEffect(() => {
    const headerEl = rootRef.current?.closest('header');
    if (!headerEl || typeof ResizeObserver === 'undefined') return;
    const apply = () => setLevel(levelForWidth(headerEl.clientWidth));
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(headerEl);
    return () => ro.disconnect();
  }, []);

  const link = (section: string) =>
    wsId && boardId ? `/ws/${wsId}/boards/${boardId}/${section}` : '#';

  const navCollapsed = level === 'icon';
  const navInOverflow = level === 'narrow';

  // 섹션 nav 항목 정의 (emoji 매핑 §2.3 기준).
  const primaryNav = [
    { key: 'features', icon: '🧩', label: 'Features', to: link('features') },
    { key: 'qa', icon: '🔬', label: 'QA', to: link('qa') },
    { key: 'security', icon: '🛡', label: 'Security', to: link('security') },
    { key: 'resources', icon: '📁', label: 'Resources', to: link('resources') },
  ];
  const overflowNav = [
    ...(benchmarkMode
      ? [{ key: 'leaderboard', icon: '🏆', label: 'Benchmark', to: link('leaderboard') }]
      : []),
    { key: 'archive', icon: '🗄', label: 'Archive', to: link('archive') },
    { key: 'settings', icon: '⚙', label: 'Settings', to: link('settings') },
  ];

  return (
    <div ref={rootRef} style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing.sm }}>
      {/* 상태 액션 — 시각·위치적으로 분리. overflow 로 숨기지 않는다. */}
      <HeaderAction
        icon={paused ? '▶' : '⏸'}
        label={paused ? 'Resume Board' : 'Pause Board'}
        onClick={onTogglePause}
        variant={paused ? 'state-active' : 'default'}
        stateColor={tokens.colors.warning}
        collapsed={navInOverflow}
      />

      {/* 상태 ↔ nav 구분선 */}
      <span
        aria-hidden="true"
        style={{ width: 1, height: 20, background: tokens.colors.border, margin: `0 ${tokens.spacing.xs}px` }}
      />

      {/* 1급 nav — full/icon 에서만 노출 */}
      {!navInOverflow &&
        primaryNav.map((item) => (
          <HeaderAction key={item.key} icon={item.icon} label={item.label} to={item.to} collapsed={navCollapsed} />
        ))}

      {/* overflow 드롭다운 — narrow 면 1급 nav 까지 흡수 */}
      <HeaderOverflowMenu>
        {navInOverflow &&
          primaryNav.map((item) => (
            <HeaderAction key={item.key} icon={item.icon} label={item.label} to={item.to} menuItem />
          ))}
        {overflowNav.map((item) => (
          <HeaderAction key={item.key} icon={item.icon} label={item.label} to={item.to} menuItem />
        ))}
      </HeaderOverflowMenu>
    </div>
  );
}
