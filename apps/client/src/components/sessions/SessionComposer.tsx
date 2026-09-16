import React, { useCallback, useEffect, useRef, useState } from 'react';
import { tokens } from '../../tokens';

/**
 * Agent Session 프롬프트 입력. Chat 의 ChatMessageInput 과 달리 방/첨부/멘션에
 * 묶이지 않는다 — 텍스트 하나를 그대로 CLI 세션에 보낸다. Enter 전송,
 * Shift+Enter 줄바꿈, 한글 IME 조합 중 Enter 는 무시한다.
 */
export interface SessionComposerProps {
  disabled: boolean;
  busy: boolean;
  placeholder: string;
  hint?: string | null;
  onSend: (text: string) => Promise<void> | void;
  onCancel: () => void;
}

export default function SessionComposer({ disabled, busy, placeholder, hint, onSend, onCancel }: SessionComposerProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const submit = useCallback(async () => {
    const value = text.trim();
    if (!value || disabled || busy || sending) return;
    setSending(true);
    try {
      await onSend(value);
      setText('');
      requestAnimationFrame(() => ref.current?.focus());
    } finally {
      setSending(false);
    }
  }, [text, disabled, busy, sending, onSend]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    if ((e.nativeEvent as any).isComposing) return; // IME 조합 중
    e.preventDefault();
    void submit();
  };

  const locked = disabled || busy || sending;
  return (
    <div
      style={{
        borderTop: `1px solid ${tokens.colors.border}`,
        background: tokens.colors.surfaceCard,
        // 오른쪽 여백은 AppLayout 의 고정 알림 벨(우하단)이 Send/Cancel 버튼을 덮지 않게 한다.
        padding: '10px 64px 12px 16px',
        flexShrink: 0,
      }}
    >
      {hint && (
        <div style={{ fontSize: 11.5, color: tokens.colors.textMuted, marginBottom: 6 }}>{hint}</div>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <textarea
          ref={ref}
          value={text}
          rows={1}
          disabled={disabled}
          placeholder={placeholder}
          aria-label="Prompt"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          style={{
            flex: 1,
            minHeight: 40,
            maxHeight: 220,
            resize: 'none',
            padding: '9px 12px',
            borderRadius: tokens.radii.lg,
            border: `1px solid ${tokens.colors.border}`,
            background: tokens.colors.surface,
            color: tokens.colors.textPrimary,
            fontFamily: 'inherit',
            fontSize: 13.5,
            lineHeight: 1.5,
            outline: 'none',
            opacity: disabled ? 0.6 : 1,
          }}
        />
        {busy ? (
          <button
            type="button"
            onClick={onCancel}
            style={{
              height: 40,
              padding: '0 14px',
              borderRadius: tokens.radii.lg,
              border: `1px solid ${tokens.colors.danger}`,
              background: 'transparent',
              color: tokens.colors.dangerLight,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void submit()}
            disabled={locked || !text.trim()}
            style={{
              height: 40,
              padding: '0 16px',
              borderRadius: tokens.radii.lg,
              border: 'none',
              background: locked || !text.trim() ? tokens.colors.surfaceHover : tokens.gradients.accent,
              color: locked || !text.trim() ? tokens.colors.textMuted : '#fff',
              fontSize: 13,
              fontWeight: 600,
              cursor: locked || !text.trim() ? 'not-allowed' : 'pointer',
            }}
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        )}
      </div>
      <div style={{ marginTop: 5, fontSize: 10.5, color: tokens.colors.textMuted }}>
        Enter to send · Shift+Enter for a new line · slash commands go straight to the CLI
      </div>
    </div>
  );
}
