import { getLocaleTag } from '../../i18n/core';
import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import type { BusinessCompany } from '../../business.types';
import type { BusinessMailMessage, MailConnection, MailConnections, MailList } from '../../business-mail.types';
import { Button, Textarea } from '../common';
import { BusinessIcon } from './BusinessIcon';
import { BusinessMailConnectionForm, MAIL_PURPOSES } from './BusinessMailConnectionForm';
import BusinessMailReplyPanel, { MAIL_REPLY_STATUS } from './BusinessMailReplyPanel';
import { useBoardStreamEvent } from '../../contexts/BoardStreamContext';
import { BusinessPageHeader } from './BusinessPageHeader';

const STATUS = { get received() { return translate('수신'); }, get sending() { return translate('발신 중'); }, get accepted() { return translate('서버 접수'); }, get uncertain() { return translate('발신 확인 필요'); } };
const when = (value: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(getLocaleTag()) : '—';

export default function BusinessMailPage() {
  useLocale();
  const { hasPermission } = useAuth(); const { showToast } = useToast();
  const allowed = hasPermission('business.manage');
  const [params, setParams] = useSearchParams();
  const [catalog, setCatalog] = useState<MailConnections>({ connectors: [], connections: [], credentials: [] });
  const [companies, setCompanies] = useState<BusinessCompany[]>([]);
  const [list, setList] = useState<MailList>({ messages: [], total: 0, offset: 0, limit: 50 });
  const [detail, setDetail] = useState<BusinessMailMessage | null>(null);
  const [selected, setSelected] = useState(params.get('message') || ''); const [note, setNote] = useState('');
  const [editor, setEditor] = useState<MailConnection | 'new' | null>(null);
  const [error, setError] = useState(''); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filters = Object.fromEntries(['company_id', 'connection_id', 'address', 'purpose', 'direction', 'status', 'confirmation', 'reply_status', 'offset'].map(k => [k, params.get(k) || (k === 'company_id' ? params.get('company') : '')]).filter((pair): pair is [string, string] => !!pair[1]));
  const filterKey = JSON.stringify(filters);
  const extraFilterCount = Object.keys(filters).filter(k => k !== 'company_id' && k !== 'offset').length;
  const connectionsOpen = params.get('connections') === '1';
  useEffect(() => { if (params.get('message')) setSelected(params.get('message')!); }, [params]);
  useBoardStreamEvent('business_mail_update', () => { if (allowed) setRefresh(n => n + 1); });
  useEffect(() => {
    if (!allowed) return;
    let active = true; setLoading(true);
    void Promise.all([api.listBusinessMailConnections(), api.listBusinessCompanies(), api.listBusinessMail(JSON.parse(filterKey))])
      .then(([connections, companyRows, messages]) => { if (active) { setCatalog(connections); setCompanies(companyRows); setList(messages); setError(''); } })
      .catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [allowed, filterKey, refresh]);
  useEffect(() => { const timer = setInterval(() => { if (!document.hidden) setRefresh(n => n + 1); }, 30000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    let active = true; setDetail(null); setNote('');
    if (allowed && selected) void api.getBusinessMail(selected).then(row => { if (active) { setDetail(row); setNote(row.note || ''); } }).catch(e => { if (active) showToast(e.message, 'error'); });
    return () => { active = false; };
  }, [selected, allowed, showToast]);
  const filter = (key: string, value: string) => {
    const next = new URLSearchParams(params); next.delete('offset'); next.delete('message'); if (key === 'company_id') next.delete('company');
    if (value) next.set(key, value); else next.delete(key);
    setParams(next); setSelected('');
  };
  const select = (key: string, label: string, options: Array<{ value: string; label: string }>) => <select className="business-filter" aria-label={label} value={filters[key] || ''} onChange={e => filter(key, e.target.value)}><option value="">{label}</option>{options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;
  const sync = async (row: MailConnection) => {
    setBusy(row.id);
    try { const result = await api.syncBusinessMail(row.id); showToast(translate('수집 완료{0}', { 0: result.has_more ? translate(' · 나머지는 자동 수집을 이어갑니다.') : '' }), 'success'); }
    catch (e) { showToast((e as Error).message, 'error'); }
    finally { setBusy(''); setRefresh(n => n + 1); }
  };
  const confirm = async () => {
    if (!detail) return; setBusy(detail.id);
    try { const result = await api.confirmBusinessMail(detail.id, { revision: detail.revision, confirmed: !detail.confirmed, note }); setDetail(result); setRefresh(n => n + 1); }
    catch (e) { showToast((e as Error).message, 'error'); const current = await api.getBusinessMail(detail.id).catch(() => null); if (current) setDetail(current); }
    finally { setBusy(''); }
  };
  if (!allowed) return <div className="business-page">{translate('비즈니스 메일을 보려면 business.manage 권한이 필요합니다.')}</div>;
  return <div className="business-page business-mail-page">
    <BusinessPageHeader title={translate('비즈니스 메일')} description={translate('자동으로 수집한 메일과 발신 결과를 확인하고, 처리 기록을 남깁니다.')}
      actions={<Button aria-label={translate('메일 연결 추가')} title={translate('메일 연결 추가')} onClick={() => setEditor('new')}><BusinessIcon name="plus" size={18} /><span className="business-header-action-label">{translate('메일 연결 추가')}</span></Button>}
      moreActions={close => <>
        <Button variant="ghost" disabled={loading} onClick={() => { close(); setRefresh(n => n + 1); }}><BusinessIcon name="refresh" size={16} />{translate('메일 새로고침')}</Button>
        <Button variant="ghost" aria-pressed={connectionsOpen} onClick={() => { close(); const next = new URLSearchParams(params); connectionsOpen ? next.delete('connections') : next.set('connections', '1'); setParams(next); }}><BusinessIcon name="connector" size={16} />{translate('연결 관리 (')}{catalog.connections.length})</Button>
      </>}
    />
    {error && <div role="alert" className="business-error">{error}<Button variant="ghost" onClick={() => setRefresh(n => n + 1)}>{translate('다시 불러오기')}</Button></div>}
    {(connectionsOpen || (!loading && !catalog.connections.length)) && <section className="business-panel business-mail-connections" aria-label={translate('메일 연결')}>
      {!catalog.connections.length && <p>{translate('대표·회계·마케팅·운영 메일을 연결하면 한 목록에서 확인할 수 있습니다.')}</p>}
      {catalog.connections.map(row => <article key={row.id}><div><strong>{row.name}</strong><span className="business-pill">{row.enabled ? row.status === 'error' ? translate('연결 확인 필요') : translate('사용 중') : translate('중지됨')}</span><p className="business-muted">{row.config.addresses.join(', ')} · {MAIL_PURPOSES.find(p => p.value === row.purpose)?.label} {translate('· 마지막 수집')} {when(row.synced_at)}</p><p className="business-muted">{['idle', 'push'].includes(row.receiving?.mode || '') ? translate('실시간 수신 연결됨') : translate('주기 수집')} · {row.notify_incoming !== false ? translate('수신 알림 켜짐') : translate('수신 알림 꺼짐')} · {row.automation?.mode === 'automatic' ? translate('자동 답장') : row.automation?.mode === 'review' ? translate('승인 후 답장') : translate('답장 자동화 꺼짐')}</p>{row.receiving?.error && <p className="business-muted">{row.receiving.error}</p>}{row.last_error && <p className="business-error">{row.last_error}</p>}</div><div className="business-card-actions"><Button variant="secondary" disabled={!!busy || !row.enabled || row.busy} onClick={() => void sync(row)}>{translate('지금 수집')}</Button><Button variant="ghost" disabled={!!busy} onClick={() => setEditor(row)}>{translate('설정')}</Button></div></article>)}
    </section>}
    <div className="business-mail-filters" aria-label={translate('메일 필터')}>
      {select('company_id', translate('모든 회사'), companies.map(c => ({ value: c.id, label: c.name })))}
      <Button variant="secondary" aria-expanded={filtersOpen} aria-controls="business-mail-filter-fields" onClick={() => setFiltersOpen(!filtersOpen)}><BusinessIcon name="filter" size={16} />{translate('필터')}{extraFilterCount > 0 && ` (${extraFilterCount})`}</Button>
      <div id="business-mail-filter-fields" className="business-mail-filter-fields" hidden={!filtersOpen}>
        {select('connection_id', translate('모든 연결'), catalog.connections.map(c => ({ value: c.id, label: c.name })))}
        {select('address', translate('모든 메일 주소'), [...new Set(catalog.connections.flatMap(c => c.config.addresses))].map(a => ({ value: a, label: a })))}
        {select('purpose', translate('모든 업무 용도'), MAIL_PURPOSES)}
        {select('direction', translate('수신·발신 전체'), [{ value: 'inbound', label: translate('수신') }, { value: 'outbound', label: translate('발신') }])}
        {select('confirmation', translate('처리 상태 전체'), [{ value: 'pending', label: translate('미확인') }, { value: 'confirmed', label: translate('확인 완료') }])}
        {select('status', translate('발신·수신 상태 전체'), Object.entries(STATUS).map(([value, label]) => ({ value, label })))}
        {select('reply_status', translate('답장 상태 전체'), Object.entries(MAIL_REPLY_STATUS).map(([value, label]) => ({ value, label })))}
        <Button variant="ghost" onClick={() => { setParams(connectionsOpen ? { connections: '1' } : {}); setSelected(''); }}>{translate('필터 초기화')}</Button>
      </div>
    </div>
    <div className="business-mail-workspace">
      <section className="business-panel business-mail-list" aria-label={translate('통합 메일 목록')} aria-busy={loading}>
        <div className="business-section-heading"><h2>{translate('전체 메일')}</h2><span className="business-muted">{list.total}{translate('건')}{loading ? translate(' · 불러오는 중…') : ''}</span></div>
        {!loading && !list.messages.length && <p className="business-empty-inline">{translate('조건에 맞는 메일이 없습니다. 연결을 추가하거나 수집 상태를 확인하세요.')}</p>}
        {list.messages.map(message => <button key={message.id} disabled={!!busy} className={`business-mail-row ${selected === message.id ? 'selected' : ''}`} onClick={() => setSelected(message.id)} aria-pressed={selected === message.id}>
          <span className="business-mail-row-meta"><span>{catalog.connections.find(c => c.id === message.connection_id)?.name || translate('메일 연결')}</span><span>{message.reply ? MAIL_REPLY_STATUS[message.reply.status] : STATUS[message.status]} · {message.confirmed ? translate('확인 완료') : translate('미확인')}</span></span>
          <strong>{message.subject || translate('(제목 없음)')}</strong><span>{message.direction === 'inbound' ? message.from : message.to.join(', ')}</span><small>{when(message.date || message.created_at)}</small>
        </button>)}
        <div className="business-card-actions business-mail-pagination"><Button variant="ghost" disabled={loading || list.offset === 0} onClick={() => filter('offset', String(Math.max(0, list.offset - list.limit)))}>{translate('이전')}</Button><span className="business-muted">{list.total ? `${list.offset + 1}–${Math.min(list.total, list.offset + list.limit)}` : '0'}</span><Button variant="ghost" disabled={loading || list.offset + list.limit >= list.total} onClick={() => filter('offset', String(list.offset + list.limit))}>{translate('다음')}</Button></div>
      </section>
      <section className="business-panel business-mail-detail" aria-label={translate('메일 내용')}>
        {!detail ? <p className="business-muted">{selected ? translate('메일을 불러오는 중…') : translate('메일을 선택해 내용과 자동화 결과를 확인하세요.')}</p> : <>
          <div className="business-section-heading"><h2>{detail.subject || translate('(제목 없음)')}</h2><span className="business-pill">{STATUS[detail.status]}</span></div>
          <p className="business-muted">{translate('보낸 사람:')} {detail.from}<br />{translate('받는 사람:')} {detail.to.join(', ')}<br />{when(detail.date)}</p>
          {detail.last_error && <p role="status" className="business-error">{detail.last_error}</p>}
          {detail.status === 'accepted' && <p className="business-muted">{translate('메일 서버가 발신을 접수했습니다. 수신자에게 최종 전달됐다는 뜻은 아닙니다.')}</p>}
          {detail.truncated && <p role="status" className="business-error">{translate('본문이 길거나 크기 제한을 넘었습니다. 전체 내용은 원본 메일에서 확인하세요.')}</p>}
          <pre className="business-mail-body">{detail.text || translate('(텍스트 본문 없음)')}</pre>
          {!!detail.attachments.length && <div className="business-muted">{translate('첨부파일:')} {detail.attachments.map(a => a.name).join(', ')}<br />{translate('첨부 내용은 원본 메일에서 확인하세요.')}</div>}
          <Textarea aria-label={translate('처리 메모')} label={translate('처리 메모')} value={note} maxLength={2000} rows={3} onChange={e => setNote(e.target.value)} />
          <div className="business-card-actions"><Button disabled={!!busy} onClick={() => void confirm()}>{detail.confirmed ? translate('미확인으로 되돌리기') : translate('확인 완료')}</Button>{detail.confirmed && <span className="business-muted">{when(detail.confirmed_at)} {translate('확인')}</span>}</div>
          <BusinessMailReplyPanel key={detail.id} message={detail} connection={catalog.connections.find(c => c.id === detail.connection_id)} refresh={refresh} onChanged={() => setRefresh(n => n + 1)} />
        </>}
      </section>
    </div>
    {editor && <BusinessMailConnectionForm row={editor === 'new' ? undefined : editor} catalog={catalog} companies={companies} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); setRefresh(n => n + 1); }} />}
  </div>;
}
