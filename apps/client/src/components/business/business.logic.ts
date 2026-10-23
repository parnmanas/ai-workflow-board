import type { BusinessStage, BusinessTask, BusinessTaskStatus } from '../../business.types';

export const STAGES: Array<{ id: BusinessStage; label: string; eyebrow: string; color: string; description: string }> = [
  { id: 'formation', label: '회사 설립', eyebrow: 'FOUNDATION', color: '#c4b5fd', description: '설립 계획부터 서명, EIN까지' },
  { id: 'banking', label: '계좌 · 입출금', eyebrow: 'BANKING', color: '#7dd3fc', description: '사업자 계좌와 자금 흐름' },
  { id: 'payments', label: '결제 · 정산', eyebrow: 'PAYMENTS', color: '#a5b4fc', description: '결제 수취와 정산 확인' },
  { id: 'accounting', label: '회계 · 신고', eyebrow: 'ACCOUNTING', color: '#6ee7b7', description: '장부, 증빙과 결산 일정' },
  { id: 'support', label: '고객지원', eyebrow: 'CUSTOMER CARE', color: '#fda4af', description: '지원 채널부터 제품 피드백까지' },
  { id: 'growth', label: '마케팅 · 성장', eyebrow: 'GROWTH', color: '#fcd34d', description: '캠페인 실행과 성과 개선' },
];
export const TASK_STATUS: Record<BusinessTaskStatus, string> = { todo: '할 일', in_progress: '진행 중', waiting: '외부 응답 대기', done: '완료' };
export const CONNECTION_STATUS = { configured: '조회 전', syncing: '조회 중', connected: '연결됨', error: '확인 필요' };
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
    const format = new Intl.NumberFormat('ko-KR', { style: 'currency', currency });
    return format.format(amount / 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2));
  } catch { return `${amount} minor units ${currency}`; }
}
export function dateTime(value: string | null): string {
  if (!value) return '아직 조회하지 않음';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
