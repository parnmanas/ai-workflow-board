import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { tokens } from '../../tokens';
import { renderMarkdown } from '../chat/utils/markdown';
import { formatReceivedAt, usageSummaryParts } from './sessionTranscript.logic';
import type { ElicitationFieldView, PermissionOptionView, TranscriptBlock } from './sessionTranscript.logic';
import { splitMarkdownImages } from './markdownImages';
import MediaLightbox, { type MediaLightboxItem } from '../common/MediaLightbox';

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
}

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
      return { text: 'done', color: tokens.colors.successLight, bg: tokens.colors.successBg };
    case 'failed':
      return { text: 'failed', color: tokens.colors.dangerLight, bg: tokens.colors.dangerBg };
    case 'cancelled':
      return { text: 'cancelled', color: tokens.colors.warningLight, bg: tokens.colors.warningBg };
    default:
      return { text: 'running', color: tokens.colors.accentSubtle, bg: tokens.colors.badgeAgentBg };
  }
}

const preStyle: React.CSSProperties = {
  margin: '6px 0 0',
  padding: '8px 10px',
  background: tokens.colors.surface,
  border: `1px solid ${tokens.colors.border}`,
  borderRadius: tokens.radii.md,
  color: tokens.colors.textStrong,
  fontFamily: MONO,
  fontSize: 11.5,
  lineHeight: 1.45,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 320,
  overflow: 'auto',
};

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

/** AWB 가 operator 에게 보낸 작업 보고 — 사람이 쓴 말이 아니라서 접어 두고, 펼치면 원문을 보여 준다. */
function ReportPromptBlock({ text }: { text: string }) {
  const count = (text.match(/^\d+\. /gm) || []).length;
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
      <details
        data-block="operator-report"
        style={{
          maxWidth: 'min(760px, 85%)', padding: '6px 11px', borderRadius: tokens.radii.lg, fontSize: 12.5,
          background: tokens.colors.surface, border: `1px dashed ${tokens.colors.border}`, color: tokens.colors.textSecondary,
        }}
      >
        <summary style={{ cursor: 'pointer' }}>📋 AWB 작업 보고{count ? ` · ${count}건` : ''}</summary>
        <div style={{ marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, color: tokens.colors.textMuted }}>{text}</div>
      </details>
    </div>
  );
}

/** operator 가 제안하고 사용자가 승인한 작업 — 누가 시켰는지 한 줄을 단 프롬프트. */
function OperatorTaskPromptBlock({ text, operator }: { text: string; operator: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
      <span data-block="operator-task-label" style={{ fontSize: 11, color: tokens.colors.textMuted }}>🧭 {operator} 제안 · 사용자 승인</span>
      <PromptBlock text={text} />
    </div>
  );
}

function PromptBlock({ text, voice }: { text: string; voice?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
      <div
        data-block="prompt"
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
          <div data-prompt-voice="wake" style={{ fontSize: 10.5, color: tokens.colors.textMuted, marginBottom: 3 }} title="이름을 불러 깨운 뒤의 첫 요청 — 음성 대화 안내 한 줄이 함께 갔습니다">
            🎙 불러서 시작
          </div>
        )}
        {text}
      </div>
    </div>
  );
}

function AutomaticPromptBlock({ text }: { text: string }) {
  return (
    <aside
      data-block="automatic-prompt"
      role="note"
      aria-label="자동 이어쓰기"
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
        <span aria-hidden="true">↻ </span>자동 이어쓰기
      </div>
      <div>표시된 응답이 없어 자동으로 이어쓰기를 요청했습니다.</div>
      <details style={{ marginTop: 4 }}>
        <summary style={{ cursor: 'pointer' }}>전송된 원문 보기</summary>
        <div style={{ marginTop: 4, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{text}</div>
      </details>
    </aside>
  );
}

function AssistantBlock({ text, loadLocalImage, registerMedia, openMedia }: { text: string; loadLocalImage?: (path: string) => Promise<Blob>; registerMedia?: (key: string, item: MediaLightboxItem) => void; openMedia?: (key: string) => void }) {
  // 공통 렌더러는 이미지·파일 문법을 모른다 — 미리보기 자리만 먼저 떼어 내고 나머지 글은 그대로 그린다.
  // 이미지와 로컬 html/md 는 같은 통(`local_image` RPC)으로 받으므로 로더도 하나를 공유한다.
  const nodes = useMemo(
    () => splitMarkdownImages(text).map((seg, i) => {
      if (seg.kind === 'text') return <React.Fragment key={i}>{renderMarkdown(seg.text)}</React.Fragment>;
      if (seg.kind === 'file') {
        return <MarkdownFile key={i} alt={seg.alt} target={seg.target} fileKind={seg.fileKind} loadLocalFile={loadLocalImage} />;
      }
      return <MarkdownImage key={i} alt={seg.alt} target={seg.target} source={seg.source} loadLocalImage={loadLocalImage} registerMedia={registerMedia} openMedia={openMedia} />;
    }),
    [text, loadLocalImage, registerMedia, openMedia],
  );
  return (
    <div
      data-block="assistant"
      style={{
        maxWidth: 860,
        color: tokens.colors.textPrimary,
        fontSize: 13.5,
        lineHeight: 1.6,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {nodes}
    </div>
  );
}

function ReasoningBlock({ text }: { text: string }) {
  return (
    <details data-block="reasoning" style={{ ...cardStyle, background: 'transparent', borderStyle: 'dashed' }}>
      <summary style={summaryStyle}>💭 Thinking ({text.length.toLocaleString()} chars)</summary>
      <div style={{ marginTop: 6, color: tokens.colors.textMuted, fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {clip(text)}
      </div>
    </details>
  );
}

function ToolBlock({ block }: { block: Extract<TranscriptBlock, { kind: 'tool' }> }) {
  const chip = statusChip(block.status);
  const input = stringify(block.input);
  const output = stringify(block.output);
  return (
    <details data-block="tool" style={cardStyle}>
      <summary style={{ ...summaryStyle, display: 'flex', alignItems: 'center', gap: 8, color: tokens.colors.textStrong }}>
        <span aria-hidden="true">{toolGlyph(block.toolKind, block.delegated)}</span>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {block.delegated ? `Delegated: ${block.title}` : block.title}
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
          <div style={{ marginTop: 6, fontSize: 11, color: tokens.colors.textMuted }}>Input</div>
          <pre style={preStyle}>{clip(input)}</pre>
        </div>
      )}
      {output && (
        <div>
          <div style={{ marginTop: 6, fontSize: 11, color: tokens.colors.textMuted }}>Output</div>
          <pre style={preStyle}>{clip(output)}</pre>
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
  const decided = block.decision;
  const rawInput = stringify(block.rawInput);
  const decidedOption = decided?.option_id ? block.options.find((o) => o.option_id === decided.option_id) : null;
  return (
    <div
      data-block="permission"
      role="group"
      aria-label="Permission request"
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
          <summary style={summaryStyle}>Details</summary>
          <pre style={preStyle}>{clip(rawInput)}</pre>
        </details>
      )}
      {decided ? (
        <div style={{ marginTop: 8, fontSize: 12, color: decided.outcome === 'selected' && optionTone(decidedOption ?? { option_id: '', name: '', kind: 'reject' }) === 'allow' ? tokens.colors.successLight : tokens.colors.textSecondary }}>
          {decided.outcome === 'selected'
            ? `${decidedOption?.name || decided.option_id || 'Selected'}`
            : 'Denied'}
          <span style={{ color: tokens.colors.textMuted }}> · {decided.decided_by === 'user' ? 'by you' : decided.decided_by === 'policy' ? 'by session policy' : decided.decided_by === 'timeout' ? 'timed out' : decided.decided_by === 'system' ? 'agent process stopped' : decided.decided_by}</span>
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
            Cancel request
          </button>
          {!enabled && (
            <span style={{ alignSelf: 'center', fontSize: 11.5, color: tokens.colors.textMuted }}>
              Session is not live — send a prompt to reopen it.
            </span>
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
          <option value="">{field.required ? 'Choose…' : '(none)'}</option>
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
  const fields = block.schema?.fields ?? [];
  const [values, setValues] = useState<Record<string, unknown>>(() => initialElicitationValues(fields));
  const decided = block.decision;
  const locked = deciding || !enabled || !onAnswer;
  const missing = fields.filter((f) => f.required && elicitationValueMissing(f, values[f.name]));
  const decidedByLabel = decided?.decided_by === 'user' ? 'by you' : decided?.decided_by === 'agent' ? 'by the agent' : decided?.decided_by === 'timeout' ? 'timed out' : decided?.decided_by === 'system' ? 'agent process stopped' : decided?.decided_by;
  return (
    <div
      data-block="elicitation"
      role="group"
      aria-label="Agent question"
      style={{
        ...cardStyle,
        borderColor: decided ? tokens.colors.border : tokens.colors.accent,
        boxShadow: decided ? undefined : `0 0 0 1px ${tokens.colors.accent}33`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: tokens.colors.textPrimary, fontWeight: 600 }}>
        <span aria-hidden="true">❓</span>
        <span style={{ flex: 1, minWidth: 0 }}>{block.schema?.title || (block.mode === 'url' ? 'Continue in your browser' : 'The agent needs your input')}</span>
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
            {decided ? `Completed · ${decidedByLabel}` : 'Waiting for you to finish there…'}
          </span>
        </div>
      ) : decided ? (
        <div style={{ marginTop: 8, fontSize: 12, color: decided.action === 'accept' ? tokens.colors.successLight : tokens.colors.textSecondary }}>
          {decided.action === 'accept'
            ? (decided.content && Object.keys(decided.content).length
              ? Object.entries(decided.content).map(([k, v]) => `${fields.find((f) => f.name === k)?.title || k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`).join(' · ')
              : 'Submitted')
            : decided.action === 'decline' ? 'Declined' : 'Cancelled'}
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
              Submit
            </button>
            <button
              type="button"
              disabled={locked}
              onClick={() => onAnswer?.(block.elicitationId, 'decline', null)}
              style={{ padding: '6px 12px', borderRadius: tokens.radii.md, border: `1px solid ${tokens.colors.borderStrong}`, background: 'transparent', color: tokens.colors.textSecondary, fontSize: 12.5, cursor: locked ? 'not-allowed' : 'pointer', opacity: locked ? 0.6 : 1 }}
            >
              Decline
            </button>
            <button
              type="button"
              disabled={locked}
              onClick={() => onAnswer?.(block.elicitationId, 'cancel', null)}
              style={{ padding: '6px 12px', borderRadius: tokens.radii.md, border: `1px solid ${tokens.colors.borderStrong}`, background: 'transparent', color: tokens.colors.textMuted, fontSize: 12.5, cursor: locked ? 'not-allowed' : 'pointer', opacity: locked ? 0.6 : 1 }}
            >
              Cancel
            </button>
            {missing.length > 0 && <span style={{ fontSize: 11.5, color: tokens.colors.textMuted }}>Fill in {missing.map((f) => f.title).join(', ')}</span>}
            {!enabled && <span style={{ fontSize: 11.5, color: tokens.colors.textMuted }}>Session is not live — send a prompt to reopen it.</span>}
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
  const done = block.entries.filter((e) => e.status === 'completed').length;
  return (
    <details data-block="plan" open style={cardStyle}>
      <summary style={{ ...summaryStyle, color: tokens.colors.textStrong }}>
        📋 Plan · {done}/{block.entries.length} done
      </summary>
      <ul style={{ margin: '6px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {block.entries.map((e, i) => (
          <li key={i} style={{ display: 'flex', gap: 8, fontSize: 12.5, color: e.status === 'completed' ? tokens.colors.textMuted : tokens.colors.textPrimary, textDecoration: e.status === 'completed' ? 'line-through' : 'none' }}>
            <span aria-hidden="true" style={{ color: e.status === 'in_progress' ? tokens.colors.accentLight : tokens.colors.textMuted }}>{planGlyph(e.status)}</span>
            <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>{e.content}</span>
            {e.priority === 'high' && <span style={{ fontSize: 10.5, color: tokens.colors.warningLight }}>high</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}

function Note({ children, tone, multiline = false }: { children: React.ReactNode; tone: 'muted' | 'danger' | 'warning'; multiline?: boolean }) {
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
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch (err: any) {
        if (!revoked) setError(err?.message || '이미지를 가져오지 못했습니다');
      }
    })();
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [block.uri, block.imageRef, loadImage, attempt]);

  useEffect(() => {
    if (url && registerMedia && (block.imageRef || block.uri)) {
      registerMedia(mediaKey, {
        src: url,
        kind: isVideo ? 'video' : 'image',
        caption: `agent ${isVideo ? 'video' : 'image'} (${block.mimeType || ''})`,
        filename: isVideo ? 'video' : 'image',
      });
    }
  }, [url, registerMedia, mediaKey, isVideo, block.mimeType, block.imageRef, block.uri]);

  const sizeLabel = block.size ? `, ${Math.round(block.size / 1024)}KB` : '';
  if (error) {
    return (
      <div data-block="image" style={{ fontSize: 11.5, color: tokens.colors.warning }}>
        이미지를 가져오지 못했습니다 — {error}
        {loadImage && block.imageRef && !block.uri && (
          <button type="button" onClick={() => setAttempt((value) => value + 1)} style={{ marginLeft: 8 }}>다시 시도</button>
        )}
      </div>
    );
  }
  if (!url) {
    return (
      <div data-block="image" style={{ fontSize: 11.5, color: tokens.colors.textMuted }}>
        이미지 불러오는 중… ({block.mimeType}{sizeLabel})
      </div>
    );
  }
  if (isVideo) {
    return (
      <div data-block="image" style={{ position: 'relative', display: 'inline-block', maxWidth: '100%' }}>
        <video
          src={url}
          controls
          preload="metadata"
          style={{
            maxWidth: '100%',
            maxHeight: 420,
            borderRadius: tokens.radii.md,
            border: `1px solid ${tokens.colors.border}`,
            background: '#000',
            display: 'block',
          }}
        />
        {openMedia && (
          <button
            type="button"
            title="크게 보기 (갤러리)"
            aria-label="Expand video"
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
    );
  }
  return (
    <button
      type="button"
      data-block="image"
      onClick={() => openMedia?.(mediaKey)}
      title="클릭하면 크게 보기 (← → 로 넘기기)"
      style={{ display: 'block', maxWidth: '100%', padding: 0, border: 'none', background: 'transparent', cursor: openMedia ? 'zoom-in' : 'default' }}
    >
      <img
        src={url}
        alt={`agent image (${block.mimeType})`}
        // 전사 폭을 넘지 않게만 제한한다 — 원본은 팝업 갤러리에서 본다(새 탭·다운로드 아님).
        style={{
          maxWidth: '100%',
          maxHeight: 420,
          objectFit: 'contain',
          borderRadius: tokens.radii.md,
          border: `1px solid ${tokens.colors.border}`,
          background: tokens.colors.surface,
          display: 'block',
        }}
      />
    </button>
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
        if (!revoked) setError(err?.message || '이미지를 가져오지 못했습니다');
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
        이미지를 가져오지 못했습니다 — {error}
        {source === 'local' && loadLocalImage && (
          <button type="button" onClick={() => setAttempt((value) => value + 1)} style={{ marginLeft: 8 }}>다시 시도</button>
        )}
        <div>{caption}</div>
      </div>
    );
  }
  if (!url) {
    return (
      <div data-block="markdown-image" style={{ whiteSpace: 'normal', fontSize: 11.5, color: tokens.colors.textMuted }}>
        이미지 불러오는 중… {caption}
      </div>
    );
  }
  return (
    <figure data-block="markdown-image" style={{ margin: '6px 0', whiteSpace: 'normal' }}>
      <button
        type="button"
        onClick={() => openMedia?.(mediaKey)}
        title="클릭하면 크게 보기 (← → 로 넘기기)"
        style={{ display: 'inline-block', maxWidth: '100%', padding: 0, border: 'none', background: 'transparent', cursor: openMedia ? 'zoom-in' : 'default' }}
      >
        <img
          src={url}
          alt={alt || target}
          referrerPolicy="no-referrer"
          onError={() => setError('브라우저가 이 이미지를 그리지 못했습니다')}
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
 * - md: 텍스트로 받아 기존 XSS-safe `renderMarkdown` 으로 그린다(새 마크다운 파서 없음).
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
        if (!revoked) setError(err?.message || '파일을 가져오지 못했습니다');
      }
    })();
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [target, fileKind, loadLocalFile]);

  const label = fileKind === 'html' ? 'HTML' : 'Markdown';
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
        {label} 파일을 가져오지 못했습니다 — {error}
        <div>{caption}</div>
      </div>
    );
  }
  if (fileKind === 'html') {
    if (!url) {
      return (
        <div data-block="markdown-file" style={{ whiteSpace: 'normal', fontSize: 11.5, color: tokens.colors.textMuted }}>
          {label} 불러오는 중… {caption}
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
            다운로드
          </a>
        </figcaption>
      </figure>
    );
  }
  if (mdText === null) {
    return (
      <div data-block="markdown-file" style={{ whiteSpace: 'normal', fontSize: 11.5, color: tokens.colors.textMuted }}>
        {label} 불러오는 중… {caption}
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
        {renderMarkdown(mdText)}
      </div>
    </div>
  );
}

export default function SessionTranscript({ blocks, decidingRequestId, onDecidePermission, onAnswerElicitation, permissionsEnabled, loadImage, loadLocalImage }: SessionTranscriptProps) {
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
  const galleryKeys = useMemo(() => Object.keys(galleryMap), [galleryMap]);
  const galleryItems = useMemo(() => galleryKeys.map((k) => galleryMap[k]), [galleryKeys, galleryMap]);
  const lightboxIndex = lightboxKey ? galleryKeys.indexOf(lightboxKey) : -1;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {blocks.map((block) => {
        switch (block.kind) {
          case 'prompt':
            return block.report
              ? <ReportPromptBlock key={block.key} text={block.text} />
              : block.operatorTask
                ? <OperatorTaskPromptBlock key={block.key} text={block.text} operator={block.operatorTask} />
                : <PromptBlock key={block.key} text={block.text} voice={block.voice} />;
          case 'automatic_prompt':
            return <AutomaticPromptBlock key={block.key} text={block.text} />;
          case 'assistant':
            return <AssistantBlock key={block.key} text={block.text} loadLocalImage={loadLocalImage} registerMedia={registerMedia} openMedia={openMedia} />;
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
            const receivedFull = block.receivedAt ? new Date(block.receivedAt).toLocaleString() : '';
            return (
              <div
                key={block.key}
                data-block="usage"
                title={
                  `input ${block.inputTokens.toLocaleString()} · output ${block.outputTokens.toLocaleString()}`
                  + ` · cache read ${block.cachedReadTokens.toLocaleString()} · cache write ${block.cacheWriteTokens.toLocaleString()}`
                  + ` · total ${block.totalTokens.toLocaleString()}`
                  + (receivedFull ? ` · received ${receivedFull}` : '')
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
                Turn ended: {block.stopReason}
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
