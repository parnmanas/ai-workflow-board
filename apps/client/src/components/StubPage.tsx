import React from 'react';
import { tokens } from '../tokens';

interface StubPageProps {
  title: string;
  body: string;
}

/**
 * Simple placeholder component for Phase 1 routes that have no implementation yet.
 * Rendered for /dashboard, /chat, /settings per D-11.
 *
 * CRITICAL: This component MUST NOT import any real-time stream client or activity-bus
 * subscription. See .planning/phases/01-foundation/01-UI-SPEC.md §"SSE Reconnect Contract".
 */
export default function StubPage({ title, body }: StubPageProps) {
  return (
    <div
      style={{
        maxWidth: 720,
        margin: '0 auto',
        padding: '48px 24px',
      }}
    >
      <h1
        style={{
          fontSize: '20px',
          fontWeight: 700,
          color: tokens.colors.textPrimary,
          margin: 0,
          marginBottom: 16,
          lineHeight: 1.2,
        }}
      >
        {title}
      </h1>
      <p
        style={{
          fontSize: '13px',
          fontWeight: 400,
          color: tokens.colors.textSecondary,
          margin: 0,
          lineHeight: 1.5,
        }}
      >
        {body}
      </p>
    </div>
  );
}
