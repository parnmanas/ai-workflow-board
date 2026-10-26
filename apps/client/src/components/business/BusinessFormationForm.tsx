import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import type { BusinessCompany, BusinessConnector, BusinessFormation, FormationApplication, FormationReferences, FormationReview } from '../../business.types';
import { useAuth } from '../../contexts/AuthContext';
import { Button, Input, Modal, Select } from '../common';
import { BusinessIcon } from './BusinessIcon';
import { dateTime, money } from './business.logic';

export const FORMATION_STATUS = { get draft() { return translate('검토 대기'); }, get submitting() { return translate('제출 결과 확인 중'); }, get uncertain() { return translate('결과 재확인 필요'); }, get submitted() { return translate('신청 접수'); } };
export function BusinessFormationForm({ company, connector, formations, onClose, onChanged }: {
  company: BusinessCompany; connector: BusinessConnector; formations: BusinessFormation[]; onClose(): void; onChanged(): Promise<void>;
}) {
  useLocale();
  const { hasPermission } = useAuth();
  const [actionId, setActionId] = useState(formations[0]?.id || '');
  const [review, setReview] = useState<FormationReview | null>(null);
  const [credentials, setCredentials] = useState<Array<{ id: string; name: string; provider: string }>>([]);
  const [credentialId, setCredentialId] = useState('');
  const [key, setKey] = useState('');
  const [environment, setEnvironment] = useState<'sandbox' | 'live'>('sandbox');
  const [references, setReferences] = useState<FormationReferences | null>(null);
  const [input, setInput] = useState<FormationApplication>({ name: company.name.replace(/\s+LLC$/i, ''), state: 'WY', industry: '', description: '', first_name: '', last_name: '', email: '', address: { line1: '', line2: '', city: '', state: '', postalCode: '', country: 'KOR', phone: '' } });
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [signing, setSigning] = useState<{ url: string; expires_at: string } | null>(null);
  useEffect(() => {
    let active = true;
    void api.listBusinessCredentials(company.account_id).then(rows => { if (active) setCredentials(rows.filter(c => c.provider === connector.credential_provider)); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [company.account_id, connector.credential_provider]);
  useEffect(() => {
    let active = true;
    setReview(null); setConsent(false); setSigning(null); setError('');
    if (actionId) void api.reviewBusinessFormation(company.id, actionId).then(value => { if (active) setReview(value); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [actionId, company.id]);
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const readReferences = () => perform(async () => {
    let id = credentialId;
    if (id === '__new__') {
      const created = await api.createCredential({ account_id: company.account_id, scope: 'account', name: `${company.name} · ${connector.name} ${environment}`, provider: connector.credential_provider!, credentials: { api_key: key }, agent_env: false });
      id = created.id; setCredentialId(id); setCredentials(previous => [...previous, created]); setKey('');
    }
    setReferences(await api.businessFormationReferences(company.id, connector.id, { credential_id: id, environment }));
  });
  const prepare = () => perform(async () => {
    const action = await api.prepareBusinessFormation(company.id, connector.id, { credential_id: credentialId, environment, application: input, revision: company.revision });
    setActionId(action.id); await onChanged();
  });
  const submit = () => perform(async () => {
    if (!review || !consent) return;
    const result = await api.submitBusinessFormation(company.id, review.formation);
    setReview(result.status === 'submitted' ? { formation: result, request: null } : await api.reviewBusinessFormation(company.id, result.id));
    setConsent(false); await onChanged();
  });
  const discard = () => perform(async () => {
    if (!review) return;
    await api.discardBusinessFormation(company.id, review.formation); setActionId(''); setReferences(null); await onChanged();
  });
  const action = review?.formation;
  const eligible = company.country === 'US' && company.entity_type === 'LLC';
  const formReady = references && input.name.trim() && input.industry && input.description.trim() && input.first_name.trim() && input.last_name.trim() && input.email.trim() && Object.entries(input.address).filter(([k]) => k !== 'line2').every(([, v]) => v.trim());
  return <Modal isOpen title={translate('{0} 설립 신청', { 0: connector.name })} maxWidth={760} onClose={() => { if (!busy) onClose(); }} footer={<><Button variant="secondary" disabled={busy} onClick={onClose}>{translate('닫기')}</Button>{!actionId && references && <Button loading={busy} disabled={!eligible || !formReady} onClick={() => void prepare()}>{translate('신청서 · 비용 검토')}</Button>}{action && action.status !== 'submitted' && <Button loading={busy} disabled={!consent || !review?.request} onClick={() => void submit()}>{action.status === 'draft' ? (action.environment === 'live' ? translate('실제 설립 신청 제출') : translate('테스트 신청 제출')) : translate('동일 요청으로 결과 재확인')}</Button>}</>}>
    <div className="business-form business-formation-form">
      <ol className="business-formation-steps"><li className={!action ? 'active' : ''}>{translate('1 · 정보 입력')}</li><li className={action?.status === 'draft' ? 'active' : ''}>{translate('2 · 비용 · 신청 검토')}</li><li className={action && action.status !== 'draft' ? 'active' : ''}>{translate('3 · 제출 · 서명 · 조회')}</li></ol>
      {formations.length > 0 && <Select label={translate('설립 신청 기록')} aria-label={translate('설립 신청 기록')} disabled={busy} value={actionId} options={[...formations.map(f => ({ value: f.id, label: `${f.environment === 'live' ? translate('실제') : translate('테스트')} · ${f.summary.name} · ${FORMATION_STATUS[f.status]}` })), { value: '', label: translate('새 신청 작성 (환경별 1건)') }]} onChange={e => setActionId(e.target.value)} />}
      {!actionId && <>
        <div className="business-form-intro"><BusinessIcon name="formation" size={28} /><p><strong>{translate('1인 LLC · Wyoming / Delaware')}</strong><br />{translate('본인이 지분 100%를 보유하며 책임자로 등록되는 신청입니다. 다인 소유·법인 소유·C-Corp는 공급자에서 진행하세요.')}</p></div>
        {!eligible && <p role="alert" className="business-error">{translate('회사 정보가 미국 LLC일 때 내부 신청을 시작할 수 있습니다. 회사 정보를 먼저 수정하세요.')}</p>}
        <div className="business-form-grid"><Select label={translate('신청 환경')} aria-label={translate('신청 환경')} disabled={busy} value={environment} options={[{ value: 'sandbox', label: translate('테스트 · 실제 설립·청구 없음') }, { value: 'live', label: translate('운영 · 실제 설립 신청') }]} onChange={e => { setEnvironment(e.target.value as 'sandbox' | 'live'); setReferences(null); }} />
          <Select label={translate('doola 파트너 키')} aria-label={translate('설립 파트너 키')} disabled={busy} value={credentialId} options={[{ value: '', label: translate('서버 전용 키 선택') }, ...credentials.map(c => ({ value: c.id, label: c.name })), ...(hasPermission('admin.credentials') ? [{ value: '__new__', label: translate('+ 새 파트너 키 등록') }] : [])]} onChange={e => { setCredentialId(e.target.value); setReferences(null); }} /></div>
        {credentialId === '__new__' && <Input label={translate('파트너 API 키')} aria-label={translate('파트너 API 키')} type="password" autoComplete="new-password" value={key} onChange={e => setKey(e.target.value)} />}
        <div className="business-card-actions"><Button variant="secondary" disabled={!eligible || !credentialId || (credentialId === '__new__' && !key.trim())} loading={busy} onClick={() => void readReferences()}>{translate('업종 · 주정부 수수료 불러오기')}</Button><a href="https://www.doola.com/partner-with-us/" target="_blank" rel="noreferrer">{translate('파트너 API 접근 신청 ↗')}</a></div>
        <p className="business-guide-note">{translate('일반 doola 구독만으로 API 키가 발급되지는 않습니다. 파트너 계약과 환경에 맞는 키가 필요합니다.')}</p>
        {references && <>
          <div className="business-form-grid"><Input label={translate('회사 이름 (LLC 접미사 제외)')} aria-label={translate('설립 회사 이름')} maxLength={100} value={input.name} onChange={e => setInput({ ...input, name: e.target.value })} /><Select label={translate('설립 주')} aria-label={translate('신청 설립 주')} value={input.state} options={references.fees.map(f => ({ value: f.state, label: `${f.state === 'WY' ? translate('Wyoming') : translate('Delaware')} · ${money(f.price_in_cents, "USD")}` }))} onChange={e => setInput({ ...input, state: e.target.value })} /></div>
          <label className="business-native-label">{translate('업종 (doola 기준)')}<input className="business-filter" aria-label={translate('설립 업종')} list="business-formation-industries" value={input.industry} onChange={e => setInput({ ...input, industry: e.target.value })} placeholder={translate('검색 후 목록의 업종을 선택하세요')} /><datalist id="business-formation-industries">{references.industries.map(v => <option key={v} value={v} />)}</datalist></label>
          <Input label={translate('영문 사업 설명 (최대 50자)')} aria-label={translate('설립 사업 설명')} maxLength={50} value={input.description} onChange={e => setInput({ ...input, description: e.target.value })} />
          <h3>{translate('유일한 소유자 · 책임자')}</h3>
          <div className="business-form-grid"><Input label={translate('영문 이름')} aria-label={translate('소유자 이름')} value={input.first_name} onChange={e => setInput({ ...input, first_name: e.target.value })} /><Input label={translate('영문 성')} aria-label={translate('소유자 성')} value={input.last_name} onChange={e => setInput({ ...input, last_name: e.target.value })} /></div>
          <Input label={translate('소유자 이메일')} aria-label={translate('소유자 이메일')} type="email" value={input.email} onChange={e => setInput({ ...input, email: e.target.value })} />
          <h3>{translate('소유자 거주지 · 우편 수취 주소')}</h3><p className="business-guide-note">{translate('영문으로 입력하세요. 이 주소를 회사 우편 수취 주소로 사용하고, 사업장 주소에는 doola 등록 대리인 주소를 사용합니다. SSN은 수집하지 않으며 제출 후 SS-4 본인 서명이 필요합니다.')}</p>
          <div className="business-form-grid">{([{ key: 'country', label: translate('거주 국가 (ISO 3자리)'), placeholder: translate('KOR / USA') }, { key: 'phone', label: translate('전화번호 (국가번호 포함)'), placeholder: '+821012345678' }, { key: 'line1', label: translate('영문 도로명 주소'), placeholder: translate('123 Teheran-ro') }, { key: 'line2', label: translate('상세 주소 (선택)'), placeholder: translate('Suite 100') }, { key: 'city', label: translate('도시'), placeholder: translate('Seoul') }, { key: 'state', label: translate('주 · 시도'), placeholder: translate('Seoul') }, { key: 'postalCode', label: translate('우편번호'), placeholder: '06134' }] as const).map(f => <Input key={f.key} label={f.label} aria-label={f.label} value={input.address[f.key]} placeholder={f.placeholder} onChange={e => setInput({ ...input, address: { ...input.address, [f.key]: f.key === 'country' ? e.target.value.toUpperCase() : e.target.value } })} />)}</div>
          <p className="business-security-note"><BusinessIcon name="lock" size={16} />{translate('신청서는 서버에 암호화해 보관하고 제출 결과 확정 후 원문을 지웁니다.')}</p>
        </>}
      </>}
      {actionId && !action && !error && <p role="status">{translate('검토할 신청서를 불러오는 중…')}</p>}
      {action && <>
        <div className="business-formation-review"><div className="business-section-heading"><span className={`business-pill ${action.status === 'submitted' ? 'connected' : ''}`}>{FORMATION_STATUS[action.status]}</span><strong>{action.environment === 'sandbox' ? translate('SANDBOX · 테스트') : translate('LIVE · 실제 설립 신청')}</strong></div><h2>{action.summary.name}</h2><p>{action.summary.state} · {action.summary.entity_type} {translate('· 1인 소유 100%')}</p><p>{action.summary.industry}</p>
          {review?.request && <dl><dt>{translate('사업 설명')}</dt><dd>{review.request.company.description}</dd><dt>{translate('소유자 · 책임자')}</dt><dd>{review.request.customer.firstName} {review.request.customer.lastName} · {review.request.customer.email}</dd><dt>{translate('거주지 · 회사 우편 수취')}</dt><dd>{Object.entries(review.request.company.responsibleParty.address).map(([k, v]) => <span key={k}>{v} </span>)}</dd><dt>{translate('사업장 주소')}</dt><dd>{translate('doola 등록 대리인 주소')}</dd></dl>}
          <div className="business-formation-cost"><span>{translate('조회한 주정부 설립 수수료')}</span><strong>{money(action.state_fee_cents, "USD")}</strong></div><small>{translate('조회')} {dateTime(action.quoted_at)} {translate('· 제출 시 다시 대조')}</small><p>{translate('API 이용·갱신·추가 서비스 비용은 doola 파트너 계약에 따릅니다. 비교표의 일반 구독료와 이 수수료를 합쳐 총액으로 해석하지 마세요.')}</p>
        </div>
        {action.last_error && <p className="business-stale" role="status">{action.last_error}</p>}
        {action.status !== 'submitted' && <><label className="business-formation-consent"><input type="checkbox" aria-label={translate('설립 제출 확인')} checked={consent} disabled={busy} onChange={e => setConsent(e.target.checked)} /><span>{translate('위 신청 정보·1인 지분·주소 사용과 주정부 수수료 및 파트너 계약 비용을 확인했습니다.')} {action.environment === 'live' ? translate('본인 또는 정당한 신청 권한을 가진 사람으로서 doola에 실제 신청 정보 전송과 설립 접수를 요청합니다.') : translate('실제 설립과 청구가 없는 Sandbox로 제출합니다.')}</span></label>{action.status === 'draft' && <Button variant="ghost" disabled={busy} onClick={() => void discard()}>{translate('이 초안 삭제하고 다시 작성')}</Button>}{action.status !== 'draft' && <p className="business-guide-note">{translate('재확인은 원래 신청서와 동일한 중복 방지 번호를 사용합니다. 다른 키·새 회사로 다시 신청하지 마세요. 제출 중에는 잠시 기다린 후 기록을 새로 확인하세요.')}</p>}</>}
        {action.status === 'submitted' && <>
          <div className="business-formation-next"><BusinessIcon name="check" size={24} /><div><strong>{translate('신청이 접수되었습니다. 설립 완료는 심사 후 확정됩니다.')}</strong><p>{translate('외부 회사 ID:')} <code>{action.external_company_id}</code><br />{translate('접수 응답:')} {action.provider_status}</p><p>{translate('연결된 doola 카드에서 상태를 조회하세요. 다른 회사가 이미 연결되어 있다면 위 회사 ID로 조회 연결을 설정하세요. 심사·EIN 발급이 끝나면 해당 업무를 완료로 표시합니다.')}</p></div></div>
          <h3>{translate('다음 단계 · 본인 서명')}</h3><p className="business-guide-note">{translate('SS-4는 EIN 신청을 위한 서류입니다. Form 8821은 doola가 추가로 요청한 경우에만 진행하세요. 서명 링크는 새로 만들면 이전 링크가 만료될 수 있습니다.')}</p>
          <div className="business-card-actions"><Button variant="secondary" disabled={busy} onClick={() => void perform(async () => setSigning(await api.signBusinessFormation(company.id, action.id, 'SS4')))}>{translate('SS-4 서명 링크 받기')}</Button><Button variant="ghost" disabled={busy} onClick={() => void perform(async () => setSigning(await api.signBusinessFormation(company.id, action.id, 'FORM8821')))}>{translate('요청받은 Form 8821')}</Button></div>
          {signing && <div className="business-security-note"><a href={signing.url} target="_blank" rel="noreferrer">{translate('doola 서명 화면 열기 ↗')}</a><span>{translate('만료')} {dateTime(signing.expires_at)}</span></div>}
          <a href={connector.portal_url} target="_blank" rel="noreferrer">{translate('공급자에서 추가 서류 · 심사 확인 ↗')}</a>
        </>}
      </>}
      {error && <p className="business-error" role="alert">{error}</p>}
    </div>
  </Modal>;
}
