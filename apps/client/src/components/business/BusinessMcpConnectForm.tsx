import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React, { useState } from 'react';
import { api } from '../../api';
import type { BusinessCompany, BusinessConnector, BusinessMcpConnection } from '../../business.types';
import { Button, Modal, Textarea } from '../common';
import { BusinessIcon } from './BusinessIcon';
import { dateTime } from './business.logic';

export const MCP_STATUS = { get disconnected() { return translate('로그인 전'); }, get authorizing() { return translate('로그인 진행 중'); }, get connected() { return translate('연결됨'); }, get error() { return translate('다시 로그인 필요'); } };

/** Owner sign-in to a provider-hosted MCP server. Agents use the connection; payment stays with the owner. */
export function BusinessMcpConnectForm({ company, connector, connection, onClose, onChanged }: {
  company: BusinessCompany; connector: BusinessConnector; connection?: BusinessMcpConnection; onClose(): void; onChanged(): Promise<void>;
}) {
  useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [paste, setPaste] = useState<{ redirect_uri: string } | null>(null);
  const [pasted, setPasted] = useState('');
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const status = connection?.status || 'disconnected';
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await work(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const login = () => run(async () => {
    const started = await api.authorizeBusinessMcp(company.id, connector.id);
    // Redirect mode needs this browser's HttpOnly cookie, so it continues in the same tab.
    if (started.mode === 'redirect') { window.location.assign(started.url); return; }
    window.open(started.url, '_blank', 'noopener');
    setPaste({ redirect_uri: started.redirect_uri });
  });
  const complete = () => run(async () => {
    await api.completeBusinessMcp(company.id, connector.id, pasted.trim());
    setPaste(null); setPasted('');
    try { await api.refreshBusinessMcpTools(company.id, connector.id); } catch { /* The tool list can be read again from this window. */ }
    await onChanged();
  });
  const refresh = () => run(async () => { await api.refreshBusinessMcpTools(company.id, connector.id); await onChanged(); });
  const disconnect = () => run(async () => { await api.disconnectBusinessMcp(company.id, connector.id); setConfirmDisconnect(false); await onChanged(); });
  const tools = connection?.tools || [];
  return <Modal isOpen onClose={() => { if (!busy) onClose(); }} title={translate('{0} 계정 연결 (MCP)', { 0: connector.name })} maxWidth={600}
    footer={<Button variant="secondary" disabled={busy} onClick={onClose}>{translate('닫기')}</Button>}>
    <div className="business-form">
      <div className="business-form-intro"><span className="business-provider-logo" style={{ color: connector.color }}>{connector.monogram}</span><p>{connector.setup_note}</p></div>
      <div className="business-mcp-status">
        <span className={`business-pill ${status}`}>{MCP_STATUS[status]}</span>
        {connection?.connected_at && <small className="business-muted">{translate('연결')} {dateTime(connection.connected_at)}</small>}
        <Button loading={busy && !paste} variant={status === 'connected' ? 'secondary' : 'primary'} onClick={() => void login()}>{status === 'connected' ? translate('다시 로그인') : translate('{0} 로그인', { 0: connector.name })}</Button>
      </div>
      {connection?.last_error && <p className="business-inline-error" role="status">{connection.last_error}</p>}
      {paste && <div className="business-mcp-paste">
        <p>{translate('새 창에서 로그인을 마치면 브라우저가 {0} 주소로 이동하고 “연결할 수 없음” 화면이 나옵니다. 정상입니다. 그 화면의 주소창에 있는 전체 주소를 복사해 붙여 넣으세요.', { 0: paste.redirect_uri })}</p>
        <Textarea label={translate('로그인 후 주소')} aria-label={translate('로그인 후 주소')} rows={3} value={pasted} placeholder={`${paste.redirect_uri}?code=…&state=…`} onChange={e => setPasted(e.target.value)} />
        <Button loading={busy} disabled={!pasted.trim().startsWith(paste.redirect_uri)} onClick={() => void complete()}>{translate('연결 완료')}</Button>
      </div>}
      {status === 'connected' && <section className="business-mcp-tools" aria-label={translate('{0} MCP 도구', { 0: connector.name })}>
        <div className="business-section-heading"><h3>{translate('에이전트가 쓸 수 있는 도구')} <small className="business-muted">{tools.length}</small></h3>
          <Button variant="ghost" disabled={busy} onClick={() => void refresh()}><BusinessIcon name="refresh" size={14} />{translate('도구 목록 갱신')}</Button></div>
        {tools.length ? <ul>{tools.map(tool => <li key={tool.name}><code>{tool.name}</code>
          <span className={`business-pill ${tool.owner_only ? 'blocked' : tool.read_only ? 'connected' : 'waiting'}`}>{tool.owner_only ? translate('소유자 직접 · 결제') : tool.read_only ? translate('조회') : translate('변경 · 지시 필요')}</span>
          {tool.description && <small>{tool.description}</small>}</li>)}</ul> : <p className="business-muted">{translate('도구 목록을 아직 읽지 않았습니다. 도구 목록 갱신을 누르세요.')}</p>}
      </section>}
      <p className="business-guide-note">{translate('회사 설립 업무를 시작하면 에이전트가 이 연결로 공급자 MCP를 사용합니다. 조회 도구는 바로 실행되고, 신청·변경 도구는 사용자가 지시한 작업에만 실행됩니다. 결제·체크아웃은 공급자 화면에서 직접 진행하세요.')}</p>
      <div className="business-security-note"><BusinessIcon name="lock" size={16} /><span>{translate('로그인 토큰은 서버에 암호화해 보관하며 에이전트에 전달하지 않습니다.')}</span></div>
      <div className="business-form-links"><a href={connector.docs_url} target="_blank" rel="noreferrer">{translate('공급자 MCP 안내 ↗')}</a><a href={connector.portal_url} target="_blank" rel="noreferrer">{translate('{0} 열기 ↗', { 0: connector.name })}</a></div>
      {connection && status !== 'disconnected' && <div className="business-delete">{confirmDisconnect
        ? <><span>{translate('공급자 계정과 데이터는 그대로 유지됩니다.')}</span><Button variant="danger" disabled={busy} onClick={() => void disconnect()}>{translate('연결 해제')}</Button></>
        : <Button variant="ghost" onClick={() => setConfirmDisconnect(true)}>{translate('이 회사에서 연결 해제')}</Button>}</div>}
      {error && <div role="alert" className="business-error">{error}</div>}
    </div>
  </Modal>;
}
