import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import type { BusinessCompany, BusinessTrademark, TrademarkList, TrademarkMail } from '../../business.types';
import { Button } from '../common';
import { BusinessIcon } from './BusinessIcon';
import { BusinessTrademarkForm } from './BusinessTrademarkForm';
import { BusinessTrademarkMail } from './BusinessTrademarkMail';
import { BusinessTrademarkIntegrations } from './BusinessTrademarkIntegrations';
import { dateTime, localDay, money } from './business.logic';
import { isForeignTrademarkDomicile, TRADEMARK_MAIL_STATUS, TRADEMARK_PHASES } from './trademark.logic';

export function BusinessTrademarks({ company, hasTasks, onChanged }: { company: BusinessCompany; hasTasks: boolean; onChanged(): Promise<void> }) {
  useLocale();
  const [data, setData] = useState<TrademarkList | null>(null);
  const [params, setParams] = useSearchParams();
  const selected = params.get('trademark') || '';
  const setSelected = (id: string) => { const next = new URLSearchParams(params); next.set('trademark', id); next.delete('authorize'); setParams(next, { replace: true }); };
  const [editing, setEditing] = useState<BusinessTrademark | 'new' | null>(null);
  const [mail, setMail] = useState<{ trademark: BusinessTrademark; mail?: TrademarkMail } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const request = ++generation.current;
    try {
      const result = await api.listBusinessTrademarks(company.id);
      if (mounted.current && request === generation.current) { setData(result); setError(''); }
    } catch (e) { if (mounted.current && request === generation.current) setError((e as Error).message); }
  }, [company.id]);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; generation.current++; }; }, [load]);
  const changed = async () => { await load(); await onChanged(); };
  const current = selected ? data?.cases.find(item => item.id === selected) : data?.cases[0];
  const index = TRADEMARK_PHASES.findIndex(item => item.value === current?.phase);
  const openMail = current && data?.mail.find(item => item.trademark_id === current.id && item.status !== 'sent');
  const initialize = async () => {
    setBusy(true);
    try { await api.initializeTrademarkTasks(company.id, company.revision); await onChanged(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <div className="business-trademarks">
    <section className="business-panel" aria-label={translate('상표 출원 관리')}>
      <div className="business-section-heading"><div><span className="business-eyebrow">{translate('US TRADEMARKS')}</span><h3>{translate('브랜드마다 하나의 출원 기록')}</h3></div><Button onClick={() => setEditing('new')}><BusinessIcon name="plus" size={16} />{translate('상표 추가')}</Button></div>
      {!hasTasks && <div className="business-empty-inline"><span>{translate('기존 회사에도 출원·계약·심사·갱신 체크리스트를 추가할 수 있습니다.')}</span><Button variant="secondary" disabled={busy} onClick={() => void initialize()}>{translate('상표 출원 절차 추가')}</Button></div>}
      {error && <div role="alert" className="business-error">{error}<Button variant="ghost" onClick={() => void load()}>{translate('다시 불러오기')}</Button></div>}
      {data && selected && !current && <p role="alert" className="business-error">{translate('링크의 상표 기록을 찾을 수 없습니다. 아래에서 관리할 상표를 선택하세요.')}</p>}
      {!data && !error && <p role="status">{translate('상표 기록을 불러오는 중…')}</p>}
      {data && !data.cases.length && <div className="business-small-empty"><BusinessIcon name="trademark" size={34} /><p>{translate('상표와 권리자를 입력하면 변호사 문의부터 등록 후 관리까지 한곳에서 이어갑니다.')}</p><span className="business-muted">{translate('회사명·제품명·로고를 각각 관리할 수 있습니다.')}</span></div>}
      {!!data?.cases.length && <div className="business-trademark-choices" role="group" aria-label={translate('관리할 상표')}>{data.cases.map(item => <button key={item.id} aria-pressed={current?.id === item.id} onClick={() => setSelected(item.id)}><BusinessIcon name="trademark" size={17} /><span>{item.mark}</span></button>)}</div>}
      {current && <>
        <div className="business-trademark-summary"><div><h3>{current.mark}</h3><p>{current.owner_name} · {current.mark_type === 'word' ? translate('문자 상표') : translate('로고·도형')}</p></div><Button variant="secondary" onClick={() => setEditing(current)}>{translate('정보 · 회신 기록')}</Button></div>
        <ol className="business-trademark-phases" aria-label={translate('기록된 출원 진행 단계')}>{TRADEMARK_PHASES.map((phase, i) => <li key={phase.value} className={i === index ? 'current' : ''} aria-current={i === index ? 'step' : undefined}><BusinessIcon name={phase.icon} size={19} /><span>{phase.label}</span>{i === index && <small>{translate('현재 기록')}</small>}</li>)}</ol>
        <div className="business-trademark-facts">
          <div><small>{translate('실제 본점')}</small><strong>{current.domicile_country || translate('확인 필요')}</strong><span>{isForeignTrademarkDomicile(current.domicile_country) ? translate('미국 변호사 대리 필요') : translate('설립 주소와 별도로 확인')}</span></div>
          <div><small>{translate('상품류 · 기본 관납료 참고')}</small><strong>{current.classes.length ? translate('{0}개 류', { 0: current.classes.length }) : translate('검토 전')}</strong><span>{current.filing_basis === 'madrid' ? translate('Madrid 별도 수수료 확인') : current.classes.length ? translate('{0} + 추가료·법률비용', { 0: money(current.classes.length * 35000) }) : translate('Section 1/44 기본 $350 / 류')}</span></div>
          <div><small>{translate('담당 변호사')}</small><strong>{current.attorney_name || translate('선임 전')}</strong><span>{current.attorney_email || translate('이메일을 기록하세요')}</span></div>
          <div><small>{translate('확인된 다음 기한')}</small><strong className={current.next_due_on && current.next_due_on < localDay() ? 'business-overdue' : ''}>{current.next_due_on || translate('확인 필요')}</strong><span>{current.deadline_source || translate('통지서·대리인 확인 기준')}</span></div>
        </div>
        <p className="business-guide-note">{translate('관납료 참고액은 완전한 견적이 아닙니다. 상품명 자유기재·정보 누락·사용증명·연장 등에 추가료가 생길 수 있습니다. 이 진행 표시는 사용자가 기록한 값이며 공식 심사 결과는 TSDR에서 확인합니다.')}</p>
        <div className="business-guide-actions"><a href="https://tmsearch.uspto.gov/" target="_blank" rel="noreferrer">{translate('선행 상표 검색 ↗')}</a><a href="https://idm-tmng.uspto.gov/" target="_blank" rel="noreferrer">{translate('상품·서비스 ID Manual ↗')}</a>{current.serial_number && <a href={`https://tsdr.uspto.gov/#caseNumber=${encodeURIComponent(current.serial_number)}&caseSearchType=US_APPLICATION&caseType=DEFAULT&searchType=statusSearch`} target="_blank" rel="noreferrer">{translate('출원')} {current.serial_number} {translate('· TSDR ↗')}</a>}{current.engagement_url && <a href={current.engagement_url} target="_blank" rel="noreferrer">{translate('계약·서명 링크 ↗')}</a>}<Link to={`/business/connectors?company=${encodeURIComponent(company.id)}&stage=trademark`}>{translate('출원 서비스·가격 비교 ↗')}</Link></div>
        <div className="business-trademark-correspondence"><div className="business-section-heading"><h3><BusinessIcon name="mail" size={20} />{translate('변호사와의 커뮤니케이션')}</h3><Button disabled={!current.attorney_email} onClick={() => setMail({ trademark: current, mail: openMail || undefined })}>{openMail ? translate('검토·발송 기록 이어가기') : translate('변호사 메일 작성')}</Button></div>
          {!current.attorney_email && <p className="business-muted">{translate('정보 · 회신 기록에서 변호사 이메일을 지정하면 초안을 만들 수 있습니다.')}</p>}
          {current.notes && <details className="business-guide-details"><summary>{translate('저장한 회신 · 진행 메모')}</summary><p style={{ whiteSpace: 'pre-wrap' }}>{current.notes}</p></details>}
          {data?.mail.filter(item => item.trademark_id === current.id).map(item => <button className="business-trademark-mail-row" key={item.id} onClick={() => setMail({ trademark: current, mail: item })}><BusinessIcon name="mail" size={18} /><span><strong>{item.subject}</strong><small>{item.to} · {dateTime(item.created_at)}</small></span><span className="business-pill">{TRADEMARK_MAIL_STATUS[item.status]}</span></button>)}
        </div>
      </>}
    </section>
    {current && <BusinessTrademarkIntegrations key={current.id} company={company} trademark={current} onChanged={onChanged} />}
    {editing && <BusinessTrademarkForm key={editing === 'new' ? 'new' : editing.id} company={company} trademark={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await changed(); }} />}
    {mail && <BusinessTrademarkMail key={`${mail.trademark.id}-${mail.mail?.id || 'new'}`} company={company} trademark={mail.trademark} mail={mail.mail} onClose={() => setMail(null)} onChanged={changed} />}
  </div>;
}
