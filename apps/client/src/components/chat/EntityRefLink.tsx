import React from 'react';
import { tokens } from '../../tokens';
import { ArtifactRefType, entityDeepLink, workspaceIdFromPath } from '../../utils/artifactRef';

const ICON: Record<ArtifactRefType, string> = {
  ticket: '🎫',
  agent: '🤖',
  board: '📊',
  action: '▶️',
  function: 'ƒ',
  schedule: '🗓️',
};

export default function EntityRefLink({
  type,
  id,
  name,
}: {
  type: ArtifactRefType;
  id: string;
  name: string;
}) {
  const workspaceId = typeof window === 'undefined' ? '' : workspaceIdFromPath(window.location.pathname);
  const href = workspaceId ? entityDeepLink(type, id, workspaceId) : null;
  const common = {
    'data-entity-ref': `${type}:${id}`,
    'aria-label': `${type} 열기: ${name}`,
    title: `${name} (${id})`,
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: '1px 6px',
      borderRadius: tokens.radii.sm,
      color: tokens.colors.accentSubtle,
      background: tokens.overlays.accentSoft,
      fontWeight: 600,
      textDecoration: 'none',
    } as React.CSSProperties,
  };
  if (!href) {
    return <span {...common}>{ICON[type]} {name} ({id}) — 연결 불가: workspace context 없음</span>;
  }
  return <a {...common} href={href}>{ICON[type]} {name}</a>;
}
