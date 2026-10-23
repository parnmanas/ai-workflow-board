import React from 'react';
import { Link } from 'react-router-dom';
import type { BusinessConnector, BusinessStage } from '../../business.types';
import { Button } from '../common';
import { BusinessIcon } from './BusinessIcon';
import { BUSINESS_GUIDES } from './business.guides';

export function BusinessHowItWorks({ onStart }: { onStart(): void }) {
  return <section className="business-how" aria-label="Business 이용 순서">
    <div className="business-section-heading"><h2><BusinessIcon name="workflow" size={19} />실제 진행은 이렇게 이어집니다</h2><Button variant="ghost" onClick={onStart}>단계별 진행 방법 <BusinessIcon name="arrow" size={14} /></Button></div>
    <ol className="business-how-steps">
      <li><span>1</span><div><strong>AWB에서 준비</strong><p>회사와 업무를 등록하고 담당자·기한을 정합니다.</p></div></li>
      <li><span>2</span><div><strong>방식을 선택해 진행</strong><p>지원되는 신청은 AWB에서, 서명·심사·송금·신고는 공급자에서 진행합니다.</p></div></li>
      <li><span>3</span><div><strong>AWB에서 확인</strong><p>결과를 조회하거나 기록하고 다음 업무로 이어갑니다.</p></div></li>
    </ol>
    <p className="business-guide-note">회사 등록은 AWB의 관리용 워크플로를 만듭니다. 서비스를 비교한 뒤 doola 내부 신청 또는 공급자 외부 신청으로 이어가세요. 마케팅은 AWB의 캠페인·승인·실행 기능을 사용합니다.</p>
  </section>;
}

export function BusinessStageGuide({ stage, connectors, connectorsPath, canMarketing }: { stage: BusinessStage; connectors: BusinessConnector[]; connectorsPath: string; canMarketing: boolean }) {
  const guide = BUSINESS_GUIDES[stage];
  const providers = connectors.filter(c => c.stage === stage);
  const steps = [
    { label: '준비할 것', icon: 'workflow', items: guide.prepare },
    { label: stage === 'growth' ? 'AWB 마케팅에서 실행' : stage === 'formation' ? '선택한 방식으로 신청' : '외부 서비스에서 진행', icon: stage, items: guide.execute },
    { label: 'AWB에서 확인·관리', icon: 'check', items: guide.track },
  ];
  return <section className="business-stage-guide" aria-label="실제 진행 방법">
    <div className="business-section-heading"><h3><BusinessIcon name="workflow" size={18} />실제 진행 방법</h3><span className="business-muted">준비 → 처리 → 결과 확인</span></div>
    <ol className="business-guide-steps">{steps.map((step, i) => <li key={step.label}>
      <div className="business-guide-step-heading"><span className="business-guide-step-number">{i + 1}</span><BusinessIcon name={step.icon} size={18} /><h4>{step.label}</h4></div>
      <ul>{step.items.map(item => <li key={item}>{item}</li>)}</ul>
      {i === 1 && <div className="business-guide-actions">{providers.map(c => <a key={c.id} href={c.portal_url} target="_blank" rel="noreferrer">{c.name} 열기 <BusinessIcon name="external" size={12} /></a>)}{stage === 'growth' && (canMarketing ? <Link to="/marketing">마케팅 열기 <BusinessIcon name="arrow" size={12} /></Link> : <span className="business-muted">캠페인 실행에는 마케팅 권한이 필요합니다.</span>)}</div>}
      {i === 2 && stage !== 'growth' && <div className="business-guide-actions"><Link to={connectorsPath}>{stage === 'trademark' ? '출원 서비스 비교' : '조회 커넥터 설정'} <BusinessIcon name="arrow" size={12} /></Link></div>}
    </li>)}</ol>
    <div className="business-guide-completion"><BusinessIcon name="check" size={19} /><div><strong>언제 완료로 표시하나요?</strong><p>{guide.completed}</p></div></div>
    <details className="business-guide-details"><summary>연결 전에 알아둘 점{guide.sources.length ? ' · 공식 진행 안내' : ''}</summary><p>{guide.connectionNote}</p>
      {guide.sources.length > 0 && <div className="business-guide-actions">{guide.sources.map(source => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.label} <BusinessIcon name="external" size={12} /></a>)}</div>}
    </details>
  </section>;
}
