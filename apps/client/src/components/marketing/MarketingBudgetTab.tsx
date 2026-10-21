import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import type {
  Credential,
  MarketingAllocation,
  MarketingBudgetPeriod,
  MarketingBudgetSummary,
  MarketingCampaignInput,
  MarketingLedgerEntry,
  MarketingPayee,
  MarketingPaymentProvider,
  MarketingSpendRequest,
} from '../../types';
import { tokens } from '../../tokens';
import { Button, Input, Modal, Select, Textarea } from '../common';
import {
  BUDGET_PERIOD_LABELS,
  PAYMENT_PROVIDER_LABELS,
  allocationStatusView,
  campaignPatch,
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
                {campaign.payees.map((p) => (
                  <li key={p.name}>{p.name}{p.ref ? ` (${p.ref})` : ''}{p.note ? ` — ${p.note}` : ''}</li>
                ))}
              </ul>
            ) : (
              <Hint>비어 있습니다 — 수취인이 없으면 어떤 지출도 요청할 수 없습니다.</Hint>
            )}
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

interface PayeeDraft { name: string; ref: string; note: string }

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
  const [payees, setPayees] = useState<PayeeDraft[]>(() => campaign.payees.map((p) => ({ name: p.name, ref: p.ref || '', note: p.note || '' })));
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
      if (!name && !p.ref.trim() && !p.note.trim()) continue;
      if (!name) { setError('수취인 이름을 비울 수 없습니다'); return; }
      if (seen.has(name.toLowerCase())) { setError(`수취인 "${name}" 이 두 번 있습니다`); return; }
      seen.add(name.toLowerCase());
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {payees.map((p, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.4fr auto', gap: 6, alignItems: 'end' }}>
                <Input aria-label={`수취인 ${i + 1} 이름`} placeholder="이름(예: Reddit Ads)" value={p.name}
                  onChange={(e) => setPayees((rows) => rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))} />
                <Input aria-label={`수취인 ${i + 1} 참조`} placeholder="계정 · 참조(선택)" value={p.ref}
                  onChange={(e) => setPayees((rows) => rows.map((r, j) => (j === i ? { ...r, ref: e.target.value } : r)))} />
                <Input aria-label={`수취인 ${i + 1} 메모`} placeholder="메모(선택)" value={p.note}
                  onChange={(e) => setPayees((rows) => rows.map((r, j) => (j === i ? { ...r, note: e.target.value } : r)))} />
                <Button size="sm" variant="ghost" onClick={() => setPayees((rows) => rows.filter((_, j) => j !== i))}>삭제</Button>
              </div>
            ))}
            <div><Button size="sm" variant="secondary" onClick={() => setPayees((rows) => [...rows, { name: '', ref: '', note: '' }])}>+ 수취인</Button></div>
          </div>
          <Hint>에이전트는 이 목록 밖의 수취인에게 지출을 요청할 수 없습니다. 외부에서 들어온 글이 수취인을 바꾸지 못하게 하는 장치입니다.</Hint>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
          <Select
            label="결제 방식"
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
