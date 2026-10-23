import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import type { BusinessCompany, BusinessCompanyInput, BusinessConnection, BusinessConnector, BusinessTask, BusinessTaskInput, BusinessStage } from '../../business.types';
import type { MarketingCampaign } from '../../types';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { Button, Input, Modal, Select, Textarea } from '../common';
import { STAGES, TASK_STATUS } from './business.logic';
import { BusinessIcon } from './BusinessIcon';

function FormError({ error }: { error: string }) { return error ? <div role="alert" className="business-error">{error}</div> : null; }

export function CompanyForm({ company, onClose, onSaved }: { company?: BusinessCompany; onClose(): void; onSaved(id: string): Promise<void> }) {
  const { hasPermission, currentAccountId } = useAuth();
  const canViewMarketing = hasPermission('marketing.manage') || hasPermission('marketing.approve_spend');
  const [input, setInput] = useState<BusinessCompanyInput>({ name: company?.name || '', entity_type: company?.entity_type || 'LLC', country: company?.country || 'US', jurisdiction: company?.jurisdiction || '', description: company?.description || '', campaign_ids: company?.campaign_ids || [] });
  const [campaigns, setCampaigns] = useState<MarketingCampaign[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    if (canViewMarketing) void api.listMarketingCampaigns().then(rows => { if (active) setCampaigns(rows.filter(c => c.account_id === (company?.account_id || currentAccountId))); }).catch(() => { if (active) setError('캠페인 목록을 불러오지 못했습니다. 기존 연결은 유지됩니다.'); });
    return () => { active = false; };
  }, [canViewMarketing, company?.account_id, currentAccountId]);
  const save = async () => {
    setBusy(true); setError('');
    try {
      const { campaign_ids, ...base } = input;
      const row = company
        ? await api.updateBusinessCompany(company.id, { ...base, ...(canViewMarketing ? { campaign_ids } : {}), revision: company.revision })
        : await api.createBusinessCompany(input);
      await onSaved(row.id);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <Modal isOpen onClose={() => { if (!busy) onClose(); }} title={company ? '회사 정보 · 캠페인 연결' : '새 비즈니스 시작'} maxWidth={600}
    footer={<><Button variant="secondary" disabled={busy} onClick={onClose}>취소</Button><Button disabled={!input.name.trim()} loading={busy} onClick={() => void save()}>{company ? '저장' : '워크플로 만들기'}</Button></>}>
    <div className="business-form">
      {!company && <div className="business-form-intro"><BusinessIcon name="formation" size={30} /><p>AWB에 관리할 회사를 등록하고 6개 영역의 운영 워크플로를 만듭니다. 이미 설립한 회사도 추가할 수 있습니다.<br /><strong>커넥터에서 가격·기능을 비교하고 doola 내부 신청 또는 외부 설립 서비스를 선택하세요.</strong></p></div>}
      <Input label="회사 이름" aria-label="회사 이름" value={input.name} maxLength={120} placeholder="예: Acme Labs LLC" onChange={e => setInput({ ...input, name: e.target.value })} />
      <div className="business-form-grid">
        <Select label="회사 형태" aria-label="회사 형태" value={input.entity_type} options={[{ value: 'LLC', label: 'LLC' }, { value: 'CCorp', label: 'C-Corp' }, { value: 'other', label: '기타 / 미정' }]} onChange={e => setInput({ ...input, entity_type: e.target.value as BusinessCompanyInput['entity_type'] })} />
        <Input label="설립 국가 (2자리)" aria-label="설립 국가" maxLength={2} value={input.country} onChange={e => setInput({ ...input, country: e.target.value.toUpperCase() })} />
      </div>
      <Input label="설립 주 / 관할 지역" aria-label="설립 주" value={input.jurisdiction} maxLength={80} placeholder="예: Delaware · 아직 미정이면 비워 두세요" onChange={e => setInput({ ...input, jurisdiction: e.target.value })} />
      <Textarea label="사업 소개" aria-label="사업 소개" value={input.description} rows={2} maxLength={2000} placeholder="어떤 제품과 서비스를 운영하나요?" onChange={e => setInput({ ...input, description: e.target.value })} />
      {canViewMarketing && <fieldset className="business-options"><legend>이 회사의 마케팅 캠페인</legend>
        {campaigns.length ? campaigns.map(c => <label key={c.id}><input type="checkbox" checked={input.campaign_ids.includes(c.id)} onChange={e => setInput({ ...input, campaign_ids: e.target.checked ? [...input.campaign_ids, c.id] : input.campaign_ids.filter(id => id !== c.id) })} />{c.name}</label>) : <p>아직 연결할 캠페인이 없습니다. 나중에 추가할 수 있습니다.</p>}
      </fieldset>}
      <FormError error={error} />
    </div>
  </Modal>;
}

export function TaskForm({ company, task, tasks, stage, onClose, onSaved }: { company: BusinessCompany; task?: BusinessTask; tasks: BusinessTask[]; stage: BusinessStage; onClose(): void; onSaved(): Promise<void> }) {
  const [input, setInput] = useState<BusinessTaskInput>({ title: task?.title || '', stage: task?.stage || stage, status: task?.status || 'todo', description: task?.description || '', owner: task?.owner || '', due_on: task?.due_on || null, notes: task?.notes || '', depends_on: task?.depends_on || [], ticket_id: task?.ticket_id || null });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [ticketQuery, setTicketQuery] = useState('');
  const [tickets, setTickets] = useState<Array<{ id: string; title: string }>>(task?.ticket ? [task.ticket] : []);
  const [ticketError, setTicketError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    if (!ticketQuery.trim()) return;
    let active = true;
    const timer = setTimeout(() => {
      void api.listTickets(company.account_id, { q: ticketQuery }).then(result => {
        if (active) { setTickets(result.tickets.filter(t => t.account_id === company.account_id).slice(0, 20)); setTicketError(''); }
      }).catch(() => { if (active) setTicketError('티켓을 검색하지 못했습니다. 다시 입력해 주세요.'); });
    }, 300);
    return () => { active = false; clearTimeout(timer); };
  }, [ticketQuery, company.account_id]);
  const save = async (remove = false) => {
    setBusy(true); setError('');
    try {
      if (remove && task) await api.deleteBusinessTask(company.id, task.id, company.revision);
      else await api.saveBusinessTask(company.id, task?.id || null, { ...input, revision: company.revision });
      await onSaved();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <Modal isOpen onClose={() => { if (!busy) onClose(); }} title={task ? '업무 관리' : '운영 업무 추가'} maxWidth={620}
    footer={<><Button variant="secondary" disabled={busy} onClick={onClose}>취소</Button><Button loading={busy} disabled={!input.title?.trim()} onClick={() => void save()}>저장</Button></>}>
    <div className="business-form">
      <Input label="업무 이름" aria-label="업무 이름" value={input.title} maxLength={200} onChange={e => setInput({ ...input, title: e.target.value })} />
      <div className="business-form-grid">
        <Select label="영역" aria-label="업무 영역" value={input.stage} options={STAGES.map(s => ({ value: s.id, label: s.label }))} onChange={e => setInput({ ...input, stage: e.target.value as BusinessStage })} />
        <Select label="진행 상태" aria-label="진행 상태" value={input.status} options={Object.entries(TASK_STATUS).map(([value, label]) => ({ value, label }))} onChange={e => setInput({ ...input, status: e.target.value as BusinessTask['status'] })} />
      </div>
      <div className="business-form-grid">
        <Input label="담당자" aria-label="담당자" value={input.owner} maxLength={100} placeholder="이름 또는 역할" onChange={e => setInput({ ...input, owner: e.target.value })} />
        <Input label="기한" aria-label="기한" type="date" value={input.due_on || ''} onChange={e => setInput({ ...input, due_on: e.target.value || null })} />
      </div>
      <Textarea label="업무 설명" aria-label="업무 설명" value={input.description} maxLength={2000} rows={2} onChange={e => setInput({ ...input, description: e.target.value })} />
      <Textarea label="진행 메모 · 확인 근거" aria-label="진행 메모" value={input.notes} maxLength={4000} rows={3} placeholder="처리 결과나 다음 확인 사항을 기록하세요." onChange={e => setInput({ ...input, notes: e.target.value })} />
      {input.status === 'done' && <p className="business-guide-note">실제 처리 결과를 확인한 뒤 완료로 기록하세요. 이 상태 변경으로 설립 신청·송금·신고가 실행되지는 않습니다.</p>}
      <details className="business-advanced"><summary>선행 업무와 실행 티켓 연결</summary>
        <fieldset className="business-options"><legend>이 업무를 시작하기 전에 마칠 일</legend>
          {tasks.filter(t => t.id !== task?.id).map(t => <label key={t.id}><input type="checkbox" checked={input.depends_on?.includes(t.id) || false} onChange={e => setInput({ ...input, depends_on: e.target.checked ? [...(input.depends_on || []), t.id] : input.depends_on?.filter(id => id !== t.id) })} />{t.title}</label>)}
        </fieldset>
        <Input label="AWB 티켓 검색" aria-label="AWB 티켓 검색" value={ticketQuery} placeholder="티켓 제목으로 검색" onChange={e => setTicketQuery(e.target.value)} />
        <Select label="실행 티켓" aria-label="실행 티켓" value={input.ticket_id || ''} options={[{ value: '', label: '연결하지 않음' }, ...(input.ticket_id && !tickets.some(t => t.id === input.ticket_id) ? [{ value: input.ticket_id, label: task?.ticket?.title || '기존 연결 티켓' }] : []), ...tickets.map(t => ({ value: t.id, label: t.title }))]} onChange={e => setInput({ ...input, ticket_id: e.target.value || null })} />
        {ticketError && <div role="alert">{ticketError}</div>}
        <p className="business-muted">티켓의 에이전트 실행 상태는 별도로 표시됩니다. 업무 완료는 결과를 확인한 뒤 기록하세요.</p>
      </details>
      {task && <div className="business-delete">
        {confirmDelete ? <><span>이 업무를 삭제할까요?</span><Button variant="danger" disabled={busy} onClick={() => void save(true)}>삭제</Button><Button variant="ghost" onClick={() => setConfirmDelete(false)}>유지</Button></> : <Button variant="ghost" onClick={() => setConfirmDelete(true)}>업무 삭제</Button>}
      </div>}
      <FormError error={error} />
    </div>
  </Modal>;
}

export function ConnectorForm({ company, connector, connection, onClose, onSaved }: { company: BusinessCompany; connector: BusinessConnector; connection?: BusinessConnection; onClose(): void; onSaved(): Promise<void> }) {
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const [credentials, setCredentials] = useState<Array<{ id: string; name: string; provider: string }>>([]);
  const [credentialId, setCredentialId] = useState(connection?.credential_id || '');
  const [environment, setEnvironment] = useState<'live' | 'sandbox'>(connection?.environment || connector.environments[0]);
  const [config, setConfig] = useState<Record<string, string>>(connection?.config || {});
  const [newSecret, setNewSecret] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  useEffect(() => {
    let active = true;
    void api.listBusinessCredentials(company.account_id).then(rows => { if (active) setCredentials(rows.filter(c => c.provider === connector.credential_provider)); }).catch(() => { if (active) setError('저장된 키 목록을 읽지 못했습니다. 창을 다시 열어 주세요.'); });
    return () => { active = false; };
  }, [company.account_id, connector.credential_provider]);
  const save = async () => {
    setBusy(true); setError('');
    try {
      let id = credentialId;
      if (id === '__new__') {
        const credential = await api.createCredential({ account_id: company.account_id, scope: 'account', name: `${company.name} · ${connector.name}`, provider: connector.credential_provider!, credentials: newSecret, agent_env: false });
        id = credential.id; setCredentialId(id); setCredentials(prev => [...prev, credential]); setNewSecret({});
      }
      await api.connectBusiness(company.id, connector.id, { credential_id: id, environment, config, revision: company.revision });
      // Connection verification is an explicit read. Failure remains visible on the saved card.
      try { await api.syncBusiness(company.id, connector.id); }
      catch (e) { showToast(`연결 설정은 저장했습니다. ${(e as Error).message}`, 'error'); }
      await onSaved();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const disconnect = async () => {
    setBusy(true); setError('');
    try { await api.disconnectBusiness(company.id, connector.id, company.revision); await onSaved(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const ready = !!credentialId && (credentialId !== '__new__' || connector.secret_fields.every(k => newSecret[k]?.trim())) && connector.fields.every(f => config[f.key]?.trim());
  return <Modal isOpen onClose={() => { if (!busy) onClose(); }} title={`${connector.name} 연결`} maxWidth={540}
    footer={<><Button variant="secondary" disabled={busy} onClick={onClose}>취소</Button><Button loading={busy} disabled={!ready} onClick={() => void save()}>저장하고 조회</Button></>}>
    <div className="business-form">
      <div className="business-form-intro"><span className="business-provider-logo" style={{ color: connector.color }}>{connector.monogram}</span><p>{connector.setup_note}</p></div>
      <Select label="환경" aria-label="연결 환경" value={environment} options={connector.environments.map(value => ({ value, label: value === 'sandbox' ? '테스트 · Sandbox' : '운영 · Live' }))} onChange={e => setEnvironment(e.target.value as 'live' | 'sandbox')} />
      <Select label="서버에 저장할 키" aria-label="연결 키" value={credentialId} options={[{ value: '', label: '저장된 키 선택' }, ...credentials.map(c => ({ value: c.id, label: c.name })), ...(hasPermission('admin.credentials') ? [{ value: '__new__', label: '+ 새 키 등록' }] : [])]} onChange={e => setCredentialId(e.target.value)} />
      {credentialId === '__new__' && connector.secret_fields.map(field => <Input key={field} label={field} aria-label={field} type="password" autoComplete="new-password" value={newSecret[field] || ''} onChange={e => setNewSecret({ ...newSecret, [field]: e.target.value })} />)}
      {connector.fields.map(field => <Input key={field.key} label={field.label} aria-label={field.label} placeholder={field.placeholder} value={config[field.key] || ''} onChange={e => setConfig({ ...config, [field.key]: e.target.value })} />)}
      <div className="business-security-note"><BusinessIcon name="lock" size={16} /><span>키는 암호화해 보관하며 에이전트에 전달하지 않습니다.</span></div>
      <div className="business-form-links"><a href={connector.docs_url} target="_blank" rel="noreferrer">키 발급 · API 안내 ↗</a>{hasPermission('admin.credentials') && <Link to="/settings/credentials" target="_blank">저장된 키 관리 ↗</Link>}</div>
      {connection && <div className="business-delete">{confirmDisconnect ? <><span>저장된 키는 유지됩니다.</span><Button variant="danger" disabled={busy} onClick={() => void disconnect()}>연결 해제</Button></> : <Button variant="ghost" onClick={() => setConfirmDisconnect(true)}>이 회사에서 연결 해제</Button>}</div>}
      <FormError error={error} />
    </div>
  </Modal>;
}
