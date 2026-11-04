import { getLocaleTag } from '../../i18n/core';
import { t as translate, getLocale } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { tokens } from '../../tokens';
import CodeBlock from '../common/CodeBlock';
import Markdown, { type MarkdownLinkRenderer } from '../common/Markdown';
import { formatReceivedAt, usageSummaryParts } from './sessionTranscript.logic';
import type { ElicitationFieldView, PermissionOptionView, TranscriptBlock } from './sessionTranscript.logic';
import { isRemoteVideoUrl, splitMarkdownImages } from './markdownImages';
import MediaLightbox, { type MediaLightboxItem } from '../common/MediaLightbox';
import { isAndroidApp } from '../../native/androidBridge';

/**
 * Agent Session 트랜스크립트 렌더러. Chat 의 MessageList 와 달리 말풍선 목록이
 * 아니라 CLI 세션 기록이다 — 스트리밍 텍스트, 접을 수 있는 사고/툴콜 카드,
 * 허용/거부 버튼이 달린 권한 카드, 턴 종료/오류/시스템 노트.
 */

export type ElicitationAction = 'accept' | 'decline' | 'cancel';

export interface SessionTranscriptProps {
  blocks: TranscriptBlock[];
  /** 결정 중인 request_id / elicitation_id (버튼 잠금). */
  decidingRequestId: string | null;
  onDecidePermission: (requestId: string, optionId: string | null) => void;
  /** 질문/폼(ACP elicitation) 답 — accept 면 content 가 요청 schema 에 맞는 객체다. */
  onAnswerElicitation?: (elicitationId: string, action: ElicitationAction, content: Record<string, unknown> | null) => void;
  /** 세션이 살아 있지 않으면(closed/suspended) 미결 권한·질문 버튼을 잠근다. */
  permissionsEnabled: boolean;
  /** 이미지 참조 → 바이트. 라우트 파라미터를 아는 페이지가 넘긴다(전사는 표현만 책임진다).
   *  `<img src>` 는 Authorization 헤더를 못 보내므로 URL 이 아니라 Blob 을 받아서 쓴다 —
   *  토큰을 쿼리로 노출하는 두 번째 인증 경로를 만들지 않기 위해서다. 안 넘기면 이미지
   *  블록은 "볼 수 없음" 으로 접힌다. */
  loadImage?: (imageRef: string) => Promise<Blob>;
  /** 에이전트가 답에 **경로로** 적은 이미지(`![alt](E:/…png)`) → 바이트. Runtime Host 매니저가
   *  그 장비에서 읽어 준다(Codex 데스크톱 앱이 같은 마크다운을 자기 장비 파일로 그리는 것의 원격판).
   *  안 넘기면 그 자리에 경로만 보인다. */
  loadLocalImage?: (path: string) => Promise<Blob>;
  /** 답에 **경로로** 적은 영상(`![데모](./out/demo.mp4)`) → 바이트. 매니저가 조각으로 읽어 주는 것을 끝까지
   *  모은다 — 전사는 진행률을 보이고, 떠나면 `signal` 로 멈춘다. 안 넘기면 그 자리에 경로만 보인다. */
  loadLocalVideo?: LocalVideoLoader;
  /** 같은 영상의 앞부분만(썸네일 한 장면용) — 바이트와 파일 전체 크기. */
  loadLocalVideoPreview?: LocalVideoPreviewLoader;
}

export type LocalVideoLoader = (
  path: string,
  options?: { onProgress?: (loaded: number, total: number) => void; signal?: AbortSignal },
) => Promise<Blob>;

export type LocalVideoPreviewLoader = (path: string, options?: { signal?: AbortSignal }) => Promise<{ blob: Blob; size: number }>;

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const MAX_PRE_CHARS = 20_000;

function stringify(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function clip(text: string): string {
  return text.length > MAX_PRE_CHARS ? `${text.slice(0, MAX_PRE_CHARS)}\n…` : text;
}

function toolGlyph(kind: string, delegated: boolean): string {
  if (delegated) return '⇢';
  switch (kind) {
    case 'read': return '📄';
    case 'edit': return '✏️';
    case 'delete': return '🗑';
    case 'move': return '↪';
    case 'search': return '🔍';
    case 'execute': return '⌘';
    case 'fetch': return '🌐';
    case 'think': return '💭';
    default: return '🛠';
  }
}

function statusChip(status: string): { text: string; color: string; bg: string } {
  switch (status) {
    case 'completed':
      return { text: translate('done'), color: tokens.colors.successLight, bg: tokens.colors.successBg };
    case 'failed':
      return { text: translate('failed'), color: tokens.colors.dangerLight, bg: tokens.colors.dangerBg };
    case 'cancelled':
      return { text: translate('cancelled'), color: tokens.colors.warningLight, bg: tokens.colors.warningBg };
    default:
      return { text: translate('running'), color: tokens.colors.accentSubtle, bg: tokens.colors.badgeAgentBg };
  }
}


const cardStyle: React.CSSProperties = {
  border: `1px solid ${tokens.colors.border}`,
  borderRadius: tokens.radii.lg,
  background: tokens.colors.surfaceCard,
  padding: '8px 12px',
  maxWidth: 860,
};

const summaryStyle: React.CSSProperties = {
  cursor: 'pointer',
  fontSize: 12,
  color: tokens.colors.textSecondary,
  userSelect: 'none',
};

function promptTime(iso: string): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** 말풍선 위에 붙는 출처 한 줄 — 누가 보낸 말인지(직접 입력 · 음성 · 다른 세션 · 시스템)를 글자로 못 박는다. */
function SenderLabel({ align, children }: { align: 'left' | 'right'; children: React.ReactNode }) {
  useLocale();
  return (
    <span
      data-sender-label={align}
      style={{
        fontSize: 11, color: tokens.colors.textMuted, lineHeight: 1.4,
        alignSelf: align === 'right' ? 'flex-end' : 'flex-start',
      }}
    >
      {children}
    </span>
  );
}

/** AWB 가 operator 에게 보낸 작업 보고 — 사람이 쓴 말이 아니라서 접어 두고, 펼치면 원문을 보여 준다. */
function ReportPromptBlock({ text, createdAt }: { text: string; createdAt?: string }) {
  useLocale();
  const count = (text.match(/^\d+\. /gm) || []).length;
  const time = createdAt ? promptTime(createdAt) : '';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 3 }}>
      <SenderLabel align="left">{translate('📋 다른 세션 소식 · AWB 자동')}{time ? ` · ${time}` : ''}</SenderLabel>
      <details
        data-block="operator-report"
        data-origin="operator-report"
        style={{
          maxWidth: 860, padding: '8px 12px', borderRadius: tokens.radii.md, fontSize: 12.5,
          background: tokens.colors.surfaceSubtle, border: `1px dashed ${tokens.colors.accent}`,
          borderLeft: `3px solid ${tokens.colors.accent}`,
          color: tokens.colors.textSecondary, alignSelf: 'flex-start',
        }}
      >
        <summary style={{ cursor: 'pointer' }}>{translate('다른 세션에서 받은 자동 보고')}{count ? translate(' · {0}건', { 0: count }) : ''} {translate('— 내가 쓴 말이 아닙니다')}</summary>
        <div style={{ marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, color: tokens.colors.textMuted }}>{text}</div>
      </details>
    </div>
  );
}

/** operator 가 제안하고 사용자가 승인한 작업 — 왼쪽 주황 카드로 그려 사용자 직접 입력과 구분한다. */
function OperatorTaskPromptBlock({ text, operator, createdAt }: { text: string; operator: string; createdAt?: string }) {
  useLocale();
  const time = createdAt ? promptTime(createdAt) : '';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 3 }}>
      <SenderLabel align="left">🧭 {operator} {translate('제안 · 사용자 승인 — 내가 쓴 말이 아닙니다')}{time ? ` · ${time}` : ''}</SenderLabel>
      <div
        data-block="operator-task"
        data-origin="operator-task"
        style={{
          maxWidth: 860, alignSelf: 'flex-start',
          padding: '9px 13px', borderRadius: tokens.radii.md,
          border: `1px solid ${tokens.colors.warning}`,
          borderLeft: `3px solid ${tokens.colors.warningLight}`,
          background: tokens.colors.warningBg,
          color: tokens.colors.textPrimary, fontSize: 13.5, lineHeight: 1.5,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}
      >
        {text}
      </div>
    </div>
  );
}

/**
 * 사람이 아니라 시스템이 보낸 프롬프트 — 직접 입력과 구분한다. 비동기 질문의 답 전달(첫 줄은 안내라 떼고 본문만),
 * 재시작으로 끊긴 턴의 재개(고정 문구 그대로).
 */
function SystemPromptBlock({ origin, label, text, createdAt, dropFirstLine }: {
  origin: 'async-answer' | 'restart-resume';
  label: string;
  text: string;
  createdAt?: string;
  dropFirstLine?: boolean;
}) {
  useLocale();
  const time = createdAt ? promptTime(createdAt) : '';
  const lines = text.split('\n');
  const body = dropFirstLine && lines.length > 1 ? lines.slice(1).join('\n').trim() : text;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 3 }}>
      <SenderLabel align="left">{label}{time ? ` · ${time}` : ''}</SenderLabel>
      <div
        data-block={origin}
        data-origin={origin}
        style={{
          maxWidth: 860, alignSelf: 'flex-start',
          padding: '8px 12px', borderRadius: tokens.radii.md,
          border: `1px solid ${tokens.colors.border}`,
          borderLeft: `3px solid ${tokens.colors.accent}`,
          background: tokens.colors.surfaceSubtle,
          color: tokens.colors.textSecondary, fontSize: 12.5, lineHeight: 1.6,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}
      >
        {body || text}
      </div>
    </div>
  );
}

function PromptBlock({ text, voice, createdAt }: { text: string; voice?: boolean; createdAt?: string }) {
  useLocale();
  const time = createdAt ? promptTime(createdAt) : '';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
      <SenderLabel align="right">{voice ? translate('🎙 음성으로 입력') : translate('👤 직접 입력')}{time ? ` · ${time}` : ''}</SenderLabel>
      <div style={{ display: 'flex', justifyContent: 'flex-end', width: '100%' }}>
      <div
        data-block="prompt"
        data-origin={voice ? 'voice' : 'user'}
        style={{
          maxWidth: 'min(760px, 85%)',
          padding: '9px 13px',
          borderRadius: `${tokens.radii.xl}px ${tokens.radii.xl}px ${tokens.radii.xs}px ${tokens.radii.xl}px`,
          background: tokens.overlays.accentStrong,
          border: `1px solid ${tokens.colors.accent}`,
          color: tokens.colors.textPrimary,
          fontSize: 13.5,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {voice && (
          <div data-prompt-voice="wake" style={{ fontSize: 10.5, color: tokens.colors.textMuted, marginBottom: 3 }} title={translate('이름을 불러 깨운 뒤의 첫 요청 — 음성 대화 안내 한 줄이 함께 갔습니다')}>
            {translate('🎙 불러서 시작')}</div>
        )}
        {text}
      </div>
      </div>
    </div>
  );
}

function AutomaticPromptBlock({ text }: { text: string }) {
  useLocale();
  return (
    <aside
      data-block="automatic-prompt"
      role="note"
      aria-label={translate('자동 이어쓰기')}
      style={{
        maxWidth: 860,
        alignSelf: 'flex-start',
        padding: '9px 13px',
        borderRadius: tokens.radii.md,
        borderLeft: `3px solid ${tokens.colors.warningLight}`,
        background: tokens.colors.surfaceSubtle,
        color: tokens.colors.textSecondary,
        fontSize: 12,
        lineHeight: 1.6,
      }}
    >
      <div style={{ color: tokens.colors.warningLight, fontWeight: 600 }}>
        <span aria-hidden="true">↻ </span>{translate('자동 이어쓰기')}</div>
      <div>{translate('표시된 응답이 없어 자동으로 이어쓰기를 요청했습니다.')}</div>
      <details style={{ marginTop: 4 }}>
        <summary style={{ cursor: 'pointer' }}>{translate('전송된 원문 보기')}</summary>
        <div style={{ marginTop: 4, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{text}</div>
      </details>
    </aside>
  );
}

function AssistantBlock({ text, loadLocalImage, loadLocalVideo, loadLocalVideoPreview, registerMedia, openMedia }: { text: string; loadLocalImage?: (path: string) => Promise<Blob>; loadLocalVideo?: LocalVideoLoader; loadLocalVideoPreview?: LocalVideoPreviewLoader; registerMedia?: (key: string, item: MediaLightboxItem) => void; openMedia?: (key: string) => void }) {
  useLocale();
  // 원격 영상 링크(맨 URL 포함)는 글 안에 둔 채 바로 아래에 썸네일을 붙인다 — 링크를 카드로 떼면 목록이 끊긴다.
  const renderLink = useCallback<MarkdownLinkRenderer>(
    (href, children) => (isRemoteVideoUrl(href)
      ? <VideoLink href={href} registerMedia={registerMedia} openMedia={openMedia}>{children}</VideoLink>
      : undefined),
    [registerMedia, openMedia],
  );
  // 인증된 이미지·파일·영상 미리보기 자리를 먼저 떼고, 나머지는 세션 Markdown으로 그린다.
  // 이미지와 로컬 html/md 는 같은 통(`local_image` RPC)으로 받으므로 로더도 하나를 공유한다.
  const nodes = useMemo(
    () => splitMarkdownImages(text).map((seg, i) => {
      if (seg.kind === 'text') return <Markdown key={i} text={seg.text} renderLink={renderLink} />;
      if (seg.kind === 'file') {
        return <MarkdownFile key={i} alt={seg.alt} target={seg.target} fileKind={seg.fileKind} loadLocalFile={loadLocalImage} />;
      }
      if (seg.kind === 'video') {
        return (
          <VideoThumb
            key={i}
            source={seg.source}
            target={seg.target}
            label={seg.alt}
            withCaption
            loadLocalVideo={loadLocalVideo}
            loadLocalVideoPreview={loadLocalVideoPreview}
            registerMedia={registerMedia}
            openMedia={openMedia}
          />
        );
      }
      return <MarkdownImage key={i} alt={seg.alt} target={seg.target} source={seg.source} loadLocalImage={loadLocalImage} registerMedia={registerMedia} openMedia={openMedia} />;
    }),
    [text, loadLocalImage, loadLocalVideo, loadLocalVideoPreview, renderLink, registerMedia, openMedia, getLocale()],
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 3 }}>
      <SenderLabel align="left">{translate('🤖 에이전트')}</SenderLabel>
      <div
        data-block="assistant"
        style={{
          // 내용 폭으로 크는 말풍선이라 860 만으로는 막히지 않는다 — 코드 블록의 긴 줄(white-space: pre)이
          // 말풍선을 화면 밖으로 밀어 전사 전체가 가로로 스크롤됐다. 폭을 전사에 묶어 코드가 제자리에서 스크롤되게 한다.
          maxWidth: 'min(860px, 100%)',
          color: tokens.colors.textPrimary,
          fontSize: 13.5,
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {nodes}
      </div>
    </div>
  );
}

function ReasoningBlock({ text }: { text: string }) {
  useLocale();
  return (
    <details data-block="reasoning" style={{ ...cardStyle, background: 'transparent', borderStyle: 'dashed' }}>
      <summary style={summaryStyle}>{translate('💭 Thinking (')}{text.length.toLocaleString(getLocaleTag())} {translate('chars)')}</summary>
      <div style={{ marginTop: 6, color: tokens.colors.textMuted, fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {clip(text)}
      </div>
    </details>
  );
}

function ToolBlock({ block }: { block: Extract<TranscriptBlock, { kind: 'tool' }> }) {
  useLocale();
  const chip = statusChip(block.status);
  const input = stringify(block.input);
  const output = stringify(block.output);
  return (
    <details data-block="tool" style={cardStyle}>
      <summary style={{ ...summaryStyle, display: 'flex', alignItems: 'center', gap: 8, color: tokens.colors.textStrong }}>
        <span aria-hidden="true">{toolGlyph(block.toolKind, block.delegated)}</span>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {block.delegated ? translate('Delegated: {0}', { 0: block.title }) : block.title}
        </span>
        {block.toolKind && (
          <span style={{ fontFamily: MONO, fontSize: 10.5, color: tokens.colors.textMuted }}>{block.toolKind}</span>
        )}
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            padding: '1px 7px',
            borderRadius: 999,
            color: chip.color,
            background: chip.bg,
          }}
        >
          {block.status === 'in_progress' ? <span className="awb-pending-pulse">{chip.text}</span> : chip.text}
        </span>
      </summary>
      {input && (
        <div>
          <CodeBlock code={input} displayCode={clip(input)} language="Input" maxHeight={320} />
        </div>
      )}
      {output && (
        <div>
          <CodeBlock code={output} displayCode={clip(output)} language="Output" maxHeight={320} />
        </div>
      )}
    </details>
  );
}

function optionTone(option: PermissionOptionView): 'allow' | 'deny' {
  return option.kind.startsWith('allow') ? 'allow' : 'deny';
}

function PermissionBlock({
  block,
  deciding,
  enabled,
  onDecide,
}: {
  block: Extract<TranscriptBlock, { kind: 'permission' }>;
  deciding: boolean;
  enabled: boolean;
  onDecide: (requestId: string, optionId: string | null) => void;
}) {
  useLocale();
  const decided = block.decision;
  const rawInput = stringify(block.rawInput);
  const decidedOption = decided?.option_id ? block.options.find((o) => o.option_id === decided.option_id) : null;
  return (
    <div
      data-block="permission"
      role="group"
      aria-label={translate('Permission request')}
      style={{
        ...cardStyle,
        borderColor: decided ? tokens.colors.border : tokens.colors.warning,
        boxShadow: decided ? undefined : `0 0 0 1px ${tokens.colors.warning}33`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: tokens.colors.textPrimary, fontWeight: 600 }}>
        <span aria-hidden="true">🔐</span>
        <span style={{ flex: 1, minWidth: 0 }}>{block.title}</span>
        {block.toolKind && <span style={{ fontFamily: MONO, fontSize: 10.5, color: tokens.colors.textMuted, fontWeight: 400 }}>{block.toolKind}</span>}
      </div>
      {block.description && (
        <div style={{ marginTop: 4, fontSize: 12, color: tokens.colors.textSecondary, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{block.description}</div>
      )}
      {rawInput && (
        <details style={{ marginTop: 4 }}>
          <summary style={summaryStyle}>{translate('Details')}</summary>
          <CodeBlock code={rawInput} displayCode={clip(rawInput)} language="Input" maxHeight={320} />
        </details>
      )}
      {decided ? (
        <div style={{ marginTop: 8, fontSize: 12, color: decided.outcome === 'selected' && optionTone(decidedOption ?? { option_id: '', name: '', kind: 'reject' }) === 'allow' ? tokens.colors.successLight : tokens.colors.textSecondary }}>
          {decided.outcome === 'selected'
            ? `${decidedOption?.name || decided.option_id || translate('Selected')}`
            : translate('Denied')}
          <span style={{ color: tokens.colors.textMuted }}> · {decided.decided_by === 'user' ? translate('by you') : decided.decided_by === 'policy' ? translate('by session policy') : decided.decided_by === 'timeout' ? translate('timed out') : decided.decided_by === 'system' ? translate('agent process stopped') : decided.decided_by}</span>
        </div>
      ) : (
        <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {block.options.map((option) => {
            const tone = optionTone(option);
            return (
              <button
                key={option.option_id}
                type="button"
                disabled={deciding || !enabled}
                onClick={() => onDecide(block.requestId, option.option_id)}
                style={{
                  padding: '6px 12px',
                  borderRadius: tokens.radii.md,
                  border: `1px solid ${tone === 'allow' ? tokens.colors.success : tokens.colors.danger}`,
                  background: tone === 'allow' ? tokens.colors.successBg : 'transparent',
                  color: tone === 'allow' ? tokens.colors.successPale : tokens.colors.dangerLight,
                  fontSize: 12.5,
                  fontWeight: 600,
                  cursor: deciding || !enabled ? 'not-allowed' : 'pointer',
                  opacity: deciding || !enabled ? 0.6 : 1,
                }}
              >
                {option.name}
              </button>
            );
          })}
          <button
            type="button"
            disabled={deciding || !enabled}
            onClick={() => onDecide(block.requestId, null)}
            style={{
              padding: '6px 12px',
              borderRadius: tokens.radii.md,
              border: `1px solid ${tokens.colors.borderStrong}`,
              background: 'transparent',
              color: tokens.colors.textSecondary,
              fontSize: 12.5,
              cursor: deciding || !enabled ? 'not-allowed' : 'pointer',
              opacity: deciding || !enabled ? 0.6 : 1,
            }}
          >
            {translate('Cancel request')}</button>
          {!enabled && (
            <span style={{ alignSelf: 'center', fontSize: 11.5, color: tokens.colors.textMuted }}>
              {translate('Session is not live — send a prompt to reopen it.')}</span>
          )}
        </div>
      )}
    </div>
  );
}

const fieldInputStyle: React.CSSProperties = {
  width: '100%',
  padding: '7px 10px',
  borderRadius: tokens.radii.md,
  border: `1px solid ${tokens.colors.border}`,
  background: tokens.colors.surface,
  color: tokens.colors.textPrimary,
  fontSize: 13,
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};

function initialElicitationValues(fields: ElicitationFieldView[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.defaultValue !== undefined && f.defaultValue !== null) out[f.name] = f.defaultValue;
    else if (f.type === 'boolean') out[f.name] = false;
    else if (f.type === 'array') out[f.name] = [];
  }
  return out;
}

function elicitationValueMissing(field: ElicitationFieldView, value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** 답을 요청 schema 의 타입으로 정리한다 — 빈 선택 필드는 빼고, 숫자는 Number 로. */
export function coerceElicitationContent(fields: ElicitationFieldView[], values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = values[f.name];
    if (elicitationValueMissing(f, v)) continue;
    if (f.type === 'number' || f.type === 'integer') {
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isFinite(n)) out[f.name] = f.type === 'integer' ? Math.round(n) : n;
    } else if (f.type === 'boolean') {
      out[f.name] = !!v;
    } else if (f.type === 'array') {
      out[f.name] = Array.isArray(v) ? v.map((x) => String(x)) : [String(v)];
    } else {
      out[f.name] = String(v);
    }
  }
  return out;
}

function ElicitationField({ field, value, onChange, disabled }: {
  field: ElicitationFieldView; value: unknown; onChange: (next: unknown) => void; disabled: boolean;
}) {
  useLocale();
  const label = (
    <div style={{ fontSize: 12, color: tokens.colors.textSecondary, marginBottom: 4 }}>
      {field.title}{field.required && <span style={{ color: tokens.colors.dangerLight }}> *</span>}
      {field.description && <span style={{ color: tokens.colors.textMuted }}> — {field.description}</span>}
    </div>
  );
  if (field.type === 'boolean') {
    return (
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: tokens.colors.textPrimary, cursor: disabled ? 'not-allowed' : 'pointer' }}>
        <input type="checkbox" checked={!!value} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span>{field.title}{field.description ? <span style={{ color: tokens.colors.textMuted }}> — {field.description}</span> : null}</span>
      </label>
    );
  }
  if (field.type === 'array' && field.choices) {
    const selected = Array.isArray(value) ? value.map((x) => String(x)) : [];
    return (
      <div>
        {label}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {field.choices.map((c) => (
            <label key={c.value} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: tokens.colors.textPrimary }}>
              <input
                type="checkbox"
                checked={selected.includes(c.value)}
                disabled={disabled}
                onChange={(e) => onChange(e.target.checked ? [...selected, c.value] : selected.filter((v) => v !== c.value))}
              />
              {c.label}
            </label>
          ))}
        </div>
      </div>
    );
  }
  if (field.choices) {
    return (
      <div>
        {label}
        <select aria-label={field.title} style={fieldInputStyle} value={typeof value === 'string' ? value : ''} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          <option value="">{field.required ? translate('Choose…') : translate('(none)')}</option>
          {field.choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </div>
    );
  }
  if (field.type === 'number' || field.type === 'integer') {
    return (
      <div>
        {label}
        <input
          aria-label={field.title}
          type="number"
          style={fieldInputStyle}
          value={value === undefined || value === null ? '' : String(value)}
          min={field.minimum}
          max={field.maximum}
          step={field.type === 'integer' ? 1 : 'any'}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
        />
      </div>
    );
  }
  const long = (field.maxLength ?? 0) > 200 || field.maxLength === undefined;
  return (
    <div>
      {label}
      {long ? (
        <textarea aria-label={field.title} rows={2} style={{ ...fieldInputStyle, resize: 'vertical' }} value={typeof value === 'string' ? value : ''} maxLength={field.maxLength} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input aria-label={field.title} type={field.format === 'email' ? 'email' : field.format === 'uri' ? 'url' : 'text'} style={fieldInputStyle} value={typeof value === 'string' ? value : ''} maxLength={field.maxLength} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}

/** 에이전트의 질문/폼(ACP elicitation). form 은 schema 대로 입력을 그리고 Submit/Decline, url 은 링크 카드. */
function ElicitationBlock({ block, deciding, enabled, onAnswer }: {
  block: Extract<TranscriptBlock, { kind: 'elicitation' }>;
  deciding: boolean;
  enabled: boolean;
  onAnswer?: (elicitationId: string, action: ElicitationAction, content: Record<string, unknown> | null) => void;
}) {
  useLocale();
  const fields = block.schema?.fields ?? [];
  const [values, setValues] = useState<Record<string, unknown>>(() => initialElicitationValues(fields));
  const decided = block.decision;
  const locked = deciding || !enabled || !onAnswer;
  const missing = fields.filter((f) => f.required && elicitationValueMissing(f, values[f.name]));
  const decidedByLabel = decided?.decided_by === 'user' ? translate('by you') : decided?.decided_by === 'agent' ? translate('by the agent') : decided?.decided_by === 'timeout' ? translate('timed out') : decided?.decided_by === 'system' ? translate('agent process stopped') : decided?.decided_by;
  return (
    <div
      data-block="elicitation"
      role="group"
      aria-label={translate('Agent question')}
      style={{
        ...cardStyle,
        borderColor: decided ? tokens.colors.border : tokens.colors.accent,
        boxShadow: decided ? undefined : `0 0 0 1px ${tokens.colors.accent}33`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: tokens.colors.textPrimary, fontWeight: 600 }}>
        <span aria-hidden="true">❓</span>
        <span style={{ flex: 1, minWidth: 0 }}>{block.schema?.title || (block.mode === 'url' ? translate('Continue in your browser') : translate('The agent needs your input'))}</span>
      </div>
      {block.message && (
        <div style={{ marginTop: 6, fontSize: 13, color: tokens.colors.textPrimary, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{block.message}</div>
      )}
      {block.schema?.description && (
        <div style={{ marginTop: 4, fontSize: 12, color: tokens.colors.textSecondary }}>{block.schema.description}</div>
      )}
      {block.mode === 'url' ? (
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {block.url && (
            <a href={block.url} target="_blank" rel="noopener noreferrer" style={{ color: tokens.colors.accentLight, fontSize: 12.5, wordBreak: 'break-all' }}>{block.url}</a>
          )}
          <span style={{ fontSize: 11.5, color: tokens.colors.textMuted }}>
            {decided ? translate('Completed · {0}', { 0: decidedByLabel }) : translate('Waiting for you to finish there…')}
          </span>
        </div>
      ) : decided ? (
        <div style={{ marginTop: 8, fontSize: 12, color: decided.action === 'accept' ? tokens.colors.successLight : tokens.colors.textSecondary }}>
          {decided.action === 'accept'
            ? (decided.content && Object.keys(decided.content).length
              ? Object.entries(decided.content).map(([k, v]) => `${fields.find((f) => f.name === k)?.title || k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`).join(' · ')
              : translate('Submitted'))
            : decided.action === 'decline' ? translate('Declined') : translate('Cancelled')}
          <span style={{ color: tokens.colors.textMuted }}> · {decidedByLabel}</span>
        </div>
      ) : (
        <form
          style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (locked || missing.length) return;
            onAnswer?.(block.elicitationId, 'accept', coerceElicitationContent(fields, values));
          }}
        >
          {fields.map((f) => (
            <ElicitationField key={f.name} field={f} value={values[f.name]} disabled={locked} onChange={(next) => setValues((prev) => ({ ...prev, [f.name]: next }))} />
          ))}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <button
              type="submit"
              disabled={locked || missing.length > 0}
              style={{
                padding: '6px 14px', borderRadius: tokens.radii.md, border: `1px solid ${tokens.colors.success}`,
                background: tokens.colors.successBg, color: tokens.colors.successPale, fontSize: 12.5, fontWeight: 600,
                cursor: locked || missing.length ? 'not-allowed' : 'pointer', opacity: locked || missing.length ? 0.6 : 1,
              }}
            >
              {translate('Submit')}</button>
            <button
              type="button"
              disabled={locked}
              onClick={() => onAnswer?.(block.elicitationId, 'decline', null)}
              style={{ padding: '6px 12px', borderRadius: tokens.radii.md, border: `1px solid ${tokens.colors.borderStrong}`, background: 'transparent', color: tokens.colors.textSecondary, fontSize: 12.5, cursor: locked ? 'not-allowed' : 'pointer', opacity: locked ? 0.6 : 1 }}
            >
              {translate('Decline')}</button>
            <button
              type="button"
              disabled={locked}
              onClick={() => onAnswer?.(block.elicitationId, 'cancel', null)}
              style={{ padding: '6px 12px', borderRadius: tokens.radii.md, border: `1px solid ${tokens.colors.borderStrong}`, background: 'transparent', color: tokens.colors.textMuted, fontSize: 12.5, cursor: locked ? 'not-allowed' : 'pointer', opacity: locked ? 0.6 : 1 }}
            >
              {translate('Cancel')}</button>
            {missing.length > 0 && <span style={{ fontSize: 11.5, color: tokens.colors.textMuted }}>{translate('Fill in')} {missing.map((f) => f.title).join(', ')}</span>}
            {!enabled && <span style={{ fontSize: 11.5, color: tokens.colors.textMuted }}>{translate('Session is not live — send a prompt to reopen it.')}</span>}
          </div>
        </form>
      )}
    </div>
  );
}

function planGlyph(status: string): string {
  switch (status) {
    case 'completed': return '☑';
    case 'in_progress': return '◐';
    default: return '☐';
  }
}

/** 에이전트의 작업 계획(ACP plan) — 같은 turn 의 최신 목록만 남는다. */
function PlanBlock({ block }: { block: Extract<TranscriptBlock, { kind: 'plan' }> }) {
  useLocale();
  const done = block.entries.filter((e) => e.status === 'completed').length;
  return (
    <details data-block="plan" open style={cardStyle}>
      <summary style={{ ...summaryStyle, color: tokens.colors.textStrong }}>
        {translate('📋 Plan ·')} {done}/{block.entries.length} {translate('done')}</summary>
      <ul style={{ margin: '6px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {block.entries.map((e, i) => (
          <li key={i} style={{ display: 'flex', gap: 8, fontSize: 12.5, color: e.status === 'completed' ? tokens.colors.textMuted : tokens.colors.textPrimary, textDecoration: e.status === 'completed' ? 'line-through' : 'none' }}>
            <span aria-hidden="true" style={{ color: e.status === 'in_progress' ? tokens.colors.accentLight : tokens.colors.textMuted }}>{planGlyph(e.status)}</span>
            <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>{e.content}</span>
            {e.priority === 'high' && <span style={{ fontSize: 10.5, color: tokens.colors.warningLight }}>{translate('high')}</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}

function Note({ children, tone, multiline = false }: { children: React.ReactNode; tone: 'muted' | 'danger' | 'warning'; multiline?: boolean }) {
  useLocale();
  const color = tone === 'danger' ? tokens.colors.dangerLight : tone === 'warning' ? tokens.colors.warningLight : tokens.colors.textMuted;
  return (
    <div style={{ display: 'flex', justifyContent: 'center' }}>
      <div
        style={{
          fontSize: 11.5,
          color,
          padding: multiline ? '8px 12px' : '3px 10px',
          borderRadius: multiline ? 8 : 999,
          border: `1px solid ${tone === 'muted' ? tokens.colors.border : color}`,
          background: tokens.colors.surface,
          maxWidth: 760,
          textAlign: multiline ? 'left' : 'center',
          whiteSpace: multiline ? 'pre-wrap' : undefined,
          wordBreak: 'break-word',
        }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * 서버는 세션 이미지 바이트를 형식 없이(application/octet-stream) 준다 — 형식은 이벤트가 들고 있다. 그 형식을
 * 붙여야 내려받은 파일에 확장자가 붙고(브라우저도 앱도 형식으로 정한다) 앱의 클립보드가 이미지로 받는다.
 * 서버의 미리보기 파일 규칙처럼 SVG 는 붙이지 않는다 — blob: 주소는 이 화면의 출처로 열린다.
 */
export function typedSessionMedia(blob: Blob, mimeType: string | undefined): Blob {
  const mime = (mimeType || '').toLowerCase();
  if (blob.type && blob.type !== 'application/octet-stream') return blob;
  if (!/^(image|video)\/[a-z0-9.+-]+$/.test(mime) || mime === 'image/svg+xml') return blob;
  return new Blob([blob], { type: mime });
}

/**
 * 에이전트가 내보낸 이미지 한 장.
 *
 * 바이트는 이벤트에 실려 오지 않는다(base64 는 1.33배로 불어나 payload 상한에 걸리고,
 * 예전에는 그래서 이미지가 조용히 사라졌다) — 참조로 따로 받아 Blob URL 로 그린다.
 * URL 은 이 컴포넌트 수명에 묶고 unmount 때 revoke 한다(안 하면 전사를 오래 열어 둘수록
 * 브라우저 메모리에 blob 이 쌓인다).
 */
function ImageBlock({
  block,
  loadImage,
  registerMedia,
  openMedia,
}: {
  block: Extract<TranscriptBlock, { kind: 'image' }>;
  loadImage?: (imageRef: string) => Promise<Blob>;
  registerMedia?: (key: string, item: MediaLightboxItem) => void;
  openMedia?: (key: string) => void;
}) {
  useLocale();
  const fromUser = (block as { from?: string }).from === 'user';
  const [url, setUrl] = useState<string>(block.uri || '');
  const [error, setError] = useState<string | null>(null);

  const [attempt, setAttempt] = useState(0);
  const mediaKey = `img:${block.imageRef || block.uri || ''}`;
  const isVideo = (block.mimeType || '').toLowerCase().startsWith('video/');

  useEffect(() => {
    setUrl(block.uri || '');
    setError(null);
    // 어댑터가 URL 로 준 외부 이미지는 그대로 쓴다 — 가져올 바이트가 없다.
    if (block.uri || !block.imageRef || !loadImage) return;
    let revoked = false;
    let objectUrl = '';
    void (async () => {
      try {
        const blob = await loadImage(block.imageRef);
        if (revoked) return;
        objectUrl = URL.createObjectURL(typedSessionMedia(blob, block.mimeType));
        setUrl(objectUrl);
      } catch (err: any) {
        if (!revoked) setError(err?.message || translate('이미지를 가져오지 못했습니다'));
      }
    })();
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [block.uri, block.imageRef, block.mimeType, loadImage, attempt]);

  useEffect(() => {
    if (url && registerMedia && (block.imageRef || block.uri)) {
      registerMedia(mediaKey, {
        src: url,
        kind: isVideo ? 'video' : 'image',
        caption: `${fromUser ? translate('sent') : translate('agent')} ${isVideo ? translate('video') : translate('image')} (${block.mimeType || ''})`,
        filename: isVideo ? 'video' : 'image',
      });
    }
  }, [url, registerMedia, mediaKey, isVideo, block.mimeType, block.imageRef, block.uri, fromUser]);

  const sizeLabel = block.size ? `, ${Math.round(block.size / 1024)}KB` : '';
  const align = fromUser ? 'flex-end' : 'flex-start';
  const label = fromUser ? translate('🖼 보낸 이미지 · 내가 첨부') : translate('🖼 에이전트 이미지');
  if (error) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: align === 'flex-end' ? 'flex-end' : 'flex-start', gap: 3 }}>
        <SenderLabel align={fromUser ? 'right' : 'left'}>{label}</SenderLabel>
        <div data-block="image" data-from={fromUser ? 'user' : 'agent'} style={{ fontSize: 11.5, color: tokens.colors.warning }}>
          {translate('이미지를 가져오지 못했습니다 —')} {error}
          {loadImage && block.imageRef && !block.uri && (
            <button type="button" onClick={() => setAttempt((value) => value + 1)} style={{ marginLeft: 8 }}>{translate('다시 시도')}</button>
          )}
        </div>
      </div>
    );
  }
  if (!url) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: align === 'flex-end' ? 'flex-end' : 'flex-start', gap: 3 }}>
        <SenderLabel align={fromUser ? 'right' : 'left'}>{label}</SenderLabel>
        <div data-block="image" data-from={fromUser ? 'user' : 'agent'} style={{ fontSize: 11.5, color: tokens.colors.textMuted }}>
          {translate('이미지 불러오는 중… (')}{block.mimeType}{sizeLabel})
        </div>
      </div>
    );
  }
  if (isVideo) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: align === 'flex-end' ? 'flex-end' : 'flex-start', gap: 3 }}>
        <SenderLabel align={fromUser ? 'right' : 'left'}>{label}</SenderLabel>
        <div data-block="image" data-from={fromUser ? 'user' : 'agent'} style={{ position: 'relative', display: 'inline-block', maxWidth: '100%', alignSelf: align }}>
          <video
            src={url}
          controls
          preload="metadata"
          style={{
            maxWidth: '100%',
            maxHeight: 420,
            borderRadius: tokens.radii.md,
            border: `1px solid ${fromUser ? tokens.colors.accent : tokens.colors.border}`,
            background: '#000',
            display: 'block',
          }}
        />
        {openMedia && (
          <button
            type="button"
            title={translate('크게 보기 (갤러리)')}
            aria-label={translate('Expand video')}
            onClick={() => openMedia(mediaKey)}
            style={{
              position: 'absolute', top: 6, right: 6, width: 28, height: 28, borderRadius: 6,
              border: '1px solid rgba(255,255,255,0.35)', background: 'rgba(0,0,0,0.6)',
              color: '#fff', fontSize: 14, cursor: 'pointer', lineHeight: 1,
            }}
          >
            ⤢
          </button>
        )}
        </div>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: align === 'flex-end' ? 'flex-end' : 'flex-start', gap: 3 }}>
      <SenderLabel align={fromUser ? 'right' : 'left'}>{label}</SenderLabel>
      <button
        type="button"
        data-block="image"
        data-from={fromUser ? 'user' : 'agent'}
        onClick={() => openMedia?.(mediaKey)}
        title={translate('클릭하면 크게 보기 (← → 로 넘기기)')}
        style={{ display: 'block', maxWidth: '100%', padding: 0, border: 'none', background: 'transparent', cursor: openMedia ? 'zoom-in' : 'default', alignSelf: align }}
      >
        <img
          src={url}
          alt={translate('{0} image ({1})', { 0: fromUser ? 'sent' : 'agent', 1: block.mimeType })}
          // 전사 폭을 넘지 않게만 제한한다 — 원본은 팝업 갤러리에서 본다(새 탭·다운로드 아님).
          style={{
            maxWidth: '100%',
            maxHeight: 420,
            objectFit: 'contain',
            borderRadius: tokens.radii.md,
            border: `1px solid ${fromUser ? tokens.colors.accent : tokens.colors.border}`,
            background: tokens.colors.surface,
            display: 'block',
          }}
        />
      </button>
    </div>
  );
}

/**
 * 에이전트 답 속의 `![alt](target)` 한 장. 로컬 경로면 Runtime Host 에서 바이트를 받아 Blob URL 로,
 * http(s) 면 그대로 그린다.
 *
 * 경로를 못 읽으면 **경로와 사유를 그대로 보인다** — 원래 글이 그 자리에 있었으므로, 그림이
 * 조용히 빠지면 에이전트가 무엇을 보여 주려 했는지조차 사라진다.
 */
function MarkdownImage({
  alt,
  target,
  source,
  loadLocalImage,
  registerMedia,
  openMedia,
}: {
  alt: string;
  target: string;
  source: 'local' | 'remote';
  loadLocalImage?: (path: string) => Promise<Blob>;
  registerMedia?: (key: string, item: MediaLightboxItem) => void;
  openMedia?: (key: string) => void;
}) {
  useLocale();
  const [url, setUrl] = useState<string>(source === 'remote' ? target : '');
  const [error, setError] = useState<string | null>(null);

  const [attempt, setAttempt] = useState(0);
  const mediaKey = `md:${source}:${target}`;

  useEffect(() => {
    if (source !== 'local' || !loadLocalImage) return;
    let revoked = false;
    let objectUrl = '';
    setUrl('');
    setError(null);
    void (async () => {
      try {
        const blob = await loadLocalImage(target);
        if (revoked) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch (err: any) {
        if (!revoked) setError(err?.message || translate('이미지를 가져오지 못했습니다'));
      }
    })();
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [source, target, loadLocalImage, attempt]);

  useEffect(() => {
    if (url && registerMedia) {
      registerMedia(mediaKey, {
        src: url,
        kind: 'image',
        caption: alt ? `${alt} — ${target}` : target,
        filename: target.split(/[\\/]/).pop()?.split(/[?#]/)[0] || 'image',
      });
    }
  }, [url, registerMedia, mediaKey, alt, target]);

  const caption = (
    <span style={{ fontFamily: MONO, fontSize: 11, color: tokens.colors.textMuted, wordBreak: 'break-all' }} title={target}>
      {alt ? `${alt} — ` : ''}{target}
    </span>
  );
  if (source === 'local' && !loadLocalImage) {
    return <div data-block="markdown-image" style={{ whiteSpace: 'normal' }}>🖼 {caption}</div>;
  }
  if (error) {
    return (
      <div data-block="markdown-image" style={{ whiteSpace: 'normal', fontSize: 11.5, color: tokens.colors.warning }}>
        {translate('이미지를 가져오지 못했습니다 —')} {error}
        {source === 'local' && loadLocalImage && (
          <button type="button" onClick={() => setAttempt((value) => value + 1)} style={{ marginLeft: 8 }}>{translate('다시 시도')}</button>
        )}
        <div>{caption}</div>
      </div>
    );
  }
  if (!url) {
    return (
      <div data-block="markdown-image" style={{ whiteSpace: 'normal', fontSize: 11.5, color: tokens.colors.textMuted }}>
        {translate('이미지 불러오는 중…')} {caption}
      </div>
    );
  }
  return (
    <figure data-block="markdown-image" style={{ margin: '6px 0', whiteSpace: 'normal' }}>
      <button
        type="button"
        onClick={() => openMedia?.(mediaKey)}
        title={translate('클릭하면 크게 보기 (← → 로 넘기기)')}
        style={{ display: 'inline-block', maxWidth: '100%', padding: 0, border: 'none', background: 'transparent', cursor: openMedia ? 'zoom-in' : 'default' }}
      >
        <img
          src={url}
          alt={alt || target}
          referrerPolicy="no-referrer"
          onError={() => setError(translate('브라우저가 이 이미지를 그리지 못했습니다'))}
          style={{
            display: 'block',
            maxWidth: '100%',
            maxHeight: 520,
            objectFit: 'contain',
            borderRadius: tokens.radii.md,
            border: `1px solid ${tokens.colors.border}`,
            background: tokens.colors.surface,
          }}
        />
      </button>
      <figcaption style={{ marginTop: 2 }}>{caption}</figcaption>
    </figure>
  );
}

/** 경로 끝 파일명으로 `download` 파일명을 만든다. 못 읽으면 확장자만 붙인다. */
function downloadName(target: string, fallbackExt: string): string {
  const base = target.split(/[\\/]/).pop()?.split(/[?#]/)[0]?.trim();
  if (base) return base;
  return `preview.${fallbackExt}`;
}

/**
 * 에이전트 답 속의 로컬 html/md 미리보기(`![결과](./report.html)`, `[보고서](./notes.md)`).
 * 이미지와 같은 통(`local_image` RPC)으로 바이트를 받아 그 자리에서 펼친다.
 *
 * - html: `sandbox=""` iframe — 스크립트·같은-origin 취급을 전부 막아 AWB origin 으로
 *   돌 수 없게 한다. 새 탭 열기 대신 다운로드 링크를 둔다(새 탭 Blob URL 은 샌드박스가
 *   안 걸려 스크립트가 AWB origin 으로 돌 수 있다).
 * - md: 텍스트로 받아 세션 Markdown 렌더러로 그린다(원문 HTML 실행 없음).
 *
 * 못 읽으면 이미지와 똑같이 경로와 사유를 그 자리에 보인다.
 */
function MarkdownFile({
  alt,
  target,
  fileKind,
  loadLocalFile,
}: {
  alt: string;
  target: string;
  fileKind: 'html' | 'markdown';
  loadLocalFile?: (path: string) => Promise<Blob>;
}) {
  useLocale();
  const [url, setUrl] = useState<string>('');
  const [mdText, setMdText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loadLocalFile) return;
    let revoked = false;
    let objectUrl = '';
    setUrl('');
    setMdText(null);
    setError(null);
    void (async () => {
      try {
        const blob = await loadLocalFile(target);
        if (revoked) return;
        if (fileKind === 'html') {
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        } else {
          setMdText(await blob.text());
        }
      } catch (err: any) {
        if (!revoked) setError(err?.message || translate('파일을 가져오지 못했습니다'));
      }
    })();
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [target, fileKind, loadLocalFile]);

  const label = fileKind === 'html' ? 'HTML' : translate('Markdown');
  const caption = (
    <span style={{ fontFamily: MONO, fontSize: 11, color: tokens.colors.textMuted, wordBreak: 'break-all' }} title={target}>
      {alt ? `${alt} — ` : ''}{target}
    </span>
  );
  if (!loadLocalFile) {
    return <div data-block="markdown-file" style={{ whiteSpace: 'normal' }}>📄 {label} {caption}</div>;
  }
  if (error) {
    return (
      <div data-block="markdown-file" style={{ whiteSpace: 'normal', fontSize: 11.5, color: tokens.colors.warning }}>
        {label} {translate('파일을 가져오지 못했습니다 —')} {error}
        <div>{caption}</div>
      </div>
    );
  }
  if (fileKind === 'html') {
    if (!url) {
      return (
        <div data-block="markdown-file" style={{ whiteSpace: 'normal', fontSize: 11.5, color: tokens.colors.textMuted }}>
          {label} {translate('불러오는 중…')} {caption}
        </div>
      );
    }
    return (
      <figure data-block="markdown-file" style={{ margin: '6px 0', whiteSpace: 'normal' }}>
        <iframe
          src={url}
          sandbox=""
          title={alt || target}
          style={{
            display: 'block',
            width: '100%',
            height: 480,
            borderRadius: tokens.radii.md,
            border: `1px solid ${tokens.colors.border}`,
            background: '#fff',
          }}
        />
        <figcaption style={{ marginTop: 2, display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <span style={{ flex: 1, minWidth: 0 }}>{caption}</span>
          <a href={url} download={downloadName(target, 'html')} style={{ fontSize: 11, color: tokens.colors.accent }}>
            {translate('다운로드')}</a>
        </figcaption>
      </figure>
    );
  }
  if (mdText === null) {
    return (
      <div data-block="markdown-file" style={{ whiteSpace: 'normal', fontSize: 11.5, color: tokens.colors.textMuted }}>
        {label} {translate('불러오는 중…')} {caption}
      </div>
    );
  }
  return (
    <div
      data-block="markdown-file"
      style={{
        margin: '6px 0',
        whiteSpace: 'normal',
        borderRadius: tokens.radii.md,
        border: `1px solid ${tokens.colors.border}`,
        background: tokens.colors.surface,
        padding: '8px 12px',
        maxWidth: 860,
      }}
    >
      <div style={{ marginBottom: 4 }}>{caption}</div>
      <div style={{ maxHeight: 480, overflow: 'auto', fontSize: 13, lineHeight: 1.6, color: tokens.colors.textPrimary, wordBreak: 'break-word' }}>
        <Markdown text={mdText} />
      </div>
    </div>
  );
}

/** React children 의 글자만 — 갤러리 캡션용이라 굵게·코드 같은 겉모양은 버린다. */
function textOf(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (React.isValidElement(node)) return textOf((node.props as { children?: React.ReactNode }).children);
  return '';
}

const megabytes = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);

/** `1:54` · `1:02:03` — 썸네일 모서리에 붙이는 길이. */
function clockOf(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** 썸네일로 보일 장면(초). 편집본은 페이드 인이라 첫 장면이 검은 경우가 많다. */
const THUMB_AT_SECONDS = 1;

/** 지금 소리를 내는 전사 영상 — 다른 영상을 틀면 멈춘다(두 영상이 겹쳐 들리지 않게). */
let playingVideo: HTMLVideoElement | null = null;
function claimPlayback(video: HTMLVideoElement) {
  if (playingVideo && playingVideo !== video && !playingVideo.paused) playingVideo.pause?.();
  playingVideo = video;
}

/**
 * 화면 가까이 오면 true — 썸네일은 보이는 것만 받는다(목록에 영상이 열세 편이어도 한꺼번에 받지 않게).
 * IntersectionObserver 가 없으면(테스트·옛 브라우저) 처음부터 true.
 */
function useNearViewport(ref: React.RefObject<Element | null>): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const target = ref.current;
    if (near || !target) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setNear(true);
        observer.disconnect();
      }
    }, { rootMargin: '400px 0px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [near, ref]);
  return near;
}

/**
 * 답 속 영상 한 편 — 이미지처럼 전사 안에 썸네일로 보이고, 누르면 그 자리에서 재생한다.
 *
 * 썸네일은 영상 전체가 아니라 한 장면만 받는다. 원격은 브라우저가 `#t=1` 장면을 위해 앞부분(메타데이터)과
 * 그 장면만 범위 요청하고, 로컬은 Runtime Host 매니저가 앞부분(`LocalVideoPreviewLoader`, 4MiB)만 보낸다 —
 * 색인(moov)이 앞에 있는 mp4 와 webm 은 그것만으로 장면이 나온다. 못 그리는 파일(색인이 뒤에 있는 mp4)은
 * 빈 카드로 두고, 누르면 끝까지 받아 재생한다. 영상 전체는 누를 때 받는다: 원격은 그 URL 을 그대로
 * 스트리밍하고, 로컬은 조각을 모아(진행률 표시) Blob URL 로 재생한다 — 앞부분이 곧 전부면 그대로 쓴다.
 *
 * `<span>` 으로만 짠다 — 목록·문단 속 링크 바로 아래(`VideoLink`)에도 들어가야 해서다(`<p>` 안에 div 불가).
 */
function VideoThumb({
  source,
  target,
  label,
  playSignal = 0,
  withCaption,
  loadLocalVideo,
  loadLocalVideoPreview,
  registerMedia,
  openMedia,
}: {
  source: 'local' | 'remote';
  target: string;
  label: string;
  /** 늘어날 때마다 재생한다 — 위의 링크 글자를 눌렀을 때. */
  playSignal?: number;
  withCaption: boolean;
  loadLocalVideo?: LocalVideoLoader;
  loadLocalVideoPreview?: LocalVideoPreviewLoader;
  registerMedia?: (key: string, item: MediaLightboxItem) => void;
  openMedia?: (key: string) => void;
}) {
  useLocale();
  const boxRef = useRef<HTMLSpanElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const near = useNearViewport(boxRef);
  const [playing, setPlaying] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [preview, setPreview] = useState<{ url: string; size: number; complete: boolean } | null>(null);
  const [fullUrl, setFullUrl] = useState('');
  const [progress, setProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const mediaKey = source === 'remote' ? `video:${target}` : `video:local:${target}`;
  const filename = downloadName(target, 'mp4');
  const captionText = label && label !== target ? `${label} — ${target}` : target;

  useEffect(() => {
    if (playSignal > 0) setPlaying(true);
  }, [playSignal]);

  // 로컬 썸네일 — 보일 때 앞부분만 받는다.
  useEffect(() => {
    if (source !== 'local' || !near || !loadLocalVideoPreview) return;
    const controller = new AbortController();
    let objectUrl = '';
    setPreview(null);
    setError(null);
    void (async () => {
      try {
        const head = await loadLocalVideoPreview(target, { signal: controller.signal });
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(head.blob);
        setPreview({ url: objectUrl, size: head.size, complete: head.blob.size >= head.size });
      } catch (err: any) {
        if (!controller.signal.aborted) setError(err?.message || translate('영상을 가져오지 못했습니다'));
      }
    })();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [source, target, near, loadLocalVideoPreview, attempt]);

  // 로컬 재생 — 누르면 끝까지 받는다. 앞부분이 곧 전부(작은 파일)면 다시 받지 않는다.
  const fetchFull = source === 'local' && playing && Boolean(preview) && !preview?.complete;
  useEffect(() => {
    if (!fetchFull || !loadLocalVideo) return;
    const controller = new AbortController();
    let objectUrl = '';
    setFullUrl('');
    setProgress(null);
    setError(null);
    void (async () => {
      try {
        const blob = await loadLocalVideo(target, {
          signal: controller.signal,
          onProgress: (loaded, total) => { if (!controller.signal.aborted) setProgress({ loaded, total }); },
        });
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setFullUrl(objectUrl);
      } catch (err: any) {
        if (!controller.signal.aborted) setError(err?.message || translate('영상을 가져오지 못했습니다'));
      }
    })();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fetchFull, target, loadLocalVideo, attempt]);

  // 원격은 썸네일과 재생이 같은 주소다 — 바꿔 끼우면 다시 받으므로 장면만 처음으로 돌린다.
  const playSrc = source === 'remote' ? target : (preview?.complete ? preview.url : fullUrl);
  const thumbSrc = source === 'remote'
    ? (near ? `${target}#t=${THUMB_AT_SECONDS}` : '')
    : (preview ? `${preview.url}#t=${THUMB_AT_SECONDS}` : '');
  const ready = playing && Boolean(playSrc);
  const src = source === 'remote' ? thumbSrc : (ready ? playSrc : thumbSrc);

  useEffect(() => {
    const video = videoRef.current;
    if (!ready || !video) return;
    if (source === 'remote') {
      try { video.currentTime = 0; } catch { /* 메타데이터 전이면 처음부터다 */ }
    }
    claimPlayback(video);
    void video.play?.()?.catch?.(() => undefined);
  }, [ready, source]);

  useEffect(() => {
    if (!registerMedia) return;
    const galleryItem = source === 'remote' ? target : playSrc;
    if (galleryItem) registerMedia(mediaKey, { src: galleryItem, kind: 'video', caption: captionText, filename });
  }, [source, target, playSrc, registerMedia, mediaKey, captionText, filename]);

  const captionStyle: React.CSSProperties = { fontFamily: MONO, fontSize: 11, color: tokens.colors.textMuted, wordBreak: 'break-all' };
  // 원격 영상은 브라우저가 다른 출처의 `download` 를 무시하므로 새 탭으로 연다. 앱 안에서는 내려받기 링크가 앱의
  // DownloadManager 로 간다(`interceptDownloadsInAndroidApp`) — 다운로드 폴더에 받는다.
  const fileLink = source === 'local'
    ? playSrc && <a href={playSrc} download={filename} style={{ fontSize: 11, color: tokens.colors.accent }}>{translate('다운로드')}</a>
    : isAndroidApp()
      ? <a href={target} download={filename} style={{ fontSize: 11, color: tokens.colors.accent }}>{translate('다운로드')}</a>
      : <a href={target} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: tokens.colors.accent }}>{translate('새 탭에서 열기')}</a>;

  if (source === 'local' && (!loadLocalVideo || !loadLocalVideoPreview)) {
    return <span data-block="markdown-video" style={{ display: 'block', whiteSpace: 'normal' }}>🎬 <span style={captionStyle} title={target}>{captionText}</span></span>;
  }
  if (error) {
    return (
      <span data-block="markdown-video" style={{ display: 'block', margin: '6px 0', whiteSpace: 'normal', fontSize: 11.5, color: tokens.colors.warning }}>
        {translate('영상을 가져오지 못했습니다 —')} {error}
        <button
          type="button"
          onClick={() => {
            setError(null);
            setAttempt((value) => value + 1);
          }}
          style={{ marginLeft: 8 }}
        >
          {translate('다시 시도')}</button>
        <span style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <span style={{ ...captionStyle, flex: 1, minWidth: 0 }} title={target}>{captionText}</span>
          {fileLink}
        </span>
      </span>
    );
  }
  const loadingFull = playing && !ready;
  const percent = progress && progress.total > 0 ? Math.min(100, (progress.loaded / progress.total) * 100) : 0;
  const sizeLabel = source === 'local' && preview ? `${megabytes(preview.size)}MB` : '';
  const badge = [duration > 0 ? clockOf(duration) : '', sizeLabel].filter(Boolean).join(' · ');
  return (
    <span data-block="markdown-video" style={{ display: 'block', margin: '6px 0', whiteSpace: 'normal' }}>
      <span
        ref={boxRef}
        data-video-thumb=""
        data-playing={ready ? 'true' : 'false'}
        style={{ position: 'relative', display: 'block', width: ready ? 'min(860px, 100%)' : 'min(480px, 100%)' }}
      >
        <video
          key={attempt}
          ref={videoRef}
          src={src || undefined}
          controls={ready}
          playsInline
          preload={ready ? 'auto' : 'metadata'}
          onPlay={(e) => claimPlayback(e.currentTarget)}
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d) && d > 0) setDuration(d);
          }}
          onError={() => {
            // 로컬 썸네일을 앞부분만으로 못 그리는 파일(색인이 뒤에 있는 mp4)은 빈 카드로 두고 누르면 끝까지 받는다.
            if (source === 'local' && !ready) return;
            setError(translate('브라우저가 이 영상을 재생하지 못했습니다'));
          }}
          style={{
            display: 'block',
            width: '100%',
            aspectRatio: ready ? undefined : '16 / 9',
            maxHeight: 520,
            objectFit: 'contain',
            borderRadius: tokens.radii.md,
            border: `1px solid ${tokens.colors.border}`,
            background: '#000',
          }}
        />
        {!ready && (
          <button
            type="button"
            disabled={loadingFull}
            onClick={() => setPlaying(true)}
            aria-label={translate('영상 재생')}
            title={translate('영상 재생')}
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              padding: 0,
              overflow: 'hidden',
              border: 'none',
              borderRadius: tokens.radii.md,
              background: 'transparent',
              color: '#fff',
              cursor: loadingFull ? 'progress' : 'pointer',
            }}
          >
            <span
              aria-hidden="true"
              style={{ width: 56, height: 56, borderRadius: '50%', background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22 }}
            >
              ▶
            </span>
            {loadingFull && (
              <span data-video-progress="" style={{ fontSize: 11.5, color: '#eee', textShadow: '0 1px 2px #000' }}>
                {translate('영상 불러오는 중… {0}', { 0: progress ? `${megabytes(progress.loaded)} / ${megabytes(progress.total)}MB` : '' })}
              </span>
            )}
            {loadingFull && progress && (
              <span aria-hidden="true" style={{ position: 'absolute', left: 0, bottom: 0, height: 3, width: `${percent}%`, background: tokens.colors.accent }} />
            )}
            {!loadingFull && badge && (
              <span
                data-video-badge=""
                style={{ position: 'absolute', right: 6, bottom: 6, padding: '1px 6px', borderRadius: 4, background: 'rgba(0,0,0,0.7)', color: '#fff', fontSize: 11, fontFamily: MONO }}
              >
                {badge}
              </span>
            )}
          </button>
        )}
        {openMedia && (source === 'remote' || playSrc) && (
          <button
            type="button"
            title={translate('크게 보기 (갤러리)')}
            aria-label={translate('Expand video')}
            onClick={() => {
              // 팝업이 같은 영상을 처음부터 다시 튼다 — 전사 쪽 소리가 겹치지 않게 멈춘다.
              videoRef.current?.pause?.();
              openMedia(mediaKey);
            }}
            style={{
              position: 'absolute', top: 6, right: 6, width: 28, height: 28, borderRadius: 6,
              border: '1px solid rgba(255,255,255,0.35)', background: 'rgba(0,0,0,0.6)',
              color: '#fff', fontSize: 14, cursor: 'pointer', lineHeight: 1,
            }}
          >
            ⤢
          </button>
        )}
      </span>
      {withCaption ? (
        <span style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', marginTop: 2 }}>
          <span style={{ ...captionStyle, flex: 1, minWidth: 0 }} title={target}>{captionText}</span>
          {fileLink}
        </span>
      ) : null}
    </span>
  );
}

/**
 * 답 속 원격 영상 링크(`[#1 다나오 비치 · 0:35](https://…/preview/a.mp4)`, 맨 URL) — 링크는 글 안에 그대로 두고
 * 바로 아래에 썸네일을 붙인다(목록이 끊기지 않는다). 링크 글자를 눌러도 새 탭 대신 그 썸네일이 재생된다.
 * Ctrl/⌘/가운데 클릭의 새 탭 열기는 브라우저 기본 동작 그대로다.
 */
function VideoLink({
  href,
  children,
  registerMedia,
  openMedia,
}: {
  href: string;
  children: React.ReactNode;
  registerMedia?: (key: string, item: MediaLightboxItem) => void;
  openMedia?: (key: string) => void;
}) {
  useLocale();
  const [playSignal, setPlaySignal] = useState(0);
  return (
    <>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        data-video-link=""
        title={translate('누르면 바로 아래에서 재생')}
        onClick={(e) => {
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          setPlaySignal((value) => value + 1);
        }}
        style={{ color: tokens.colors.accent }}
      >
        {children}
      </a>
      <VideoThumb
        source="remote"
        target={href}
        label={textOf(children).trim()}
        playSignal={playSignal}
        withCaption={false}
        registerMedia={registerMedia}
        openMedia={openMedia}
      />
    </>
  );
}

export default function SessionTranscript({ blocks, decidingRequestId, onDecidePermission, onAnswerElicitation, permissionsEnabled, loadImage, loadLocalImage, loadLocalVideo, loadLocalVideoPreview }: SessionTranscriptProps) {
  useLocale();
  // 전사 전체 이미지 갤러리 — 새 탭/다운로드 대신 팝업 + prev/next.
  // 각 이미지 블록이 URL 을 resolve 한 뒤 registerMedia 로 등록한다.
  const [galleryMap, setGalleryMap] = useState<Record<string, MediaLightboxItem>>({});
  const [lightboxKey, setLightboxKey] = useState<string | null>(null);
  const registerMedia = useCallback((key: string, item: MediaLightboxItem) => {
    setGalleryMap((prev) => {
      const cur = prev[key];
      if (cur && cur.src === item.src && cur.kind === item.kind) return prev;
      return { ...prev, [key]: item };
    });
  }, []);
  const openMedia = useCallback((key: string) => setLightboxKey(key), []);
  const galleryKeys = useMemo(() => Object.keys(galleryMap), [galleryMap, getLocale()]);
  const galleryItems = useMemo(() => galleryKeys.map((k) => galleryMap[k]), [galleryKeys, galleryMap, getLocale()]);
  const lightboxIndex = lightboxKey ? galleryKeys.indexOf(lightboxKey) : -1;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {blocks.map((block) => {
        switch (block.kind) {
          case 'prompt': {
            const origin = (block as { origin?: string }).origin
              ?? (block.report ? 'operator-report' : block.operatorTask ? 'operator-task' : block.voice ? 'voice' : 'user');
            if (origin === 'operator-report' || block.report) {
              return <ReportPromptBlock key={block.key} text={block.text} createdAt={block.createdAt} />;
            }
            if (origin === 'operator-task' || block.operatorTask) {
              return <OperatorTaskPromptBlock key={block.key} text={block.text} operator={block.operatorTask || ''} createdAt={block.createdAt} />;
            }
            if (origin === 'async-answer') {
              return <SystemPromptBlock key={block.key} origin="async-answer" label={translate('💬 질문 답변 자동 전달 · 시스템')} text={block.text} createdAt={block.createdAt} dropFirstLine />;
            }
            if (origin === 'restart-resume') {
              return <SystemPromptBlock key={block.key} origin="restart-resume" label={translate('🔄 재시작으로 끊긴 턴 이어서 · AWB')} text={block.text} createdAt={block.createdAt} />;
            }
            return <PromptBlock key={block.key} text={block.text} voice={block.voice || origin === 'voice'} createdAt={block.createdAt} />;
          }
          case 'automatic_prompt':
            return <AutomaticPromptBlock key={block.key} text={block.text} />;
          case 'assistant':
            return <AssistantBlock key={block.key} text={block.text} loadLocalImage={loadLocalImage} loadLocalVideo={loadLocalVideo} loadLocalVideoPreview={loadLocalVideoPreview} registerMedia={registerMedia} openMedia={openMedia} />;
          case 'reasoning':
            return <ReasoningBlock key={block.key} text={block.text} />;
          case 'tool':
            return <ToolBlock key={block.key} block={block} />;
          case 'permission':
            return (
              <PermissionBlock
                key={block.key}
                block={block}
                deciding={decidingRequestId === block.requestId}
                enabled={permissionsEnabled}
                onDecide={onDecidePermission}
              />
            );
          case 'elicitation':
            return (
              <ElicitationBlock
                key={block.key}
                block={block}
                deciding={decidingRequestId === block.elicitationId}
                enabled={permissionsEnabled}
                onAnswer={onAnswerElicitation}
              />
            );
          case 'plan':
            return <PlanBlock key={block.key} block={block} />;
          case 'image':
            return <ImageBlock key={block.key} block={block} loadImage={loadImage} registerMedia={registerMedia} openMedia={openMedia} />;
          case 'usage': {
            const parts = usageSummaryParts(block);
            // 조각이 하나도 없으면(모두 0) 아무것도 그리지 않는다 — "0 tokens" 는
            // 계측 실패와 구분되지 않는 거짓 정보다.
            if (parts.length === 0) return null;
            // 언제 받은 응답인지 — 같은 줄 끝에 붙인다(토큰 줄이 곧 턴의 끝이다).
            const receivedAt = formatReceivedAt(block.receivedAt);
            const receivedFull = block.receivedAt ? new Date(block.receivedAt).toLocaleString(getLocaleTag()) : '';
            return (
              <div
                key={block.key}
                data-block="usage"
                title={
                  translate('input {0} · output {1}', { 0: block.inputTokens.toLocaleString(getLocaleTag()), 1: block.outputTokens.toLocaleString(getLocaleTag()) })
                  + translate(' · cache read {0} · cache write {1}', { 0: block.cachedReadTokens.toLocaleString(getLocaleTag()), 1: block.cacheWriteTokens.toLocaleString(getLocaleTag()) })
                  + translate(' · total {0}', { 0: block.totalTokens.toLocaleString(getLocaleTag()) })
                  + (receivedFull ? translate(' · received {0}', { 0: receivedFull }) : '')
                }
                style={{ fontSize: 10.5, color: tokens.colors.textMuted, fontFamily: MONO }}
              >
                {parts.join(' · ')}
                {receivedAt && <span data-received-at={block.receivedAt}> · {receivedAt}</span>}
              </div>
            );
          }
          case 'turn':
            return (
              <Note key={block.key} tone={block.stopReason === 'error' ? 'danger' : 'warning'}>
                {translate('Turn ended:')} {block.stopReason}
              </Note>
            );
          case 'error':
            return (
              <Note key={block.key} tone="danger" multiline>
                {block.message}{block.code ? ` (${block.code})` : ''}
              </Note>
            );
          case 'system':
            return (
              <Note key={block.key} tone="muted">
                {block.text}
              </Note>
            );
          default:
            return null;
        }
      })}
      {lightboxIndex >= 0 && galleryItems[lightboxIndex] && (
        <MediaLightbox
          items={galleryItems}
          index={lightboxIndex}
          onIndexChange={(next) => {
            const key = galleryKeys[next];
            if (key) setLightboxKey(key);
          }}
          onClose={() => setLightboxKey(null)}
        />
      )}
    </div>
  );
}
