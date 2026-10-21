import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import type { MarketingAuditEvent } from '../../types';
import { tokens } from '../../tokens';
import { Button, EmptyState } from '../common';
import { actorLabel, auditCursor, auditEventTone, formatDateTime } from './marketing.logic';
import { JsonBlock, useMarketingCtx } from './MarketingUi';

const PAGE = 100;

/**
 * 감사 로그(docs/marketing.md) — 모든 결정 · 발신 · 결제 호출 · 동의 변경 · 설정 변경. append-only 라 화면도
 * 읽기만 한다. 사람이 대조한 뒤에 도착한 결제 결과(spend.late_result)와 결과 불명 · 실패는 눈에 띄게 칠한다.
 */
export default function MarketingAuditTab({ refreshKey }: { refreshKey: number }) {
  const ctx = useMarketingCtx();
  const [rows, setRows] = useState<MarketingAuditEvent[] | null>(null);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.listMarketingAudit(ctx.campaignId, { limit: PAGE })
      .then((list) => { if (!cancelled) { setRows(list || []); setMore((list || []).length >= PAGE); } })
      .catch((err) => { if (!cancelled) { setRows([]); ctx.notify((err as Error)?.message || '감사 로그를 불러오지 못했습니다', 'error'); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.campaignId, refreshKey]);

  const loadMore = useCallback(async () => {
    if (!rows?.length) return;
    setLoadingMore(true);
    try {
      const next = await api.listMarketingAudit(ctx.campaignId, { limit: PAGE, before: auditCursor(rows[rows.length - 1].created_at) });
      const seen = new Set(rows.map((r) => r.id));
      const fresh = (next || []).filter((r) => !seen.has(r.id));
      setRows([...rows, ...fresh]);
      // 새 행이 없으면 더 갈 곳이 없다(경계 시각의 행만 다시 왔다).
      setMore(fresh.length > 0 && (next || []).length >= PAGE);
    } catch (err) {
      ctx.notify((err as Error)?.message || '더 불러오지 못했습니다', 'error');
    } finally {
      setLoadingMore(false);
    }
  }, [rows, ctx]);

  if (rows === null) return <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>불러오는 중…</div>;
  if (!rows.length) return <EmptyState title="감사 기록이 없습니다" />;

  return (
    <div data-testid="marketing-audit" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {rows.map((e) => {
        const tone = auditEventTone(e.action);
        const border = tone === 'warning' ? tokens.colors.warning : tone === 'danger' ? tokens.colors.danger : tokens.colors.border;
        const hasDetail = e.detail && Object.keys(e.detail).length > 0;
        return (
          <div
            key={e.id}
            data-testid={`marketing-audit-${e.id}`}
            data-tone={tone}
            style={{
              border: `1px solid ${border}`,
              borderLeftWidth: tone === 'normal' ? 1 : 4,
              borderRadius: tokens.radii.sm,
              background: tone === 'warning' ? `${tokens.colors.warningBg}30` : tone === 'danger' ? `${tokens.colors.dangerBg}30` : tokens.colors.surfaceCard,
              padding: '8px 10px',
            }}
          >
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline', fontSize: 12 }}>
              <span style={{ color: tokens.colors.textMuted, fontVariantNumeric: 'tabular-nums' }}>{formatDateTime(e.created_at)}</span>
              <code style={{ color: tone === 'warning' ? tokens.colors.warningLight : tone === 'danger' ? tokens.colors.dangerLight : tokens.colors.accentSubtle }}>{e.action}</code>
              <span style={{ color: tokens.colors.textSecondary }}>{actorLabel(e)}</span>
            </div>
            <div style={{ fontSize: 13, color: tokens.colors.textStrong, marginTop: 2, overflowWrap: 'anywhere' }}>{e.summary}</div>
            {tone === 'warning' && e.action === 'spend.late_result' && (
              <div style={{ fontSize: 11.5, color: tokens.colors.warningLight, marginTop: 4 }}>
                사람이 결과를 기록한 뒤에 결제 시스템의 응답이 도착했습니다 — 기록한 결과와 이 응답이 맞는지 결제 시스템에서 대조하세요.
              </div>
            )}
            {hasDetail && (
              <details style={{ marginTop: 4 }}>
                <summary style={{ fontSize: 11, color: tokens.colors.textMuted, cursor: 'pointer' }}>자세히</summary>
                <JsonBlock value={e.detail} maxHeight={200} />
              </details>
            )}
          </div>
        );
      })}
      {more && (
        <div style={{ marginTop: 6 }}>
          <Button variant="secondary" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? '불러오는 중…' : '더 보기'}</Button>
        </div>
      )}
    </div>
  );
}
