import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useViewMode, defaultSectionForMode, ViewMode } from '../contexts/ViewModeContext';
import { useAuth } from '../contexts/AuthContext';
import { tokens } from '../tokens';

/**
 * Chat-first ↔ Advanced 전환 세그먼트 컨트롤 (Phase 1 · S1).
 *
 * 모드를 바꾸면 해당 모드의 기본 랜딩(assistant / boards)으로 이동해 전환이 즉시
 * 체감되도록 한다. 워크스페이스 컨텍스트가 없으면 이동 없이 모드만 저장한다.
 */
export default function ViewModeToggle() {
  const { mode, setMode } = useViewMode();
  const { currentWorkspaceId } = useAuth();
  const navigate = useNavigate();

  const select = (m: ViewMode) => {
    if (m === mode) return;
    setMode(m);
    if (currentWorkspaceId) navigate(`/ws/${currentWorkspaceId}/${defaultSectionForMode(m)}`);
  };

  const options: { key: ViewMode; label: string }[] = [
    { key: 'chat', label: 'Chat' },
    { key: 'advanced', label: 'Advanced' },
  ];

  return (
    <div
      role="group"
      aria-label="View mode"
      style={{
        display: 'inline-flex',
        background: tokens.colors.surfaceSubtle,
        border: `1px solid ${tokens.colors.border}`,
        borderRadius: tokens.radii.lg,
        padding: 2,
        flexShrink: 0,
      }}
    >
      {options.map((o) => {
        const active = o.key === mode;
        return (
          <button
            key={o.key}
            type="button"
            aria-pressed={active}
            onClick={() => select(o.key)}
            style={{
              padding: '4px 12px',
              fontSize: 12,
              fontWeight: 600,
              fontFamily: 'inherit',
              cursor: active ? 'default' : 'pointer',
              border: 'none',
              borderRadius: tokens.radii.md,
              background: active ? tokens.colors.accent : 'transparent',
              color: active ? '#fff' : tokens.colors.textSecondary,
              transition: 'background 120ms ease, color 120ms ease',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
