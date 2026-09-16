import React, { useMemo } from 'react';
import { tokens } from '../../tokens';
import { renderMarkdown } from '../chat/utils/markdown';
import type { PermissionOptionView, TranscriptBlock } from './sessionTranscript.logic';

/**
 * Agent Session 트랜스크립트 렌더러. Chat 의 MessageList 와 달리 말풍선 목록이
 * 아니라 CLI 세션 기록이다 — 스트리밍 텍스트, 접을 수 있는 사고/툴콜 카드,
 * 허용/거부 버튼이 달린 권한 카드, 턴 종료/오류/시스템 노트.
 */

export interface SessionTranscriptProps {
  blocks: TranscriptBlock[];
  /** 결정 중인 request_id (버튼 잠금). */
  decidingRequestId: string | null;
  onDecidePermission: (requestId: string, optionId: string | null) => void;
  /** 세션이 살아 있지 않으면(closed/suspended) 미결 권한 버튼을 잠근다. */
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
          <span style={{ color: tokens.colors.textMuted }}> · {decided.decided_by === 'user' ? 'by you' : decided.decided_by === 'policy' ? 'by session policy' : decided.decided_by === 'timeout' ? 'timed out' : decided.decided_by}</span>
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

export default function SessionTranscript({ blocks, decidingRequestId, onDecidePermission, permissionsEnabled }: SessionTranscriptProps) {
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
