import React, { useEffect, useRef, useState } from 'react';
import { tokens } from '../../tokens';
import { copyPlainText } from '../../utils/clipboard';

export default function CodeBlock({ code, language, displayCode = code, maxHeight }: {
  code: string;
  language?: string;
  /** Large tool results may be clipped visually; Copy always includes all received text. */
  displayCode?: string;
  maxHeight?: number;
}) {
  const [status, setStatus] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  const request = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    request.current++;
    setStatus('idle');
    return () => { request.current++; clearTimeout(timer.current); };
  }, [code]);

  const copy = async () => {
    const current = ++request.current;
    clearTimeout(timer.current);
    setStatus('copying');
    const copied = await copyPlainText(code);
    if (current !== request.current) return;
    setStatus(copied ? 'copied' : 'failed');
    if (copied) timer.current = setTimeout(() => setStatus('idle'), 2000);
  };

  return (
    <div data-code-block style={{ margin: '8px 0', minWidth: 0, maxWidth: '100%', border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md, background: tokens.colors.surface, whiteSpace: 'normal', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '5px 10px', borderBottom: `1px solid ${tokens.colors.border}`, background: tokens.colors.surfaceCard, fontSize: 11.5, userSelect: 'none' }}>
        <span style={{ color: tokens.colors.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{language || 'Code'}</span>
        <button type="button" aria-label="Copy code" disabled={status === 'copying'}
          onClick={(event) => { event.stopPropagation(); void copy(); }}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0, padding: '4px 7px', border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.sm, background: tokens.colors.surface, color: tokens.colors.textPrimary, cursor: 'pointer', font: 'inherit' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            {status === 'copied' ? <path d="m5 12 4 4L19 6" /> : <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h4" /></>}
          </svg>
          <span aria-live="polite">{status === 'copied' ? 'Copied!' : status === 'copying' ? 'Copying…' : 'Copy'}</span>
        </button>
      </div>
      {status === 'failed' && <div role="alert" style={{ padding: '5px 10px', fontSize: 12, color: tokens.colors.dangerLight }}>Copy failed. Try again or select the code and copy it manually.</div>}
      <pre style={{ margin: 0, padding: '10px 12px', maxHeight, overflow: 'auto', fontFamily: 'monospace', fontSize: 12.5, lineHeight: 1.5, whiteSpace: 'pre', overflowWrap: 'normal', wordBreak: 'normal', color: tokens.colors.textStrong }}><code>{displayCode}</code></pre>
    </div>
  );
}
