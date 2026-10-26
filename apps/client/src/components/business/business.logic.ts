import { getLocaleTag } from '../../i18n/core';
import { t as translate } from '../../i18n/core';
import type { BusinessStage, BusinessTask, BusinessTaskStatus } from '../../business.types';

export const STAGES: Array<{ id: BusinessStage; label: string; eyebrow: string; color: string; description: string }> = [
  { id: 'formation', get label() { return translate('회사 설립'); }, get eyebrow() { return translate('FOUNDATION'); }, color: '#c4b5fd', get description() { return translate('설립 계획부터 서명, EIN까지'); } },
  { id: 'trademark', get label() { return translate('상표 · 브랜드 보호'); }, get eyebrow() { return translate('BRAND PROTECTION'); }, color: '#f9a8d4', get description() { return translate('선행 조사, 변호사 선임과 계약, 출원과 등록 후 관리'); } },
  { id: 'banking', get label() { return translate('계좌 · 입출금'); }, get eyebrow() { return translate('BANKING'); }, color: '#7dd3fc', get description() { return translate('사업자 계좌와 자금 흐름'); } },
  { id: 'payments', get label() { return translate('결제 · 정산'); }, get eyebrow() { return translate('PAYMENTS'); }, color: '#a5b4fc', get description() { return translate('결제 수취와 정산 확인'); } },
  { id: 'accounting', get label() { return translate('회계 · 신고'); }, get eyebrow() { return translate('ACCOUNTING'); }, color: '#6ee7b7', get description() { return translate('장부, 증빙과 결산 일정'); } },
  { id: 'support', get label() { return translate('고객지원'); }, get eyebrow() { return translate('CUSTOMER CARE'); }, color: '#fda4af', get description() { return translate('지원 채널부터 제품 피드백까지'); } },
  { id: 'growth', get label() { return translate('마케팅 · 성장'); }, get eyebrow() { return translate('GROWTH'); }, color: '#fcd34d', get description() { return translate('캠페인 실행과 성과 개선'); } },
];
export const TASK_STATUS: Record<BusinessTaskStatus, string> = { get todo() { return translate('할 일'); }, get in_progress() { return translate('진행 중'); }, get waiting() { return translate('외부 응답 대기'); }, get done() { return translate('완료'); } };
export const CONNECTION_STATUS = { get configured() { return translate('조회 전'); }, get syncing() { return translate('조회 중'); }, get connected() { return translate('연결됨'); }, get error() { return translate('확인 필요'); } };
export function localDay(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
export function overdue(task: BusinessTask, today = localDay()): boolean { return task.status !== 'done' && !!task.due_on && task.due_on < today; }
export function nextTasks(tasks: BusinessTask[]): BusinessTask[] {
  return tasks.filter(t => t.status !== 'done' && !t.blocked_by.length).sort((a, b) =>
    Number(overdue(b)) - Number(overdue(a)) || (a.due_on || '9999').localeCompare(b.due_on || '9999') || a.position - b.position);
}
export function money(amount: number, currency = 'USD'): string {
  try {
    const format = new Intl.NumberFormat(getLocaleTag(), { style: 'currency', currency });
    return format.format(amount / 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2));
  } catch { return translate('{0} minor units {1}', { 0: amount, 1: currency }); }
}
export function dateTime(value: string | null): string {
  if (!value) return translate('아직 조회하지 않음');
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(getLocaleTag(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
