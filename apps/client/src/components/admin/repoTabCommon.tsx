import React from 'react';
import { tokens } from '../../tokens';

// History / Files 탭이 공유하는 소품. 두 탭 모두 같은 monospace 와 에러 박스
// 스타일을 쓰므로 한 곳에 모았다.

export const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

export function ErrorBox({ message }: { message: string }) {
  return (
    <div
      data-testid="repo-error"
      style={{
        fontSize: 12,
        color: tokens.colors.danger,
        background: `${tokens.colors.danger}14`,
        border: `1px solid ${tokens.colors.danger}40`,
        borderRadius: tokens.radii.md,
        padding: '10px 12px',
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        marginTop: 8,
      }}
    >
      {message}
    </div>
  );
}
