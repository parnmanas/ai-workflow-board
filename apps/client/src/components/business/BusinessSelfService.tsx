import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import type { BusinessCompany, BusinessConnector, SelfServiceAssessment } from '../../business.types';
import { Button, Modal } from '../common';
import { BusinessIcon } from './BusinessIcon';

function SelfSteps({ assessment }: { assessment: SelfServiceAssessment }) {
  return <>
    <div className="business-residency-guide" aria-label="해외 거주자 직접 처리 조건"><h3>해외에서 운영해도 직접 처리할 수 있나요?</h3><div className="business-residency-grid">{assessment.residency.map(row => <article key={row.subject}><span className="business-pill">{row.status}</span><h4>{row.subject}</h4><p>{row.condition}</p></article>)}</div></div>
    <ol className="business-self-steps">{assessment.steps.map((step, index) => <li key={step.title}><span className="business-self-step-number">{index + 1}</span><div><small>{step.where}</small><h4>{step.title}</h4><p>{step.detail}</p>{step.url && <a href={step.url} target="_blank" rel="noreferrer">공식 절차 열기 ↗</a>}</div></li>)}</ol>
    <div className="business-self-notices">{assessment.notices.map(note => <p key={note}>{note}</p>)}</div>
    <details className="business-service-details"><summary>공식 근거 · 확인 {assessment.checked_at}</summary><div className="business-self-sources">{assessment.sources.map(source => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.label} ↗</a>)}</div></details>
  </>;
}

export function BusinessSelfServiceSummary({ company, provider, plan, onReview }: { company: BusinessCompany; provider: string; plan: string; onReview(): void }) {
  const [assessment, setAssessment] = useState<SelfServiceAssessment | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true; setAssessment(null); setError('');
    api.assessBusinessSelfService(company.id, provider, plan).then(result => { if (active) setAssessment(result); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [company.id, company.revision, provider, plan]);
  return <section className="business-panel business-self-summary" aria-label="직접 처리 진행 안내">
    <div className="business-section-heading"><h3><BusinessIcon name="workflow" size={20} />직접 처리 진행 안내</h3><Button variant="secondary" onClick={onReview}>조건 다시 확인</Button></div>
    {error && <p role="alert">{error}</p>}
    {assessment ? <><span className={`business-pill ${assessment.eligible ? 'connected' : 'error'}`}>{assessment.eligible ? '사용 조건 확인됨' : '조건 재확인 필요'}</span><p className="business-guide-note">{assessment.scope}</p><SelfSteps assessment={assessment} /></> : !error && <p role="status">조건과 절차를 불러오는 중…</p>}
  </section>;
}

export function BusinessSelfServiceForm({ company, connector, plan, onClose, onSaved }: { company: BusinessCompany; connector: BusinessConnector; plan: string; onClose(): void; onSaved(): Promise<void> }) {
  const [answers, setAnswers] = useState<Record<string, boolean>>(company.self_service?.[connector.id]?.answers || {});
  const [assessment, setAssessment] = useState<SelfServiceAssessment | null>(null);
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => {
    let active = true; setLoading(true); setError('');
    api.assessBusinessSelfService(company.id, connector.id, plan, answers).then(result => { if (active) setAssessment(result); }).catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [company.id, company.revision, connector.id, plan, answers]);
  const fresh = assessment && JSON.stringify(assessment.answers) === JSON.stringify(answers);
  const ready = fresh && assessment.eligible && assessment.company_revision === company.revision && !loading;
  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true); setError('');
    try { await api.chooseBusinessService(company.id, connector.stage, { provider: connector.id, plan, revision: company.revision, self_service_answers: answers }); await onSaved(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <Modal isOpen title={`${connector.name} · 사용 조건`} maxWidth={950} onClose={() => { if (!busy) onClose(); }} footer={<><Button variant="ghost" disabled={busy} onClick={onClose}>닫기</Button><Button disabled={!ready || busy} onClick={() => void submit()}>{busy ? '저장 중…' : '조건을 확인하고 직접 처리 선택'}</Button></>}>
    <div className="business-self-intro"><span className="business-provider-logo">DIY</span><div><strong>{connector.offering?.pricing.plans.find(p => p.id === plan)?.name}</strong><p>{connector.offering?.pricing.plans.find(p => p.id === plan)?.price} · {connector.setup_note}</p></div></div>
    <p className="business-guide-note">{company.name} · {company.country} · {company.entity_type} · {company.jurisdiction}</p>
    <p className="business-guide-note">{assessment?.scope}</p><p className="business-guide-note">{connector.offering?.pricing.extra}</p>
    {error && <p className="business-inline-error" role="alert">{error}</p>}
    {assessment && assessment.company_revision !== company.revision && <p className="business-stale" role="alert">확인 중 회사 정보가 변경되었습니다. 창을 닫고 워크플로를 새로고침한 뒤 다시 확인하세요.</p>}
    {assessment && <>
      <div className="business-self-progress" role="status"><strong>{assessment.questions.filter(q => typeof answers[q.key] === 'boolean').length} / {assessment.questions.length} 조건 확인</strong><span>{loading ? '확인 중…' : ready ? '직접 처리 선택 가능' : '미응답·준비 조건을 확인하세요'}</span></div>
      <div className="business-self-questions">{assessment.questions.map(q => <fieldset key={q.key} disabled={busy}><legend>{q.label}</legend><p>{q.detail}</p><small>{q.required_yes ? '선택 전 준비 조건' : '처리 경로·추가 검토 조건'}</small><div className="business-self-answer">{[{ label: '예', value: true }, { label: '아니요', value: false }].map(option => <label key={option.label}><input type="radio" name={q.key} checked={answers[q.key] === option.value} onChange={() => setAnswers({ ...answers, [q.key]: option.value })} />{option.label}</label>)}<label><input type="radio" name={q.key} checked={answers[q.key] === undefined} onChange={() => { const next = { ...answers }; delete next[q.key]; setAnswers(next); }} />아직 확인 전</label></div></fieldset>)}</div>
      {!!assessment.blockers.length && <ul className="business-self-blockers" role="status">{assessment.blockers.map(block => <li key={block}>{block}</li>)}</ul>}
      <h3>선택 후 진행 순서</h3><SelfSteps assessment={assessment} />
    </>}
    {loading && !assessment && <p role="status">조건을 불러오는 중…</p>}
  </Modal>;
}
