import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import type { MarketingConsentNotice, MarketingConsentNoticeOverview, MarketingConsentNoticePreview } from '../../types';
import { useToast } from '../../contexts/ToastContext';
import { tokens } from '../../tokens';
import { Button, Input, Modal, Textarea } from '../common';
import { formatDateTime } from './marketing.logic';
import {
  CONSENT_NOTICE_LEAD_DAYS,
  CONSENT_NOTICE_PLACEHOLDERS,
  CONSENT_NOTICE_PLACEHOLDER_LABELS,
  CONSENT_NOTICE_POLICIES,
  CONSENT_NOTICE_POLICY_LABELS,
  consentNoticeCountItems,
  consentNoticeDraftFrom,
  consentNoticePayload,
  consentNoticeStatusView,
  consentNoticeSummary,
  formatDay,
  type ConsentNoticeDraft,
} from './consentNotice.logic';
import { FieldLabel, Hint, Panel, StatusPill, tableStyles } from './MarketingUi';

/**
 * 수신 동의 재확인 안내(docs/marketing.md "동의 재확인 안내") — 연락처 화면 위의 요약과 설정 창. 연락처처럼 계정 단위이고
 * `accountId` 는 연락처 화면이 받은 그대로 싣는다(없으면 서버가 정한다).
 */
export function ConsentNoticePanel({ accountId }: { accountId: string | null }) {
  useLocale();
  const [overview, setOverview] = useState<MarketingConsentNoticeOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    let cancelled = false;
    api.getMarketingConsentNoticeSettings(accountId)
      .then((o) => { if (!cancelled) { setOverview(o); setError(null); } })
      .catch((err) => { if (!cancelled) setError((err as Error)?.message || translate('재확인 안내 설정을 불러오지 못했습니다')); });
    return () => { cancelled = true; };
  }, [accountId]);
  useEffect(() => load(), [load]);

  const counts = overview?.counts;
  return (
    <Panel
      testId="marketing-consent-notice"
      title={translate('동의 재확인 안내 (2년)')}
      actions={<Button size="sm" variant="secondary" disabled={!overview} onClick={() => setOpen(true)}>{translate('설정')}</Button>}
    >
      {error && !overview ? (
        <div role="alert" style={{ fontSize: 12, color: tokens.colors.dangerLight }}>{error}</div>
      ) : !overview || !counts ? (
        <div style={{ fontSize: 12, color: tokens.colors.textSecondary }}>{translate('불러오는 중…')}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 12.5, color: tokens.colors.textStrong }} data-testid="marketing-consent-notice-summary">
            {consentNoticeSummary(overview.settings)}
          </div>
          {overview.settings.enabled && (
            <div style={{ fontSize: 12, color: tokens.colors.textSecondary }}>
              {translate('안내 기간')} {counts.in_window} {translate('· 보낼 예정')} {counts.waiting} {translate('· 최근 30일 보냄')} {counts.sent_30d} {translate('· 유지 클릭')} {counts.kept_30d} {translate('· 실패')} {counts.failed_30d}
            </div>
          )}
          {counts.waiting_no_sender > 0 && (
            <Hint tone="warning">{counts.waiting_no_sender}{translate('건은 같은 브랜드 · 목록의 메일 채널이 없어 보내지 못하고 있습니다 — 기한 전에 메일 채널을 승인하세요.')}</Hint>
          )}
          {counts.failed_retryable > 0 && (
            <Hint tone="warning">{translate('기한 전에 실패한 안내')} {counts.failed_retryable}{translate('통 — 메일 설정을 고친 뒤 "설정" 에서 다시 보낼 수 있습니다.')}</Hint>
          )}
          {counts.expired > 0 && (
            <Hint tone="warning">{translate('기한이 지난 브랜드 동의')} {counts.expired}{translate('건 — 안내로는 이을 수 없고, 새로 동의를 받아 가져와야 다시 보냅니다.')}</Hint>
          )}
        </div>
      )}
      {open && overview && (
        <ConsentNoticeSettingsModal
          accountId={accountId}
          overview={overview}
          onSaved={setOverview}
          onClose={() => { setOpen(false); load(); }}
        />
      )}
    </Panel>
  );
}

function ConsentNoticeSettingsModal({ accountId, overview, onSaved, onClose }: {
  accountId: string | null;
  overview: MarketingConsentNoticeOverview;
  onSaved(o: MarketingConsentNoticeOverview): void;
  onClose(): void;
}) {
  useLocale();
  const { showToast } = useToast();
  const [draft, setDraft] = useState<ConsentNoticeDraft>(() => consentNoticeDraftFrom(overview.settings));
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<MarketingConsentNoticePreview | null>(null);
  const [serverError, setServerError] = useState('');
  const [recent, setRecent] = useState<MarketingConsentNotice[] | null>(null);
  const [recentError, setRecentError] = useState('');
  const [recentKey, setRecentKey] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const { payload, errors } = consentNoticePayload(draft);
  const set = (patch: Partial<ConsentNoticeDraft>) => { setDraft((d) => ({ ...d, ...patch })); setPreview(null); setServerError(''); };

  useEffect(() => {
    let cancelled = false;
    api.listMarketingConsentNotices(accountId, { limit: 50 })
      .then((rows) => { if (!cancelled) { setRecent(rows); setRecentError(''); } })
      .catch((err) => { if (!cancelled) setRecentError((err as Error)?.message || translate('최근 안내를 불러오지 못했습니다')); });
    return () => { cancelled = true; };
  }, [accountId, recentKey]);

  const retryFailed = async () => {
    setRetrying(true);
    setServerError('');
    try {
      const result = await api.retryFailedMarketingConsentNotices(accountId);
      onSaved({ settings: result.settings, counts: result.counts });
      setRecentKey((k) => k + 1);
      showToast(translate('실패한 안내 {0}통을 다시 보냅니다', { 0: result.requeued }), 'success');
    } catch (err) {
      setServerError((err as Error)?.message || translate('다시 보내지 못했습니다'));
    } finally {
      setRetrying(false);
    }
  };

  const runPreview = async () => {
    if (errors.length) return;
    setPreviewing(true);
    setServerError('');
    try {
      setPreview(await api.previewMarketingConsentNotice(accountId, payload));
    } catch (err) {
      setServerError((err as Error)?.message || translate('미리보기를 만들지 못했습니다'));
    } finally {
      setPreviewing(false);
    }
  };

  const save = async () => {
    if (errors.length) return;
    setSaving(true);
    setServerError('');
    try {
      const saved = await api.saveMarketingConsentNoticeSettings(accountId, payload);
      onSaved(saved);
      setDraft(consentNoticeDraftFrom(saved.settings));
      showToast(saved.settings.enabled ? translate('저장했습니다 — 안내 기간에 든 연락처에게 보내기 시작합니다') : translate('저장했습니다'), 'success');
    } catch (err) {
      setServerError((err as Error)?.message || translate('저장하지 못했습니다'));
    } finally {
      setSaving(false);
    }
  };

  const turningOn = draft.enabled && !overview.settings.enabled;
  return (
    <Modal
      isOpen
      onClose={onClose}
      title={translate('동의 재확인 안내')}
      maxWidth={880}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>{translate('닫기')}</Button>
          <Button variant="secondary" disabled={previewing || errors.length > 0} onClick={() => void runPreview()}>
            {previewing ? translate('만드는 중…') : translate('미리보기')}
          </Button>
          <Button variant="primary" disabled={saving || errors.length > 0} onClick={() => void save()}>{saving ? translate('저장 중…') : translate('저장')}</Button>
        </>
      )}
    >
      <div data-testid="marketing-consent-notice-settings" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 12.5, color: tokens.colors.warningLight, lineHeight: 1.55 }}>
          {translate('정보통신망법 §50⑧ — 광고성 정보 수신 동의를 받았으면')} <b>{translate('동의일부터 2년마다, 2년이 되는 날 전까지')}</b> {translate('받는 사람에게 동의 사실을 알려야 합니다. 서버가 안내 끝에')} <b>{translate('보낸 곳 · 동의한 날짜 · 유지와 철회 방법')}</b>{translate('을 붙이고, 아래 무응답 처리를 받는 사람에게 그대로 알립니다. 법정 통지라 광고 표기를 붙이지 않습니다 — 광고 문구를 섞지 마세요. 기한이 지난 동의는 안내로 잇지 않습니다(동의를 다시 묻는 메일도 광고성 정보입니다).')}</div>

        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, color: tokens.colors.textStrong, cursor: 'pointer' }}>
          <input
            type="checkbox"
            aria-label={translate('재확인 안내 보내기')}
            checked={draft.enabled}
            onChange={(e) => set({ enabled: e.target.checked })}
          />
          <span>{translate('재확인 안내 보내기')}</span>
        </label>
        {turningOn && (
          <Hint tone="warning">
            {translate('저장하면 안내 기간에 든 브랜드 동의')} {overview.counts.in_window}{translate('건에 대해 10분 안에 보내기 시작합니다. 발신자는 같은 브랜드로 메일을 보내는 메일 채널입니다(최근 받은 메일의 채널, 없으면 같은 브랜드이며 그 사람의 목록을 쓰는 채널).')}</Hint>
        )}

        <Input
          label={translate('기한 며칠 전에 보낼까요 ({0}–{1}일)', { 0: CONSENT_NOTICE_LEAD_DAYS.min, 1: CONSENT_NOTICE_LEAD_DAYS.max })}
          value={draft.lead_days}
          inputMode="numeric"
          onChange={(e) => set({ lead_days: e.target.value })}
        />

        <div>
          <FieldLabel>{translate('응답이 없으면')}</FieldLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {CONSENT_NOTICE_POLICIES.map((p) => (
              <label key={p} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, color: tokens.colors.textSecondary, cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="marketing-consent-notice-policy"
                  data-testid={`marketing-consent-notice-policy-${p}`}
                  checked={draft.on_no_response === p}
                  onChange={() => set({ on_no_response: p })}
                />
                <span>
                  <b style={{ color: tokens.colors.textStrong }}>{CONSENT_NOTICE_POLICY_LABELS[p].label}</b>
                  <span style={{ display: 'block', fontSize: 12 }}>{CONSENT_NOTICE_POLICY_LABELS[p].detail}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <Input label={translate('제목')} value={draft.subject} onChange={(e) => set({ subject: e.target.value })} />
        <Textarea
          label={translate('본문 — 법정 항목 · 유지 · 철회 링크는 서버가 이 뒤에 붙입니다')}
          aria-label={translate('안내 본문')}
          rows={6}
          value={draft.body}
          onChange={(e) => set({ body: e.target.value })}
        />
        <Hint>
          {translate('쓸 수 있는 자리표시자:')} {CONSENT_NOTICE_PLACEHOLDERS.map((p) => `{{${p}}} ${CONSENT_NOTICE_PLACEHOLDER_LABELS[p]}`).join(' · ')}
        </Hint>
        {errors.length > 0 && (
          <ul role="alert" style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: tokens.colors.dangerLight }}>
            {errors.map((e) => <li key={e}>{e}</li>)}
          </ul>
        )}
        {serverError && <div role="alert" style={{ fontSize: 12, color: tokens.colors.dangerLight }}>{serverError}</div>}

        {preview && (
          <div data-testid="marketing-consent-notice-preview" style={{ border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.sm, padding: 10 }}>
            <FieldLabel>{translate('미리보기 — 예시 받는 사람(홍길동), 기한')} {draft.lead_days}{translate('일 전')}</FieldLabel>
            <div style={{ fontSize: 12, color: tokens.colors.textSecondary, marginBottom: 4 }}>
              {preview.sender ? translate('보내는 채널: {0} · {1} <{2}>', { 0: preview.sender.channel_name, 1: preview.sender.from_name, 2: preview.sender.from_address }) : translate('보내는 채널: 없음')}
            </div>
            <div style={{ fontSize: 13, fontWeight: 700, color: tokens.colors.textPrimary, marginBottom: 6 }}>{preview.subject}</div>
            <pre style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: tokens.colors.textStrong, fontFamily: 'inherit' }}>
              {preview.text}
            </pre>
            {preview.warnings.map((w) => <Hint key={w} tone="warning">{w}</Hint>)}
          </div>
        )}

        <div>
          <FieldLabel>{translate('현황')}</FieldLabel>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 6 }} data-testid="marketing-consent-notice-counts">
            {consentNoticeCountItems(overview.counts).map((item) => (
              <div key={item.key} style={{ fontSize: 12, color: item.warn ? tokens.colors.warningLight : tokens.colors.textSecondary }}>
                {item.label} <b style={{ color: item.warn ? tokens.colors.warningLight : tokens.colors.textStrong }}>{item.value}</b>
              </div>
            ))}
          </div>
          {overview.counts.failed_retryable > 0 && (
            <div style={{ marginTop: 8 }}>
              <Button size="sm" variant="secondary" disabled={retrying} onClick={() => void retryFailed()}>
                {retrying ? translate('다시 보내는 중…') : translate('실패한 안내 다시 보내기 ({0})', { 0: overview.counts.failed_retryable })}
              </Button>
              <Hint tone="warning">
                {translate('기한 전인 것만 다시 보냅니다. 공급자 시간 초과로 "닿았을 수 있음" 으로 닫힌 안내는 두 번 받을 수 있습니다 — 메일 설정(키 · 도메인)을 고친 뒤에 누르세요.')}</Hint>
            </div>
          )}
          {overview.settings.version > 0 && (
            <Hint>{translate('문구 버전')} {overview.settings.version}{overview.settings.updated_by_name ? ` · ${overview.settings.updated_by_name}` : ''} · {formatDateTime(overview.settings.updated_at)}</Hint>
          )}
        </div>

        <div>
          <FieldLabel>{translate('최근 안내')}</FieldLabel>
          {recentError ? (
            <div role="alert" style={{ fontSize: 12, color: tokens.colors.dangerLight }}>{recentError}</div>
          ) : recent === null ? (
            <div style={{ fontSize: 12, color: tokens.colors.textSecondary }}>{translate('불러오는 중…')}</div>
          ) : recent.length === 0 ? (
            <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>{translate('아직 보낸 안내가 없습니다.')}</div>
          ) : (
            <div style={{ overflow: 'auto', maxHeight: 280, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.sm }}>
              <table style={tableStyles.table} data-testid="marketing-consent-notice-list">
                <thead>
                  <tr>
                    <th style={tableStyles.th}>{translate('받는 사람')}</th>
                    <th style={tableStyles.th}>{translate('동의 기한')}</th>
                    <th style={tableStyles.th}>{translate('상태')}</th>
                    <th style={tableStyles.th}>{translate('보냄 · 유지')}</th>
                    <th style={tableStyles.th}>{translate('사유')}</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((n) => (
                    <tr key={n.id}>
                      <td style={tableStyles.td}>{n.contact_email || <span style={{ color: tokens.colors.textMuted }}>{translate('(삭제됨)')}</span>}</td>
                      <td style={tableStyles.td}>{formatDay(n.due_at)}</td>
                      <td style={tableStyles.td}><StatusPill view={consentNoticeStatusView(n.status)} /></td>
                      <td style={tableStyles.td}>
                        {n.sent_at ? `${formatDateTime(n.sent_at)} · ${n.policy === 'lapse' ? translate('응답 없으면 철회') : translate('응답 없으면 유지')}` : '—'}
                        {n.kept_at && <div style={{ fontSize: 11, color: tokens.colors.successLight }}>{formatDay(n.kept_at)} {translate('유지함')}</div>}
                        {!n.kept_at && n.renewed_at && <div style={{ fontSize: 11, color: tokens.colors.textSecondary }}>{translate('응답 없어 이어짐')}</div>}
                      </td>
                      <td style={{ ...tableStyles.td, fontSize: 11, color: tokens.colors.textMuted, overflowWrap: 'anywhere' }}>
                        {n.bounce_type && <div style={{ color: tokens.colors.warningLight }}>{translate('닿지 않음(')}{n.bounce_type})</div>}
                        {n.error || n.event_note || ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
