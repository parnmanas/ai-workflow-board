/**
 * 채널별 성과 리포트 — 순수 함수(docs/marketing.md "분석").
 *
 * 화면 · get_marketing_report · 사이클 지시문이 같은 숫자를 보도록 집계를 한곳에 둔다.
 * 지출은 원장에서(capture − refund, 그 행이 쓰인 시각 기준), 지표는 marketing_metrics 에서(누적형은 합,
 * 수준형은 마지막 값), 게시 수는 기간 안에 published 된 글이다. 클릭은 raw 다 — 봇 · 반복을 걸렀지만
 * 사람 클릭이라고 증명하지는 못하므로 돈을 쓰는 판단의 유일한 근거로 쓰지 말라고 리포트가 적어 둔다.
 */
import { MARKETING_COUNTER_METRICS, MARKETING_GAUGE_METRICS } from './marketing-constants';
import { formatMinorAmount } from './money';

export interface ReportChannel { id: string; name: string; platform: string; kind: string; status: string }
export interface ReportPost { channel_id: string; status: string; published_at: Date | null }
export interface ReportMetric { channel_id: string; metric: string; value: number; bucket_start: Date }
export interface ReportLedger { channel_id: string; kind: string; amount_minor: number; created_at: Date }

export interface ReportInput {
  currency: string;
  since: Date;
  until: Date;
  channels: ReportChannel[];
  posts: ReportPost[];
  metrics: ReportMetric[];
  ledger: ReportLedger[];
  allocations: Map<string, number>;
  feedback: Map<string, number>;
  inbound: Map<string, number>;
  tickets: Map<string, number>;
}

type Metrics = Record<string, number>;

function inRange(at: Date | null | undefined, since: Date, until: Date): boolean {
  if (!at) return false;
  const t = new Date(at).getTime();
  return t >= since.getTime() && t < until.getTime();
}

function ratio(a: number, b: number): number | null {
  return b > 0 ? a / b : null;
}

function aggregate(input: ReportInput, channelId: string | null) {
  const match = (id: string) => channelId === null || id === channelId;
  const metrics: Metrics = {};
  for (const m of MARKETING_COUNTER_METRICS) metrics[m] = 0;
  const gaugeAt: Record<string, number> = {};
  for (const row of input.metrics) {
    if (!match(row.channel_id) || !inRange(row.bucket_start, input.since, input.until)) continue;
    const value = Number(row.value) || 0;
    if ((MARKETING_COUNTER_METRICS as readonly string[]).includes(row.metric)) {
      metrics[row.metric] = (metrics[row.metric] || 0) + value;
    } else if ((MARKETING_GAUGE_METRICS as readonly string[]).includes(row.metric)) {
      // 채널별 마지막 관측값. 캠페인 합계는 채널마다의 마지막 값을 더한다(아래).
      const t = new Date(row.bucket_start).getTime();
      const key = `${row.metric}`;
      if (channelId !== null && (gaugeAt[key] === undefined || t >= gaugeAt[key])) {
        gaugeAt[key] = t;
        metrics[key] = value;
      }
    }
  }
  let capture = 0;
  let refund = 0;
  for (const row of input.ledger) {
    if (!match(row.channel_id) || !inRange(row.created_at, input.since, input.until)) continue;
    if (row.kind === 'capture') capture += Number(row.amount_minor) || 0;
    if (row.kind === 'refund') refund += Number(row.amount_minor) || 0;
  }
  const spent = capture - refund;
  const published = input.posts.filter((p) => match(p.channel_id) && p.status === 'published' && inRange(p.published_at, input.since, input.until)).length;
  const sum = (m: Map<string, number>) => (channelId === null ? [...m.values()].reduce((a, b) => a + b, 0) : m.get(channelId) || 0);
  return {
    posts_published: published,
    metrics,
    spent_minor: spent,
    feedback: sum(input.feedback),
    inbound_items: sum(input.inbound),
    feedback_tickets: sum(input.tickets),
    derived: {
      cpc_minor: ratio(spent, metrics.clicks),
      cost_per_signup_minor: ratio(spent, metrics.signups),
      cost_per_conversion_minor: ratio(spent, metrics.conversions),
      ctr: ratio(metrics.clicks, metrics.impressions),
      conversion_rate: ratio(metrics.conversions, metrics.clicks),
      roas: ratio(metrics.revenue_minor, spent),
    },
  };
}

export function buildReport(input: ReportInput) {
  const channels = input.channels.map((ch) => ({
    channel_id: ch.id,
    name: ch.name,
    platform: ch.platform,
    kind: ch.kind,
    status: ch.status,
    allocation_minor: input.allocations.has(ch.id) ? input.allocations.get(ch.id)! : null,
    ...aggregate(input, ch.id),
  }));
  const totals = aggregate(input, null);
  for (const gauge of MARKETING_GAUGE_METRICS) {
    const values = channels.map((c) => c.metrics[gauge]).filter((v) => typeof v === 'number');
    if (values.length) totals.metrics[gauge] = values.reduce((a, b) => a + b, 0);
  }
  const fmt = (n: number) => formatMinorAmount(Math.round(n), input.currency);
  const lines = channels.map((c) => {
    const parts = [
      `${c.name} (${c.platform}, ${c.status})`,
      `posts ${c.posts_published}`,
      `clicks ${c.metrics.clicks}`,
    ];
    if (c.metrics.impressions) parts.push(`impressions ${c.metrics.impressions}`);
    if (c.metrics.signups) parts.push(`signups ${c.metrics.signups}`);
    if (c.metrics.conversions) parts.push(`conversions ${c.metrics.conversions}`);
    if (c.spent_minor) parts.push(`spent ${fmt(c.spent_minor)}`);
    if (c.derived.cpc_minor !== null && c.spent_minor) parts.push(`CPC ${fmt(c.derived.cpc_minor)}`);
    if (c.derived.cost_per_conversion_minor !== null && c.spent_minor) parts.push(`per conversion ${fmt(c.derived.cost_per_conversion_minor)}`);
    if (c.allocation_minor !== null) parts.push(`allocation ${fmt(c.allocation_minor)}`);
    if (c.feedback || c.inbound_items) parts.push(`feedback ${c.feedback + c.inbound_items}`);
    if (c.feedback_tickets) parts.push(`tickets ${c.feedback_tickets}`);
    return parts.join(' · ');
  });
  return {
    since: input.since,
    until: input.until,
    currency: input.currency,
    channels,
    totals,
    lines,
    caveats: [
      'clicks are raw counts from tracked links (bots, HEAD/prefetch and repeats within 30 minutes are excluded) — not proof of human visits; do not base spend on clicks alone.',
      'metrics other than clicks are observations recorded by agents or people (see marketing_metrics.source).',
    ],
  };
}
