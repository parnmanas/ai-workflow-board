import React, { useState } from 'react';
import { api } from '../../api';
import type { BusinessCompany, BusinessTrademark, TrademarkInput } from '../../business.types';
import { Button, Input, Modal, Select, Textarea } from '../common';
import { emptyTrademark, TRADEMARK_PHASES } from './trademark.logic';

export function BusinessTrademarkForm({ company, trademark, onClose, onSaved }: { company: BusinessCompany; trademark?: BusinessTrademark; onClose(): void; onSaved(): Promise<void> }) {
  const [input, setInput] = useState<TrademarkInput>(trademark || emptyTrademark(company.name));
  const [classes, setClasses] = useState(input.classes.join(', '));
  const [tab, setTab] = useState('mark');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof TrademarkInput>(key: K, value: TrademarkInput[K]) => setInput(previous => ({ ...previous, [key]: value }));
  const field = (key: keyof TrademarkInput, label: string, type = 'text', placeholder = '') => <Input label={label} aria-label={label} type={type} placeholder={placeholder} value={String(input[key])} onChange={e => set(key, e.target.value as never)} />;
  const save = async () => {
    setBusy(true); setError('');
    try {
      const values = classes.trim() ? classes.split(',').map(value => Number(value.trim())) : [];
      if (values.some(value => !Number.isInteger(value) || value < 1 || value > 45)) throw new Error('상품류는 1~45의 숫자를 쉼표로 구분해 입력하세요.');
      await api.saveBusinessTrademark(company.id, trademark?.id || null, { ...input, classes: values, domicile_country: input.domicile_country.toUpperCase(), revision: trademark?.revision });
      await onSaved();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <Modal isOpen title={trademark ? '상표 기록 수정' : '새 상표 출원 준비'} onClose={() => { if (!busy) onClose(); }} maxWidth={760}
    footer={<><Button variant="secondary" disabled={busy} onClick={onClose}>닫기</Button><Button loading={busy} disabled={!input.mark.trim() || !input.owner_name.trim()} onClick={() => void save()}>상표 기록 저장</Button></>}>
    <div className="business-form">
      <div className="business-trademark-tabs" role="group" aria-label="상표 입력 영역">{[{ id: 'mark', label: '1. 상표 · 권리자' }, { id: 'counsel', label: '2. 변호사 · 계약' }, { id: 'progress', label: '3. 진행 · 회신' }].map(item => <button type="button" key={item.id} aria-pressed={tab === item.id} onClick={() => setTab(item.id)}>{item.label}</button>)}</div>
      {tab === 'mark' && <>
        <p className="business-guide-note">미국 출원 준비 자료입니다. 저장하면 관리 기록이 만들어지며, 공식 출원은 변호사 또는 Trademark Center에서 진행합니다.</p>
        <div className="business-form-grid">{field('mark', '상표명 · 로고 식별명')}
          <Select label="상표 형태" aria-label="상표 형태" value={input.mark_type} options={[{ value: 'word', label: '문자 상표' }, { value: 'design', label: '로고 · 도형 상표' }]} onChange={e => set('mark_type', e.target.value as TrademarkInput['mark_type'])} />
          {field('owner_name', '실제 권리자 법적 이름')}{field('domicile_country', '실제 본점 국가 코드', 'text', 'US, KR 등 · 미정이면 빈칸')}
        </div>
        <p className="business-guide-note">미국 LLC의 설립 주·등록 대리인 주소와 실제 본점은 다를 수 있습니다. 미국·미국 영토 밖에 본점이 있으면 미국 변호사의 대리가 필요합니다.</p>
        <Textarea label="상품 · 서비스" aria-label="상품 · 서비스" rows={3} value={input.goods_services} onChange={e => set('goods_services', e.target.value)} />
        <div className="business-form-grid"><Input label="검토할 상품류" aria-label="검토할 상품류" value={classes} placeholder="예: 9, 42 · 변호사와 확정" onChange={e => setClasses(e.target.value)} />
          <Select label="출원 근거" aria-label="출원 근거" value={input.filing_basis} options={[{ value: 'undecided', label: '변호사와 검토 예정' }, { value: 'use', label: '미국 내 사용 · 1(a)' }, { value: 'intent', label: '사용 의사 · 1(b)' }, { value: 'foreign', label: '외국 출원·등록 · 44' }, { value: 'madrid', label: 'Madrid 국제출원 · 별도 경로' }]} onChange={e => set('filing_basis', e.target.value as TrademarkInput['filing_basis'])} />
        </div>
        <Textarea label="실제 사용 · 증빙 자료 메모" aria-label="실제 사용 · 증빙 자료 메모" rows={3} value={input.evidence_notes} onChange={e => set('evidence_notes', e.target.value)} placeholder="실제 사용한 상품·화면, URL와 확인일 등. 로고·증빙 원본은 변호사의 보안 업로드 경로로 전달하세요." />
      </>}
      {tab === 'counsel' && <>
        <div className="business-form-grid">{field('attorney_name', '변호사 · 로펌 이름')}{field('attorney_email', '변호사 이메일', 'email')}</div>
        <Textarea label="면허 확인 · 견적 · 수임 범위" aria-label="면허 확인 · 견적 · 수임 범위" rows={5} value={input.attorney_notes} onChange={e => set('attorney_notes', e.target.value)} placeholder="미국 주 변호사 면허 확인, 이해충돌 확인, 관납료와 추가 비용, 담당 기한 등을 기록하세요." />
        {field('engagement_url', '계약 · 서명 서비스 링크', 'url', 'https://')}
        <p className="business-guide-note">합의한 계약서를 본인이 서명하는 링크를 기록합니다. 링크 저장이나 계약서 요청 메일은 계약 체결을 뜻하지 않습니다.</p>
      </>}
      {tab === 'progress' && <>
        <Select label="기록할 진행 단계" aria-label="기록할 진행 단계" value={input.phase} options={TRADEMARK_PHASES} onChange={e => set('phase', e.target.value as TrademarkInput['phase'])} />
        <div className="business-form-grid">{field('serial_number', 'USPTO 출원번호', 'text', '8자리 숫자')}{field('registration_number', '등록증 등록번호')}{field('next_due_on', '확인된 다음 기한', 'date')}{field('deadline_source', '기한 출처 · 확인 내용', 'text', '공식 통지서 또는 변호사 확인')}</div>
        <Textarea label="변호사 회신 · 진행 메모" aria-label="변호사 회신 · 진행 메모" rows={6} value={input.notes} onChange={e => set('notes', e.target.value)} placeholder="회신 일시, 합의 내용, 다음 행동과 담당자를 기록하세요." />
        <p className="business-guide-note">진행 단계는 사용자가 확인해 기록한 값입니다. 심사 기한은 자동 계산하지 않으며, 사건별 통지서와 대리인 확인을 사용합니다.</p>
      </>}
      {error && <div role="alert" className="business-error">{error}</div>}
    </div>
  </Modal>;
}
