import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { useAuth } from '../../contexts/AuthContext';
import type { BusinessCompany } from '../../business.types';
import type { MailConnection, MailConnectionInput, MailConnections, MailEndpoint } from '../../business-mail.types';
import { Button, Input, Modal, Select, Textarea } from '../common';
import RuntimeSpecEditor, { emptyRuntimeSpec, type RuntimeSpecDraft } from '../runtime/RuntimeSpecEditor';
import { isRuntimeSpecComplete } from '../../runtime/runtimeSpec';
import { useHostNames } from '../../runtime/useHostNames';
import { assigneeDisplayName } from '../../tickets/assignee';

export const MAIL_PURPOSES = [{ value: 'general', label: '대표' }, { value: 'accounting', label: '회계' }, { value: 'marketing', label: '마케팅' }, { value: 'operations', label: '운영' }];
export function BusinessMailConnectionForm({ row, catalog, companies, onClose, onSaved }: {
  row?: MailConnection; catalog: MailConnections; companies: BusinessCompany[]; onClose(): void; onSaved(): void;
}) {
  const { hasPermission, currentAccountId } = useAuth();
  const hostNames = useHostNames();
  const [input, setInput] = useState<MailConnectionInput>(row || { name: '', provider: 'smtp_imap', company_id: null, purpose: 'operations', credential_id: '', enabled: true, interval_minutes: 5,
    config: { addresses: [], imap: { host: '', port: 993, tls: 'implicit', username: '', folder: 'INBOX' }, smtp: { host: '', port: 587, tls: 'starttls', username: '' } } });
  const [addresses, setAddresses] = useState(row?.config.addresses.join(', ') || '');
  const [runtimeDraft, setRuntimeDraft] = useState<RuntimeSpecDraft>(() => ({ ...emptyRuntimeSpec(), ...row?.automation?.agent_runtime }));
  const [newSecret, setNewSecret] = useState<Record<string, string>>({});
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const saveFooter = useRef<HTMLDivElement>(null);
  useEffect(() => { if (error) saveFooter.current?.scrollIntoView?.({ block: 'nearest' }); }, [error]);
  const owner = row?.account_id || companies.find(c => c.id === input.company_id)?.account_id;
  const keys = catalog.credentials.filter(c => !owner || c.account_id === owner);
  const patch = (changes: Partial<MailConnectionInput>) => setInput(old => ({ ...old, ...changes }));
  const automation = input.automation || { mode: 'off' as const, agent_runtime: null, objective: '', max_replies_per_day: 20 };
  const runtimeAccount = owner || catalog.credentials.find(c => c.id === input.credential_id)?.account_id || currentAccountId || '';
  const setAutomation = (delta: Partial<typeof automation>) => patch({ automation: { ...automation, ...delta } });
  const endpoint = (kind: 'smtp' | 'imap') => {
    const value = input.config[kind];
    const change = (delta: Partial<MailEndpoint>) => patch({ config: { ...input.config, [kind]: { ...value, ...delta } } });
    return <fieldset className="business-options"><legend>{kind.toUpperCase()} {kind === 'smtp' ? '발신' : '수신'}</legend>
      <label><input type="checkbox" checked={!!value} disabled={!!row} onChange={e => patch({ config: { ...input.config, [kind]: e.target.checked ? { host: '', port: kind === 'smtp' ? 587 : 993, tls: kind === 'smtp' ? 'starttls' : 'implicit', username: '', ...(kind === 'imap' ? { folder: 'INBOX' } : {}) } : undefined } })} />사용</label>
      {value && <div className="business-form-grid">
        <Input aria-label={`${kind.toUpperCase()} 서버`} label={`${kind.toUpperCase()} 서버`} value={value.host} disabled={!!row} onChange={e => change({ host: e.target.value })} />
        <Input aria-label={`${kind.toUpperCase()} 포트`} label={`${kind.toUpperCase()} 포트`} type="number" value={value.port} disabled={!!row} onChange={e => change({ port: Number(e.target.value) })} />
        <Input aria-label={`${kind.toUpperCase()} 로그인 이름`} label={`${kind.toUpperCase()} 로그인 이름`} value={value.username} disabled={!!row} onChange={e => change({ username: e.target.value })} />
        <Select aria-label={`${kind.toUpperCase()} 보안`} label={`${kind.toUpperCase()} 보안`} value={value.tls} disabled={!!row} options={[{ value: 'implicit', label: 'TLS' }, { value: 'starttls', label: 'STARTTLS' }]} onChange={e => change({ tls: e.target.value as MailEndpoint['tls'] })} />
        {kind === 'imap' && <Input aria-label="수집할 폴더" label="수집할 폴더" value={value.folder || 'INBOX'} disabled={!!row} onChange={e => change({ folder: e.target.value })} />}
      </div>}
    </fieldset>;
  };
  const save = async () => {
    setBusy(true); setError('');
    try {
      let resolvedAutomation = automation;
      if (automation.mode !== 'off') {
        if (!automation.objective.trim()) throw new Error('업무 목적 · 답장 기준을 입력하세요.');
        if (!isRuntimeSpecComplete(runtimeDraft)) throw new Error('담당 에이전트의 Host·CLI·작업 폴더를 설정하세요.');
        const resolved = await api.validateRuntimeSpec(runtimeAccount, runtimeDraft);
        if (!resolved.ok || !resolved.spec) throw new Error(resolved.error || '담당 에이전트 설정을 확인하세요.');
        resolvedAutomation = { ...automation, agent_runtime: resolved.spec };
      }
      let credentialId = input.credential_id;
      if (credentialId === '__new__') {
        const credential = await api.createCredential({ name: `${input.name} · Mail`, provider: 'mail', account_id: owner || currentAccountId || undefined, scope: 'account', credentials: newSecret, agent_env: false });
        credentialId = credential.id; patch({ credential_id: credentialId });
      }
      await api.configureBusinessMail({ ...input, automation: resolvedAutomation, credential_id: credentialId, config: { ...input.config, addresses: addresses.split(/[,\n]/).map(s => s.trim()).filter(Boolean) } });
      onSaved();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <Modal isOpen onClose={() => { if (!busy) onClose(); }} title={row ? '메일 연결 설정' : '메일 커넥터 추가'} maxWidth={650}
    footer={<div ref={saveFooter} data-testid="mail-connection-save" style={{ width: '100%' }}>
      {error && <div role="alert" className="business-error" style={{ marginBottom: 8 }}>{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><Button variant="secondary" disabled={busy} onClick={onClose}>취소</Button><Button loading={busy} disabled={!input.name.trim() || !input.credential_id || !addresses.trim()} onClick={() => void save()}>연결 저장</Button></div>
    </div>}>
    <div className="business-form business-mail-form">
      <Input aria-label="연결 이름" label="연결 이름" value={input.name} maxLength={120} placeholder="예: 운영 메일 · NAS" onChange={e => patch({ name: e.target.value })} />
      <div className="business-form-grid">
        <Select aria-label="회사" label="회사" value={input.company_id || ''} options={[{ value: '', label: '공통 · 회사 미지정' }, ...companies.filter(c => !row || c.account_id === row.account_id).map(c => ({ value: c.id, label: c.name }))]} onChange={e => patch({ company_id: e.target.value || null, ...(!row ? { credential_id: '' } : {}) })} />
        <Select aria-label="업무 용도" label="업무 용도" value={input.purpose} options={MAIL_PURPOSES} onChange={e => patch({ purpose: e.target.value })} />
      </div>
      <Select aria-label="메일 커넥터" label="메일 커넥터" value={input.provider} disabled={!!row} options={catalog.connectors.map(c => ({ value: c.id, label: c.name }))} onChange={e => patch({ provider: e.target.value as MailConnectionInput['provider'], config: e.target.value === 'jmap' ? { addresses: [], jmap_url: '' } : { addresses: [], imap: { host: '', port: 993, tls: 'implicit', username: '', folder: 'INBOX' }, smtp: { host: '', port: 587, tls: 'starttls', username: '' } } })} />
      <p className="business-muted">{catalog.connectors.find(c => c.id === input.provider)?.note}</p>
      <Input aria-label="메일 주소" label="메일 주소" value={addresses} placeholder="ops@example.com, support@example.com" onChange={e => setAddresses(e.target.value)} />
      <p className="business-muted">서버에서 사용 권한을 설정한 주소와 별칭을 쉼표로 구분하세요.</p>
      {input.provider === 'smtp_imap' ? <>{endpoint('imap')}{endpoint('smtp')}</> : <>
        <Input aria-label="JMAP Session URL" label="JMAP Session URL" value={input.config.jmap_url || ''} disabled={!!row} placeholder="https://mail.example.com/.well-known/jmap" onChange={e => patch({ config: { ...input.config, jmap_url: e.target.value } })} />
        <Input aria-label="JMAP 계정 ID (선택)" label="JMAP 계정 ID (선택)" value={input.config.jmap_account_id || ''} disabled={!!row} onChange={e => patch({ config: { ...input.config, jmap_account_id: e.target.value || undefined } })} />
      </>}
      <Select aria-label="메일 인증 정보" label="메일 인증 정보" value={input.credential_id} options={[{ value: '', label: '서버 전용 Mail credential 선택' }, ...keys.map(k => ({ value: k.id, label: k.name })), ...(hasPermission('admin.credentials') ? [{ value: '__new__', label: '+ 인증 정보 등록' }] : []), ...(input.credential_id && input.credential_id !== '__new__' && !keys.some(k => k.id === input.credential_id) ? [{ value: input.credential_id, label: '등록한 인증 정보' }] : [])]} onChange={e => patch({ credential_id: e.target.value })} />
      {input.credential_id === '__new__' && (input.provider === 'jmap' ? ['jmap_token'] : [...(input.config.imap ? ['imap_password'] : []), ...(input.config.smtp ? ['smtp_password'] : [])]).map(key => <Input key={key} aria-label={key === 'jmap_token' ? 'JMAP API 토큰' : `${key.startsWith('imap') ? 'IMAP' : 'SMTP'} 비밀번호 · 앱 비밀번호`} label={key === 'jmap_token' ? 'JMAP API 토큰' : `${key.startsWith('imap') ? 'IMAP' : 'SMTP'} 비밀번호 · 앱 비밀번호`} type="password" autoComplete="new-password" value={newSecret[key] || ''} onChange={e => setNewSecret({ ...newSecret, [key]: e.target.value })} />)}
      {hasPermission('admin.credentials') && <Link to="/settings/credentials" target="_blank">저장된 인증 정보 관리 ↗</Link>}
      <Select aria-label="자동 수집 간격" label="자동 수집 간격" value={String(input.interval_minutes)} options={[5, 15, 60].map(n => ({ value: String(n), label: `${n}분` }))} onChange={e => patch({ interval_minutes: Number(e.target.value) })} />
      <p className="business-muted">IMAP IDLE 또는 JMAP 실시간 알림을 지원하면 새 메일을 바로 수집합니다. 위 간격은 연결 복구 시 누락 확인에도 사용합니다.</p>
      <label><input type="checkbox" checked={input.notify_incoming !== false} onChange={e => patch({ notify_incoming: e.target.checked })} />새 메일마다 알림</label>
      <fieldset className="business-options"><legend>답장 자동화</legend>
        <Select label="답장 모드" aria-label="답장 모드" value={automation.mode} options={[{ value: 'off', label: '자동화 끔' }, { value: 'review', label: '반자동 · 사람이 승인한 뒤 발송' }, { value: 'automatic', label: '자동 · 에이전트 작성 후 발송' }]} onChange={e => setAutomation({ mode: e.target.value as typeof automation.mode })} />
        {automation.mode !== 'off' && <>
          <Textarea label="업무 목적 · 답장 기준" aria-label="업무 목적 · 답장 기준" rows={4} maxLength={8000} value={automation.objective} placeholder="예: 제품 사용 문의에 한국어로 간단히 답장. 환불·계약·금액 약속은 사람에게 확인 요청." onChange={e => setAutomation({ objective: e.target.value })} />
          <p>담당 에이전트: {isRuntimeSpecComplete(runtimeDraft) ? assigneeDisplayName(runtimeDraft, hostNames) : '지정 안 함'}</p>
          <RuntimeSpecEditor key={runtimeAccount} accountId={runtimeAccount} value={runtimeDraft} onChange={setRuntimeDraft}
            hosts={Object.entries(hostNames).map(([id, name]) => ({ id, name }))} disabled={busy} />
          <Select label="자동 답장 발신 주소" value={automation.from || ''} options={[{ value: '', label: '연결의 첫 번째 주소' }, ...addresses.split(/[,\n]/).map(a => a.trim()).filter(Boolean).map(a => ({ value: a, label: a }))]} onChange={e => setAutomation({ from: e.target.value || undefined })} />
          <Input label="하루 최대 답장 처리 수" type="number" min={1} max={100} value={automation.max_replies_per_day} onChange={e => setAutomation({ max_replies_per_day: Number(e.target.value) })} />
          <p className="business-muted">저장 후 새로 수집하는 메일부터 적용합니다. 과거 메일은 ‘답장 작성 요청’으로 처리할 수 있습니다. 자동 모드에서도 판단이 어려운 답장은 승인 대기로 남깁니다.</p>
        </>}
      </fieldset>
      <label><input type="checkbox" checked={input.enabled} onChange={e => patch({ enabled: e.target.checked })} />연결 사용 · 자동 수집</label>
    </div>
  </Modal>;
}
