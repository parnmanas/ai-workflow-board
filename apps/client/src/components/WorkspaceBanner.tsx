import React from 'react';
import { tokens } from '../tokens';

interface WorkspaceBannerProps {
  workspaceName: string;
}

export default function WorkspaceBanner({ workspaceName }: WorkspaceBannerProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        width: '100%',
        background: tokens.colors.warningBg,
        borderLeft: `4px solid ${tokens.colors.warning}`,
        padding: '8px 24px',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0,
        boxSizing: 'border-box',
      }}
    >
      <div style={{
        width: 8,
        height: 8,
        background: tokens.colors.warning,
        borderRadius: '50%',
        flexShrink: 0,
      }} />
      <span style={{ fontSize: 13, color: tokens.colors.warningLight }}>
        Acting in workspace {workspaceName} — changes affect this workspace only
      </span>
    </div>
  );
}
