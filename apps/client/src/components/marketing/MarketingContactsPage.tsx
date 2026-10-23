import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import type { MarketingBrand, MarketingContact, MarketingContactImportResult } from '../../types';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { tokens } from '../../tokens';
import PageHeader from '../PageHeader';
import { Button, ConfirmDialog, EmptyState, ErrorState, Input, Modal, PermissionNotice, Select, Textarea } from '../common';
import { CONTACT_STATUS_FILTERS, UNSUBSCRIBE_SOURCE_LABELS, contactStatusView, formatCount, formatDateTime } from './marketing.logic';
import {
  CONSENT_METHODS,
  CONSENT_METHOD_LABELS,
  CONTACT_FIELDS,
  CONTACT_FIELD_LABELS,
  autoMapHeaders,
  buildContactImport,
  chunkContacts,
  normalizeListName,
  parseCsv,
  splitLists,
  type ContactMapping,
} from './marketingContacts.logic';
import { FieldLabel, Hint, NoteModal, StatusPill, tableStyles } from './MarketingUi';
import { MarketingContactReplies } from './MarketingContactReplies';
import { ConsentNoticePanel } from './MarketingConsentNotice';
import { contactConsentLine } from './consentNotice.logic';

const PAGE_SIZE = 50;

/**
 * 메일 연락처(docs/marketing.md "메일") — 설치 전체의 한 목록이고 사람만 넣는다(에이전트 경로 없음). 캠페인 화면에서
 * 열면 그 캠페인의 실행 키(`?account=` → account_id)를 그대로 싣는다. 사용자가 고르는 소유 구분이 아니다
 * (docs/ownership.md) — 없으면 서버가 정한다.
 */
export default function MarketingContactsPage() {
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const canManage = hasPermission('marketing.manage');
  const [searchParams] = useSearchParams();
  const accountId = searchParams.get('account') || null;
  const campaignId = searchParams.get('campaign') || '';
  // 목록 · 검색 칸은 "검색"(또는 Enter)을 눌러야 적용한다 — 글자마다 묻지 않게.
  const [list, setList] = useState(searchParams.get('list') || '');
  const [appliedList, setAppliedList] = useState((searchParams.get('list') || '').trim().toLowerCase());
  const [status, setStatus] = useState('');
  const [brands, setBrands] = useState<MarketingBrand[]>([]);
  const [brandId, setBrandId] = useState('');
  const [brandName, setBrandName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [migrating, setMigrating] = useState(false);
  const [unsubscribeBrandId, setUnsubscribeBrandId] = useState<string | undefined>();
  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ total: number; contacts: MarketingContact[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [campaignName, setCampaignName] = useState('');
  const [importing, setImporting] = useState(false);
  const [unsubscribing, setUnsubscribing] = useState<MarketingContact | null>(null);
  const [erasing, setErasing] = useState<MarketingContact | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!canManage) return;
    let cancelled = false;
    api.listMarketingBrands(accountId).then((rows) => { if (!cancelled) setBrands(rows); })
      .catch((err) => { if (!cancelled) setError((err as Error).message); });
    return () => { cancelled = true; };
  }, [accountId, canManage, reloadKey]);
  useEffect(() => { setSelected([]); }, [accountId, appliedList, status, appliedQuery, offset]);
  const applyFilters = () => {
    setAppliedList(list.trim().toLowerCase());
    setAppliedQuery(query.trim());
    setOffset(0);
  };
  useEffect(() => {
    if (!canManage) return;
    let cancelled = false;
    api.listMarketingContacts(accountId, { list: appliedList || undefined, status: status || undefined, q: appliedQuery || undefined, limit: PAGE_SIZE, offset })
      .then((d) => { if (!cancelled) { setData(d); setError(null); } })
      .catch((err) => { if (!cancelled) setError((err as Error)?.message || '연락처를 불러오지 못했습니다'); });
    return () => { cancelled = true; };
  }, [canManage, accountId, appliedList, status, appliedQuery, offset, reloadKey]);

  useEffect(() => {
    if (!campaignId || !canManage) return;
    let cancelled = false;
    api.getMarketingCampaign(campaignId).then((c) => { if (!cancelled) setCampaignName(c.name); }).catch(() => {});
    return () => { cancelled = true; };
  }, [campaignId, canManage]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  if (!canManage) {
    return (
      <div style={{ padding: 24 }}>
        <PermissionNotice title="마케팅 운영 권한이 필요합니다" message="메일 연락처는 marketing.manage 권한이 있는 사람만 봅니다." />
      </div>
    );
  }

  const runUnsubscribe = async (contact: MarketingContact, note: string) => {
    setBusy(true);
    try {
      await api.unsubscribeMarketingContact(contact.id, note, accountId, unsubscribeBrandId);
      showToast('수신거부를 기록했습니다', 'success');
      setUnsubscribing(null);
      reload();
    } catch (err) {
      showToast((err as Error)?.message || '기록하지 못했습니다', 'error');
    } finally {
      setBusy(false);
    }
  };

  const runErase = async (contact: MarketingContact) => {
    setBusy(true);
    try {
      await api.eraseMarketingContact(contact.id, accountId);
      showToast('연락처를 지웠습니다 — 억제용 해시만 남았습니다', 'success');
      setErasing(null);
      reload();
    } catch (err) {
      showToast((err as Error)?.message || '지우지 못했습니다', 'error');
    } finally {
      setBusy(false);
    }
  };

  const createBrand = async () => {
    if (!brandName.trim() || busy) return;
    setBusy(true);
    try {
      const brand = await api.createMarketingBrand(accountId, brandName.trim());
      setBrandId(brand.id); setBrandName(''); reload();
    } catch (err) { showToast((err as Error).message, 'error'); }
    finally { setBusy(false); }
  };
  const migrate = async () => {
    if (!brandId || !selected.length || busy) return;
    setBusy(true);
    try {
      await api.migrateMarketingLegacyConsent(accountId, brandId, selected);
      setSelected([]); setMigrating(false); reload();
      showToast('선택한 기존 동의를 브랜드에 이관했습니다', 'success');
    } catch (err) { showToast((err as Error).message, 'error'); }
    finally { setBusy(false); }
  };
  const total = data?.total ?? 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader
        title="Marketing Contacts"
        description="마케팅 메일을 받는 동의 연락처 — 동의 증거와 함께 사람이 넣고, 수신거부 · 바운스 · 스팸 신고 · 삭제된 주소는 다시 가져와도 억제됩니다."
        actions={(
          <>
            {campaignId
              ? <Link to={`/marketing/${encodeURIComponent(campaignId)}?tab=channels`} style={{ fontSize: 12, color: tokens.colors.textSecondary }}>← {campaignName || '캠페인'}</Link>
              : <Link to="/marketing" style={{ fontSize: 12, color: tokens.colors.textSecondary }}>← 캠페인 목록</Link>}
            <Button variant="primary" size="md" onClick={() => setImporting(true)}>CSV 가져오기</Button>
          </>
        )}
      />
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <ConsentNoticePanel accountId={accountId} />
        <MarketingContactReplies key={accountId || 'default'} accountId={accountId} brands={brands} onContact={(email) => { setQuery(email); setAppliedQuery(email); setList(''); setAppliedList(''); setStatus(''); setOffset(0); }} />
        <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
          <Select label="가져오기 · 기존 동의 이관 대상 브랜드" value={brandId} options={[{ value: '', label: '— 브랜드 선택 —' }, ...brands.map((b) => ({ value: b.id, label: b.name }))]} onChange={(e) => setBrandId(e.target.value)} />
          <Input label="새 브랜드 이름" value={brandName} onChange={(e) => setBrandName(e.target.value)} />
          <Button disabled={busy || !brandName.trim()} onClick={() => void createBrand()}>브랜드 만들기</Button>
          <Button disabled={busy || !brandId || !selected.length} onClick={() => setMigrating(true)}>선택 {selected.length}명 기존 동의 이관</Button>
        </div>
        <Hint>기존 동의의 실제 발신자가 확인된 연락처만 선택해 브랜드 하나에 이관하세요. 이관 전 연락처는 브랜드 발송에서 제외됩니다. 목록은 분류이고, 같은 브랜드의 여러 목록은 동의를 공유합니다.</Hint>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 1fr) minmax(140px, 1fr) minmax(200px, 2fr) auto', gap: 8, alignItems: 'end' }}>
          <Input
            label="수신 목록"
            value={list}
            placeholder="전체"
            onChange={(e) => setList(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') applyFilters(); }}
          />
          <Select
            label="상태"
            value={status}
            options={[{ value: '', label: '전체' }, ...CONTACT_STATUS_FILTERS.map((s) => ({ value: s, label: contactStatusView(s).label }))]}
            onChange={(e) => { setStatus(e.target.value); setOffset(0); }}
          />
          <Input
            label="검색(주소 · 이름)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') applyFilters(); }}
          />
          <Button variant="secondary" size="md" onClick={applyFilters}>검색</Button>
        </div>

        {error && data && (
          <div role="alert" style={{ fontSize: 12, color: tokens.colors.dangerLight }}>{error}</div>
        )}
        {error && !data ? (
          <ErrorState message={error} onRetry={reload} />
        ) : !data ? (
          <div style={{ fontSize: 13, color: tokens.colors.textSecondary }}>불러오는 중…</div>
        ) : data.contacts.length === 0 ? (
          <EmptyState
            title="연락처가 없습니다"
            description="가입 폼 · 결제 · 행사에서 동의를 받은 사람만 넣으세요. CSV 로 가져올 때 동의 방법 · 시각 · 출처가 필요합니다."
            action={<Button variant="primary" onClick={() => setImporting(true)}>CSV 가져오기</Button>}
          />
        ) : (
          <>
            <div style={{ fontSize: 12, color: tokens.colors.textSecondary }}>
              {formatCount(total)}명 중 {offset + 1}–{offset + data.contacts.length}
            </div>
            <div style={{ border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md, overflow: 'auto', background: tokens.colors.surfaceCard }}>
              <table style={tableStyles.table} data-testid="marketing-contacts">
                <thead>
                  <tr>
                    <th style={tableStyles.th}>기존 동의 이관</th>
                    <th style={tableStyles.th}>주소</th>
                    <th style={tableStyles.th}>이름</th>
                    <th style={tableStyles.th}>목록</th>
                    <th style={tableStyles.th}>상태</th>
                    <th style={tableStyles.th}>동의 증거</th>
                    <th style={tableStyles.th}>야간 수신</th>
                    <th style={tableStyles.th}>국가 · 시간대</th>
                    <th style={tableStyles.th} />
                  </tr>
                </thead>
                <tbody>
                  {data.contacts.map((c) => {
                    return (
                    <tr key={c.id}>
                      <td style={tableStyles.td}>{!c.legacy_consent_migrated && c.status === 'subscribed' ? <input type="checkbox" aria-label={`${c.email} 기존 동의 이관 선택`} checked={selected.includes(c.id)} onChange={(e) => setSelected((ids) => e.target.checked ? [...ids, c.id] : ids.filter((id) => id !== c.id))} /> : '—'}</td>
                      <td style={tableStyles.td}>{c.email || <span style={{ color: tokens.colors.textMuted }}>(삭제됨)</span>}</td>
                      <td style={tableStyles.td}>{c.name}</td>
                      <td style={tableStyles.td}>{c.lists.join(', ')}</td>
                      <td style={tableStyles.td}>
                        <StatusPill view={contactStatusView(c.status)} />
                        {c.unsubscribed_at && (
                          <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 2 }}>
                            {formatDateTime(c.unsubscribed_at)}{c.unsubscribe_source ? ` · ${UNSUBSCRIBE_SOURCE_LABELS[c.unsubscribe_source] || c.unsubscribe_source}` : ''}
                          </div>
                        )}
                      </td>
                      <td style={tableStyles.td}>
                        {(c.consents || []).length === 0 && <span>브랜드 동의 없음 — 발송 제외</span>}
                        {(c.consents || []).map((entry) => {
                          const consent = contactConsentLine({ ...c, ...entry });
                          return <div key={entry.id} style={{ marginBottom: 8 }}>
                            <b>{brands.find((b) => b.id === entry.brand_id)?.name || entry.brand_id}</b> · {contactStatusView(entry.status).label}
                            <div>{CONSENT_METHOD_LABELS[entry.consent_method] || entry.consent_method} · {formatDateTime(entry.consent_at)}</div>
                            <div>{entry.consent_source}{entry.consent_text_version ? ` · 문구 ${entry.consent_text_version}` : ''}</div>
                            {entry.consent_due_at && <div data-testid={`marketing-contact-consent-${c.id}-${entry.brand_id}`} style={{ color: consent.expired ? tokens.colors.dangerLight : tokens.colors.textSecondary }}>동의 기한 {consent.due}{consent.expired ? ' 지남 — 발송 제외' : ''}{consent.notice ? ` · ${consent.notice}` : ''}</div>}
                            <div>야간 수신: {entry.night_consent ? '동의' : '미동의'}</div>
                            {c.status === 'subscribed' && entry.status === 'subscribed' && <Button size="sm" variant="ghost" onClick={() => { setUnsubscribeBrandId(entry.brand_id); setUnsubscribing(c); }}>이 브랜드 수신거부</Button>}
                          </div>;
                        })}
                        {!c.legacy_consent_migrated && <div>미이관 증거: {formatDateTime(c.consent_at)} · {c.consent_source}</div>}
                      </td>
                      <td style={tableStyles.td}>브랜드별 동의 참조</td>
                      <td style={tableStyles.td}>{[c.country, c.timezone].filter(Boolean).join(' · ')}</td>
                      <td style={{ ...tableStyles.td, whiteSpace: 'nowrap' }}>
                        {c.status === 'subscribed' && (
                          <Button size="sm" variant="ghost" onClick={() => { setUnsubscribeBrandId(undefined); setUnsubscribing(c); }}>전체 브랜드 수신거부</Button>
                        )}
                        {c.status !== 'erased' && (
                          <Button size="sm" variant="danger" onClick={() => setErasing(c)}>삭제</Button>
                        )}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>이전</Button>
              <Button size="sm" variant="secondary" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>다음</Button>
            </div>
          </>
        )}
      </div>

      {importing && (
        <ImportContactsModal
          accountId={accountId}
          brands={brands}
          defaultBrandId={brandId}
          defaultList={searchParams.get('list') || ''}
          onClose={() => setImporting(false)}
          onImported={reload}
        />
      )}
      <NoteModal
        isOpen={!!unsubscribing}
        title={unsubscribeBrandId ? `${brands.find((b) => b.id === unsubscribeBrandId)?.name || '브랜드'} 수신거부` : '전체 브랜드 수신거부'}
        message={unsubscribing ? `${unsubscribing.email} — 전화 · 답장처럼 다른 경로로 받은 수신거부를 기록합니다. ${unsubscribeBrandId ? '이 브랜드의' : '모든 브랜드의'} 발송 대상에서 빠집니다.` : undefined}
        label="받은 경로 · 메모"
        busy={busy}
        confirmLabel="수신거부 기록"
        onClose={() => setUnsubscribing(null)}
        onSubmit={(note) => { if (unsubscribing) void runUnsubscribe(unsubscribing, note); }}
      />
      <ConfirmDialog
        isOpen={migrating}
        title="기존 동의를 이 브랜드에 이관할까요?"
        message={`선택한 ${selected.length}명의 기존 동의 발신자가 “${brands.find((b) => b.id === brandId)?.name || ''}”임을 확인했습니다. 이 동의는 한 브랜드에만 이관할 수 있으며 다른 브랜드에 복제되지 않습니다. 불명확한 연락처는 선택에서 제외하세요.`}
        confirmLabel={busy ? '이관 중…' : '발신자 확인 · 이관'}
        onConfirm={() => void migrate()}
        onCancel={() => { if (!busy) setMigrating(false); }}
      />
      <ConfirmDialog
        isOpen={!!erasing}
        title="연락처를 삭제할까요?"
        message={erasing ? `${erasing.email || '이 연락처'} 의 주소와 이름을 지우고, 다시 가져와도 억제되도록 해시만 남깁니다. 되돌릴 수 없습니다.` : undefined}
        confirmLabel={busy ? '삭제 중…' : '삭제'}
        cancelLabel="취소"
        danger
        onConfirm={() => { if (erasing && !busy) void runErase(erasing); }}
        onCancel={() => setErasing(null)}
      />
    </div>
  );
}

function ImportContactsModal({ accountId, brands, defaultBrandId, defaultList, onClose, onImported }: {
  brands: MarketingBrand[];
  defaultBrandId: string;
  accountId: string | null;
  defaultList: string;
  onClose(): void;
  onImported(): void;
}) {
  const [brandId, setBrandId] = useState(defaultBrandId);
  const [text, setText] = useState('');
  const [lists, setLists] = useState(defaultList);
  const [method, setMethod] = useState('');
  const [source, setSource] = useState('');
  const [mapping, setMapping] = useState<ContactMapping | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ totals: MarketingContactImportResult; failures: Array<{ line: number; email: string; error: string }> } | null>(null);
  const [submitError, setSubmitError] = useState('');

  const parsed = useMemo(() => (text.trim() ? parseCsv(text) : null), [text]);
  const headerKey = parsed?.headers.join('\u0000') || '';
  useEffect(() => {
    setMapping(parsed && !parsed.error ? autoMapHeaders(parsed.headers) : null);
    // 머리글이 바뀔 때만 다시 맞춘다 — 사람이 고친 매핑을 칸을 고칠 때마다 덮지 않게.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headerKey]);

  const defaultLists = splitLists(lists);
  const plan = useMemo(
    () => (parsed && !parsed.error && mapping ? buildContactImport(parsed, mapping, { lists: defaultLists, consent_method: method, consent_source: source }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [parsed, mapping, lists, method, source],
  );

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      setText(await file.text());
      setResult(null);
    } catch {
      setSubmitError('파일을 읽지 못했습니다');
    }
  };

  const submit = async () => {
    if (!brandId || !plan || !plan.valid.length) return;
    setBusy(true);
    setSubmitError('');
    const totals: MarketingContactImportResult = { created: 0, updated: 0, suppressed: 0, invalid: [] };
    const failures: Array<{ line: number; email: string; error: string }> = [];
    const normalizedLists = defaultLists.map((l) => normalizeListName(l)).filter((l): l is string => !!l);
    try {
      const chunks = chunkContacts(plan.valid);
      let base = 0;
      for (const chunk of chunks) {
        const r = await api.importMarketingContacts(accountId, { brand_id: brandId, lists: normalizedLists, contacts: chunk });
        totals.created += r.created;
        totals.updated += r.updated;
        totals.suppressed += r.suppressed;
        for (const bad of r.invalid || []) {
          failures.push({ line: plan.validLines[base + bad.index] ?? 0, email: bad.email, error: bad.error });
        }
        base += chunk.length;
      }
      totals.invalid = failures.map((f, index) => ({ index, email: f.email, error: f.error }));
      setResult({ totals, failures });
      onImported();
    } catch (err) {
      setSubmitError((err as Error)?.message || '가져오지 못했습니다');
      if (totals.created || totals.updated || totals.suppressed) {
        setResult({ totals, failures });
        onImported();
      }
    } finally {
      setBusy(false);
    }
  };

  const preview = plan?.rows.slice(0, 20) || [];
  return (
    <Modal
      isOpen
      onClose={onClose}
      title="연락처 CSV 가져오기"
      maxWidth={880}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>{result ? '닫기' : '취소'}</Button>
          {!result && (
            <Button variant="primary" disabled={busy || !brandId || !plan || !plan.valid.length} onClick={() => void submit()}>
              {busy ? '가져오는 중…' : `${formatCount(plan?.valid.length || 0)}명 가져오기`}
            </Button>
          )}
        </>
      )}
    >
      <div data-testid="marketing-contacts-import" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 12.5, color: tokens.colors.warningLight, lineHeight: 1.55 }}>
          마케팅 메일은 받는 사람이 동의한 경우에만 보낼 수 있습니다(정보통신망법 §50 · CAN-SPAM). 그래서 연락처마다
          <b> 동의 방법 · 동의 시각 · 동의 출처</b>가 법적 증거로 필요하고, 증거가 없는 행은 가져오지 않습니다.
          이미 수신거부했거나 삭제된 주소는 다시 가져와도 억제되어 메일이 가지 않습니다. 동의 2년이 지나면 발송에서 빠집니다 — 기한 전에 재확인 안내가 나가면 이어지고(연락처 화면의 "동의 재확인 안내"), 지난 뒤에는 새 동의가 있어야 합니다.
        </div>

        {result ? (
          <div data-testid="marketing-contacts-import-result" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: tokens.colors.textPrimary }}>
              새로 {formatCount(result.totals.created)} · 갱신 {formatCount(result.totals.updated)} · 억제 {formatCount(result.totals.suppressed)} · 거부 {formatCount(result.failures.length)}
            </div>
            {result.totals.suppressed > 0 && <Hint>억제된 주소는 예전에 수신거부했거나 삭제된 주소입니다 — 다시 받으려면 그 사람이 새로 동의해야 합니다.</Hint>}
            {result.failures.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: tokens.colors.dangerLight }}>
                {result.failures.slice(0, 50).map((f, i) => <li key={i}>{f.line ? `${f.line}행 ` : ''}{f.email}: {f.error}</li>)}
              </ul>
            )}
            {submitError && <div role="alert" style={{ fontSize: 12, color: tokens.colors.dangerLight }}>{submitError}</div>}
          </div>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
              <Select label="동의를 받은 발신자(브랜드)" value={brandId} options={[{ value: '', label: '— 브랜드 선택 —' }, ...brands.map((b) => ({ value: b.id, label: b.name }))]} onChange={(e) => setBrandId(e.target.value)} />
              <Input label="모든 행에 더할 수신 목록 (쉼표로 여러 개)" value={lists} placeholder="newsletter" onChange={(e) => setLists(e.target.value)} />
              <Select
                label="동의 방법 — 열이 없을 때"
                value={method}
                options={[{ value: '', label: '— CSV 의 열에서 읽기 —' }, ...CONSENT_METHODS.map((m) => ({ value: m, label: `${CONSENT_METHOD_LABELS[m]} (${m})` }))]}
                onChange={(e) => setMethod(e.target.value)}
              />
              <Input label="동의 출처 — 열이 없을 때" value={source} placeholder="https://example.com/signup" onChange={(e) => setSource(e.target.value)} />
            </div>
            <Hint>동의 시각(consent_at)은 행마다 CSV 에 있어야 합니다 — 증거라서 기본값으로 채우지 않습니다.</Hint>
            <div>
              <FieldLabel>CSV 파일</FieldLabel>
              <input type="file" accept=".csv,text/csv,text/plain" aria-label="CSV 파일" onChange={(e) => void readFile(e.target.files?.[0])} />
            </div>
            <Textarea
              label="또는 붙여넣기 — 첫 줄은 머리글"
              aria-label="CSV 내용"
              rows={6}
              monospace
              value={text}
              placeholder={'email,name,consent_method,consent_source,consent_at\nkim@example.com,김민지,signup_form,https://example.com/signup,2026-09-01T10:00:00Z'}
              onChange={(e) => { setText(e.target.value); setResult(null); }}
            />
            {parsed?.error && <div role="alert" style={{ fontSize: 12, color: tokens.colors.dangerLight }}>{parsed.error}</div>}

            {parsed && !parsed.error && mapping && (
              <div>
                <FieldLabel>열 매핑 — 머리글 {parsed.headers.length}개 · 데이터 {formatCount(parsed.rows.length)}행 (구분자 {parsed.delimiter === '\t' ? '탭' : parsed.delimiter})</FieldLabel>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 8 }}>
                  {CONTACT_FIELDS.map((field) => (
                    <Select
                      key={field}
                      label={CONTACT_FIELD_LABELS[field]}
                      value={String(mapping[field])}
                      options={[{ value: '-1', label: '— 없음 —' }, ...parsed.headers.map((h, i) => ({ value: String(i), label: h || `(열 ${i + 1})` }))]}
                      onChange={(e) => setMapping({ ...mapping, [field]: Number(e.target.value) })}
                    />
                  ))}
                </div>
              </div>
            )}

            {plan && (
              <div>
                <div style={{ fontSize: 12.5, color: tokens.colors.textStrong, marginBottom: 6 }} data-testid="marketing-contacts-import-summary">
                  가져올 수 있음 {formatCount(plan.valid.length)} · 오류 {formatCount(plan.invalidCount)}
                </div>
                {plan.defaultListErrors.map((e) => <div key={e} role="alert" style={{ fontSize: 12, color: tokens.colors.dangerLight }}>{e}</div>)}
                <div style={{ overflow: 'auto', maxHeight: 280, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.sm }}>
                  <table style={tableStyles.table}>
                    <thead>
                      <tr>
                        <th style={tableStyles.th}>행</th>
                        <th style={tableStyles.th}>주소</th>
                        <th style={tableStyles.th}>동의</th>
                        <th style={tableStyles.th}>결과</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.map((row) => (
                        <tr key={row.line}>
                          <td style={tableStyles.td}>{row.line}</td>
                          <td style={tableStyles.td}>{row.email || '—'}</td>
                          <td style={tableStyles.td}>
                            {row.contact ? `${CONSENT_METHOD_LABELS[row.contact.consent_method] || row.contact.consent_method} · ${formatDateTime(row.contact.consent_at)}` : '—'}
                          </td>
                          <td style={{ ...tableStyles.td, color: row.errors.length ? tokens.colors.dangerLight : tokens.colors.successLight }}>
                            {row.errors.length ? row.errors.join(' / ') : '가져옴'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {plan.rows.length > preview.length && <Hint>처음 {preview.length}행만 보여 줍니다(전체 {formatCount(plan.rows.length)}행).</Hint>}
              </div>
            )}
            {submitError && <div role="alert" style={{ fontSize: 12, color: tokens.colors.dangerLight }}>{submitError}</div>}
          </>
        )}
      </div>
    </Modal>
  );
}
