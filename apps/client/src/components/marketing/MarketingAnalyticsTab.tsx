import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import type { MarketingLink, MarketingMetric, MarketingReport, MarketingReportRow } from '../../types';
import { tokens } from '../../tokens';
import { Button, Input, Select } from '../common';
import {
  CONNECTOR_METRICS,
  METRIC_LABELS,
  RECORDABLE_METRICS,
  REPORT_PERIOD_DAYS,
  engagementCollectedChannel,
  formatCount,
  formatDateTime,
  formatMinor,
  formatRate,
  formatRoas,
  metricValueText,
  reportRange,
  safeHttpUrl,
} from './marketing.logic';
import { ExternalLink, Hint, Panel, tableStyles, useAction, useMarketingCtx } from './MarketingUi';

/**
 * 분석(docs/marketing.md "분석") — 채널별 리포트 · 추적 링크 · 지표 기록. 클릭은 raw 다: 봇 · 반복을 걸렀지만
 * 사람의 방문이라고 증명하지 못하므로 그것만으로 돈을 쓰는 판단을 하지 말라는 주의를 그대로 보여 준다.
 */
export default function MarketingAnalyticsTab({ refreshKey }: { refreshKey: number }) {
  useLocale();
  const ctx = useMarketingCtx();
  const [days, setDays] = useState<number>(30);
  const [report, setReport] = useState<MarketingReport | null>(null);
  const [reportError, setReportError] = useState('');
  const [links, setLinks] = useState<MarketingLink[] | null>(null);
  const [metrics, setMetrics] = useState<MarketingMetric[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setReportError('');
    api.getMarketingReport(ctx.campaignId, reportRange(days))
      .then((r) => { if (!cancelled) setReport(r); })
      .catch((err) => { if (!cancelled) { setReport(null); setReportError((err as Error)?.message || translate('리포트를 만들지 못했습니다')); } });
    return () => { cancelled = true; };
  }, [ctx.campaignId, days, refreshKey]);

  useEffect(() => {
    let cancelled = false;
    api.listMarketingLinks(ctx.campaignId).then((rows) => { if (!cancelled) setLinks(rows || []); }).catch(() => { if (!cancelled) setLinks([]); });
    api.listMarketingMetrics(ctx.campaignId, 100).then((rows) => { if (!cancelled) setMetrics(rows || []); }).catch(() => { if (!cancelled) setMetrics([]); });
    return () => { cancelled = true; };
  }, [ctx.campaignId, refreshKey]);

  const currency = report?.currency || ctx.currency;
  const row = (label: React.ReactNode, r: MarketingReportRow, key: string, extra?: { status?: string; allocation?: number | null }) => (
    <tr key={key}>
      <td style={tableStyles.td}>{label}{extra?.status ? <span style={{ color: tokens.colors.textMuted }}> · {extra.status}</span> : null}</td>
      <td style={{ ...tableStyles.td, ...tableStyles.num }}>{formatCount(r.posts_published)}</td>
      <td style={{ ...tableStyles.td, ...tableStyles.num }}>{formatCount(r.metrics.clicks)}</td>
      <td style={{ ...tableStyles.td, ...tableStyles.num }}>{formatCount(r.metrics.impressions)}</td>
      <td style={{ ...tableStyles.td, ...tableStyles.num }}>{formatCount(r.metrics.engagements)}</td>
      <td style={{ ...tableStyles.td, ...tableStyles.num }}>{formatCount(r.metrics.replies)}</td>
      <td style={{ ...tableStyles.td, ...tableStyles.num }}>{formatCount(r.metrics.signups)}</td>
      <td style={{ ...tableStyles.td, ...tableStyles.num }}>{formatCount(r.metrics.conversions)}</td>
      <td style={{ ...tableStyles.td, ...tableStyles.num }}>{extra && 'allocation' in extra ? (extra.allocation === null || extra.allocation === undefined ? '—' : formatMinor(extra.allocation, currency)) : ''}</td>
      <td style={{ ...tableStyles.td, ...tableStyles.num }}>{formatMinor(r.spent_minor, currency)}</td>
      <td style={{ ...tableStyles.td, ...tableStyles.num }}>{r.derived.cpc_minor === null ? '—' : formatMinor(r.derived.cpc_minor, currency)}</td>
      <td style={{ ...tableStyles.td, ...tableStyles.num }}>{r.derived.cost_per_conversion_minor === null ? '—' : formatMinor(r.derived.cost_per_conversion_minor, currency)}</td>
      <td style={{ ...tableStyles.td, ...tableStyles.num }}>{formatRate(r.derived.ctr)}</td>
      <td style={{ ...tableStyles.td, ...tableStyles.num }}>{formatRoas(r.derived.roas)}</td>
      <td style={{ ...tableStyles.td, ...tableStyles.num }}>{formatCount(r.feedback + r.inbound_items)}</td>
      <td style={{ ...tableStyles.td, ...tableStyles.num }}>{formatCount(r.feedback_tickets)}</td>
    </tr>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Panel
        testId="marketing-report"
        title={translate('채널별 성과')}
        actions={(
          <div role="group" aria-label={translate('기간')} style={{ display: 'flex', gap: 4 }}>
            {REPORT_PERIOD_DAYS.map((d) => (
              <Button key={d} size="sm" variant={d === days ? 'primary' : 'secondary'} aria-pressed={d === days} onClick={() => setDays(d)}>
                {d}{translate('일')}</Button>
            ))}
          </div>
        )}
      >
        {reportError ? (
          <div role="alert" style={{ fontSize: 12, color: tokens.colors.dangerLight }}>{reportError}</div>
        ) : !report ? (
          <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>{translate('불러오는 중…')}</div>
        ) : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table style={tableStyles.table}>
                <thead>
                  <tr>
                    <th style={tableStyles.th}>{translate('채널')}</th>
                    <th style={{ ...tableStyles.th, ...tableStyles.num }}>{translate('게시')}</th>
                    <th style={{ ...tableStyles.th, ...tableStyles.num }}>{translate('클릭(raw)')}</th>
                    <th style={{ ...tableStyles.th, ...tableStyles.num }}>{translate('노출')}</th>
                    <th style={{ ...tableStyles.th, ...tableStyles.num }}>{translate('참여')}</th>
                    <th style={{ ...tableStyles.th, ...tableStyles.num }}>{translate('답글')}</th>
                    <th style={{ ...tableStyles.th, ...tableStyles.num }}>{translate('가입')}</th>
                    <th style={{ ...tableStyles.th, ...tableStyles.num }}>{translate('전환')}</th>
                    <th style={{ ...tableStyles.th, ...tableStyles.num }}>{translate('편성액')}</th>
                    <th style={{ ...tableStyles.th, ...tableStyles.num }}>{translate('지출')}</th>
                    <th style={{ ...tableStyles.th, ...tableStyles.num }}>{translate('CPC')}</th>
                    <th style={{ ...tableStyles.th, ...tableStyles.num }}>{translate('전환당 비용')}</th>
                    <th style={{ ...tableStyles.th, ...tableStyles.num }}>{translate('CTR')}</th>
                    <th style={{ ...tableStyles.th, ...tableStyles.num }}>{translate('ROAS')}</th>
                    <th style={{ ...tableStyles.th, ...tableStyles.num }}>{translate('피드백')}</th>
                    <th style={{ ...tableStyles.th, ...tableStyles.num }}>{translate('티켓')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.channels.map((c) => row(c.name, c, c.channel_id, { status: c.status, allocation: c.allocation_minor }))}
                  {row(<strong>{translate('합계')}</strong>, report.totals, "__totals")}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 6 }}>
              {formatDateTime(report.since)} ~ {formatDateTime(report.until)}
            </div>
            {report.caveats.length > 0 && (
              <ul data-testid="marketing-report-caveats" style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 11.5, color: tokens.colors.warningLight, lineHeight: 1.6 }}>
                {report.caveats.map((c) => <li key={c}>{c}</li>)}
              </ul>
            )}
          </>
        )}
      </Panel>

      <LinksPanel links={links} />
      <MetricsPanel metrics={metrics} />
    </div>
  );
}

function LinksPanel({ links }: { links: MarketingLink[] | null }) {
  useLocale();
  const ctx = useMarketingCtx();
  const { busy, run } = useAction();
  const usable = [...ctx.channels.values()].filter((c) => c.status === 'active' || c.status === 'paused');
  const [channelId, setChannelId] = useState('');
  const [destination, setDestination] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState('');
  const domains = ctx.campaign?.allowed_domains || [];

  const create = async () => {
    if (!channelId) { setError(translate('채널을 고르세요')); return; }
    const destinationUrl = safeHttpUrl(destination);
    if (!destinationUrl) { setError(translate('목적지는 http(s) 주소여야 합니다')); return; }
    setError('');
    const saved = await run(
      () => api.createMarketingLink(ctx.campaignId, { channel_id: channelId, destination_url: destinationUrl, ...(label.trim() ? { label: label.trim() } : {}) }),
      (link) => (link.url ? translate('추적 링크를 만들었습니다: {0}', { 0: link.url }) : translate('추적 링크를 만들었습니다')),
    );
    if (saved) { setDestination(''); setLabel(''); }
  };

  return (
    <Panel title={translate('추적 링크')}>
      {ctx.canManage && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 1fr) minmax(220px, 2fr) minmax(140px, 1fr) auto', gap: 8, alignItems: 'end', marginBottom: 6 }}>
          <Select
            label={translate('채널')}
            value={channelId}
            placeholder={translate('— 채널 —')}
            options={usable.map((c) => ({ value: c.id, label: c.name }))}
            onChange={(e) => setChannelId(e.target.value)}
          />
          <Input label={translate('목적지 URL')} value={destination} placeholder="https://example.com/landing" onChange={(e) => setDestination(e.target.value)} />
          <Input label={translate('라벨 (선택)')} value={label} onChange={(e) => setLabel(e.target.value)} />
          <Button variant="primary" size="md" disabled={busy} onClick={() => void create()}>{translate('만들기')}</Button>
        </div>
      )}
      <Hint>
        {translate('목적지는 허용 도메인(')}{domains.length ? domains.join(', ') : translate('없음 — 캠페인 설정에서 추가')}{translate(') 안이어야 합니다. 링크를 열면 서버가 UTM 을 붙여 목적지로 보냅니다.')}</Hint>
      {error && <div role="alert" style={{ fontSize: 12, color: tokens.colors.dangerLight, marginTop: 4 }}>{error}</div>}
      {links === null ? (
        <div style={{ fontSize: 12, color: tokens.colors.textMuted, marginTop: 8 }}>{translate('불러오는 중…')}</div>
      ) : links.length === 0 ? (
        <div style={{ fontSize: 12, color: tokens.colors.textMuted, marginTop: 8 }}>{translate('추적 링크가 없습니다.')}</div>
      ) : (
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table style={tableStyles.table}>
            <thead>
              <tr>
                <th style={tableStyles.th}>{translate('링크')}</th>
                <th style={tableStyles.th}>{translate('목적지')}</th>
                <th style={tableStyles.th}>{translate('채널')}</th>
                <th style={tableStyles.th}>{translate('라벨')}</th>
                <th style={{ ...tableStyles.th, ...tableStyles.num }}>{translate('클릭(raw)')}</th>
                <th style={tableStyles.th}>{translate('만든 이')}</th>
              </tr>
            </thead>
            <tbody>
              {links.map((l) => (
                <tr key={l.id}>
                  <td style={tableStyles.td}>{l.url ? <ExternalLink href={l.url}>{l.url}</ExternalLink> : <code title={translate('서버에 AWB_PUBLIC_URL 이 없어 공개 주소를 만들 수 없습니다')}>{l.code}</code>}</td>
                  <td style={tableStyles.td}><ExternalLink href={l.destination_url} /></td>
                  <td style={tableStyles.td}>{ctx.channels.get(l.channel_id)?.name || '—'}</td>
                  <td style={tableStyles.td}>{l.label}</td>
                  <td style={{ ...tableStyles.td, ...tableStyles.num }}>{formatCount(l.clicks)}</td>
                  <td style={tableStyles.td}>{l.created_by_name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function MetricsPanel({ metrics }: { metrics: MarketingMetric[] | null }) {
  useLocale();
  const ctx = useMarketingCtx();
  const { busy, run } = useAction();
  const [metric, setMetric] = useState<string>('impressions');
  const [value, setValue] = useState('');
  const [channelId, setChannelId] = useState('');
  const [observedAt, setObservedAt] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  const record = async () => {
    if (!/^\d+$/.test(value.trim())) { setError(translate('값은 0 이상의 정수입니다(매출은 최소 단위)')); return; }
    if ((CONNECTOR_METRICS as readonly string[]).includes(metric)) {
      if (engagementCollectedChannel(ctx.channels.get(channelId))) {
        setError(translate('reddit · GitHub 채널의 참여 · 답글은 서버가 게시물에서 직접 읽습니다 — 기록하지 않습니다'));
        return;
      }
      if (!channelId && [...ctx.channels.values()].some((c) => engagementCollectedChannel(c))) {
        setError(translate('채널을 고르세요 — 서버가 읽는 reddit · GitHub 채널이 있어, 캠페인 전체 참여 · 답글은 그 몫을 두 번 셀 수 있습니다'));
        return;
      }
    }
    let observed: string | undefined;
    if (observedAt) {
      const d = new Date(observedAt);
      if (Number.isNaN(d.getTime())) { setError(translate('관측 시각을 읽을 수 없습니다')); return; }
      if (d.getTime() > Date.now() + 5 * 60_000) { setError(translate('관측 시각이 미래입니다')); return; }
      observed = d.toISOString();
    }
    setError('');
    const saved = await run(
      () => api.recordMarketingMetrics(ctx.campaignId, [{
        metric,
        value: Number(value.trim()),
        ...(channelId ? { channel_id: channelId } : {}),
        ...(observed ? { observed_at: observed } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      }]),
      translate('지표를 기록했습니다'),
    );
    if (saved) { setValue(''); setNote(''); }
  };

  return (
    <Panel title={translate('지표 기록')}>
      {ctx.canManage && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, alignItems: 'end', marginBottom: 6 }}>
          <Select
            label={translate('지표')}
            value={metric}
            options={RECORDABLE_METRICS.map((m) => ({ value: m, label: METRIC_LABELS[m] || m }))}
            onChange={(e) => setMetric(e.target.value)}
          />
          <Input label={translate('값')} value={value} inputMode="numeric" onChange={(e) => setValue(e.target.value)} />
          <Select
            label={translate('채널 (선택)')}
            value={channelId}
            options={[{ value: '', label: translate('캠페인 전체') }, ...[...ctx.channels.values()].map((c) => ({ value: c.id, label: c.name }))]}
            onChange={(e) => setChannelId(e.target.value)}
          />
          <Input label={translate('관측 시각 (선택)')} type="datetime-local" value={observedAt} onChange={(e) => setObservedAt(e.target.value)} />
          <Input label={translate('출처 메모 (선택)')} value={note} onChange={(e) => setNote(e.target.value)} />
          <Button variant="primary" size="md" disabled={busy} onClick={() => void record()}>{translate('기록')}</Button>
        </div>
      )}
      <Hint>
        {translate('플랫폼 통계에서 직접 확인한 수치만 남기세요. 클릭은 추적 링크에서만 셉니다. reddit · GitHub 채널에 서버가 게시한 글의 참여(점수 · 반응) · 답글은 서버가 게시 후 14일 동안 읽어 \'자동 수집\' 으로 남깁니다 — 값은 직전에 읽은 값과의 차이입니다.')}</Hint>
      {error && <div role="alert" style={{ fontSize: 12, color: tokens.colors.dangerLight, marginTop: 4 }}>{error}</div>}
      {metrics && metrics.length > 0 && (
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table style={tableStyles.table}>
            <thead>
              <tr>
                <th style={tableStyles.th}>{translate('관측')}</th>
                <th style={tableStyles.th}>{translate('지표')}</th>
                <th style={{ ...tableStyles.th, ...tableStyles.num }}>{translate('값')}</th>
                <th style={tableStyles.th}>{translate('채널')}</th>
                <th style={tableStyles.th}>{translate('기록')}</th>
                <th style={tableStyles.th}>{translate('메모')}</th>
              </tr>
            </thead>
            <tbody>
              {metrics.map((m) => (
                <tr key={m.id}>
                  <td style={tableStyles.td}>{formatDateTime(m.observed_at)}</td>
                  <td style={tableStyles.td}>{METRIC_LABELS[m.metric] || m.metric}</td>
                  <td style={{ ...tableStyles.td, ...tableStyles.num }}>{metricValueText(m, ctx.currency)}</td>
                  <td style={tableStyles.td}>{m.channel_id ? ctx.channels.get(m.channel_id)?.name || '—' : translate('전체')}</td>
                  <td style={tableStyles.td}>{m.source === 'connector' ? translate('자동 수집') : m.recorded_by_name || m.recorded_by_type}</td>
                  <td style={tableStyles.td}>{m.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
