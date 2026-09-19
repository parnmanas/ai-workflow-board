import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { tokens } from '../../tokens';
import type { AgentSessionCommand } from '../../types';
import { applySlashCommand, matchSlashCommands } from './sessionTranscript.logic';

/**
 * Agent Session 프롬프트 입력. Chat 의 ChatMessageInput 과 달리 방/첨부/멘션에
 * 묶이지 않는다 — 텍스트 하나를 그대로 CLI 세션에 보낸다. Enter 전송,
 * Shift+Enter 줄바꿈, 한글 IME 조합 중 Enter 는 무시한다.
 * `/` 로 시작하면 어댑터가 알려 준 slash command 목록으로 자동완성한다
 * (↑/↓ 이동, Enter/Tab 선택, Esc 닫기) — 선택해도 전송하지 않고 텍스트만 채운다.
 */
export interface SessionComposerProps {
  disabled: boolean;
  busy: boolean;
  placeholder: string;
  hint?: string | null;
  /** 어댑터의 available_commands — 없으면 자동완성 없이 텍스트 그대로 보낸다. */
  commands?: AgentSessionCommand[];
  onSend: (text: string) => Promise<void> | void;
  onCancel: () => void;
}

export default function SessionComposer({ disabled, busy, placeholder, hint, commands, onSend, onCancel }: SessionComposerProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [selected, setSelected] = useState(0);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  const slash = useMemo(() => matchSlashCommands(text, commands ?? []), [text, commands]);
  const popupOpen = slash.active && slash.matches.length > 0 && dismissedFor !== text;
  useEffect(() => { setSelected(0); }, [slash.query, slash.matches.length]);

  const pick = useCallback((command: AgentSessionCommand) => {
    const next = applySlashCommand(command);
    setText(next);
    setDismissedFor(next);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.length, next.length);
    });
  }, []);

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
    if ((e.nativeEvent as any).isComposing) return; // IME 조합 중
    if (popupOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((i) => (i + 1) % slash.matches.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSelected((i) => (i - 1 + slash.matches.length) % slash.matches.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(slash.matches[Math.min(selected, slash.matches.length - 1)]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setDismissedFor(text); return; }
    }
    if (e.key !== 'Enter' || e.shiftKey) return;
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
      {popupOpen && (
        <ul
          role="listbox"
          aria-label="Slash commands"
          style={{
            listStyle: 'none', margin: '0 0 6px', padding: 4, maxHeight: 220, overflowY: 'auto', maxWidth: 520,
            border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md, background: tokens.colors.surfaceCard,
          }}
        >
          {slash.matches.map((c, i) => (
            <li
              key={c.name}
              role="option"
              aria-selected={i === selected}
              data-command={c.name}
              onMouseDown={(e) => { e.preventDefault(); pick(c); }}
              onMouseEnter={() => setSelected(i)}
              style={{
                display: 'flex', gap: 10, alignItems: 'baseline', padding: '5px 8px', borderRadius: tokens.radii.sm, cursor: 'pointer',
                background: i === selected ? tokens.colors.surfaceHover : 'transparent',
              }}
            >
              <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12.5, color: tokens.colors.textPrimary, whiteSpace: 'nowrap' }}>/{c.name}{c.input_hint ? <span style={{ color: tokens.colors.textMuted }}> {c.input_hint}</span> : null}</span>
              <span style={{ fontSize: 12, color: tokens.colors.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.description}</span>
            </li>
          ))}
        </ul>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <textarea
          ref={ref}
          value={text}
          rows={1}
          disabled={disabled}
          placeholder={placeholder}
          aria-label="Prompt"
          aria-expanded={popupOpen}
          aria-autocomplete={commands && commands.length ? 'list' : undefined}
          onChange={(e) => { setText(e.target.value); if (dismissedFor !== null && e.target.value !== dismissedFor) setDismissedFor(null); }}
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
        Enter to send · Shift+Enter for a new line · {commands && commands.length ? `type / for ${commands.length} commands` : 'slash commands go straight to the CLI'}
      </div>
    </div>
  );
}
