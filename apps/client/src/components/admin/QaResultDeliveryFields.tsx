import React, { useEffect, useState } from 'react';
import { t as translate } from '../../i18n/core';
import { api } from '../../api';
import type { MailConnection } from '../../business-mail.types';
import { Input, Select } from '../common';
import type { QaDeliveryForm } from './qaScenario.logic';

export default function QaResultDeliveryFields({ accountId, form, onChange }: {
  accountId: string; form: QaDeliveryForm; onChange: (patch: Partial<QaDeliveryForm>) => void;
}) {
  const [channels, setChannels] = useState<Array<{ id: string; name: string }>>([]);
  const [connections, setConnections] = useState<MailConnection[]>([]);
  const [channelError, setChannelError] = useState('');
  const [mailError, setMailError] = useState('');
  useEffect(() => {
    let cancelled = false;
    if (form.share) api.getChannels(accountId).then(rows => {
      if (!cancelled) setChannels(rows.filter(c => c.account_id === accountId && c.is_active && c.type === 'discord'));
    }).catch(() => { if (!cancelled) setChannelError(translate('공유 채널을 불러오지 못했습니다. 계정 채널 설정을 확인하세요.')); });
    if (form.email) api.listBusinessMailConnections().then(data => {
      if (!cancelled) setConnections(data.connections.filter(c => c.account_id === accountId && c.enabled && (c.provider === 'jmap' || c.config.smtp)));
    }).catch(() => { if (!cancelled) setMailError(translate('메일 연결을 불러오지 못했습니다. 비즈니스 메일 권한과 연결을 확인하세요.')); });
    return () => { cancelled = true; };
  }, [accountId, form.share, form.email]);
  const connection = connections.find(c => c.id === form.connectionId);
  return <div style={{ display: 'grid', gap: 10 }}>
    <p style={{ margin: 0, fontSize: 12 }}>{translate('결과는 항상 실행 기록에 저장됩니다. 티켓 생성과 별개로 공유·메일을 함께 선택할 수 있습니다.')}</p>
    <label><input type="checkbox" checked={form.share} onChange={e => onChange({ share: e.target.checked })} /> {translate('내용을 채널에 공유')}</label>
    {form.share && <div style={{ display: 'grid', gap: 6 }}>
      {channelError && <p role="alert">{channelError}</p>}
      {!channelError && !channels.length && <p>{translate('설정 → 채널에서 활성 Discord 채널을 등록하세요.')}</p>}
      {channels.map(c => <label key={c.id}><input type="checkbox" checked={form.channelIds.includes(c.id)} onChange={e => onChange({ channelIds: e.target.checked ? [...form.channelIds, c.id] : form.channelIds.filter(id => id !== c.id) })} /> {c.name}</label>)}
      {form.channelIds.filter(id => !channels.some(c => c.id === id)).map(id => <label key={id}><input type="checkbox" checked onChange={() => onChange({ channelIds: form.channelIds.filter(x => x !== id) })} /> {translate('사용할 수 없는 채널')} ({id.slice(0, 8)})</label>)}
    </div>}
    <label><input type="checkbox" checked={form.email} onChange={e => onChange({ email: e.target.checked })} /> {translate('결과를 메일로 보내기')}</label>
    {form.email && <>
      {mailError && <p role="alert">{mailError}</p>}
      {!mailError && !connections.length && <p>{translate('비즈니스 → 메일에서 발신 연결을 먼저 등록하세요.')}</p>}
      <Select aria-label={translate('발신 메일 연결')} label={translate('발신 메일 연결')} value={form.connectionId}
        options={[{ value: '', label: translate('연결 선택') }, ...connections.map(c => ({ value: c.id, label: c.name })),
          ...(form.connectionId && !connection ? [{ value: form.connectionId, label: translate('사용할 수 없는 메일 연결') }] : [])]}
        onChange={e => { const id = e.target.value; onChange({ connectionId: id, from: connections.find(c => c.id === id)?.config.addresses[0] || '' }); }} />
      <Select aria-label={translate('발신 주소')} label={translate('발신 주소')} value={form.from} options={[{ value: '', label: translate('발신 주소 선택') },
        ...Array.from(new Set([...(connection?.config.addresses || []), ...(form.from ? [form.from] : [])])).map(a => ({ value: a, label: a }))]}
        onChange={e => onChange({ from: e.target.value })} />
      <Input aria-label={translate('수신자')} label={translate('수신자 (쉼표로 구분, 최대 10명)')} value={form.recipients} onChange={e => onChange({ recipients: e.target.value })} />
    </>}
    {(form.share || form.email) && <Select aria-label={translate('결과 전달 시점')} label={translate('결과 전달 시점')} value={form.when}
      options={[{ value: 'failure', label: translate('실패한 경우만') }, { value: 'always', label: translate('모든 실행 결과') }]}
      onChange={e => onChange({ when: e.target.value as QaDeliveryForm['when'] })} />}
  </div>;
}
