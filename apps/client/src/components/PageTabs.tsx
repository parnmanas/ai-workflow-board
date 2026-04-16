import React from 'react';
import { Link } from 'react-router-dom';
import { tokens } from '../tokens';

interface PageTab {
  id: string;
  label: string;
  to?: string;
  onClick?: () => void;
  disabled?: boolean;
}

interface PageTabsProps {
  tabs: PageTab[];
  activeId: string;
}

function tabStyle(active: boolean, disabled: boolean): React.CSSProperties {
  return {
    padding: '12px 16px',
    background: 'transparent',
    border: 'none',
    borderBottom: active ? `2px solid ${tokens.colors.accent}` : '2px solid transparent',
    color: disabled ? tokens.colors.borderStrong : active ? tokens.colors.textPrimary : tokens.colors.textSecondary,
    fontSize: '13px',
    fontWeight: active ? 600 : 500,
    cursor: disabled ? 'not-allowed' : 'pointer',
    pointerEvents: disabled ? 'none' : 'auto',
    whiteSpace: 'nowrap',
    fontFamily: 'inherit',
    textDecoration: 'none',
  };
}

export default function PageTabs({ tabs, activeId }: PageTabsProps) {
  return (
    <div
      role="tablist"
      style={{
        display: 'flex',
        gap: 4,
        borderBottom: `1px solid ${tokens.colors.border}`,
        background: tokens.colors.surface,
        padding: '0 24px',
        flexShrink: 0,
        overflowX: 'auto',
      }}
    >
      {tabs.map(tab => {
        const active = tab.id === activeId;
        const disabled = !!tab.disabled;
        const style = tabStyle(active, disabled);

        const hoverIn = (e: React.MouseEvent<HTMLElement>) => {
          if (!active && !disabled) {
            (e.currentTarget as HTMLElement).style.color = tokens.colors.textStrong;
          }
        };
        const hoverOut = (e: React.MouseEvent<HTMLElement>) => {
          if (!active && !disabled) {
            (e.currentTarget as HTMLElement).style.color = tokens.colors.textSecondary;
          }
        };

        if (tab.to) {
          return (
            <Link
              key={tab.id}
              to={tab.to}
              role="tab"
              aria-selected={active}
              style={style}
              onMouseEnter={hoverIn}
              onMouseLeave={hoverOut}
            >
              {tab.label}
            </Link>
          );
        }

        return (
          <button
            type="button"
            key={tab.id}
            role="tab"
            aria-selected={active}
            disabled={disabled}
            onClick={tab.onClick}
            style={style}
            onMouseEnter={hoverIn}
            onMouseLeave={hoverOut}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
