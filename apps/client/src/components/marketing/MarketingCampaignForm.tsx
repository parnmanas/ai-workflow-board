import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React, { useState } from 'react';
import { api } from '../../api';
import type {
  MarketingCampaign,
  MarketingCampaignInput,
  MarketingCapability,
  MarketingFeedbackTicketStatus,
  MarketingLimitKey,
} from '../../types';
import { useAuth } from '../../contexts/AuthContext';
import { tokens } from '../../tokens';
import { Button, Input, Modal, Select, Textarea } from '../common';
import DeclareRuntimeSection from '../runtime/DeclareRuntimeSection';
import { useProjects } from '../../projects/useProjects';
import { useHostNames } from '../../runtime/useHostNames';
import { assigneeDisplayName } from '../../tickets/assignee';
import { specSummary } from '../../runtime/runtimeSpec';
import {
  CAPABILITY_DESCRIPTIONS,
  CAPABILITY_LABELS,
  DEFAULT_LIMITS,
  LIMIT_KEYS,
  LIMIT_LABELS,
  MARKETING_CAPABILITIES,
  cadenceDraftFrom,
  cadencePayload,
  campaignPatch,
  isCurrencyCode,
  normalizeCurrencyCode,
  parseList,
  withoutMoneySettings,
  type CadenceDraft,
} from './marketing.logic';
import { FieldLabel, Hint } from './MarketingUi';

/**
 * 캠페인 만들기 · 설정 고치기(docs/marketing.md). 캠페인은 공통 업무라 소유를 고르지 않는다 — 실행 키(account_id)는
 * 서버가 정한다(docs/ownership.md). 돈 설정(통화 · 한도 · 수취인 · 결제 방식)은
 * 예산 설정(MarketingBudgetSettingsModal)에서 marketing.approve_spend 가 있는 사람만 고친다.
 */

export function RuntimeSpecLabel({ spec, empty }: { spec: Record<string, any> | null | undefined; empty: string }) {
  useLocale();
  const hostNames = useHostNames();
  if (!spec) return <span style={{ color: tokens.colors.textMuted }}>{empty}</span>;
  const name = assigneeDisplayName(spec, hostNames);
  const hostName = spec.manager_agent_id ? hostNames[spec.manager_agent_id] : undefined;
  return (
    <span>
      <span style={{ color: tokens.colors.textStrong, fontWeight: 600 }}>{name || specSummary(spec, hostName)}</span>
      <span style={{ color: tokens.colors.textMuted, marginLeft: 6, fontSize: 11 }}>{specSummary(spec, hostName)}</span>
    </span>
  );
}

function CapabilityChecklist({ value, onChange }: { value: MarketingCapability[]; onChange(next: MarketingCapability[]): void }) {
  useLocale();
  const toggle = (cap: MarketingCapability, on: boolean) => {
    const next = on ? [...value, cap] : value.filter((c) => c !== cap);
    onChange(MARKETING_CAPABILITIES.filter((c) => next.includes(c)));
  };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 8 }}>
      {MARKETING_CAPABILITIES.map((cap) => (
        <label
          key={cap}
          style={{
            display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer', padding: 8,
            border: `1px solid ${value.includes(cap) ? tokens.colors.accent : tokens.colors.border}`, borderRadius: tokens.radii.sm,
          }}
        >
          <input type="checkbox" aria-label={CAPABILITY_LABELS[cap]} checked={value.includes(cap)} onChange={(e) => toggle(cap, e.target.checked)} />
          <span>
            <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: tokens.colors.textStrong }}>{CAPABILITY_LABELS[cap]}</span>
            <span style={{ display: 'block', fontSize: 11, color: tokens.colors.textMuted, lineHeight: 1.4 }}>{CAPABILITY_DESCRIPTIONS[cap]}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

function CadenceFields({ value, onChange }: { value: CadenceDraft; onChange(next: CadenceDraft): void }) {
  useLocale();
  const radio = (kind: CadenceDraft['kind'], label: string) => (
    <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13, color: tokens.colors.textSecondary, cursor: 'pointer' }}>
      <input type="radio" name="marketing-cadence" checked={value.kind === kind} onChange={() => onChange({ ...value, kind })} />
      {label}
    </label>
  );
  return (
    <div>
      <FieldLabel>{translate('사이클 주기')}</FieldLabel>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 8 }}>
        {radio('manual', translate('수동 실행만'))}
        {radio('interval', translate('시간 간격'))}
        {radio('cron', translate('cron (UTC)'))}
      </div>
      {value.kind === 'interval' && (
        <div style={{ maxWidth: 220 }}>
          <Input label={translate('몇 시간마다')} value={value.hours} inputMode="decimal" onChange={(e) => onChange({ ...value, hours: e.target.value })} />
        </div>
      )}
      {value.kind === 'cron' && (
        <Input label={translate('cron (5필드, UTC — 예: "0 1 * * *" = 매일 01:00 UTC)')} value={value.cron} onChange={(e) => onChange({ ...value, cron: e.target.value })} />
      )}
      <Hint>{translate('사이클마다 캠페인 에이전트가 새 채팅 방에서 깨어나 할 일을 하고 요약을 남깁니다. 최소 간격은 10분입니다.')}</Hint>
    </div>
  );
}

interface CampaignFormModalProps {
  mode: 'create' | 'edit';
  campaign?: MarketingCampaign | null;
  canApproveSpend: boolean;
  onClose(): void;
  onSaved(campaign: MarketingCampaign): void;
  notify(message: string, type?: 'success' | 'error' | 'info'): void;
}

export function CampaignFormModal({ mode, campaign: campaignProp, canApproveSpend, onClose, onSaved, notify }: CampaignFormModalProps) {
  useLocale();
  const { currentAccountId } = useAuth();
  // 연 순간의 캠페인과 비교한다 — 열려 있는 동안 다른 사람이 바꾼 값(기능 · 상한 …)을, 이 화면에서 건드리지 않은
  // 칸이 "바뀜" 으로 잡혀 예전 값으로 되돌리지 않게(캠페인 객체는 marketing_update 마다 새로 온다).
  const [campaign] = useState(() => campaignProp || null);
  const editing = mode === 'edit' && !!campaign;
  const { projects } = useProjects(currentAccountId || '');
  const [name, setName] = useState(campaign?.name || '');
  const [projectId, setProjectId] = useState(campaign?.project_id || '');
  const [brief, setBrief] = useState(campaign?.product_brief || '');
  const [goal, setGoal] = useState(campaign?.goal || '');
  const [audience, setAudience] = useState(campaign?.target_audience || '');
  const [capabilities, setCapabilities] = useState<MarketingCapability[]>(campaign?.capabilities || ['channel_discovery', 'community_post', 'analytics']);
  const [cadence, setCadence] = useState<CadenceDraft>(() => cadenceDraftFrom(campaign || null));
  const [currency, setCurrency] = useState(campaign?.currency || 'KRW');
  const [agent, setAgent] = useState<Record<string, any> | null>(campaign?.agent_runtime || null);
  const [disclosure, setDisclosure] = useState(campaign?.disclosure || '');
  const [domains, setDomains] = useState((campaign?.allowed_domains || []).join('\n'));
  const [limits, setLimits] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const key of LIMIT_KEYS) {
      const v = campaign?.limit_overrides?.[key];
      out[key] = v === undefined || v === null ? '' : String(v);
    }
    return out;
  });
  const [ticketStatus, setTicketStatus] = useState<MarketingFeedbackTicketStatus>(campaign?.feedback_ticket_status || 'backlog');
  const [improvement, setImprovement] = useState<Record<string, any> | null>(campaign?.improvement_assignee || null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const selectedProject = projects.find((p) => p.id === projectId) || null;
  // 실행 선언(credential · 폴더)을 고를 때 싣는 실행 키 — 수정이면 캠페인의 것, 새로 만들면 고른 Project 의 것.
  const runtimeAccountId = editing ? campaign!.account_id : selectedProject?.account_id || currentAccountId || '';

  const submit = async () => {
    if (!name.trim()) { setError(translate('이름을 입력하세요')); return; }
    const cadenceBody = cadencePayload(cadence);
    if (!cadenceBody.ok) { setError(cadenceBody.error); return; }
    if (canApproveSpend && !editing && !isCurrencyCode(currency)) { setError(translate('통화는 ISO 4217 세 글자 코드입니다 (예: KRW, USD)')); return; }
    if (capabilities.includes('feedback_to_product') && !projectId) {
      setError(translate('"피드백 → 제품 개선" 은 제품 Project 가 필요합니다 — Project 를 고르거나 그 기능을 끄세요'));
      return;
    }
    const limitOverrides: Partial<Record<MarketingLimitKey, number>> = {};
    for (const key of LIMIT_KEYS) {
      const raw = (limits[key] || '').trim();
      if (!raw) continue;
      if (!/^\d+$/.test(raw) || Number(raw) > 1000) { setError(translate('{0} 은 0~1000 사이의 정수여야 합니다', { 0: LIMIT_LABELS[key] })); return; }
      limitOverrides[key] = Number(raw);
    }
    setError('');
    setSaving(true);
    try {
      let saved: MarketingCampaign;
      if (editing) {
        const draft: MarketingCampaignInput = {
          name: name.trim(),
          project_id: projectId || null,
          product_brief: brief,
          goal,
          target_audience: audience,
          capabilities,
          cycle_cron: cadenceBody.cycle_cron,
          cycle_interval_ms: cadenceBody.cycle_interval_ms,
          agent_runtime: agent,
          disclosure,
          allowed_domains: parseList(domains),
          limits: limitOverrides,
          feedback_ticket_status: ticketStatus,
          improvement_assignee: improvement,
        };
        // 이 화면에는 돈 설정이 없다 — 그래도 실수로 섞이지 않게 canEditMoney: false.
        const patch = campaignPatch(campaign!, draft, { canEditMoney: false });
        if (!Object.keys(patch).length) { onClose(); return; }
        saved = await api.updateMarketingCampaign(campaign!.id, patch);
        notify(translate('캠페인 설정을 저장했습니다'), 'success');
      } else {
        const body: MarketingCampaignInput & { name: string } = {
          name: name.trim(),
          product_brief: brief,
          goal,
          target_audience: audience,
          capabilities,
          cycle_cron: cadenceBody.cycle_cron,
          cycle_interval_ms: cadenceBody.cycle_interval_ms,
          ...(projectId ? { project_id: projectId } : {}),
          ...(agent ? { agent_runtime: agent } : {}),
          ...(canApproveSpend ? { currency: normalizeCurrencyCode(currency) } : {}),
        };
        saved = await api.createMarketingCampaign(canApproveSpend ? body : withoutMoneySettings(body));
        notify(translate('캠페인 "{0}" 을 만들었습니다', { 0: saved.name }), 'success');
      }
      onSaved(saved);
    } catch (err) {
      setError((err as Error)?.message || translate('저장하지 못했습니다'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={editing ? translate('캠페인 설정') : translate('새 캠페인')}
      maxWidth={760}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>{translate('취소')}</Button>
          <Button variant="primary" disabled={saving} onClick={() => void submit()}>
            {saving ? translate('저장 중…') : editing ? translate('저장') : translate('캠페인 만들기')}
          </Button>
        </>
      )}
    >
      <div data-testid="marketing-campaign-form" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Input label={translate('이름')} value={name} onChange={(e) => setName(e.target.value)} />
        <Select
          label={translate('제품 Project (선택)')}
          value={projectId}
          options={[{ value: '', label: translate('— 없음 —') }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
          onChange={(e) => setProjectId(e.target.value)}
        />
        <Hint>{translate('피드백에서 나온 버그 · 기능 요청 티켓이 이 Project 에 들어갑니다.')}</Hint>
        <Textarea label={translate('제품 브리프 — 무엇을 알리는가')} rows={4} value={brief} onChange={(e) => setBrief(e.target.value)}
          placeholder={translate('제품이 무엇이고 누구의 어떤 문제를 푸는지. 에이전트는 여기 적힌 사실만 홍보합니다.')} />
        <Textarea label={translate('목표')} rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={translate('예: 3개월 안에 셀프호스팅 사용자 가입 300명')} />
        <Textarea label={translate('대상 청중')} rows={2} value={audience} onChange={(e) => setAudience(e.target.value)} />
        <div>
          <FieldLabel>{translate('기능')}</FieldLabel>
          <CapabilityChecklist value={capabilities} onChange={setCapabilities} />
          <Hint>{translate('꺼진 기능의 MCP 툴은 이 캠페인에서 거부됩니다. 돈 · 외부 발신 · 채널 개설은 켜도 언제나 사람이 승인합니다.')}</Hint>
        </div>
        <CadenceFields value={cadence} onChange={setCadence} />

        <div>
          <FieldLabel>{translate('캠페인 에이전트')}</FieldLabel>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <RuntimeSpecLabel spec={agent} empty={translate('지정 안 함 — 시작하기 전에 지정해야 합니다')} />
            {agent && <Button size="sm" variant="ghost" onClick={() => setAgent(null)}>{translate('해제')}</Button>}
          </div>
          <DeclareRuntimeSection
            // 선언을 지우면 새로 연다 — 지운 선언의 credential 을 들고 있지 않게.
            key={`${runtimeAccountId}:${agent ? 'set' : 'none'}`}
            accountId={runtimeAccountId}
            initialValue={agent}
            onResolved={(spec) => {
              setAgent(spec);
              notify(translate('에이전트 설정을 적용했습니다 — 저장하면 반영됩니다'), 'info');
            }}
          />
        </div>

        {!editing && (
          canApproveSpend ? (
            <div style={{ maxWidth: 220 }}>
              <Input label={translate('통화 (ISO 4217)')} value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
              <Hint>{translate('캠페인 하나에 통화 하나. 돈이 오가기 시작하면 바꿀 수 없습니다. 예산은 만든 뒤 예산 설정에서 정합니다.')}</Hint>
            </div>
          ) : (
            <Hint>{translate('통화 · 예산 · 수취인은 지출 승인 권한(marketing.approve_spend)이 있는 사람이 정합니다. 그 전까지 이 캠페인은 KRW, 예산 0(지출 불가)입니다.')}</Hint>
          )
        )}

        {editing && (
          <>
            <Input label={translate('공개 문구 — 모든 커뮤니티 글 끝에 서버가 붙인다')} value={disclosure} maxLength={300} onChange={(e) => setDisclosure(e.target.value)} />
            <Hint>{translate('비우면 기본 문구로 돌아갑니다. 메일은 이 문구 대신 법정 꼬리말이 붙습니다.')}</Hint>
            <Textarea label={translate('추적 링크 허용 도메인 (한 줄에 하나)')} rows={3} value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="example.com" />
            <Hint>{translate('추적 링크의 목적지는 이 도메인(과 하위 도메인)만 됩니다 — 오픈 리다이렉트를 막습니다.')}</Hint>
            <div>
              <FieldLabel>{translate('일일 상한(최근 24시간 생성 수, 비우면 기본값)')}</FieldLabel>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 8 }}>
                {LIMIT_KEYS.map((key) => (
                  <Input
                    key={key}
                    label={LIMIT_LABELS[key]}
                    value={limits[key] || ''}
                    inputMode="numeric"
                    placeholder={translate('기본 {0}', { 0: DEFAULT_LIMITS[key] })}
                    onChange={(e) => setLimits((prev) => ({ ...prev, [key]: e.target.value }))}
                  />
                ))}
              </div>
            </div>
            <Select
              label={translate('피드백 티켓을 넣을 상태')}
              value={ticketStatus}
              options={[
                { value: 'backlog', label: translate('backlog — 사람이 보고 넘긴다') },
                { value: 'todo', label: translate('todo — 담당이 있으면 바로 개선이 시작된다') },
              ]}
              onChange={(e) => setTicketStatus(e.target.value as MarketingFeedbackTicketStatus)}
            />
            <div>
              <FieldLabel>{translate('개선 담당(피드백 티켓의 assignee)')}</FieldLabel>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                <RuntimeSpecLabel spec={improvement} empty={translate('지정 안 함 — Project 기본 담당')} />
                {improvement && <Button size="sm" variant="ghost" onClick={() => setImprovement(null)}>{translate('해제')}</Button>}
              </div>
              <DeclareRuntimeSection
                accountId={runtimeAccountId}
                initialValue={improvement}
                onResolved={(spec) => { setImprovement(spec); notify(translate('개선 담당을 적용했습니다 — 저장하면 반영됩니다'), 'info'); }}
              />
            </div>
          </>
        )}
        {error && <div role="alert" style={{ fontSize: 12, color: tokens.colors.dangerLight }}>{error}</div>}
      </div>
    </Modal>
  );
}
