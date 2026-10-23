import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import type { BusinessCompany, BusinessTrademark, TrademarkConnectorDefinition, TrademarkIntegration, TrademarkIntegrationAction as Action, TrademarkIntegrationsView } from '../../business.types';
import { Button } from '../common';
import { BusinessIcon } from './BusinessIcon';
import { TrademarkIntegrationSetup } from './TrademarkIntegrationSetup';
import { TrademarkIntegrationAction } from './TrademarkIntegrationAction';
import { dateTime } from './business.logic';
import { TRADEMARK_MAIL_STATUS } from './trademark.logic';

const statuses = { configured: '설정됨', connected: '연결됨', error: '확인 필요', disconnected: '연결 해제됨' };
const kinds = { email: '메일', contract: '계약', document: '문서', deadline: '일정·기한', matter: '사건', status: '공식 상태' };
const detailLabels: Record<string, string> = { serial_number: '출원번호', status_code: '상태 코드', registration_number: '등록번호', filing_date: '출원일', document_id: '문서 ID', message_id: '메일 ID', attachments: '첨부 목록', envelope_id: '서명 요청 ID', completed_at: '서명 완료', thread_id: '메일 스레드', conversation_id: '메일 대화', has_attachments: '첨부', matter_id: '로펌 사건 번호', end_at: '종료 시각' };
export function BusinessTrademarkIntegrations({ company, trademark, onChanged }: { company: BusinessCompany; trademark: BusinessTrademark; onChanged(): Promise<void> }) {
  const [params] = useSearchParams(); const authorizeId = params.get('authorize');
  const [data, setData] = useState<TrademarkIntegrationsView | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState('');
  const [setting, setSetting] = useState<{ connector: TrademarkConnectorDefinition; connection?: TrademarkIntegration } | null>(null);
  const [working, setWorking] = useState<{ connector: TrademarkConnectorDefinition; connection: TrademarkIntegration; action?: Action } | null>(null);
  const [filter, setFilter] = useState('all'); const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    try { const result = await api.listTrademarkIntegrations(company.id, trademark.id); if (generation.current === current) { setData(result); setError(''); } }
    catch (e) { if (generation.current === current) setError((e as Error).message); }
  }, [company.id, trademark.id]);
  useEffect(() => {
    void load(); const refresh = () => { if (!document.hidden) void load(); }; const timer = setInterval(refresh, 30_000); window.addEventListener('focus', refresh);
    return () => { generation.current++; clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [load]);
  const changed = async () => { await load(); await onChanged(); };
  const run = async (id: string, work: () => Promise<void>) => {
    setBusy(id); setError(''); try { await work(); } catch (e) { setError((e as Error).message); } finally { setBusy(''); await load(); }
  };
  const activeConnections = data?.connections.filter(c => c.ready).length || 0;
  useEffect(() => {
    if (authorizeId && data?.connections.some(c => c.id === authorizeId)) document.getElementById(`business-integration-${authorizeId}`)?.scrollIntoView({ block: 'center' });
  }, [authorizeId, !!data]);
  const replyAddress = data?.connections.find(c => c.provider === 'resend_inbound' && c.ready)?.reply_address;
  const visibleRecords = data?.records.filter(record => filter === 'all' || record.kind === filter) || [];
  const openAction = (action: Action) => {
    const connection = data?.connections.find(row => row.id === action.integration_id); const connector = data?.connectors.find(row => row.id === connection?.provider);
    if (connection && connector) setWorking({ connection, connector, action });
  };
  return <section className="business-panel business-integrations" aria-label="상표 자동화 커넥터">
    <div className="business-section-heading"><div><span className="business-eyebrow">CONNECTED LEGAL WORKFLOW</span><h3>회신 · 계약 · 사건 자동화</h3></div><span className="business-pill">{activeConnections}개 사용 가능</span></div>
    <p className="business-guide-note">메일·계약·로펌·공식 상태를 기능별 커넥터로 연결합니다. 자동 수집은 서버에서 계속되며 외부 발송은 원문을 검토한 뒤 실행합니다. 읽어 온 기한·회신은 담당자 확인 자료입니다.</p>
    {error && <div role="alert" className="business-error">{error}<Button variant="ghost" onClick={() => void load()}>연결 목록 다시 불러오기</Button></div>}
    {!data && !error && <p role="status">연결 가능한 서비스를 불러오는 중…</p>}
    {data && authorizeId && !data.connections.some(c => c.id === authorizeId) && <p role="alert" className="business-error">링크의 연결을 찾을 수 없습니다. 이 상표의 연결 설정을 확인하세요.</p>}
    <div className="business-trademark-automation-grid">{data?.connectors.map(connector => {
      const connection = data.connections.find(c => c.provider === connector.id);
      const pending = connection && data.actions.find(action => action.integration_id === connection.id && action.status !== 'sent');
      const requestedLogin = connection?.id === authorizeId;
      return <article key={connector.id} id={connection ? `business-integration-${connection.id}` : undefined} className={requestedLogin ? 'business-integration-authorize' : undefined} aria-label={`${connector.name} 커넥터`}>
        {requestedLogin && <p role="status" className="business-guide-note">에이전트가 준비한 연결입니다. {connection?.status === 'disconnected' ? '연결 설정을 저장한 뒤 로그인하세요.' : '아래 로그인 버튼을 눌러 이 브라우저에서 서비스 접근을 허용하세요.'}</p>}
        <div className="business-section-heading"><BusinessIcon name={connector.icon} size={24} /><span className={`business-pill ${connection?.ready ? 'done' : ''}`}>{connection ? statuses[connection.status] : '연결 전'}</span></div>
        <h4>{connector.name}</h4><ul>{connector.capabilities.map(capability => <li key={capability}>{capability}</li>)}</ul>
        {connection?.identity && <p className="business-integration-identity">{connection.identity.email || connection.identity.name || connection.identity.account_id}</p>}
        {connection && <><p className="business-muted">{connection.auto_sync ? `${connection.interval_minutes}분마다 자동 수집` : '수동 수집'} · {connection.synced_at ? dateTime(connection.synced_at) : '첫 수집 전'}</p><p>{connection.summary}</p>{connection.last_error && <p className="business-stale">{connection.last_error}</p>}</>}
        {connection?.reply_address && <div className="business-integration-address"><strong>이 상표의 Reply-To 주소</strong><code>{connection.reply_address}</code><Button variant="ghost" onClick={() => void run(connector.id, () => navigator.clipboard.writeText(connection.reply_address))}>회신 주소 복사</Button></div>}
        <div className="business-guide-actions"><Button variant="secondary" disabled={!!busy || !!pending} onClick={() => setSetting({ connector, connection })}>연결 설정</Button>
          {connection && connection.status !== 'disconnected' && connector.auth === 'oauth' && <Button variant="secondary" disabled={!!busy} onClick={() => void run(connector.id, async () => { const result = await api.authorizeTrademarkIntegration(company.id, trademark.id, connection.id); window.location.assign(result.url); })}>{connection.ready ? '로그인 갱신' : '서비스 로그인 연결'}</Button>}
          {connection?.ready && <Button variant="secondary" disabled={!!busy} loading={busy === connector.id} onClick={() => void run(connector.id, async () => { await api.syncTrademarkIntegration(company.id, trademark.id, connection.id); })}>지금 수집</Button>}
          {connection && connector.action && (connection.ready || pending) && <Button disabled={!!busy || (connector.action === 'mail' && !trademark.attorney_email && !pending)} onClick={() => setWorking({ connector, connection, action: pending || undefined })}>{pending ? '검토·발송 이어가기' : connector.action === 'contract' ? '계약 서명 요청' : '이 계정으로 메일 작성'}</Button>}
        </div>
        <details className="business-guide-details"><summary>연결 방법 · 웹훅 설정</summary><p>{connector.setup}</p>{connection && connector.auth === 'oauth' && <div className="business-integration-address"><strong>Callback URL</strong><code>{connection.callback_url}</code>{!connection.public_url_configured && <p>서버 AWB_PUBLIC_URL 설정이 필요합니다.</p>}</div>}{connection?.webhook_url && <div className="business-integration-address"><strong>서명 검증 웹훅 URL</strong><code>{connection.webhook_url}</code></div>}<a href={connector.docs_url} target="_blank" rel="noreferrer">공식 API 안내 ↗</a>
          {connection && connection.status !== 'disconnected' && <Button variant="ghost" disabled={!!busy || !!pending} onClick={() => void run(connector.id, async () => { await api.disconnectTrademarkIntegration(company.id, trademark.id, connection); })}>자동 수집 중지 · 연결 해제</Button>}</details>
      </article>;
    })}</div>
    {!!data?.actions.length && <div className="business-integration-history"><h4>발송 · 서명 요청 기록</h4>{data.actions.map(action => <button className="business-trademark-mail-row" key={action.id} onClick={() => openAction(action)}><BusinessIcon name={action.kind === 'contract' ? 'lock' : 'mail'} size={18} /><span><strong>{action.title}</strong><small>{dateTime(action.created_at)} · {action.external_status}</small></span><span className="business-pill">{TRADEMARK_MAIL_STATUS[action.status]}</span></button>)}</div>}
    <div className="business-section-heading"><h4>수집한 회신 · 문서 · 진행 상황</h4><span className="business-muted">최근 갱신 150건</span></div>
    <div className="business-trademark-choices" role="group" aria-label="수집 기록 필터">{[['all', '전체'], ...Object.entries(kinds)].map(([key, label]) => <button key={key} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>)}</div>
    {!visibleRecords.length && <p className="business-muted">연결 후 수집하면 이곳에 회신·계약·공식 기록이 표시됩니다.</p>}
    <div className="business-integration-records">{visibleRecords.map(record => <details key={record.id} className="business-guide-details"><summary><span className="business-pill">{kinds[record.kind]}</span> {record.title || '수집 기록'} <small>{record.status}</small></summary><p className="business-muted">{record.from && `${record.from} · `}{record.date || ''}</p>{!!record.to?.length && <p className="business-muted">수신: {record.to.join(', ')}</p>}{record.text && <pre className="business-trademark-mail-body">{record.text}</pre>}{record.details && <dl className="business-trademark-envelope">{Object.entries(record.details).filter(([, value]) => !!value).map(([key, value]) => <React.Fragment key={key}><dt>{detailLabels[key] || key}</dt><dd>{value}</dd></React.Fragment>)}</dl>}{record.url && /^https:\/\//.test(record.url) && <a href={record.url} target="_blank" rel="noreferrer">공급자 원본에서 확인 ↗</a>}</details>)}</div>
    {setting && <TrademarkIntegrationSetup company={company} trademarkId={trademark.id} {...setting} onClose={() => setSetting(null)} onSaved={changed} />}
    {working && <TrademarkIntegrationAction company={company} trademark={trademark} {...working} replyAddress={replyAddress} onClose={() => setWorking(null)} onChanged={changed} />}
  </section>;
}
