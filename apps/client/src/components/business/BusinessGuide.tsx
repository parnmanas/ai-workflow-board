import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React from 'react';
import { Link } from 'react-router-dom';
import type { BusinessConnector, BusinessStage } from '../../business.types';
import { Button } from '../common';
import { BusinessIcon } from './BusinessIcon';
import { BUSINESS_GUIDES } from './business.guides';

export function BusinessHowItWorks({ onStart }: { onStart(): void }) {
  useLocale();
  return <section className="business-how" aria-label={translate('Business 이용 순서')}>
    <div className="business-section-heading"><h2><BusinessIcon name="workflow" size={19} />{translate('실제 진행은 이렇게 이어집니다')}</h2><Button variant="ghost" onClick={onStart}>{translate('업무 맡기기')} <BusinessIcon name="arrow" size={14} /></Button></div>
    <ol className="business-how-steps">
      <li><span>1</span><div><strong>{translate('목표를 맡기세요')}</strong><p>{translate('회사 설립 목표와 담당 에이전트를 선택합니다.')}</p></div></li>
      <li><span>2</span><div><strong>{translate('에이전트가 진행합니다')}</strong><p>{translate('조사·비교·신청 준비와 결과 정리를 같은 업무에서 이어갑니다.')}</p></div></li>
      <li><span>3</span><div><strong>{translate('필요한 결정에 답하세요')}</strong><p>{translate('선택·비용 승인·본인 서명이 필요할 때만 확인하고, 수정은 이어서 요청합니다.')}</p></div></li>
    </ol>
    <p className="business-guide-note">{translate('진행 과정, 준비한 문서, 결정과 수정 요청은 하나의 업무에 남습니다. 실제 설립 신청은 준비된 내용을 검토하고 승인한 뒤 제출합니다.')}</p>
  </section>;
}

export function BusinessStageGuide({ stage, connectors, connectorsPath, canMarketing }: { stage: BusinessStage; connectors: BusinessConnector[]; connectorsPath: string; canMarketing: boolean }) {
  useLocale();
  const guide = BUSINESS_GUIDES[stage];
  const providers = connectors.filter(c => c.stage === stage);
  const steps = [
    { label: translate('준비할 것'), icon: 'workflow', items: guide.prepare },
    { label: stage === 'growth' ? translate('AWB 마케팅에서 실행') : stage === 'formation' ? translate('선택한 방식으로 신청') : stage === 'accounting' ? translate('직접 기록 또는 서비스 이용') : translate('외부 서비스에서 진행'), icon: stage, items: guide.execute },
    { label: translate('AWB에서 확인·관리'), icon: 'check', items: guide.track },
  ];
  return <section className="business-stage-guide" aria-label={translate('실제 진행 방법')}>
    <div className="business-section-heading"><h3><BusinessIcon name="workflow" size={18} />{translate('실제 진행 방법')}</h3><span className="business-muted">{translate('준비 → 처리 → 결과 확인')}</span></div>
    <ol className="business-guide-steps">{steps.map((step, i) => <li key={step.label}>
      <div className="business-guide-step-heading"><span className="business-guide-step-number">{i + 1}</span><BusinessIcon name={step.icon} size={18} /><h4>{step.label}</h4></div>
      <ul>{step.items.map(item => <li key={item}>{item}</li>)}</ul>
      {i === 1 && <div className="business-guide-actions">{providers.filter(c => c.mode !== 'manual').map(c => <a key={c.id} href={c.portal_url} target="_blank" rel="noreferrer">{c.name} {translate('열기')} <BusinessIcon name="external" size={12} /></a>)}{stage === 'growth' && (canMarketing ? <Link to="/marketing">{translate('마케팅 열기')} <BusinessIcon name="arrow" size={12} /></Link> : <span className="business-muted">{translate('캠페인 실행에는 마케팅 권한이 필요합니다.')}</span>)}</div>}
      {i === 2 && stage !== 'growth' && <div className="business-guide-actions"><Link to={connectorsPath}>{stage === 'trademark' ? translate('출원 서비스 비교') : translate('직접 처리 · 서비스 비교')} <BusinessIcon name="arrow" size={12} /></Link></div>}
    </li>)}</ol>
    <div className="business-guide-completion"><BusinessIcon name="check" size={19} /><div><strong>{translate('언제 완료로 표시하나요?')}</strong><p>{guide.completed}</p></div></div>
    <details className="business-guide-details"><summary>{translate('연결 전에 알아둘 점')}{guide.sources.length ? translate(' · 공식 진행 안내') : ''}</summary><p>{guide.connectionNote}</p>
      {guide.sources.length > 0 && <div className="business-guide-actions">{guide.sources.map(source => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.label} <BusinessIcon name="external" size={12} /></a>)}</div>}
    </details>
  </section>;
}
