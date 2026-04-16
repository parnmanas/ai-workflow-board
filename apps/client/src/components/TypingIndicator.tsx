import React from 'react';
import { tokens } from '../tokens';

interface TypingIndicatorProps {
  agentName: string | null;
}

export function TypingIndicator({ agentName }: TypingIndicatorProps) {
  if (!agentName) return null;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '6px 0', fontSize: '11px', color: tokens.colors.textSecondary,
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: '50%',
        background: tokens.colors.accent, display: 'inline-block', flexShrink: 0,
      }} />
      <span style={{ animation: 'dotPulse 1.2s ease-in-out infinite' }}>
        {agentName} is typing...
      </span>
    </div>
  );
}

export default TypingIndicator;
