import { t as translate, getLocale } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { tokens } from '../../tokens';
import type { AgentSessionCommand } from '../../types';
import { applySlashCommand, matchSlashCommands } from './sessionTranscript.logic';
import { readFileAsBase64 } from '../chat/utils/attachments';
import { useHandsFreeConversation, type ConversationPhase } from '../../voice/useVoice';
import { WAKE_IDLE_SLEEP_MS } from '../../voice/wake.logic';
import MediaLightbox from '../common/MediaLightbox';

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
 * `busy` 동안에도 입력은 막지 않고 **화면이 붙잡아 두지도 않는다** — Claude Code/Codex
 * 데스크탑처럼 Enter 를 누르면 바로 보낸다. 매니저가 진행 중인 턴에 끼워 넣어(`_session/steering`)
 * 에이전트가 그 턴 안에서 읽고 답하고, 끼워 넣지 못하는 CLI 면 매니저가 들고 있다가 턴이 끝나는
 * 즉시 보낸다(어느 쪽인지 전사에 남는다). 예전엔 여기서 큐에 쌓았다가 턴이 끝난 뒤에야 보냈다 —
 * 에이전트는 그 말을 끝까지 모른 채 일했다.
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
   * 🎙 를 켜면 대화 모드다: 말을 멈출 때마다 그 발화가 글자로 바뀌어 곧바로 전송된다(턴 중이면 큐로).
   * `liveCaptions` 면 말하는 동안 실시간 자막을 보여 준다(엔진을 더 부르므로 무료 엔진에서만).
   * `wake` 는 이 세션이 operator 일 때 — 이름으로 불려 깨어나면 대화 모드가 스스로 켜진다.
   */
  voiceInput?: { liveCaptions: boolean; wake?: VoiceWakeBinding | null } | null;
}

/**
 * 음성 지원(docs/voice-operator.md "음성 지원 · 잠들기")과 컴포저의 연결. 깨어 있는 동안 대화 모드를
 * 켜 두고, 사용자가 마이크를 끄거나 오래 조용하면 잠든다.
 */
export interface VoiceWakeBinding {
  /** operator 이름 — 상태 줄에 보인다. */
  name: string;
  /** 깨어 있다. true 가 되면 대화 모드를 켜고, false 가 되면(잠듦) 끈다. */
  awake: boolean;
  /** A fresh notification can focus an already awake operator again. */
  activationKey?: number;
  /** 부르는 말에 이어 한 말 — 대화 모드가 켜지면 곧바로 보낸다. 한 번만 준다. */
  takeFirstPrompt(): string | null;
  /** 들은 말 → 보낼 글. 부르는 말을 떼고, 다른 operator 를 부르면 그리로 넘긴다. null 이면 보내지 않는다. */
  transformUtterance(text: string): string | null;
  /** 사용자가 마이크를 끄거나(`mic-off`) 오래 조용하면(`idle`) — 잠든다. */
  onSleep(reason: 'mic-off' | 'idle'): void;
}

/** 깨어 있는 동안의 상태 줄 — 이름 없이 말하면 된다는 것과 언제 잠드는지를 알려 준다. */
function awakePhaseLabel(phase: ConversationPhase, name: string): string {
  if (phase === 'listening') return translate('🟢 {0} 깨어 있음 — 이름 없이 말하면 됩니다 ({1}초 조용하면 잠듭니다)', { 0: name, 1: Math.round(WAKE_IDLE_SLEEP_MS / 1000) });
  if (phase === 'starting') return translate('🟢 {0} 깨어나는 중…', { 0: name });
  return CONVERSATION_PHASE_LABEL[phase];
}

const CONVERSATION_PHASE_LABEL: Record<ConversationPhase, string> = {
  off: '',
  get starting() { return translate('마이크 준비 중… (처음 한 번은 음성 감지 모델을 받느라 몇 초 걸립니다)'); },
  get 'waiting-gesture'() { return translate('화면을 한 번 누르면 마이크 소리를 듣기 시작합니다'); },
  get listening() { return translate('🎙 듣는 중 — 말을 멈추면 자동으로 보냅니다'); },
  get hearing() { return translate('🔴 말하는 중…'); },
  get transcribing() { return translate('보내는 중…'); },
  get 'paused-for-reply'() { return translate('🔈 답을 읽는 중 — 끝나면 다시 듣습니다'); },
};


export default function SessionComposer({ disabled, busy, placeholder, hint, commands, onSend, onCancel, voiceInput }: SessionComposerProps) {
  useLocale();
  const [text, setText] = useState('');
  const [images, setImages] = useState<SessionPromptImage[]>([]);
  // 보내기 전에 첨부한 그림을 크게 확인한다(대화 속 첨부와 같은 라이트박스).
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [selected, setSelected] = useState(0);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

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
        error = translate('이미지만 보낼 수 있습니다 (png/jpeg/gif/webp/bmp/avif) — {0} 건너뜀', { 0: file.name || translate('이름 없음') });
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        error = translate('8MB 이하만 보낼 수 있습니다 — {0} 건너뜀', { 0: file.name || translate('이름 없음') });
        continue;
      }
      if (imagesRef.current.length + pendings.length >= MAX_IMAGES_PER_PROMPT) {
        error = translate('한 번에 {0}장까지 보낼 수 있습니다', { 0: MAX_IMAGES_PER_PROMPT });
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
        if (!base64) throw new Error(translate('empty'));
        setImages((prev) => prev.map((img) => (img.localId === p.localId
          ? { base64, mime_type: p.mime, name: p.file.name || 'image', size: p.file.size, previewUrl: p.previewUrl, localId: p.localId }
          : img)));
      } catch {
        URL.revokeObjectURL(p.previewUrl);
        setImages((prev) => prev.filter((img) => img.localId !== p.localId));
        setAttachError(translate('읽지 못한 파일이 있습니다 — {0}', { 0: p.file.name || translate('이름 없음') }));
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

  const slash = useMemo(() => matchSlashCommands(text, commands ?? []), [text, commands, getLocale()]);
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
  }, [text, images, disabled, sending, stillReading, onSend, revokeImages]);

  const wake = voiceInput?.wake ?? null;
  const awake = !!wake?.awake;
  const wakeRef = useRef(wake);
  wakeRef.current = wake;
  const submitRef = useRef(submit);
  submitRef.current = submit;

  const conversation = useHandsFreeConversation(useCallback((heard: string) => {
    const binding = wakeRef.current;
    const spoken = binding?.awake ? binding.transformUtterance(heard) : heard;
    if (!spoken) return;
    const merged = [text.trim(), spoken].filter(Boolean).join(' ');
    // 보낼 수 없는 순간(다른 전송 중 · 이미지 읽는 중)이면 버리지 않고 입력창에 남긴다.
    if (!stillReading && !sending && !disabled) {
      void submit(merged);
      return;
    }
    setText(merged);
  }, [text, stillReading, sending, disabled, submit]), { liveCaptions: !!voiceInput?.liveCaptions, keepListeningWhenHidden: awake });
  const showMic = !!voiceInput && conversation.supported;
  const conversing = conversation.phase !== 'off';

  // 깨어나면 대화 모드를 켜고 호출어를 포함한 첫 발화를 보낸다. 잠들면 끈다.
  const { start: startConversation, stop: stopConversation } = conversation;
  const startedByWakeRef = useRef(false);
  useEffect(() => {
    if (!showMic) return;
    if (awake) {
      ref.current?.focus();
      if (!startedByWakeRef.current) {
        startedByWakeRef.current = true;
        void startConversation(false);
      }
      const first = wakeRef.current?.takeFirstPrompt();
      if (first) void submitRef.current(first);
    } else if (startedByWakeRef.current) {
      startedByWakeRef.current = false;
      stopConversation();
    }
  }, [awake, wake?.activationKey, showMic, startConversation, stopConversation]);

  // 깨어 있는데 대화 모드가 꺼졌다(사용자가 🎙 를 껐거나 마이크를 못 열었다) — 잠든다.
  const prevPhaseRef = useRef(conversation.phase);
  useEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = conversation.phase;
    if (awake && prev !== 'off' && conversation.phase === 'off') {
      startedByWakeRef.current = false;
      wakeRef.current?.onSleep('mic-off');
    }
  }, [conversation.phase, awake]);

  // 깨어 있는 동안 아무 말이 없으면 잠든다. 답을 기다리거나 읽는 동안은 세지 않는다.
  useEffect(() => {
    if (!awake || conversation.phase !== 'listening' || busy || sending) return;
    const timer = setTimeout(() => wakeRef.current?.onSleep('idle'), WAKE_IDLE_SLEEP_MS);
    return () => clearTimeout(timer);
  }, [awake, conversation.phase, busy, sending]);

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
  const previewIndex = previewId ? images.findIndex((img) => img.localId === previewId) : -1;
  return (
    <div
      className="awb-session-composer"
      style={{
        borderTop: `1px solid ${tokens.colors.border}`,
        background: tokens.colors.surfaceCard,
        padding: '10px 16px 12px',
        flexShrink: 0,
      }}
    >
      {hint && (
        <div style={{ fontSize: 11.5, color: tokens.colors.textMuted, marginBottom: 6 }}>{hint}</div>
      )}
      {images.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }} aria-label={translate('Attached images')}>
          {images.map((img) => (
            <div
              key={img.localId}
              title={img.name || translate('읽는 중…')}
              style={{
                position: 'relative', width: 56, height: 56, borderRadius: tokens.radii.md, overflow: 'hidden',
                border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface,
              }}
            >
              <button
                type="button"
                onClick={() => setPreviewId(img.localId)}
                aria-label={translate('Preview image {0}', { 0: img.name || 'attached' })}
                style={{ display: 'block', width: '100%', height: '100%', padding: 0, border: 'none', background: 'transparent', cursor: 'zoom-in' }}
              >
                <img src={img.previewUrl} alt={img.name || translate('attached image')} style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: img.base64 ? 1 : 0.5, display: 'block' }} />
              </button>
              <button
                type="button"
                onClick={() => removeImage(img.localId)}
                aria-label={translate('Remove image {0}', { 0: img.name || 'attached' })}
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
      {previewIndex >= 0 && (
        <MediaLightbox
          items={images.map((img) => ({ src: img.previewUrl, kind: 'image' as const, caption: img.name || translate('첨부 이미지'), filename: img.name || 'image' }))}
          index={previewIndex}
          onIndexChange={(next) => setPreviewId(images[next]?.localId ?? null)}
          onClose={() => setPreviewId(null)}
        />
      )}
      {attachError && (
        <div style={{ fontSize: 11.5, color: tokens.colors.warning, marginBottom: 6 }}>{attachError}</div>
      )}
      {showMic && conversation.error && (
        <div role="status" style={{ fontSize: 11.5, color: tokens.colors.warning, marginBottom: 6 }}>{conversation.error}</div>
      )}
      {showMic && conversing && (
        <div
          role="status"
          aria-live="polite"
          data-conversation-phase={conversation.phase}
          style={{
            display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 8, marginBottom: 6, padding: '6px 10px',
            borderRadius: tokens.radii.md, background: tokens.colors.surface, border: `1px solid ${tokens.colors.border}`,
            fontSize: 12, color: tokens.colors.textSecondary,
          }}
        >
          <span style={{ minWidth: 0, overflowWrap: 'anywhere', color: conversation.phase === 'hearing' ? tokens.colors.dangerLight : awake ? tokens.colors.successLight : tokens.colors.textMuted }}>
            {awake && wake ? awakePhaseLabel(conversation.phase, wake.name) : CONVERSATION_PHASE_LABEL[conversation.phase]}
          </span>
          {conversation.caption && (
            <span style={{ flex: 1, minWidth: 0, color: tokens.colors.textPrimary, fontStyle: 'italic' }}>{conversation.caption}</span>
          )}
          {awake && (
            <button
              type="button"
              onClick={() => wakeRef.current?.onSleep('mic-off')}
              title={translate('지금 잠듭니다 — 다시 이름을 부르면 깨어납니다')}
              style={{
                marginLeft: 'auto', flexShrink: 0, padding: '1px 8px', fontSize: 11.5, borderRadius: 999, cursor: 'pointer',
                border: `1px solid ${tokens.colors.border}`, background: 'transparent', color: tokens.colors.textSecondary,
              }}
            >
              {translate('💤 잠들기')}</button>
          )}
        </div>
      )}
      {popupOpen && (
        <ul
          role="listbox"
          aria-label={translate('Slash commands')}
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
              <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12.5, color: tokens.colors.textPrimary, minWidth: 0, overflowWrap: 'anywhere' }}>/{c.name}{c.input_hint ? <span style={{ color: tokens.colors.textMuted }}> {c.input_hint}</span> : null}</span>
              <span style={{ minWidth: 0, fontSize: 12, color: tokens.colors.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.description}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="awb-composer-row">
        {!!commands?.length && (
          <button
            type="button"
            aria-label={translate('Browse slash commands')}
            title={translate('Browse this CLI\'s commands (or type /). Terminal-only commands may be unavailable here.')}
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
          aria-label={translate('Attach images')}
          onChange={(e) => { void addFiles(e.target.files ?? []); e.target.value = ''; }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={locked}
          title={translate('이미지 첨부 (png/jpeg/gif/webp/bmp/avif, 장당 8MB, 최대 5장)')}
          aria-label={translate('Attach images')}
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
            onClick={conversation.toggle}
            disabled={disabled}
            aria-label={conversing ? translate('Stop conversation mode') : translate('Start conversation mode')}
            aria-pressed={conversing}
            title={conversing
              ? translate('대화 모드 끄기 — 마이크를 닫습니다')
              : translate('대화 모드 — 켜 두고 말하면, 말을 멈출 때마다 자동으로 보냅니다')}
            style={{
              height: 40, minWidth: 40, padding: '0 10px', borderRadius: tokens.radii.lg,
              border: `1px solid ${conversing ? tokens.colors.danger : tokens.colors.border}`,
              background: conversing ? `${tokens.colors.danger}22` : tokens.colors.surface,
              color: conversing ? tokens.colors.dangerLight : disabled ? tokens.colors.textMuted : tokens.colors.textSecondary,
              fontSize: 16, cursor: disabled ? 'not-allowed' : 'pointer',
              // 입력 크기를 테두리 그림자로 — 듣고 있다는 것을 눈으로 확인한다.
              boxShadow: conversation.phase === 'hearing' || conversation.phase === 'listening'
                ? `0 0 0 ${Math.round(2 + conversation.level * 8)}px ${tokens.colors.danger}33` : 'none',
              transition: 'box-shadow 80ms linear',
            }}
          >
            {conversation.phase === 'starting' ? '…' : '🎙'}
          </button>
        )}
        <textarea
          className="awb-composer-input"
          ref={ref}
          value={text}
          rows={1}
          disabled={disabled}
          placeholder={placeholder}
          aria-label={translate('Prompt')}
          aria-expanded={popupOpen}
          aria-autocomplete={commands && commands.length ? 'list' : undefined}
          onChange={(e) => { setText(e.target.value); if (dismissedFor !== null && e.target.value !== dismissedFor) setDismissedFor(null); }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          style={{
            flex: 1,
            minWidth: 0,
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
            {translate('Cancel')}</button>
        )}
        <button
          type="button"
          className="awb-composer-send"
          onClick={() => void submit()}
          disabled={locked || !canSend || stillReading}
          title={busy ? translate('진행 중인 턴에 바로 보냅니다 — 에이전트가 작업 중에 읽고 이어서 답합니다') : undefined}
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
          {sending ? translate('Sending…') : translate('Send')}
        </button>
      </div>
      <div className="awb-composer-help" style={{ marginTop: 5, fontSize: 10.5, color: tokens.colors.textMuted }}>
        {busy ? translate('Enter sends into the running turn — the agent reads it mid-task') : translate('Enter to send')} {translate('· Shift+Enter for a new line · 📎 or paste images to attach')}{showMic ? translate(' · 🎙 conversation mode: just talk, pause to send') : ''}{commands && commands.length ? translate(' · type / for {0} commands', { 0: commands.length }) : translate(' · slash commands go straight to the CLI')}
      </div>
    </div>
  );
}
