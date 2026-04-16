import React from 'react';
import { tokens } from '../tokens';

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}

export default function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <header
      style={{
        background: tokens.gradients.surfaceCard,
        borderBottom: `1px solid ${tokens.colors.border}`,
        padding: '16px 24px',
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        flexShrink: 0,
      }}
    >
      <div>
        <h1 style={{ fontSize: '16px', fontWeight: 700, color: tokens.colors.textPrimary, margin: 0 }}>{title}</h1>
        {description && (
          <p style={{ fontSize: '11px', color: tokens.colors.textSecondary, margin: '2px 0 0 0' }}>{description}</p>
        )}
      </div>
      {actions && (
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          {actions}
        </div>
      )}
    </header>
  );
}
