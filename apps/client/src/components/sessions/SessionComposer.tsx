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
 *
 * `busy` 동안에도 입력은 막지 않는다 — 실제 CLI/Desktop 처럼 타이핑·Enter 를
 * 그대로 받되, 전송 대신 큐에 쌓아 둔다(`queue`). `busy` 가 true→false 로
 * 넘어가는 그 순간(턴 종료 — permission/elicitation 대기도 `busy` 에 포함되므로
 * 사용자가 그 결정을 마친 뒤에만 넘어간다)에 큐 맨 앞을 하나 흘려보낸다. 그 전송이
 * 다시 새 턴을 열어 `busy` 가 true 로 돌아오면, 다음 false 전환 때 그다음 항목을
 * 흘려보내는 식으로 한 번에 하나씩만 나간다 — 세션은 한 턴만 처리할 수 있어서다.
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
  const [queue, setQueue] = useState<string[]>([]);
  const queueRef = useRef<string[]>([]);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  const setQueueBoth = useCallback((next: string[]) => {
    queueRef.current = next;
    setQueue(next);
  }, []);

  const removeQueued = useCallback((index: number) => {
    setQueueBoth(queueRef.current.filter((_, i) => i !== index));
  }, [setQueueBoth]);

  // busy 가 방금 false 로 넘어온 시점에만 큐 맨 앞을 흘려보낸다 — busy 가 그대로거나
  // (다른 prop 변화로 effect 가 재실행돼도) true→true, false→false 는 무시한다.
  const prevBusyRef = useRef(busy);
  useEffect(() => {
    const wasBusy = prevBusyRef.current;
    prevBusyRef.current = busy;
    if (!wasBusy || busy || disabled) return;
    const [next, ...rest] = queueRef.current;
    if (next === undefined) return;
    setQueueBoth(rest);
    setSending(true);
    Promise.resolve(onSend(next)).finally(() => setSending(false));
  }, [busy, disabled, onSend, setQueueBoth]);

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
    if (!value || disabled || sending) return;
    if (busy) {
      setQueueBoth([...queueRef.current, value]);
      setText('');
      return;
    }
    setSending(true);
    try {
      await onSend(value);
      setText('');
      requestAnimationFrame(() => ref.current?.focus());
    } finally {
      setSending(false);
    }
  }, [text, disabled, busy, sending, onSend, setQueueBoth]);

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

  const locked = disabled || sending;
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
      {queue.length > 0 && (
        <ul
          aria-label="Queued prompts"
          style={{
            listStyle: 'none', margin: '0 0 6px', padding: 0, display: 'flex', flexDirection: 'column', gap: 4,
          }}
        >
          {queue.map((q, i) => (
            <li
              key={i}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', borderRadius: tokens.radii.md,
                border: `1px dashed ${tokens.colors.border}`, background: tokens.colors.surface,
              }}
            >
              <span style={{ fontSize: 11, color: tokens.colors.textMuted, flexShrink: 0 }}>{i === 0 ? '다음 전송…' : `대기 ${i + 1}`}</span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: tokens.colors.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q}</span>
              <button
                type="button"
                onClick={() => removeQueued(i)}
                aria-label="Remove queued prompt"
                style={{
                  flexShrink: 0, border: 'none', background: 'transparent', color: tokens.colors.textMuted,
                  fontSize: 14, lineHeight: 1, cursor: 'pointer', padding: '2px 4px',
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
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
        {busy && (
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
        )}
        <button
          type="button"
          onClick={() => void submit()}
          disabled={locked || !text.trim()}
          title={busy ? '지금 보내지 않고, 현재 턴이 끝나면 큐 순서대로 전송합니다' : undefined}
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
          {sending ? 'Sending…' : busy ? 'Queue' : 'Send'}
        </button>
      </div>
      <div style={{ marginTop: 5, fontSize: 10.5, color: tokens.colors.textMuted }}>
        {busy ? 'Enter queues — sent once the current turn finishes' : 'Enter to send'} · Shift+Enter for a new line · {commands && commands.length ? `type / for ${commands.length} commands` : 'slash commands go straight to the CLI'}
      </div>
    </div>
  );
}
