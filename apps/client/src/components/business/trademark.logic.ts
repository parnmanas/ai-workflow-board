import type { TrademarkInput, TrademarkMailPayload, TrademarkPhase } from '../../business.types';

export const TRADEMARK_PHASES: Array<{ value: TrademarkPhase; label: string; icon: string }> = [
  { value: 'preparing', label: '자료 · 선행 조사', icon: 'workflow' },
  { value: 'counsel', label: '변호사 · 견적', icon: 'support' },
  { value: 'contract', label: '수임 · 계약', icon: 'lock' },
  { value: 'filing', label: '검토 · 서명 · 출원', icon: 'trademark' },
  { value: 'examination', label: '심사 · 보정', icon: 'clock' },
  { value: 'registered', label: '등록 · 유지', icon: 'check' },
];
export const TRADEMARK_MAIL_KINDS = [
  { value: 'quote', label: '변호사 확인 · 견적 문의' }, { value: 'engagement', label: '수임계약서 · 서명 요청' },
  { value: 'filing', label: '출원 자료 전달 · 검토 요청' }, { value: 'status', label: '진행 상황 · 기한 확인' },
  { value: 'office_action', label: 'Office Action 검토 · 대응 견적' },
];
export const TRADEMARK_MAIL_STATUS = { draft: '검토 대기', sending: '발송 확인 중', sent: '공급자 접수', uncertain: '결과 확인 필요' };
export const MAIL_DELIVERY: Record<string, string> = { accepted: '접수됨 · 전달 여부 조회 전', sent: '발송됨', delivered: '전달됨', delivery_delayed: '전달 지연', complained: '스팸 신고', bounced: '반송됨', opened: '열람 이벤트', clicked: '클릭 이벤트', failed: '전달 실패', scheduled: '예약됨', canceled: '취소됨', unknown: '확인 필요' };
export function isForeignTrademarkDomicile(country: string): boolean {
  return !!country && !['US', 'AS', 'GU', 'MP', 'PR', 'VI', 'UM'].includes(country);
}
export function emptyTrademark(owner: string): TrademarkInput {
  return { mark: '', mark_type: 'word', owner_name: owner, domicile_country: '', goods_services: '', classes: [], filing_basis: 'undecided',
    evidence_notes: '', phase: 'preparing', attorney_name: '', attorney_email: '', attorney_notes: '', engagement_url: '', serial_number: '',
    registration_number: '', next_due_on: '', deadline_source: '', notes: '' };
}
export function trademarkMailto(payload: TrademarkMailPayload): string {
  return `mailto:${encodeURIComponent(payload.to)}?subject=${encodeURIComponent(payload.subject)}&body=${encodeURIComponent(payload.text)}`;
}
