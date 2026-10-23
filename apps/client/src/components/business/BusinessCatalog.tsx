import React, { useState } from 'react';
import type { BusinessCompany, BusinessConnection, BusinessConnector } from '../../business.types';
import { Button, Modal } from '../common';
import { BusinessIcon } from './BusinessIcon';
import { CONNECTION_STATUS, dateTime, STAGES } from './business.logic';

const API_LABEL = { public: '공개 API', partner: '파트너 API · 승인 필요', unverified: '공개 API 미확인' };
export const executionLabel = (c: BusinessConnector) => c.formation ? '내부 신청 + 상태 조회' : c.mode === 'api' ? '외부 처리 + 내부 조회' : '외부 처리 + 업무 기록';

export function BusinessConnectorCard({ connector: c, company, connection, busy, onSetup, onSync, onChoose, onFormation, comparing, onCompare, onOpenData }: {
  connector: BusinessConnector; company: BusinessCompany; connection?: BusinessConnection; busy: boolean;
  onSetup(): void; onSync(): void; onChoose(plan: string): void; onFormation(): void; comparing?: boolean; onCompare?: () => void; onOpenData?: () => void;
}) {
  const selected = company.service_choices?.[c.stage];
  const [planId, setPlanId] = useState(selected?.provider === c.id ? selected.plan : c.offering?.pricing.plans[0]?.id || '');
  const plan = c.offering?.pricing.plans.find(p => p.id === planId) || c.offering?.pricing.plans[0];
  const chosen = selected?.provider === c.id;
  return <article className={`business-connector-card ${chosen ? 'is-selected' : ''}`} aria-label={`${c.name} 서비스`}>
    <div className="business-connector-top"><span className="business-provider-logo" style={{ color: c.color, background: `${c.color}12` }}>{c.monogram}</span>
      <span className={`business-pill ${chosen ? 'connected' : ''}`}>{chosen ? '우리 회사 선택' : STAGES.find(s => s.id === c.stage)?.label}</span>
      {onCompare && <label className="business-compare-check"><input type="checkbox" aria-label={`${c.name} 비교`} checked={!!comparing} onChange={onCompare} />비교</label>}
    </div>
    <h3>{c.name}</h3><p>{c.offering?.best_for || c.summary}</p>
    {plan && <div className="business-price"><strong>{plan.price}</strong><select aria-label={`${c.name} 가격 플랜`} value={plan.id} onChange={e => setPlanId(e.target.value)}>{c.offering!.pricing.plans.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select><small>{plan.detail}</small></div>}
    <div className={`business-execution-mode ${c.formation ? 'native' : ''}`}><BusinessIcon name={c.formation ? 'workflow' : c.mode === 'api' ? 'connector' : 'external'} size={16} /><span>{executionLabel(c)}</span></div>
    <div className="business-capabilities">{c.capabilities.map(cap => <span key={cap}>{cap}</span>)}</div>
    <details className="business-service-details"><summary>포함 기능 · 비용 · 연결 조건</summary>
      {c.offering && <><h4>공급자 서비스 기능 · 플랜별 상이</h4><ul>{c.offering.features.map(f => <li key={f}>{f}</li>)}</ul><p>{c.offering.pricing.extra}</p><a href={c.offering.pricing.url} target="_blank" rel="noreferrer">공식 가격표 ↗</a><small>확인 {c.offering.pricing.checked_at} · USD · 실제 계약·결제 가격 확인</small><h4>{API_LABEL[c.offering.api_access]}</h4><p>{c.offering.api_note}</p><h4>서비스에서 진행할 일</h4><ul>{c.offering.external_steps.map(f => <li key={f}>{f}</li>)}</ul></>}
      <h4>AWB에서 할 수 있는 일</h4><p>{c.mode === 'handoff' ? '서비스 바로가기와 업무 기록을 제공합니다. API 데이터 동기화 어댑터는 아직 제공하지 않습니다.' : c.setup_note}</p><a href={c.docs_url} target="_blank" rel="noreferrer">공식 연결 안내 ↗</a>
    </details>
    <div className="business-connector-bottom">
      {connection && <small className="business-connection-line"><span className={`business-pill ${connection.status}`}>{CONNECTION_STATUS[connection.status]}</span>{connection.environment === 'sandbox' ? '테스트 · ' : ''}{dateTime(connection.synced_at)}</small>}
      {connection?.last_error && <p className="business-inline-error" role="status">{connection.last_error}</p>}
      <div className="business-card-actions">
        {plan && <Button variant={chosen ? 'secondary' : 'primary'} disabled={busy || (chosen && selected?.plan === plan.id)} onClick={() => onChoose(plan.id)}>{chosen && selected?.plan === plan.id ? '선택됨' : '이 서비스 선택'}</Button>}
        {c.formation && <Button variant="secondary" onClick={onFormation}>설립 신청 · 기록 <BusinessIcon name="arrow" size={14} /></Button>}
        {c.mode === 'api' && <Button variant="ghost" onClick={onSetup}>{connection ? '연결 설정' : '조회 연결'}</Button>}
        {connection && <Button variant="ghost" disabled={busy} onClick={onSync}><BusinessIcon name="refresh" size={14} />조회</Button>}
        <a className="business-external" href={c.portal_url} target="_blank" rel="noreferrer" aria-label={`${c.name} 서비스 열기`}>서비스 ↗</a>
      </div>
      {connection?.snapshot && onOpenData && <Button variant="ghost" onClick={onOpenData}>조회 데이터 보기 <BusinessIcon name="arrow" size={14} /></Button>}
    </div>
  </article>;
}

export function BusinessCatalog({ connectors, company, renderCard, initialStage = 'all' }: {
  connectors: BusinessConnector[]; company: BusinessCompany; initialStage?: string;
  renderCard(c: BusinessConnector, comparing?: boolean, onCompare?: () => void): React.ReactNode;
}) {
  const [stage, setStage] = useState(initialStage);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState('all');
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [comparison, setComparison] = useState(false);
  const [notice, setNotice] = useState('');
  const compared = connectors.filter(c => compareIds.includes(c.id));
  const visible = connectors.filter(c => (stage === 'all' || c.stage === stage) && (mode === 'all' || (mode === 'native' ? !!c.formation : c.mode === mode)) && `${c.name} ${c.summary} ${c.offering?.features.join(' ')}`.toLowerCase().includes(query.toLowerCase().trim()));
  const toggle = (c: BusinessConnector) => {
    setNotice('');
    if (compareIds.includes(c.id)) { setCompareIds(compareIds.filter(id => id !== c.id)); return; }
    if (compared.length && compared[0].stage !== c.stage) { setNotice('같은 업무 영역의 서비스를 비교하세요. 비교 목록을 비우면 다른 영역을 선택할 수 있습니다.'); return; }
    if (compareIds.length >= 3) { setNotice('한 번에 최대 3개 서비스를 비교할 수 있습니다.'); return; }
    setCompareIds([...compareIds, c.id]);
  };
  return <>
    <div className="business-selected-services" aria-label="회사별 선택 서비스">{STAGES.filter(s => s.id !== 'growth').map(s => {
      const choice = company.service_choices?.[s.id]; const provider = connectors.find(c => c.id === choice?.provider);
      return <button key={s.id} onClick={() => setStage(s.id)}><BusinessIcon name={s.id} size={19} /><small>{s.label}</small><strong>{provider?.name || '서비스 선택'}</strong><span>{provider?.offering?.pricing.plans.find(p => p.id === choice?.plan)?.name || '가격·기능 비교'}</span></button>;
    })}</div>
    <div className="business-chip-filters" role="group" aria-label="커넥터 영역 필터"><button aria-pressed={stage === 'all'} onClick={() => setStage('all')}>전체 {connectors.length}</button>{STAGES.filter(s => s.id !== 'growth').map(s => <button key={s.id} aria-pressed={stage === s.id} onClick={() => setStage(s.id)}><BusinessIcon name={s.id} size={15} />{s.label} {connectors.filter(c => c.stage === s.id).length}</button>)}</div>
    <div className="business-catalog-toolbar"><input className="business-filter" type="search" aria-label="서비스 검색" placeholder="서비스 · 기능 검색" value={query} onChange={e => setQuery(e.target.value)} /><select className="business-filter" aria-label="연동 방식" value={mode} onChange={e => setMode(e.target.value)}><option value="all">모든 진행 방식</option><option value="native">내부 신청 가능</option><option value="api">내부 조회 가능</option><option value="handoff">외부 서비스</option></select><span>{visible.length}개 서비스</span></div>
    <p className="business-catalog-note">선택은 회사의 사용 계획을 저장합니다. 가입·구매·기존 연결 변경은 실행하지 않습니다. 정가·과금 단위와 별도 비용을 함께 비교하세요.</p>
    {notice && <p className="business-stale" role="status">{notice}</p>}
    <div className="business-connectors-grid">{visible.map(c => renderCard(c, compareIds.includes(c.id), () => toggle(c)))}</div>
    {!visible.length && <p className="business-small-empty">검색 조건에 맞는 서비스가 없습니다.</p>}
    {compared.length > 0 && <div className="business-compare-tray" role="region" aria-label="서비스 비교 목록"><div><strong>{compared.map(c => c.name).join(' · ')}</strong><small>같은 영역 최대 3개 · {compared.length}/3 선택</small></div><Button disabled={compared.length < 2} onClick={() => setComparison(true)}>가격 · 기능 비교</Button><Button variant="ghost" onClick={() => { setCompareIds([]); setNotice(''); }}>비우기</Button></div>}
    {comparison && <ServiceComparison connectors={compared} onClose={() => setComparison(false)} />}
  </>;
}

function ServiceComparison({ connectors, onClose }: { connectors: BusinessConnector[]; onClose(): void }) {
  const rows: Array<{ title: string; content(c: BusinessConnector): React.ReactNode }> = [
    { title: '추천 용도', content: c => c.offering?.best_for },
    { title: '가격 · 플랜', content: c => c.offering?.pricing.plans.map(p => <div className="business-compare-plan" key={p.id}><strong>{p.price}</strong><span>{p.name}</span><small>{p.detail}</small></div>) },
    { title: '별도 비용 · 조건', content: c => c.offering?.pricing.extra },
    { title: '공급자 기능', content: c => <ul>{c.offering?.features.map(f => <li key={f}>{f}</li>)}</ul> },
    { title: 'AWB 진행 방식', content: c => <><strong>{executionLabel(c)}</strong><p>{c.capabilities.join(' · ')}</p>{c.formation && <small>현재 내부 신청: 1인 LLC · WY/DE</small>}</> },
    { title: 'API 이용 조건', content: c => <><span className="business-pill">{c.offering && API_LABEL[c.offering.api_access]}</span><p>{c.offering?.api_note}</p></> },
    { title: '외부에서 할 일', content: c => <ul>{c.offering?.external_steps.map(f => <li key={f}>{f}</li>)}</ul> },
    { title: '가격 근거', content: c => <><a href={c.offering?.pricing.url} target="_blank" rel="noreferrer">공식 가격표 ↗</a><small>확인 {c.offering?.pricing.checked_at}</small></> },
  ];
  return <Modal isOpen title="서비스 가격 · 기능 비교" onClose={onClose} maxWidth={1100} footer={<Button onClick={onClose}>비교를 마치고 선택하기</Button>}>
    <div className="business-comparison-actions"><span>좁은 화면에서는 표를 좌우로 움직여 비교하세요.</span><Button variant="ghost" onClick={onClose}>비교 닫기</Button></div>
    <p className="business-catalog-note">USD 기준 공개 가격입니다. 월·연간·1회·좌석·거래당 비용은 과금 단위가 다릅니다. 전체 기능의 포함 범위와 최종 요금은 각 플랜·계약에서 확인하세요.</p>
    <div className="business-comparison-scroll" tabIndex={0} role="region" aria-label="서비스 비교표"><table className="business-comparison-table"><thead><tr><th>비교 항목</th>{connectors.map(c => <th key={c.id}><span className="business-provider-mark" style={{ color: c.color }}>{c.monogram}</span>{c.name}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.title}><th>{row.title}</th>{connectors.map(c => <td key={c.id}>{row.content(c)}</td>)}</tr>)}</tbody></table></div>
  </Modal>;
}
