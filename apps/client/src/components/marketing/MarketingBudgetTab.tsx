import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import type {
  Credential,
  MarketingAllocation,
  MarketingBudgetPeriod,
  MarketingBudgetSummary,
  MarketingCampaignInput,
  MarketingDirectPaymentProvider,
  MarketingLedgerEntry,
  MarketingPayee,
  MarketingPaymentCheckResult,
  MarketingPaymentProvider,
  MarketingSpendRequest,
} from '../../types';
import { tokens } from '../../tokens';
import { Button, Input, Modal, Select, Textarea } from '../common';
import {
  BUDGET_PERIOD_LABELS,
  DIRECT_PAYMENT_PROVIDERS,
  DIRECT_PAYMENT_PROVIDER_LABELS,
  DIRECT_PROVIDER_CREDENTIAL_FIELDS,
  DIRECT_REF_FORMATS,
  PAYMENT_PROVIDER_LABELS,
  allocationStatusView,
  campaignPatch,
  directPaymentCredentials,
  directRefProblem,
  isDirectPaymentProvider,
  openRequestLabel,
  parseCardCategories,
  payeeRouteLabel,
  cardControlsLabel,
  directRouteOptionLabel,
  DIRECT_PROVIDER_SPECS,
  formatDateTime,
  formatMinor,
  isCurrencyCode,
  minorToMajorInput,
  normalizeCurrencyCode,
  orderAllocationsForApproval,
  parseMajorToMinor,
  spendStatusView,
  type MoneyParse,
} from './marketing.logic';
import { AllocationCard, SpendCard } from './MarketingCards';
import { FieldLabel, Hint, KeyValue, Panel, StatusPill, tableStyles, useAction, useMarketingCtx } from './MarketingUi';
import { PaymentCredentialGuide } from './PaymentCredentialGuide';

const LEDGER_KIND_LABELS: Record<string, string> = {
  reserve: '보류(승인)',
  release: '보류 해제',
  capture: '결제',
  refund: '환불',
};

const SPEND_FILTERS = ['', 'pending', 'approved', 'executing', 'unknown', 'paid', 'failed', 'denied', 'expired', 'cancelled'];

/**
 * 예산 · 결제(docs/marketing.md "예산 편성 · 집행 · 결제"). 숫자는 전부 원장에서 계산된 서버 요약이다 —
 * 화면은 더하지 않고 그대로 보여 준다. 돈을 움직이는 버튼은 marketing.approve_spend 에게만 보인다.
 */
export default function MarketingBudgetTab({
  budget,
  allocations,
  refreshKey,
}: {
  budget: MarketingBudgetSummary | null;
  allocations: MarketingAllocation[];
  refreshKey: number;
}) {
  const ctx = useMarketingCtx();
  const currency = budget?.currency || ctx.currency;
  const [filter, setFilter] = useState('');
  const [spend, setSpend] = useState<MarketingSpendRequest[] | null>(null);
  const [ledger, setLedger] = useState<MarketingLedgerEntry[] | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [allocating, setAllocating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.listMarketingSpendRequests(ctx.campaignId, { status: filter || undefined, limit: 200 })
      .then((rows) => { if (!cancelled) setSpend(rows || []); })
      .catch((err) => { if (!cancelled) { setSpend([]); ctx.notify((err as Error)?.message || '지출 요청을 불러오지 못했습니다', 'error'); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.campaignId, filter, refreshKey]);

  useEffect(() => {
    let cancelled = false;
    api.listMarketingLedger(ctx.campaignId, 200)
      .then((rows) => { if (!cancelled) setLedger(rows || []); })
      .catch(() => { if (!cancelled) setLedger([]); });
    return () => { cancelled = true; };
  }, [ctx.campaignId, refreshKey]);

  const proposed = allocations.filter((a) => a.status === 'proposed');
  const history = allocations.filter((a) => a.status !== 'proposed');
  const currentByChannel = new Map((budget?.channels || []).map((c) => [c.channel_id, c.allocation_minor]));
  const campaign = ctx.campaign;
  const canEditSettings = !!campaign && ctx.canManage && ctx.canApproveSpend;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Panel
        testId="marketing-budget-summary"
        title="예산 요약"
        actions={(
          <>
            {canEditSettings && <Button size="sm" variant="secondary" onClick={() => setSettingsOpen(true)}>예산 설정…</Button>}
            {ctx.canApproveSpend && <Button size="sm" variant="primary" onClick={() => setAllocating(true)}>예산 직접 편성…</Button>}
          </>
        )}
      >
        {!budget ? (
          <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>불러오는 중…</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>
            <KeyValue
              items={[
                ['총 예산', budget.total.cap > 0 ? formatMinor(budget.total.cap, currency) : '0 — 지출할 수 없습니다'],
                ['결제됨', formatMinor(budget.total.spent, currency)],
                ['보류 중', formatMinor(budget.total.held, currency)],
                ['가용', <strong key="avail">{formatMinor(budget.total.available, currency)}</strong>],
              ]}
            />
            <KeyValue
              items={[
                ['예산 기간', `${BUDGET_PERIOD_LABELS[budget.caps.budget_period] || budget.caps.budget_period}${budget.period.key !== 'all' ? ` · ${budget.period.key}` : ''}`],
                ['기간 상한', budget.period_usage.cap === null ? '없음' : formatMinor(budget.period_usage.cap, currency)],
                ['기간 사용', `${formatMinor(budget.period_usage.spent, currency)} 결제 + ${formatMinor(budget.period_usage.held, currency)} 보류`],
                ['기간 가용', budget.period_usage.available === null ? '—' : formatMinor(budget.period_usage.available, currency)],
              ]}
            />
            <KeyValue
              items={[
                ['건당 상한', budget.caps.max_transaction_minor > 0 ? formatMinor(budget.caps.max_transaction_minor, currency) : '없음'],
                ['2인 승인', budget.caps.dual_approval_threshold_minor > 0 ? `${formatMinor(budget.caps.dual_approval_threshold_minor, currency)} 이상` : '끔'],
                ['편성 합계', formatMinor(budget.allocated_total_minor, currency)],
                ['편성 제안 대기', String(budget.pending_allocations)],
                ['결제 방식', PAYMENT_PROVIDER_LABELS[budget.payment_provider] || budget.payment_provider],
              ]}
            />
          </div>
        )}
        {campaign && (
          <div style={{ marginTop: 12 }}>
            <FieldLabel>수취인 허용 목록 — 지출 요청의 수취인은 이 안에서만</FieldLabel>
            {campaign.payees.length ? (
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: tokens.colors.textStrong, lineHeight: 1.6 }}>
                {campaign.payees.map((p) => {
                  const route = payeeRouteLabel(p);
                  const controls = cardControlsLabel(p, campaign.currency);
                  return (
                    <li key={p.name} data-testid={`marketing-payee-${p.name}`}>
                      {p.name}
                      {route ? <span style={{ color: tokens.colors.textSecondary }}> — 직접 결제: {route}</span> : p.ref ? ` (${p.ref})` : ''}
                      {controls ? <span style={{ color: tokens.colors.textSecondary }}> ({controls})</span> : ''}
                      {p.note ? ` — ${p.note}` : ''}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <Hint>비어 있습니다 — 수취인이 없으면 어떤 지출도 요청할 수 없습니다.</Hint>
            )}
            {campaign.payees.some((p) => isDirectPaymentProvider(p.provider)) && ctx.canApproveSpend && <PaymentCheckPanel />}
          </div>
        )}
        {!ctx.canApproveSpend && (
          <Hint>읽기 전용입니다. 예산 · 수취인 · 결제 방식과 지출 승인은 marketing.approve_spend 권한이 있는 사람이 정합니다.</Hint>
        )}
        {ctx.canApproveSpend && !ctx.canManage && (
          <Hint>예산 설정을 바꾸려면 캠페인 운영 권한(marketing.manage)도 필요합니다.</Hint>
        )}
      </Panel>

      {budget && budget.channels.length > 0 && (
        <Panel title="채널별 예산">
          <div style={{ overflowX: 'auto' }}>
            <table style={tableStyles.table}>
              <thead>
                <tr>
                  <th style={tableStyles.th}>채널</th>
                  <th style={tableStyles.th}>상태</th>
                  <th style={{ ...tableStyles.th, ...tableStyles.num }}>편성액</th>
                  <th style={{ ...tableStyles.th, ...tableStyles.num }}>기간 보류</th>
                  <th style={{ ...tableStyles.th, ...tableStyles.num }}>기간 결제</th>
                  <th style={{ ...tableStyles.th, ...tableStyles.num }}>기간 잔여</th>
                  <th style={{ ...tableStyles.th, ...tableStyles.num }}>누적 결제</th>
                </tr>
              </thead>
              <tbody>
                {budget.channels.map((c) => (
                  <tr key={c.channel_id}>
                    <td style={tableStyles.td}>{c.name}</td>
                    <td style={tableStyles.td}>{c.status}</td>
                    <td style={{ ...tableStyles.td, ...tableStyles.num }}>{c.allocation_minor === null ? '편성 없음' : formatMinor(c.allocation_minor, currency)}</td>
                    <td style={{ ...tableStyles.td, ...tableStyles.num }}>{formatMinor(c.period_held_minor, currency)}</td>
                    <td style={{ ...tableStyles.td, ...tableStyles.num }}>{formatMinor(c.period_spent_minor, currency)}</td>
                    <td style={{ ...tableStyles.td, ...tableStyles.num }}>{c.period_available_minor === null ? '—' : formatMinor(c.period_available_minor, currency)}</td>
                    <td style={{ ...tableStyles.td, ...tableStyles.num }}>{formatMinor(c.spent_all_time_minor, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Hint>편성이 없는 채널에는 지출할 수 없습니다 — 성과를 보고 편성한 뒤 그 안에서 집행합니다.</Hint>
        </Panel>
      )}

      {proposed.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: tokens.colors.textPrimary }}>편성 제안 — 승인 대기</div>
          {proposed.map((a) => <AllocationCard key={a.id} allocation={a} currentMinor={currentByChannel.get(a.channel_id) ?? null} />)}
        </div>
      )}

      <Panel
        title="지출 요청"
        actions={(
          <div style={{ minWidth: 160 }}>
            <Select
              aria-label="지출 요청 상태"
              value={filter}
              options={SPEND_FILTERS.map((s) => ({ value: s, label: s ? spendStatusView(s).label : '전체' }))}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
        )}
      >
        {spend === null ? (
          <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>불러오는 중…</div>
        ) : spend.length === 0 ? (
          <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>지출 요청이 없습니다.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {spend.map((s) => <SpendCard key={s.id} spend={s} />)}
          </div>
        )}
      </Panel>

      {history.length > 0 && (
        <Panel title="편성 기록">
          <div style={{ overflowX: 'auto' }}>
            <table style={tableStyles.table}>
              <thead>
                <tr>
                  <th style={tableStyles.th}>시각</th>
                  <th style={tableStyles.th}>채널</th>
                  <th style={{ ...tableStyles.th, ...tableStyles.num }}>금액</th>
                  <th style={tableStyles.th}>상태</th>
                  <th style={tableStyles.th}>제안 · 결정</th>
                  <th style={tableStyles.th}>메모</th>
                </tr>
              </thead>
              <tbody>
                {history.map((a) => (
                  <tr key={a.id}>
                    <td style={tableStyles.td}>{formatDateTime(a.created_at)}</td>
                    <td style={tableStyles.td}>{ctx.channels.get(a.channel_id)?.name || a.channel_id.slice(0, 8)}</td>
                    <td style={{ ...tableStyles.td, ...tableStyles.num }}>{formatMinor(a.amount_minor, a.currency || currency)}</td>
                    <td style={tableStyles.td}><StatusPill view={allocationStatusView(a.status)} /></td>
                    <td style={tableStyles.td}>{a.proposed_by_name}{a.decided_by_name ? ` → ${a.decided_by_name}` : ''}</td>
                    <td style={tableStyles.td}>{a.decision_note || a.rationale}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      <Panel title="원장" testId="marketing-ledger">
        {ledger === null ? (
          <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>불러오는 중…</div>
        ) : ledger.length === 0 ? (
          <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>아직 돈이 움직인 기록이 없습니다.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={tableStyles.table}>
              <thead>
                <tr>
                  <th style={tableStyles.th}>시각</th>
                  <th style={tableStyles.th}>종류</th>
                  <th style={{ ...tableStyles.th, ...tableStyles.num }}>금액</th>
                  <th style={tableStyles.th}>기간</th>
                  <th style={tableStyles.th}>행위자</th>
                  <th style={tableStyles.th}>메모</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((e) => (
                  <tr key={e.id}>
                    <td style={tableStyles.td}>{formatDateTime(e.created_at)}</td>
                    <td style={tableStyles.td}>{LEDGER_KIND_LABELS[e.kind] || e.kind}</td>
                    <td style={{ ...tableStyles.td, ...tableStyles.num }}>{formatMinor(e.amount_minor, e.currency || currency)}</td>
                    <td style={tableStyles.td}>{e.period_key}</td>
                    <td style={tableStyles.td}>{e.actor_name || e.actor_type}</td>
                    <td style={tableStyles.td}>{e.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Hint>원장은 덧붙이기만 합니다 — 고치거나 지우는 경로가 없고, 위의 모든 금액이 이 행들의 합입니다.</Hint>
      </Panel>

      {settingsOpen && campaign && <BudgetSettingsModal onClose={() => setSettingsOpen(false)} />}
      {allocating && budget && <DirectAllocationModal budget={budget} onClose={() => setAllocating(false)} />}
    </div>
  );
}

function moneyField(value: string, currency: string): MoneyParse {
  if (!value.trim()) return { ok: true, minor: 0 };
  return parseMajorToMinor(value, currency, { allowZero: true });
}

interface PayeeDraft {
  name: string;
  ref: string;
  note: string;
  provider: '' | MarketingDirectPaymentProvider;
  credential_id: string;
  /** 카드 공급자만 — 일회용 · 허용 업종(쉼표) · 카드당 최대(통화 단위 입력). */
  card_single_use: boolean;
  card_categories: string;
  card_max: string;
}

const EMPTY_PAYEE: PayeeDraft = { name: '', ref: '', note: '', provider: '', credential_id: '', card_single_use: true, card_categories: '', card_max: '' };

/**
 * 연결 확인 — 직접 결제 수취인의 credential 과 대상(광고 캠페인)을 공급자에서 읽기만 한다. 돈은 움직이지 않는다.
 * 실제(또는 테스트) 계정의 설정이 맞는지, 상한이 걸려 있는지를 지출 요청 전에 본다.
 */
function PaymentCheckPanel() {
  const ctx = useMarketingCtx();
  const { busy, run } = useAction();
  const [result, setResult] = useState<MarketingPaymentCheckResult | null>(null);
  const check = async () => {
    const out = await run(() => api.checkMarketingPayments(ctx.campaignId));
    if (out) setResult(out);
  };
  return (
    <div data-testid="marketing-payment-check" style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void check()}>{busy ? '확인 중…' : '연결 확인'}</Button>
        <span style={{ fontSize: 12, color: tokens.colors.textMuted }}>직접 결제 수취인의 credential · 광고 캠페인 · 지금 상한을 읽어 봅니다. 아무것도 바꾸지 않습니다.</span>
      </div>
      {result && (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.6 }}>
          {result.payees.map((r) => (
            <li key={r.payee} data-testid={`marketing-payment-check-${r.payee}`} style={{ color: r.ok ? tokens.colors.textStrong : tokens.colors.dangerLight }}>
              <strong>{r.ok ? '정상' : '문제'}</strong> · {r.payee} ({DIRECT_PAYMENT_PROVIDER_LABELS[r.provider] || r.provider} {r.ref})
              {r.ceiling_text ? ` · 지금 상한 ${r.ceiling_text}` : ''}
              {r.target_name_untrusted ? <span style={{ color: tokens.colors.textMuted }}> · 공급자 이름 “{r.target_name_untrusted}”</span> : ''}
              {r.api_version ? ` · API ${r.api_version}` : ''}
              {r.open_request ? ` · ${openRequestLabel(r.open_request)}` : ''}
              {r.problems.length > 0 && <div>{r.problems.join(' / ')}</div>}
              {r.provider_message_untrusted && (
                <div style={{ color: tokens.colors.textMuted }}>공급자 메시지 “{r.provider_message_untrusted}”</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 돈 설정 — 통화 · 한도 · 2인 승인 · 수취인 · 결제 방식(marketing.approve_spend + 캠페인 운영 권한). */
function BudgetSettingsModal({ onClose }: { onClose(): void }) {
  const ctx = useMarketingCtx();
  // 연 순간의 캠페인과 비교한다 — 열려 있는 동안 다른 승인자가 바꾼 값(임계값 · 수취인 …)을, 이 화면에서 건드리지
  // 않은 칸이 "바뀜" 으로 잡혀 예전 값으로 되돌리지 않게.
  const [campaign] = useState(() => ctx.campaign!);
  const { busy, run } = useAction();
  const [currency, setCurrency] = useState(campaign.currency);
  // 통화를 바꾸면 금액 칸의 뜻이 바뀐다(500000 KRW → 500000 USD). 칸을 비우고 새 통화로 다시 적게 한다.
  const [amountsCleared, setAmountsCleared] = useState(false);
  const [total, setTotal] = useState(minorToMajorInput(campaign.budget_total_minor, campaign.currency));
  const [period, setPeriod] = useState<MarketingBudgetPeriod>(campaign.budget_period);
  const [periodCap, setPeriodCap] = useState(minorToMajorInput(campaign.budget_period_minor, campaign.currency));
  const [maxTx, setMaxTx] = useState(minorToMajorInput(campaign.max_transaction_minor, campaign.currency));
  const [dual, setDual] = useState(minorToMajorInput(campaign.dual_approval_threshold_minor, campaign.currency));
  const [payees, setPayees] = useState<PayeeDraft[]>(() => campaign.payees.map((p) => ({
    name: p.name, ref: p.ref || '', note: p.note || '', provider: isDirectPaymentProvider(p.provider) ? p.provider : '', credential_id: p.credential_id || '',
    card_single_use: p.card_single_use !== false,
    card_categories: (p.card_categories || []).join(', '),
    card_max: typeof p.card_max_minor === 'number' ? minorToMajorInput(p.card_max_minor, campaign.currency) : '',
  })));
  const [provider, setProvider] = useState<MarketingPaymentProvider>(campaign.payment_provider);
  const [credentialId, setCredentialId] = useState(campaign.payment_credential_id || '');
  const [credentials, setCredentials] = useState<Credential[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api.listCredentials(ctx.accountId || undefined)
      .then((rows) => { if (!cancelled) setCredentials((rows || []).filter((c) => !c.agent_env)); })
      .catch(() => { if (!cancelled) setCredentials([]); });
    return () => { cancelled = true; };
  }, [ctx.accountId]);

  const code = normalizeCurrencyCode(currency);
  const currencyChanged = code !== campaign.currency;
  const changeCurrency = (value: string) => {
    const next = value.toUpperCase();
    if (next === currency) return;
    setCurrency(next);
    if (!amountsCleared) {
      setTotal('');
      setPeriodCap('');
      setMaxTx('');
      setDual('');
      setAmountsCleared(true);
    }
  };
  const parsed = useMemo(() => ({
    total: moneyField(total, code),
    periodCap: moneyField(periodCap, code),
    maxTx: moneyField(maxTx, code),
    dual: moneyField(dual, code),
  }), [total, periodCap, maxTx, dual, code]);
  const errorOf = (p: MoneyParse) => (p.ok ? undefined : p.error);

  const submit = async () => {
    if (!isCurrencyCode(code)) { setError('통화는 ISO 4217 세 글자 코드입니다'); return; }
    if (currencyChanged) {
      const missing = [total, maxTx, dual, ...(period === 'none' ? [] : [periodCap])].some((v) => !v.trim());
      if (missing) { setError(`통화를 바꿨으니 금액을 모두 새 통화(${code})로 다시 적으세요 — 상한이 없으면 0 을 적습니다`); return; }
    }
    for (const p of Object.values(parsed)) if (!p.ok) { setError(p.error); return; }
    const cleaned: MarketingPayee[] = [];
    const seen = new Set<string>();
    for (const p of payees) {
      const name = p.name.trim();
      if (!name && !p.ref.trim() && !p.note.trim() && !p.provider) continue;
      if (!name) { setError('수취인 이름을 비울 수 없습니다'); return; }
      if (seen.has(name.toLowerCase())) { setError(`수취인 "${name}" 이 두 번 있습니다`); return; }
      seen.add(name.toLowerCase());
      if (p.provider) {
        const refProblem = directRefProblem(p.provider, p.ref);
        if (refProblem) { setError(`수취인 "${name}": ${refProblem}`); return; }
        if (!p.credential_id) { setError(`수취인 "${name}": ${DIRECT_PAYMENT_PROVIDER_LABELS[p.provider]} credential 을 고르세요`); return; }
        // 서버가 저장하는 순서(name · ref · note · provider · credential_id · card_*)와 같게 — 그대로인 수취인을 "바뀜" 으로 보내지 않는다.
        const route = { name, ref: p.ref.trim(), ...(p.note.trim() ? { note: p.note.trim() } : {}), provider: p.provider, credential_id: p.credential_id };
        if (DIRECT_PROVIDER_SPECS[p.provider].kind !== 'card') { cleaned.push(route); continue; }
        const categories = parseCardCategories(p.card_categories);
        if (categories.problem) { setError(`수취인 "${name}": ${categories.problem}`); return; }
        let cardMax: number | null = null;
        if (p.card_max.trim()) {
          const parsedMax = parseMajorToMinor(p.card_max, code);
          if (!parsedMax.ok) { setError(`수취인 "${name}" 카드당 최대: ${parsedMax.error}`); return; }
          cardMax = parsedMax.minor;
        }
        cleaned.push({ ...route, card_single_use: p.card_single_use, card_categories: categories.categories, ...(cardMax !== null ? { card_max_minor: cardMax } : {}) });
        continue;
      }
      cleaned.push({ name, ...(p.ref.trim() ? { ref: p.ref.trim() } : {}), ...(p.note.trim() ? { note: p.note.trim() } : {}) });
    }
    if (cleaned.length > 50) { setError('수취인은 50명까지입니다'); return; }
    if (provider === 'webhook' && !credentialId) { setError('webhook 결제에는 결제 credential(webhook_url · secret)이 필요합니다'); return; }
    const minor = (p: MoneyParse) => (p.ok ? p.minor : 0);
    const draft: MarketingCampaignInput = {
      currency: code,
      budget_total_minor: minor(parsed.total),
      budget_period: period,
      budget_period_minor: minor(parsed.periodCap),
      max_transaction_minor: minor(parsed.maxTx),
      dual_approval_threshold_minor: minor(parsed.dual),
      payees: cleaned,
      payment_provider: provider,
      payment_credential_id: provider === 'webhook' ? credentialId : null,
    };
    const patch = campaignPatch(campaign, draft, { canEditMoney: ctx.canApproveSpend });
    if (!Object.keys(patch).length) { onClose(); return; }
    setError('');
    const saved = await run(() => api.updateMarketingCampaign(campaign.id, patch), '예산 설정을 저장했습니다');
    if (saved) onClose();
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="예산 설정"
      maxWidth={720}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>취소</Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>{busy ? '저장 중…' : '저장'}</Button>
        </>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Hint>금액은 {code} 단위로 적습니다(예: {code === 'KRW' || code === 'JPY' ? '500000' : '1250.50'}). 0 은 “없음”이 아니라 칸마다 뜻이 다릅니다 — 아래 설명을 보세요.</Hint>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          <Input label="통화" value={currency} maxLength={3} onChange={(e) => changeCurrency(e.target.value)} />
          <Input label="총 예산 (0 = 지출 불가)" value={total} inputMode="decimal" error={errorOf(parsed.total)} onChange={(e) => setTotal(e.target.value)} />
          <Select
            label="예산 기간"
            value={period}
            options={(['none', 'week', 'month'] as MarketingBudgetPeriod[]).map((p) => ({ value: p, label: BUDGET_PERIOD_LABELS[p] }))}
            onChange={(e) => setPeriod(e.target.value as MarketingBudgetPeriod)}
          />
          <Input label="기간 상한 (0 = 없음)" value={periodCap} inputMode="decimal" disabled={period === 'none'} error={errorOf(parsed.periodCap)} onChange={(e) => setPeriodCap(e.target.value)} />
          <Input label="건당 상한 (0 = 없음)" value={maxTx} inputMode="decimal" error={errorOf(parsed.maxTx)} onChange={(e) => setMaxTx(e.target.value)} />
          <Input label="2인 승인 기준 (0 = 끔)" value={dual} inputMode="decimal" error={errorOf(parsed.dual)} onChange={(e) => setDual(e.target.value)} />
        </div>
        {amountsCleared && (
          <Hint tone="warning">통화를 바꿔 금액 칸을 비웠습니다 — 모든 금액을 {code || '새 통화'} 로 다시 적으세요.</Hint>
        )}
        <Hint>통화는 돈이 요청되거나 움직이기 시작하면 바꿀 수 없습니다. 2인 승인 기준 이상인 지출은 서로 다른 승인자 두 명이 승인해야 실행됩니다.</Hint>

        <div>
          <FieldLabel>수취인 허용 목록</FieldLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {payees.map((p, i) => {
              const set = (patch: Partial<PayeeDraft>) => setPayees((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
              const options = p.provider ? directPaymentCredentials(credentials || [], p.provider, ctx.accountId) : [];
              return (
                <div key={i} data-testid={`marketing-payee-row-${i}`} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.4fr auto', gap: 6, alignItems: 'end' }}>
                    <Input aria-label={`수취인 ${i + 1} 이름`} placeholder="이름(예: Reddit Ads)" value={p.name} onChange={(e) => set({ name: e.target.value })} />
                    <Input aria-label={`수취인 ${i + 1} 참조`} placeholder={p.provider ? DIRECT_REF_FORMATS[p.provider] : '계정 · 참조(선택)'} value={p.ref}
                      onChange={(e) => set({ ref: e.target.value })} />
                    <Input aria-label={`수취인 ${i + 1} 메모`} placeholder="메모(선택)" value={p.note} onChange={(e) => set({ note: e.target.value })} />
                    <Button size="sm" variant="ghost" onClick={() => setPayees((rows) => rows.filter((_, j) => j !== i))}>삭제</Button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, alignItems: 'end' }}>
                    <Select
                      aria-label={`수취인 ${i + 1} 결제 경로`}
                      value={p.provider}
                      options={[
                        { value: '', label: '캠페인 결제 방식(아래)' },
                        ...DIRECT_PAYMENT_PROVIDERS.map((d) => ({ value: d, label: directRouteOptionLabel(d) })),
                      ]}
                      onChange={(e) => set({ provider: e.target.value as PayeeDraft['provider'], credential_id: '' })}
                    />
                    {p.provider && (
                      <Select
                        aria-label={`수취인 ${i + 1} credential`}
                        value={p.credential_id}
                        placeholder={credentials === null ? '불러오는 중…' : options.length ? '— credential 선택 —' : `${DIRECT_PAYMENT_PROVIDER_LABELS[p.provider]} credential 없음`}
                        options={options.map((c) => ({ value: c.id, label: c.name }))}
                        onChange={(e) => set({ credential_id: e.target.value })}
                      />
                    )}
                  </div>
                  {p.provider && DIRECT_PROVIDER_SPECS[p.provider].kind === 'card' && (
                    <div data-testid={`marketing-payee-card-${i}`} style={{ display: 'grid', gridTemplateColumns: 'auto 1.4fr 1fr', gap: 6, alignItems: 'end' }}>
                      <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: tokens.colors.textPrimary, paddingBottom: 8 }}>
                        <input
                          type="checkbox"
                          aria-label={`수취인 ${i + 1} 일회용 카드`}
                          checked={p.card_single_use}
                          onChange={(e) => set({ card_single_use: e.target.checked })}
                        />
                        일회용(첫 결제 뒤 해지)
                      </label>
                      <Input aria-label={`수취인 ${i + 1} 허용 업종`} placeholder="허용 업종(쉼표, 선택 — 예: advertising_services)" value={p.card_categories}
                        onChange={(e) => set({ card_categories: e.target.value })} />
                      <Input aria-label={`수취인 ${i + 1} 카드당 최대`} placeholder={`카드당 최대(선택, ${code || '통화'} — 예: 500)`} value={p.card_max} inputMode="decimal"
                        onChange={(e) => set({ card_max: e.target.value })} />
                    </div>
                  )}
                  {p.provider && (
                    <Hint>
                      {DIRECT_PAYMENT_PROVIDER_LABELS[p.provider]} 대상: {DIRECT_REF_FORMATS[p.provider]}. credential 은 Credentials 에서 provider
                      “{DIRECT_PAYMENT_PROVIDER_LABELS[p.provider]}” 로 이 계정에 만듭니다(필드 {[...DIRECT_PROVIDER_CREDENTIAL_FIELDS[p.provider].required, ...DIRECT_PROVIDER_CREDENTIAL_FIELDS[p.provider].optional.map((f) => `${f}(선택)`)].join(', ')}).
                      {DIRECT_PROVIDER_SPECS[p.provider].kind === 'card' && ' 셀프 서비스 Standard 프로그램은 카드당 하루 500 USD 라 카드당 최대를 500 으로 두기를 권합니다. 허용 업종을 틀리게 적으면 모든 결제가 거절됩니다.'}
                    </Hint>
                  )}
                  {p.provider && <PaymentCredentialGuide provider={p.provider} />}
                </div>
              );
            })}
            <div><Button size="sm" variant="secondary" onClick={() => setPayees((rows) => [...rows, { ...EMPTY_PAYEE }])}>+ 수취인</Button></div>
          </div>
          <Hint>에이전트는 이 목록 밖의 수취인에게 지출을 요청할 수 없습니다. 외부에서 들어온 글이 수취인을 바꾸지 못하게 하는 장치입니다.</Hint>
          <Hint>
            직접 결제(Meta Ads · Google Ads) 수취인은 정해 둔 광고 캠페인 하나의 고정 상한만 올립니다 — Meta 는 캠페인 지출 한도(spend_cap),
            Google 은 공유하지 않는 캠페인 총예산. 처음 상한은 사람이 광고 화면에서 정하고, 일 예산 캠페인은 쓸 수 없습니다. 승인 금액 = 상한이 늘어나는 양입니다.
            Stripe Issuing 수취인은 정해 둔 카드 소지자 아래에 승인 금액이 누적 한도인 가상 카드를 한 장씩 만들고, 사람이 Stripe 대시보드에서 그 카드로 결제합니다.
          </Hint>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
          <Select
            label="결제 방식(직접 결제 경로가 없는 수취인)"
            value={provider}
            options={(['manual', 'webhook'] as MarketingPaymentProvider[]).map((p) => ({ value: p, label: PAYMENT_PROVIDER_LABELS[p] }))}
            onChange={(e) => setProvider(e.target.value as MarketingPaymentProvider)}
          />
          {provider === 'webhook' && (
            <Select
              label="결제 credential"
              value={credentialId}
              placeholder={credentials === null ? '불러오는 중…' : '— credential 선택 —'}
              options={(credentials || []).map((c) => ({ value: c.id, label: c.name }))}
              onChange={(e) => setCredentialId(e.target.value)}
            />
          )}
        </div>
        {provider === 'webhook' && (
          <Hint>
            webhook credential 에는 webhook_url(https) 과 secret(16자 이상) 필드가 있어야 합니다. 서버가 서명(X-AWB-Signature)과
            Idempotency-Key 를 붙여 보내고, 응답이 모호하면 결과 불명(unknown)으로 두고 다시 보내지 않습니다.
          </Hint>
        )}
        {error && <div role="alert" style={{ fontSize: 12, color: tokens.colors.dangerLight }}>{error}</div>}
      </div>
    </Modal>
  );
}

/** 사람이 직접 채널별 기간 편성액을 정하고 곧바로 승인한다. */
function DirectAllocationModal({ budget, onClose }: { budget: MarketingBudgetSummary; onClose(): void }) {
  const ctx = useMarketingCtx();
  const { busy, run } = useAction();
  const currency = budget.currency || ctx.currency;
  // 연 순간의 편성과 비교한다 — 열려 있는 동안 다른 사람이 바꾼 채널을 이 화면이 예전 값으로 되돌리지 않게.
  const [rows] = useState(() => budget.channels.filter((c) => c.status === 'active' || c.status === 'paused'));
  const [amounts, setAmounts] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const c of rows) out[c.channel_id] = c.allocation_minor === null ? '' : minorToMajorInput(c.allocation_minor, currency);
    return out;
  });
  const [rationale, setRationale] = useState('');
  const [error, setError] = useState('');

  const submit = async () => {
    const allocations: Array<{ channel_id: string; amount_minor: number }> = [];
    for (const c of rows) {
      const raw = (amounts[c.channel_id] || '').trim();
      const before = c.allocation_minor === null ? '' : minorToMajorInput(c.allocation_minor, currency);
      if (raw === before) continue;
      if (!raw) continue;
      const parsed = parseMajorToMinor(raw, currency, { allowZero: true });
      if (!parsed.ok) { setError(`${c.name}: ${parsed.error}`); return; }
      allocations.push({ channel_id: c.channel_id, amount_minor: parsed.minor });
    }
    if (!allocations.length) { setError('바꾼 편성액이 없습니다'); return; }
    // 서버는 한 줄씩 차례로 승인하며 매번 "다른 채널의 active 편성 + 이 줄 ≤ 상한" 을 본다. 줄이는 것부터 보내야
    // 끝 상태가 상한 안인 재배분(A 60→70, B 40→30, 상한 100)이 순서 때문에 409 로 멈추지 않는다.
    const ordered = orderAllocationsForApproval(allocations, new Map(rows.map((c) => [c.channel_id, c.allocation_minor])));
    setError('');
    const saved = await run(
      () => api.setMarketingAllocations(ctx.campaignId, { allocations: ordered, rationale: rationale.trim() }),
      `${allocations.length}개 채널의 편성을 정했습니다`,
    );
    if (saved) onClose();
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="예산 직접 편성"
      maxWidth={620}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>취소</Button>
          <Button variant="primary" disabled={busy || !rows.length} onClick={() => void submit()}>{busy ? '저장 중…' : '편성하고 승인'}</Button>
        </>
      )}
    >
      {rows.length === 0 ? (
        <Hint>승인된 채널이 없습니다 — 편성은 활성 · 일시정지 채널에만 합니다.</Hint>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map((c) => (
            <div key={c.channel_id} style={{ display: 'grid', gridTemplateColumns: '1fr 180px', gap: 8, alignItems: 'end' }}>
              <div style={{ fontSize: 13, color: tokens.colors.textStrong }}>
                {c.name}
                <div style={{ fontSize: 11, color: tokens.colors.textMuted }}>
                  현재 {c.allocation_minor === null ? '편성 없음' : formatMinor(c.allocation_minor, currency)}
                </div>
              </div>
              <Input
                aria-label={`${c.name} 편성액`}
                value={amounts[c.channel_id] || ''}
                inputMode="decimal"
                placeholder={currency}
                onChange={(e) => setAmounts((prev) => ({ ...prev, [c.channel_id]: e.target.value }))}
              />
            </div>
          ))}
          <Textarea label="근거 (선택)" rows={2} value={rationale} onChange={(e) => setRationale(e.target.value)} />
          <Hint>바꾼 채널만 새 편성으로 저장하고 곧바로 승인합니다(그 채널의 이전 편성은 대체됩니다). 편성 합계는 기간 상한(없으면 총 예산)을 넘을 수 없습니다.</Hint>
          {error && <div role="alert" style={{ fontSize: 12, color: tokens.colors.dangerLight }}>{error}</div>}
        </div>
      )}
    </Modal>
  );
}
