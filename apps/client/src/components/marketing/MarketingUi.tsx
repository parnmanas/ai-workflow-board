import React, { createContext, useContext, useEffect, useState } from 'react';
import { tokens } from '../../tokens';
import { toneStyle } from '../../activity';
import { Button, Modal, Textarea } from '../common';
import type { MarketingCampaign } from '../../types';
import { prettyJson, safeHttpUrl, type StatusView } from './marketing.logic';

/**
 * Marketing 화면이 같이 쓰는 작은 조각들 — 상태 pill · 안전한 외부 링크 · 패널 · 사유 입력 모달,
 * 그리고 카드들이 캠페인 맥락(통화 · 권한 · 채널 이름 · 갱신)을 받는 context.
 */

// ── 캠페인 맥락 ─────────────────────────────────────────────────────────────

export interface MarketingChannelRef {
  id: string;
  name: string;
  platform: string;
  kind?: string;
  status?: string;
  target?: string;
  guidelines?: string;
  rules_summary?: string;
  rules_url?: string;
  list_name?: string;
}

export interface MarketingCtx {
  /** 예산 승인자만 열 수 있는 화면(marketing.manage 없음)에서는 null. */
  campaign: MarketingCampaign | null;
  campaignId: string;
  /** 캠페인의 소유 계정 — credential · Outreach 채널 · 연락처를 그 계정에서 고른다. */
  accountId: string;
  currency: string;
  dualThresholdMinor: number;
  disclosure: string;
  channels: Map<string, MarketingChannelRef>;
  canManage: boolean;
  canApproveSpend: boolean;
  userId: string;
  /** 쓰기 뒤에 화면 데이터를 다시 읽는다. */
  refresh(): void;
  notify(message: string, type?: 'success' | 'error' | 'info'): void;
}

const MarketingContext = createContext<MarketingCtx | null>(null);

export const MarketingCtxProvider = MarketingContext.Provider;

export function useMarketingCtx(): MarketingCtx {
  const ctx = useContext(MarketingContext);
  if (!ctx) throw new Error('useMarketingCtx must be used inside a marketing campaign view');
  return ctx;
}

/** 버튼 하나의 비동기 동작 — 겹쳐 누르지 않게 busy 를 들고, 실패는 toast 로 알린다. */
export function useAction() {
  const ctx = useMarketingCtx();
  const [busy, setBusy] = useState(false);
  const run = async <T,>(fn: () => Promise<T>, success?: string | ((result: T) => string | null)): Promise<T | null> => {
    if (busy) return null;
    setBusy(true);
    try {
      const result = await fn();
      const message = typeof success === 'function' ? success(result) : success;
      if (message) ctx.notify(message, 'success');
      ctx.refresh();
      return result;
    } catch (err) {
      ctx.notify((err as Error)?.message || '요청에 실패했습니다', 'error');
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

// ── 표시 조각 ───────────────────────────────────────────────────────────────

export function StatusPill({ view, testId, title }: { view: StatusView; testId?: string; title?: string }) {
  const { color, background } = toneStyle(view.tone);
  return (
    <span
      data-testid={testId}
      title={title}
      style={{
        fontSize: 11,
        fontWeight: 600,
        padding: '2px 8px',
        borderRadius: tokens.radii.sm,
        color,
        background,
        whiteSpace: 'nowrap',
        display: 'inline-block',
        lineHeight: 1.4,
      }}
    >
      {view.label}
    </span>
  );
}

export function Chip({ children, muted = false, title }: { children: React.ReactNode; muted?: boolean; title?: string }) {
  return (
    <span
      title={title}
      style={{
        fontSize: 11,
        padding: '1px 7px',
        borderRadius: 999,
        border: `1px solid ${muted ? tokens.colors.border : tokens.colors.accent}`,
        color: muted ? tokens.colors.textMuted : tokens.colors.accentPale,
        background: muted ? 'transparent' : tokens.overlays.accentFaint,
        whiteSpace: 'nowrap',
        display: 'inline-block',
        lineHeight: 1.5,
      }}
    >
      {children}
    </span>
  );
}

/** http(s) 만 링크가 된다. 새 창 + noopener noreferrer — 외부 페이지가 이 탭을 조작하지 못하게. */
export function ExternalLink({ href, children }: { href: string; children?: React.ReactNode }) {
  const safe = safeHttpUrl(href);
  if (!safe) return <span style={{ color: tokens.colors.textMuted, wordBreak: 'break-all' }}>{children ?? href}</span>;
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer" style={{ color: tokens.colors.accentLight, wordBreak: 'break-all' }}>
      {children ?? safe}
    </a>
  );
}

export function Panel({
  title,
  actions,
  children,
  testId,
  tone,
}: {
  title?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
  /** 경보(결과 불명 결제 등) — 테두리를 위험 색으로. */
  tone?: 'danger' | 'attention';
}) {
  const border = tone === 'danger' ? tokens.colors.danger : tone === 'attention' ? tokens.colors.warning : tokens.colors.border;
  return (
    <section
      data-testid={testId}
      style={{
        border: `1px solid ${border}`,
        borderRadius: tokens.radii.md,
        background: tokens.colors.surfaceCard,
        padding: 14,
        minWidth: 0,
      }}
    >
      {(title || actions) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          {title && <div style={{ fontSize: 13, fontWeight: 700, color: tokens.colors.textPrimary, flex: '1 1 auto', minWidth: 0 }}>{title}</div>}
          {actions && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginLeft: 'auto' }}>{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** 라벨 · 값 두 칸 격자. 값이 없는 줄은 그리지 않는다. */
export function KeyValue({ items }: { items: Array<[string, React.ReactNode]> }) {
  const shown = items.filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!shown.length) return null;
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(96px, max-content) 1fr', gap: '4px 12px', margin: 0, fontSize: 12 }}>
      {shown.map(([label, value]) => (
        <React.Fragment key={label}>
          <dt style={{ color: tokens.colors.textMuted }}>{label}</dt>
          <dd style={{ margin: 0, color: tokens.colors.textStrong, minWidth: 0, overflowWrap: 'anywhere' }}>{value}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

export function Hint({ children, tone }: { children: React.ReactNode; tone?: 'danger' | 'warning' }) {
  const color = tone === 'danger' ? tokens.colors.dangerLight : tone === 'warning' ? tokens.colors.warningLight : tokens.colors.textMuted;
  return <div style={{ fontSize: 11, color, lineHeight: 1.5, marginTop: 4 }}>{children}</div>;
}

/** 여러 줄 글 — 사람이나 에이전트가 쓴 문단을 줄바꿈 그대로. */
export function Prose({ text, empty = '—' }: { text: string | null | undefined; empty?: string }) {
  const value = (text || '').trim();
  return (
    <div style={{ fontSize: 13, color: value ? tokens.colors.textStrong : tokens.colors.textMuted, whiteSpace: 'pre-wrap', lineHeight: 1.55, overflowWrap: 'anywhere' }}>
      {value || empty}
    </div>
  );
}

/** 인용 블록 — 홍보 규칙 · 외부인이 쓴 글처럼 "남의 말" 을 그대로 보여 줄 때. */
export function Quote({ label, children, tone }: { label?: string; children: React.ReactNode; tone?: 'warning' | 'muted' }) {
  const border = tone === 'warning' ? tokens.colors.warning : tokens.colors.borderStrong;
  return (
    <div style={{ borderLeft: `3px solid ${border}`, padding: '6px 10px', background: tokens.colors.surfaceSubtle, borderRadius: tokens.radii.sm }}>
      {label && <div style={{ fontSize: 11, fontWeight: 700, color: tone === 'warning' ? tokens.colors.warningLight : tokens.colors.textSecondary, marginBottom: 4 }}>{label}</div>}
      <div style={{ fontSize: 12.5, color: tokens.colors.textStrong, whiteSpace: 'pre-wrap', lineHeight: 1.5, overflowWrap: 'anywhere' }}>{children}</div>
    </div>
  );
}

export function JsonBlock({ value, testId, maxHeight = 260 }: { value: unknown; testId?: string; maxHeight?: number }) {
  return (
    <pre
      data-testid={testId}
      style={{
        margin: 0,
        padding: 10,
        background: tokens.colors.surface,
        border: `1px solid ${tokens.colors.border}`,
        borderRadius: tokens.radii.sm,
        color: tokens.colors.textStrong,
        fontSize: 12,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        maxHeight,
        overflow: 'auto',
      }}
    >
      {prettyJson(value)}
    </pre>
  );
}

export function FieldLabel({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label
      htmlFor={htmlFor}
      style={{
        fontSize: tokens.typography.fontSizeXs,
        fontWeight: tokens.typography.fontWeightSemibold,
        color: tokens.colors.textMuted,
        textTransform: 'uppercase',
        display: 'block',
        marginBottom: tokens.spacing.xs,
      }}
    >
      {children}
    </label>
  );
}

export function Meta({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, color: tokens.colors.textMuted, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>{children}</div>;
}

export const tableStyles = {
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 },
  th: {
    textAlign: 'left' as const,
    padding: '6px 8px',
    fontSize: 11,
    fontWeight: 600,
    color: tokens.colors.textSecondary,
    borderBottom: `1px solid ${tokens.colors.border}`,
    background: tokens.colors.surfaceSubtle,
    whiteSpace: 'nowrap' as const,
  },
  td: {
    padding: '6px 8px',
    borderBottom: `1px solid ${tokens.colors.border}`,
    color: tokens.colors.textStrong,
    verticalAlign: 'top' as const,
  },
  num: { textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const, whiteSpace: 'nowrap' as const },
};

// ── 사유 입력 모달 ─────────────────────────────────────────────────────────

export interface NoteModalProps {
  isOpen: boolean;
  title: string;
  message?: React.ReactNode;
  label?: string;
  placeholder?: string;
  /** 비어 있으면 확인 버튼이 꺼진다(거부 사유 — 에이전트가 배운다). */
  required?: boolean;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onSubmit(note: string): void;
  onClose(): void;
}

export function NoteModal({
  isOpen,
  title,
  message,
  label = '메모',
  placeholder,
  required = false,
  confirmLabel,
  danger = false,
  busy = false,
  onSubmit,
  onClose,
}: NoteModalProps) {
  const [note, setNote] = useState('');
  useEffect(() => {
    if (isOpen) setNote('');
  }, [isOpen]);
  const ok = !required || note.trim().length > 0;
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      maxWidth={520}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>취소</Button>
          <Button variant={danger ? 'danger' : 'primary'} disabled={!ok || busy} onClick={() => onSubmit(note.trim())}>
            {busy ? '처리 중…' : confirmLabel}
          </Button>
        </>
      )}
    >
      {message && <div style={{ fontSize: 13, color: tokens.colors.textSecondary, lineHeight: 1.5, marginBottom: 10 }}>{message}</div>}
      <Textarea
        label={required ? `${label} (필수)` : `${label} (선택)`}
        aria-label={label}
        value={note}
        rows={4}
        placeholder={placeholder}
        onChange={(e) => setNote(e.target.value)}
      />
    </Modal>
  );
}
