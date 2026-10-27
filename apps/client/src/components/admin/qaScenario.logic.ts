import type { QaResultDelivery, QaScenarioListItem } from '../../types';

export function filterQaScenarios(rows: QaScenarioListItem[], projectId: string, query: string, enabled: string) {
  const text = query.trim().toLowerCase();
  return rows.filter(s => (!projectId || (projectId === 'unassigned' ? !s.project_id : s.project_id === projectId))
    && (enabled === 'all' || s.enabled === (enabled === 'enabled'))
    && (!text || [s.name, s.description, ...(s.tags || [])].join(' ').toLowerCase().includes(text)));
}

export function qaBatchIds(rows: QaScenarioListItem[], selected?: Set<string>): string[] {
  return rows.filter(s => s.enabled && (!selected || selected.has(s.id))).map(s => s.id);
}

export interface QaDeliveryForm {
  share: boolean;
  email: boolean;
  when: QaResultDelivery['when'];
  channelIds: string[];
  connectionId: string;
  from: string;
  recipients: string;
}

export function qaDeliveryForm(value?: QaResultDelivery | null): QaDeliveryForm {
  return { share: !!value?.channel_ids?.length, email: !!value?.email, when: value?.when || 'failure',
    channelIds: value?.channel_ids || [], connectionId: value?.email?.connection_id || '',
    from: value?.email?.from || '', recipients: value?.email?.to.join(', ') || '' };
}

export function qaDeliveryPayload(form: QaDeliveryForm): QaResultDelivery | null {
  if (!form.share && !form.email) return null;
  if (form.share && !form.channelIds.length) throw new Error('결과를 공유할 채널을 선택하세요.');
  const to = [...new Set(form.recipients.split(/[,;\n]/).map(s => s.trim()).filter(Boolean))];
  if (form.email && (!form.connectionId || !form.from || !to.length)) throw new Error('메일 연결·발신 주소·수신자를 입력하세요.');
  return { when: form.when, channel_ids: form.share ? form.channelIds : [],
    email: form.email ? { connection_id: form.connectionId, from: form.from, to } : null };
}
