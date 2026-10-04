import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { tokens } from '../../tokens';
import type { AgentSessionCommand } from '../../types';
import { applySlashCommand, matchSlashCommands } from './sessionTranscript.logic';
import { readFileAsBase64 } from '../chat/utils/attachments';
import { useVoiceDictation } from '../../voice/useVoice';

/**
 * Agent Session 프롬프트 입력. Chat 의 ChatMessageInput 과 달리 방/멘션에
 * 묶이지 않는다 — 텍스트 + 이미지 첨부를 그대로 CLI 세션에 보낸다. Enter 전송,
 * Shift+Enter 줄바꿈, 한글 IME 조합 중 Enter 는 무시한다.
 * `/` 로 시작하면 어댑터가 알려 준 slash command 목록으로 자동완성한다
 * (↑/↓ 이동, Enter/Tab 선택, Esc 닫기). 완성된 명령은 Enter 로 바로 전송한다.
 *
 * 이미지는 ACP Image 블록으로 간다 — opencode 가 `promptCapabilities.image` 를
 * 광고하는(1.18.34 실측) 네이티브 경로라 별도 MCP 우회가 필요 없다. vision 을
 * 모르는 모델은 어댑터·모델이 직접 거절한다. 장수·용량 상한(5장·장당 8MB)은 서버가
 * 최종 판정하고, 여기는 탭 OOM 전에 빨리 막는 용도로만 둔다.
 *
 * `busy` 동안에도 입력은 막지 않는다 — 실제 CLI/Desktop 처럼 타이핑·Enter 를
 * 그대로 받되, 전송 대신 큐에 쌓아 둔다(`queue`). `busy` 가 true→false 로
 * 넘어가는 그 순간(턴 종료 — permission/elicitation 대기도 `busy` 에 포함되므로
 * 사용자가 그 결정을 마친 뒤에만 넘어간다)에 큐 맨 앞을 하나 흘려보낸다. 그 전송이
 * 다시 새 턴을 열어 `busy` 가 true 로 돌아오면, 다음 false 전환 때 그다음 항목을
 * 흘려보내는 식으로 한 번에 하나씩만 나간다 — 세션은 한 턴만 처리할 수 있어서다.
 */

/** 미리보기 파이프라인과 같은 집합 — SVG 는 화면에 그릴 수 없어 받지 않는다. */
const ACCEPTED_IMAGE_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif',
]);
const ACCEPT_ATTR = 'image/png,image/jpeg,image/gif,image/webp,image/bmp,image/avif';
/** 서버 상한과 같은 값 — 빨리 막는 용도(서버가 최종 판정). */
const MAX_IMAGES_PER_PROMPT = 5;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export interface SessionPromptImage {
  base64: string;
  mime_type: string;
  name: string;
  size: number;
  previewUrl: string;
  /** 컴포저 내부 매칭용 — 전송 payload 에는 싣지 않는다. */
  localId: string;
}

export interface SessionPrompt {
  text: string;
  images: SessionPromptImage[];
  /** 말로 보낸 프롬프트 — 말로 물으면 답도 소리로 듣는다(세션 화면이 읽기 여부를 정할 때 쓴다). */
  spoken?: boolean;
}

export interface SessionComposerProps {
  disabled: boolean;
  busy: boolean;
  placeholder: string;
  hint?: string | null;
  /** 어댑터의 available_commands — 없으면 자동완성 없이 텍스트 그대로 보낸다. */
  commands?: AgentSessionCommand[];
  onSend: (prompt: SessionPrompt) => Promise<void> | void;
  onCancel: () => void;
  /**
   * 음성 입력 — 서버에 STT 가 준비돼 있을 때만 준다(없으면 마이크 버튼이 나오지 않는다).
   * 전사된 글자는 입력창의 글자 뒤에 붙고, `autoSend` 면 곧바로 보낸다(턴 중이면 큐로).
   */
  voiceInput?: { autoSend: boolean } | null;
}

function promptLabel(p: SessionPrompt): string {
  if (p.text.trim()) return p.text;
  if (p.images.length) return `[${p.images.length} image(s)]`;
  return '';
}

export default function SessionComposer({ disabled, busy, placeholder, hint, commands, onSend, onCancel, voiceInput }: SessionComposerProps) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<SessionPromptImage[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [selected, setSelected] = useState(0);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const [queue, setQueue] = useState<SessionPrompt[]>([]);
  const queueRef = useRef<SessionPrompt[]>([]);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const setQueueBoth = useCallback((next: SessionPrompt[]) => {
    queueRef.current = next;
    setQueue(next);
  }, []);

  const removeQueued = useCallback((index: number) => {
    setQueueBoth(queueRef.current.filter((_, i) => i !== index));
  }, [setQueueBoth]);

  const revokeImages = useCallback((list: SessionPromptImage[]) => {
    for (const img of list) URL.revokeObjectURL(img.previewUrl);
  }, []);

  // 동기 검증(addFiles)이 최신 목록을 보게 + unmount 때 남은 미리보기 URL 을 거둔다.
  const imagesRef = useRef(images);
  imagesRef.current = images;
  useEffect(() => () => revokeImages(imagesRef.current), [revokeImages]);

  const removeImage = useCallback((localId: string) => {
    setImages((prev) => {
      const target = prev.find((p) => p.localId === localId);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((p) => p.localId !== localId);
    });
  }, []);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    // 동기 검증은 한 번에 — setState updater 안에서 setAttachError 같은 side effect 를
    // 일으키지 않게 한다(StrictMode double-invoke 에서도 한 번만 보인다).
    let error: string | null = null;
    const pendings: { localId: string; file: File; mime: string; previewUrl: string }[] = [];
    const mkId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    for (const file of list) {
      const mime = (file.type || '').toLowerCase();
      if (!ACCEPTED_IMAGE_MIMES.has(mime)) {
        error = `이미지만 보낼 수 있습니다 (png/jpeg/gif/webp/bmp/avif) — ${file.name || '이름 없음'} 건너뜀`;
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        error = `8MB 이하만 보낼 수 있습니다 — ${file.name || '이름 없음'} 건너뜀`;
        continue;
      }
      if (imagesRef.current.length + pendings.length >= MAX_IMAGES_PER_PROMPT) {
        error = `한 번에 ${MAX_IMAGES_PER_PROMPT}장까지 보낼 수 있습니다`;
        break;
      }
      pendings.push({ localId: mkId(), file, mime, previewUrl: URL.createObjectURL(file) });
    }
    setAttachError(error);
    if (!pendings.length) return;
    // base64 는 전송 직전이 아니라 여기서 읽는다 — 읽는 동안 썸네일은 반투명으로 보인다.
    setImages((prev) => [...prev, ...pendings.map((p) => ({
      base64: '', mime_type: p.mime, name: '', size: p.file.size, previewUrl: p.previewUrl, localId: p.localId,
    }))]);
    for (const p of pendings) {
      try {
        const base64 = await readFileAsBase64(p.file);
        if (!base64) throw new Error('empty');
        setImages((prev) => prev.map((img) => (img.localId === p.localId
          ? { base64, mime_type: p.mime, name: p.file.name || 'image', size: p.file.size, previewUrl: p.previewUrl, localId: p.localId }
          : img)));
      } catch {
        URL.revokeObjectURL(p.previewUrl);
        setImages((prev) => prev.filter((img) => img.localId !== p.localId));
        setAttachError(`읽지 못한 파일이 있습니다 — ${p.file.name || '이름 없음'}`);
      }
    }
  }, []);

  const onPaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files: File[] = [];
    for (const item of Array.from(e.clipboardData?.items ?? [])) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (!files.length) return;
    e.preventDefault();
    void addFiles(files);
  }, [addFiles]);

  // busy 가 방금 false 로 넘어온 시점에만 큐 맨 앞을 흘려보낸다 — busy 가 그대로거나
  // (다른 prop 변화로 effect 가 재실행돼도) true→true, false→false 는 무시한다.
  const prevBusyRef = useRef(busy);
  useEffect(() => {
    const wasBusy = prevBusyRef.current;
    prevBusyRef.current = busy;
    if (!wasBusy || busy || disabled) return;
    const [next, ...rest] = queueRef.current;
    if (!next) return;
    setQueueBoth(rest);
    setSending(true);
    Promise.resolve(onSend(next)).finally(() => setSending(false));
  }, [busy, disabled, onSend, setQueueBoth]);

  const slash = useMemo(() => matchSlashCommands(text, commands ?? []), [text, commands]);
  const popupOpen = slash.active && slash.matches.length > 0 && dismissedFor !== text;
  const commandListRef = useRef<HTMLUListElement>(null);
  useEffect(() => { setSelected(0); }, [slash.query, slash.matches.length]);
  useEffect(() => {
    if (popupOpen) commandListRef.current?.children[selected]?.scrollIntoView?.({ block: 'nearest' });
  }, [popupOpen, selected]);

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

  const canSend = text.trim().length > 0 || images.some((p) => p.base64);
  const stillReading = images.some((p) => !p.base64);

  /** `overrideText` — 음성 전사처럼 입력창을 거치지 않고 바로 보낼 글자(그때는 말로 보낸 프롬프트다). */
  const submit = useCallback(async (overrideText?: string) => {
    const ready = images.filter((p) => p.base64);
    const value: SessionPrompt = { text: (overrideText ?? text).trim(), images: ready, ...(overrideText !== undefined ? { spoken: true } : {}) };
    if ((!value.text && !ready.length) || disabled || sending || stillReading) return;
    if (busy) {
      setQueueBoth([...queueRef.current, value]);
      setText('');
      revokeImages(images);
      setImages([]);
      return;
    }
    setSending(true);
    try {
      await onSend(value);
      setText('');
      revokeImages(images);
      setImages([]);
      requestAnimationFrame(() => ref.current?.focus());
    } finally {
      setSending(false);
    }
  }, [text, images, disabled, busy, sending, stillReading, onSend, setQueueBoth, revokeImages]);

  const dictation = useVoiceDictation(useCallback((spoken: string) => {
    const merged = [text.trim(), spoken].filter(Boolean).join(' ');
    // 보낼 수 없는 순간(다른 전송 중 · 이미지 읽는 중)이면 버리지 않고 입력창에 남긴다.
    if (voiceInput?.autoSend && !stillReading && !sending && !disabled) {
      void submit(merged);
      return;
    }
    setText(merged);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(merged.length, merged.length);
    });
  }, [text, voiceInput?.autoSend, stillReading, sending, disabled, submit]));
  const showMic = !!voiceInput && dictation.supported;
  const recording = dictation.phase === 'recording';

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.nativeEvent as any).isComposing) return; // IME 조합 중
    if (e.key === 'Enter' && e.shiftKey) return;
    if (popupOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((i) => (i + 1) % slash.matches.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSelected((i) => (i - 1 + slash.matches.length) % slash.matches.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const command = slash.matches[Math.min(selected, slash.matches.length - 1)];
        if (e.key === 'Enter' && text === `/${command.name}`) void submit();
        else pick(command);
        return;
      }
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
          ref={commandListRef}
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
              <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: tokens.colors.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {promptLabel(q)}{q.images.length > 0 && ` 🖼 ${q.images.length}`}
              </span>
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
      {images.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }} aria-label="Attached images">
          {images.map((img) => (
            <div
              key={img.localId}
              title={img.name || '읽는 중…'}
              style={{
                position: 'relative', width: 56, height: 56, borderRadius: tokens.radii.md, overflow: 'hidden',
                border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface,
              }}
            >
              <img src={img.previewUrl} alt={img.name || 'attached image'} style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: img.base64 ? 1 : 0.5 }} />
              <button
                type="button"
                onClick={() => removeImage(img.localId)}
                aria-label={`Remove image ${img.name || 'attached'}`}
                style={{
                  position: 'absolute', top: 0, right: 0, border: 'none', background: 'rgba(0,0,0,0.55)', color: '#fff',
                  fontSize: 12, lineHeight: 1, cursor: 'pointer', padding: '2px 5px', borderBottomLeftRadius: 6,
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {attachError && (
        <div style={{ fontSize: 11.5, color: tokens.colors.warning, marginBottom: 6 }}>{attachError}</div>
      )}
      {showMic && dictation.error && (
        <div role="status" style={{ fontSize: 11.5, color: tokens.colors.warning, marginBottom: 6 }}>{dictation.error}</div>
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
              title={c.description}
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
        {!!commands?.length && (
          <button
            type="button"
            aria-label="Browse slash commands"
            title="Browse this CLI's commands (or type /). Terminal-only commands may be unavailable here."
            disabled={locked || (!!text.trim() && !slash.active)}
            onClick={() => { setText('/'); setDismissedFor(null); ref.current?.focus(); }}
            style={{ height: 40, minWidth: 40, borderRadius: tokens.radii.lg, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface, color: tokens.colors.textSecondary }}
          >
            /
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT_ATTR}
          multiple
          style={{ display: 'none' }}
          aria-label="Attach images"
          onChange={(e) => { void addFiles(e.target.files ?? []); e.target.value = ''; }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={locked}
          title="이미지 첨부 (png/jpeg/gif/webp/bmp/avif, 장당 8MB, 최대 5장)"
          aria-label="Attach images"
          style={{
            height: 40, minWidth: 40, padding: '0 10px', borderRadius: tokens.radii.lg,
            border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface,
            color: locked ? tokens.colors.textMuted : tokens.colors.textSecondary,
            fontSize: 16, cursor: locked ? 'not-allowed' : 'pointer',
          }}
        >
          📎
        </button>
        {showMic && (
          <button
            type="button"
            onClick={dictation.toggle}
            disabled={locked || dictation.phase === 'transcribing'}
            aria-label={recording ? 'Stop recording and send' : 'Speak a prompt'}
            aria-pressed={recording}
            title={recording
              ? '다시 누르면 녹음을 끝내고 글자로 바꿔 보냅니다'
              : dictation.phase === 'transcribing' ? '글자로 바꾸는 중…' : '눌러서 말하기 — 다시 누르면 끝납니다'}
            style={{
              height: 40, minWidth: 40, padding: '0 10px', borderRadius: tokens.radii.lg,
              border: `1px solid ${recording ? tokens.colors.danger : tokens.colors.border}`,
              background: recording ? `${tokens.colors.danger}22` : tokens.colors.surface,
              color: recording ? tokens.colors.dangerLight : locked ? tokens.colors.textMuted : tokens.colors.textSecondary,
              fontSize: 16, cursor: locked ? 'not-allowed' : 'pointer',
              // 입력 크기를 테두리 그림자로 — 듣고 있다는 것을 눈으로 확인한다.
              boxShadow: recording ? `0 0 0 ${Math.round(2 + dictation.level * 8)}px ${tokens.colors.danger}33` : 'none',
              transition: 'box-shadow 80ms linear',
            }}
          >
            {dictation.phase === 'transcribing' ? '…' : recording ? '■' : '🎙'}
          </button>
        )}
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
          onPaste={onPaste}
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
          disabled={locked || !canSend || stillReading}
          title={busy ? '지금 보내지 않고, 현재 턴이 끝나면 큐 순서대로 전송합니다' : undefined}
          style={{
            height: 40,
            padding: '0 16px',
            borderRadius: tokens.radii.lg,
            border: 'none',
            background: locked || !canSend || stillReading ? tokens.colors.surfaceHover : tokens.gradients.accent,
            color: locked || !canSend || stillReading ? tokens.colors.textMuted : '#fff',
            fontSize: 13,
            fontWeight: 600,
            cursor: locked || !canSend || stillReading ? 'not-allowed' : 'pointer',
          }}
        >
          {sending ? 'Sending…' : busy ? 'Queue' : 'Send'}
        </button>
      </div>
      <div style={{ marginTop: 5, fontSize: 10.5, color: tokens.colors.textMuted }}>
        {busy ? 'Enter queues — sent once the current turn finishes' : 'Enter to send'} · Shift+Enter for a new line · 📎 or paste images to attach{showMic ? ' · 🎙 tap to speak, tap again to send' : ''}{commands && commands.length ? ` · type / for ${commands.length} commands` : ' · slash commands go straight to the CLI'}
      </div>
    </div>
  );
}
