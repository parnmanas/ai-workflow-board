import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import { tokens } from '../../tokens';
import { ArtifactRefType, workspaceIdFromPath } from '../../utils/artifactRef';

const ICON: Record<ArtifactRefType, string> = {
  ticket: '🎫', agent: '🤖', board: '📊', action: '▶️', function: 'ƒ', schedule: '🗓️',
};

type Resolution = {
  type: ArtifactRefType;
  id: string;
  available: boolean;
  label: string;
  deepLink: string | null;
  workspaceName?: string;
  boardName?: string;
  reason?: string;
};

const REASON: Record<string, string> = {
  malformed_id: '잘못된 UUID',
  workspace_access_denied: 'workspace 접근 권한 없음',
  not_found: '존재하지 않음',
  outside_workspace: '다른 workspace의 엔터티',
  no_detail_surface: '상세 화면 없음',
  resolving: '확인 중',
  resolver_failed: '확인 실패',
  workspace_context_missing: 'workspace context 없음',
};

export default function ResolvedArtifactRef({
  type, id, claimedLabel,
}: {
  type: ArtifactRefType;
  id: string;
  claimedLabel: string;
}) {
  const workspaceId = typeof window === 'undefined' ? '' : workspaceIdFromPath(window.location.pathname);
  const [resolved, setResolved] = useState<Resolution | null>(null);
  const [failure, setFailure] = useState(workspaceId ? 'resolving' : 'workspace_context_missing');

  useEffect(() => {
    let active = true;
    if (!workspaceId) return;
    api.resolveArtifactRefs(workspaceId, [{ type, id }])
      .then(rows => {
        if (!active) return;
        setResolved(rows[0] || null);
        setFailure(rows[0]?.reason || '');
      })
      .catch(() => active && setFailure('resolver_failed'));
    return () => { active = false; };
  }, [workspaceId, type, id]);

  const common = {
    'data-entity-ref': `${type}:${id}`,
    'data-artifact-state': resolved?.available ? 'available' : failure,
    title: [
      resolved?.label || claimedLabel,
      resolved?.workspaceName,
      resolved?.boardName,
      id,
    ].filter(Boolean).join(' · '),
    style: {
      display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 6px',
      borderRadius: tokens.radii.sm, color: resolved?.available ? tokens.colors.accentSubtle : tokens.colors.textMuted,
      background: resolved?.available ? tokens.overlays.accentSoft : tokens.colors.surfaceCard,
      fontWeight: 600, textDecoration: 'none',
    } as React.CSSProperties,
  };

  if (resolved?.available && resolved.deepLink) {
    const context = [resolved.workspaceName, resolved.boardName].filter(Boolean).join(' / ');
    return (
      <a {...common} href={resolved.deepLink} aria-label={`${type} 열기: ${resolved.label}`}>
        {ICON[type]} {resolved.label}{context ? ` · ${context}` : ''}
      </a>
    );
  }
  const reason = REASON[resolved?.reason || failure] || resolved?.reason || failure;
  return (
    <span {...common} aria-disabled="true">
      {ICON[type]} {resolved?.label || claimedLabel || type} ({id}) — 연결 불가: {reason}
    </span>
  );
}
