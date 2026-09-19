import React, { useMemo, useState } from 'react';
import { tokens } from '../../tokens';
import { renderMarkdown } from '../chat/utils/markdown';
import type { ElicitationFieldView, PermissionOptionView, TranscriptBlock } from './sessionTranscript.logic';

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

function PromptBlock({ text }: { text: string }) {
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
        {text}
      </div>
    </div>
  );
}

function AssistantBlock({ text }: { text: string }) {
  const nodes = useMemo(() => renderMarkdown(text), [text]);
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

function Note({ children, tone }: { children: React.ReactNode; tone: 'muted' | 'danger' | 'warning' }) {
  const color = tone === 'danger' ? tokens.colors.dangerLight : tone === 'warning' ? tokens.colors.warningLight : tokens.colors.textMuted;
  return (
    <div style={{ display: 'flex', justifyContent: 'center' }}>
      <div
        style={{
          fontSize: 11.5,
          color,
          padding: '3px 10px',
          borderRadius: 999,
          border: `1px solid ${tone === 'muted' ? tokens.colors.border : color}`,
          background: tokens.colors.surface,
          maxWidth: 760,
          textAlign: 'center',
          wordBreak: 'break-word',
        }}
      >
        {children}
      </div>
    </div>
  );
}

export default function SessionTranscript({ blocks, decidingRequestId, onDecidePermission, onAnswerElicitation, permissionsEnabled }: SessionTranscriptProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {blocks.map((block) => {
        switch (block.kind) {
          case 'prompt':
            return <PromptBlock key={block.key} text={block.text} />;
          case 'assistant':
            return <AssistantBlock key={block.key} text={block.text} />;
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
          case 'usage':
            return (
              <div key={block.key} data-block="usage" style={{ fontSize: 10.5, color: tokens.colors.textMuted, fontFamily: MONO }}>
                tokens in {block.inputTokens.toLocaleString()} · out {block.outputTokens.toLocaleString()} · total {block.totalTokens.toLocaleString()}
              </div>
            );
          case 'turn':
            return (
              <Note key={block.key} tone={block.stopReason === 'error' ? 'danger' : 'warning'}>
                Turn ended: {block.stopReason}
              </Note>
            );
          case 'error':
            return (
              <Note key={block.key} tone="danger">
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
    </div>
  );
}
