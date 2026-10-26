import { t as translate } from '../../i18n/core';
import type { TrademarkInput, TrademarkMailPayload, TrademarkPhase } from '../../business.types';

export const TRADEMARK_PHASES: Array<{ value: TrademarkPhase; label: string; icon: string }> = [
  { value: 'preparing', get label() { return translate('자료 · 선행 조사'); }, icon: 'workflow' },
  { value: 'counsel', get label() { return translate('변호사 · 견적'); }, icon: 'support' },
  { value: 'contract', get label() { return translate('수임 · 계약'); }, icon: 'lock' },
  { value: 'filing', get label() { return translate('검토 · 서명 · 출원'); }, icon: 'trademark' },
  { value: 'examination', get label() { return translate('심사 · 보정'); }, icon: 'clock' },
  { value: 'registered', get label() { return translate('등록 · 유지'); }, icon: 'check' },
];
export const TRADEMARK_MAIL_KINDS = [
  { value: 'quote', get label() { return translate('변호사 확인 · 견적 문의'); } }, { value: 'engagement', get label() { return translate('수임계약서 · 서명 요청'); } },
  { value: 'filing', get label() { return translate('출원 자료 전달 · 검토 요청'); } }, { value: 'status', get label() { return translate('진행 상황 · 기한 확인'); } },
  { value: 'office_action', get label() { return translate('Office Action 검토 · 대응 견적'); } },
];
export const TRADEMARK_MAIL_STATUS = { get draft() { return translate('검토 대기'); }, get sending() { return translate('발송 확인 중'); }, get sent() { return translate('공급자 접수'); }, get uncertain() { return translate('결과 확인 필요'); } };
export const MAIL_DELIVERY: Record<string, string> = { get accepted() { return translate('접수됨 · 전달 여부 조회 전'); }, get sent() { return translate('발송됨'); }, get delivered() { return translate('전달됨'); }, get delivery_delayed() { return translate('전달 지연'); }, get complained() { return translate('스팸 신고'); }, get bounced() { return translate('반송됨'); }, get opened() { return translate('열람 이벤트'); }, get clicked() { return translate('클릭 이벤트'); }, get failed() { return translate('전달 실패'); }, get scheduled() { return translate('예약됨'); }, get canceled() { return translate('취소됨'); }, get unknown() { return translate('확인 필요'); } };
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
