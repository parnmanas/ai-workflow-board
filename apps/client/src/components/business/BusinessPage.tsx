import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import type { BusinessCompany, BusinessConnection, BusinessConnector, BusinessDetail, BusinessMcpConnection, BusinessStage, BusinessTask } from '../../business.types';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { Button, ErrorState, PermissionNotice } from '../common';
import { BusinessIcon } from './BusinessIcon';
import { CompanyForm, ConnectorForm, TaskForm } from './BusinessForms';
import { dateTime, money, nextTasks, overdue, STAGES, TASK_STATUS } from './business.logic';
import { BusinessHowItWorks, BusinessStageGuide } from './BusinessGuide';
import { BusinessSelfServiceForm, BusinessSelfServiceSummary } from './BusinessSelfService';
import { BusinessCashbook } from './BusinessCashbook';
import { BusinessCatalog, BusinessConnectorCard } from './BusinessCatalog';
import { BusinessMcpConnectForm } from './BusinessMcpConnectForm';
import { BusinessTrademarks } from './BusinessTrademarks';
import { BusinessPageHeader } from './BusinessPageHeader';
import { BusinessExecutionStatus, BusinessWorkStartForm } from './BusinessWorkExecution';
import { BusinessTaskWorkspace } from './BusinessTaskWorkspace';

type View = 'overview' | 'operations' | 'connectors';

function rememberedCompany(userId: string): string {
  try { return sessionStorage.getItem(`business.company.${userId}`) || ''; } catch { return ''; }
}

function ProgressRing({ done, total }: { done: number; total: number }) {
  useLocale();
  const percent = total ? Math.round(done / total * 100) : 0;
  return <div className="business-ring" role="img" aria-label={translate('업무 완료율 {0}%', { 0: percent })}>
    <svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="42" className="business-ring-track" /><circle cx="50" cy="50" r="42" className="business-ring-value" pathLength="100" strokeDasharray={`${percent} 100`} /></svg>
    <span><strong>{percent}<small>%</small></strong><small>{translate('업무 완료')}</small></span>
  </div>;
}

function TaskRow({ task, busy, onOpen, onToggle }: { task: BusinessTask; busy: boolean; onOpen(): void; onToggle(): void }) {
  useLocale();
  const stage = STAGES.find(s => s.id === task.stage)!;
  const blocked = task.blocked_by.length > 0 && task.status !== 'done';
  return <div className={`business-task ${task.status === 'done' ? 'is-done' : ''}`}>
    <button type="button" className={`business-check ${task.status === 'done' ? 'checked' : ''}`} aria-label={`${task.title} ${task.status === 'done' ? translate('완료 취소') : translate('완료로 표시')}`} disabled={busy || blocked} onClick={onToggle} title={blocked ? translate('선행 업무를 먼저 완료하세요') : undefined}>
      {task.status === 'done' ? <BusinessIcon name="check" size={15} /> : blocked ? <BusinessIcon name="lock" size={13} /> : null}
    </button>
    <button type="button" className="business-task-body" onClick={onOpen}>
      <span className="business-task-title">{task.title}</span>
      <span className="business-task-meta"><span style={{ color: stage.color }}>{stage.label}</span>{task.owner && <span>◉ {task.owner}</span>}{task.due_on && <span className={overdue(task) ? 'business-overdue' : ''}><BusinessIcon name="clock" size={12} />{task.due_on}{overdue(task) ? translate(' · 기한 지남') : ''}</span>}</span>
    </button>
    <span className={`business-pill ${blocked ? 'blocked' : task.status}`}>{blocked ? translate('선행 {0}건 대기', { 0: task.blocked_by.length }) : TASK_STATUS[task.status]}</span>
    <button type="button" className="business-ticket-link" onClick={onOpen}>{translate('과정·결과 보기')} <BusinessIcon name="arrow" size={14} /></button>
  </div>;
}

function SnapshotPanel({ connector, connection }: { connector: BusinessConnector; connection: BusinessConnection }) {
  useLocale();
  const [expanded, setExpanded] = useState(false);
  const snapshot = connection.snapshot;
  if (!snapshot) return null;
  return <section className="business-panel business-snapshot" aria-label={translate('{0} 조회 데이터', { 0: connector.name })}>
    <div className="business-section-heading"><h3><span className="business-provider-mark" style={{ color: connector.color }}>{connector.monogram}</span>{connector.name}</h3><span className="business-muted">{connection.environment === 'sandbox' && translate('테스트 · ')}{dateTime(connection.synced_at)} {translate('기준')}</span></div>
    {connection.status !== 'connected' && <p className="business-stale">{translate('최근 조회가 완료되지 않아 이전 데이터를 표시합니다.')}</p>}
    <div className="business-live-metrics">{snapshot.metrics.map((metric, i) => <div key={i}><small>{metric.label}{metric.currency ? ` · ${metric.currency}` : ''}</small><strong>{metric.amount_minor === undefined ? metric.value : money(metric.amount_minor, metric.currency)}</strong></div>)}</div>
    {snapshot.records.length > 0 && <div className="business-data-table"><table><thead><tr><th>{translate('항목')}</th><th>{translate('상태')}</th><th>{translate('일시 / 기한')}</th><th>{translate('금액')}</th></tr></thead><tbody>{snapshot.records.slice(0, expanded ? 50 : 6).map((record, i) => <tr key={`${record.id}-${i}`}><td>{record.label}</td><td><span className="business-pill">{record.status}</span></td><td>{record.date ? (/^\d{4}-\d{2}-\d{2}$/.test(record.date) ? record.date : dateTime(record.date)) : '—'}</td><td className="business-money">{record.amount_minor === undefined ? '—' : money(record.amount_minor, record.currency)}</td></tr>)}</tbody></table></div>}
    {snapshot.records.length > 6 && <Button variant="ghost" onClick={() => setExpanded(!expanded)}>{expanded ? translate('접기') : translate('조회된 {0}건 펼치기', { 0: snapshot.records.length })}</Button>}
    <p className="business-source-note">{snapshot.note}</p>
  </section>;
}

export default function BusinessPage({ view }: { view: View }) {
  useLocale();
  const { hasPermission, user } = useAuth();
  const canUse = hasPermission('business.manage');
  const canMarketing = hasPermission('marketing.manage') || hasPermission('marketing.approve_spend');
  const { showToast } = useToast();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [companies, setCompanies] = useState<BusinessCompany[] | null>(null);
  const [connectors, setConnectors] = useState<BusinessConnector[]>([]);
  const [detail, setDetail] = useState<BusinessDetail | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [companyModal, setCompanyModal] = useState<'new' | 'edit' | null>(null);
  const [taskModal, setTaskModal] = useState<BusinessTask | 'new' | null>(null);
  const [connectorModal, setConnectorModal] = useState<BusinessConnector | null>(null);
  const [startWork, setStartWork] = useState(false);
  const [busy, setBusy] = useState('');
  const [filter, setFilter] = useState('all');
  const [mcpModal, setMcpModal] = useState<BusinessConnector | null>(null);
  const [mcp, setMcp] = useState<BusinessMcpConnection[]>([]);
  const [selfModal, setSelfModal] = useState<{ connector: BusinessConnector; plan: string } | null>(null);
  const rememberedId = rememberedCompany(user?.id || '');
  const selectedId = params.get('company') || companies?.find(c => c.id === rememberedId)?.id || companies?.[0]?.id || '';
  const selectedRef = useRef(selectedId); selectedRef.current = selectedId;
  const generation = useRef(0);
  const stageTabsRef = useRef<HTMLDivElement>(null);
  const stage = STAGES.find(s => s.id === params.get('stage')) || STAGES[0];

  useEffect(() => {
    // Deep links and browser Back must reveal the selected stage without moving the page vertically.
    const tabs = stageTabsRef.current;
    const selected = tabs?.querySelector<HTMLElement>('[aria-pressed=true]');
    if (!tabs || !selected) return;
    const reveal = () => {
      const parent = tabs.getBoundingClientRect(); const child = selected.getBoundingClientRect();
      if (child.left < parent.left || child.right > parent.right) tabs.scrollLeft += child.left - parent.left - (parent.width - child.width) / 2;
    };
    reveal();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(reveal); observer.observe(tabs);
    return () => observer.disconnect();
  }, [stage.id, view, !!detail]);

  useEffect(() => {
    if (user?.id && companies?.some(c => c.id === selectedId)) {
      try { sessionStorage.setItem(`business.company.${user.id}`, selectedId); } catch { /* Optional navigation preference. */ }
    }
  }, [selectedId, companies, user?.id]);

  const bootstrap = useCallback(async () => {
    if (!canUse) return;
    setError('');
    try { const [companies, connectors] = await Promise.all([api.listBusinessCompanies(), api.listBusinessConnectors()]); setCompanies(companies); setConnectors(connectors); }
    catch (e) { setError((e as Error).message); }
  }, [canUse, user?.id]);
  useEffect(() => { void bootstrap(); }, [bootstrap]);
  const loadDetail = useCallback(async () => {
    if (!canUse || !selectedId) return;
    const request = ++generation.current;
    setLoading(true);
    try {
      const [data, mcpRows] = await Promise.all([api.getBusinessCompany(selectedId), api.listBusinessMcp(selectedId)]);
      if (request === generation.current && selectedRef.current === selectedId) { setDetail(data); setMcp(mcpRows); setError(''); }
    } catch (e) { if (request === generation.current) setError((e as Error).message); }
    finally { if (request === generation.current) setLoading(false); }
  }, [selectedId, canUse]);
  useEffect(() => {
    setDetail(null); setStartWork(false); setTaskModal(null); setConnectorModal(null); setCompanyModal(null); setMcpModal(null); setMcp([]); setSelfModal(null);
    void loadDetail();
    return () => { generation.current++; };
  }, [loadDetail]);
  useEffect(() => {
    if (view !== 'overview' || !detail?.formation_work || startWork || companyModal) return;
    const timer = window.setInterval(() => { if (!document.hidden) void loadDetail(); }, 10000);
    return () => window.clearInterval(timer);
  }, [view, !!detail?.formation_work, startWork, companyModal, loadDetail]);
  // The provider callback and an agent's sign-in link land with ?mcp=<provider>; open that panel once.
  useEffect(() => {
    const provider = params.get('mcp'); const connector = provider && connectors.find(c => c.id === provider && c.mode === 'mcp');
    if (!connector || !detail || detail.company.id !== selectedId) return;
    setMcpModal(connector);
    const next = new URLSearchParams(params); next.delete('mcp'); setParams(next, { replace: true });
  }, [params, connectors, detail, selectedId, setParams]);
  const reload = async () => {
    await loadDetail();
    setCompanies(await api.listBusinessCompanies());
  };
  const path = (target: View, stageId?: BusinessStage) => `/business${target === 'overview' ? '' : `/${target}`}?company=${encodeURIComponent(selectedId)}${stageId ? `&stage=${stageId}` : ''}`;
  const chooseStage = (stageId: BusinessStage) => { setFilter('all'); navigate(path('operations', stageId)); };
  const toggleTask = async (task: BusinessTask) => {
    if (!detail) return;
    setBusy(task.id);
    try { await api.saveBusinessTask(selectedId, task.id, { revision: detail.company.revision, status: task.status === 'done' ? 'todo' : 'done' }); await reload(); }
    catch (e) { showToast((e as Error).message, 'error'); await loadDetail(); }
    finally { setBusy(''); }
  };
  const sync = async (provider: string) => {
    setBusy(provider);
    try {
      const result = await api.syncBusiness(selectedId, provider);
      if (selectedRef.current === selectedId) { await loadDetail(); showToast(result.last_error || translate('최신 데이터를 조회했습니다.'), result.status === 'error' ? 'error' : 'success'); }
    } catch (e) { showToast((e as Error).message, 'error'); }
    finally { setBusy(''); }
  };

  if (!canUse) return <div className="business-page"><PermissionNotice title={translate('Business 권한이 필요합니다')} message={translate('회사와 운영 데이터를 관리하려면 business.manage 권한이 필요합니다.')} /></div>;
  const company = detail?.company;
  const tasks = detail?.tasks || [];
  const done = tasks.filter(t => t.status === 'done').length;
  const upcoming = nextTasks(tasks);
  const late = tasks.filter(t => overdue(t));
  const connected = detail?.connections.filter(c => c.status === 'connected').length || 0;
  const activeStageTasks = tasks.filter(t => t.stage === stage.id);
  const visibleTasks = activeStageTasks.filter(t => filter === 'all' || (filter === 'open' && t.status !== 'done') || (filter === 'attention' && (overdue(t) || t.status === 'waiting')) || (filter === 'done' && t.status === 'done'));
  const openTask = (taskId: string) => {
    const task = tasks.find(item => item.id === taskId);
    navigate(`${path('operations', task?.stage || stage.id)}&task=${encodeURIComponent(taskId)}`);
  };
  const renderTask = (task: BusinessTask) => <TaskRow key={task.id} task={task} busy={!!busy || loading} onOpen={() => openTask(task.id)} onToggle={() => void toggleTask(task)} />;
  const chooseService = async (connector: BusinessConnector, plan: string) => {
    if (!company) return;
    if (connector.mode === 'manual') { setSelfModal({ connector, plan }); return; }
    setBusy(connector.id);
    try { await api.chooseBusinessService(company.id, connector.stage, { provider: connector.id, plan, revision: company.revision }); await reload(); showToast(translate('사용할 서비스를 저장했습니다. 가입·구매는 해당 신청 단계에서 진행하세요.'), 'success'); }
    catch (e) { showToast((e as Error).message, 'error'); await loadDetail(); }
    finally { setBusy(''); }
  };
  const renderConnector = (connector: BusinessConnector, comparing?: boolean, onCompare?: () => void) => company && <BusinessConnectorCard key={connector.id} connector={connector} company={company} connection={detail?.connections.find(c => c.provider === connector.id)} mcpConnection={mcp.find(row => row.provider === connector.id)} busy={!!busy || loading} onSetup={() => setConnectorModal(connector)} onSync={() => void sync(connector.id)} onChoose={plan => void chooseService(connector, plan)} onMcp={() => setMcpModal(connector)} comparing={comparing} onCompare={onCompare} onOpenData={view === 'connectors' ? () => chooseStage(connector.stage) : undefined} />;

  if (company && detail && params.get('task')) return <BusinessTaskWorkspace key={`${company.id}-${params.get('task')}`} detail={detail} taskId={params.get('task')!} onBack={() => navigate(path('operations', stage.id))} onChanged={reload} onOpenTask={openTask} />;

  return <div className="business-page" aria-busy={loading}>
    <BusinessPageHeader
      title={view === 'overview' ? translate('비즈니스 전체 흐름') : view === 'operations' ? translate('운영 워크플로') : translate('커넥터')}
      context={!!companies?.length && <select className="business-company-picker" aria-label={translate('관리할 회사')} title={companies.find(c => c.id === selectedId)?.name} value={selectedId} onChange={e => { const next = new URLSearchParams(params); next.set('company', e.target.value); next.delete('trademark'); next.delete('authorize'); setParams(next); }}>{!companies.some(c => c.id === selectedId) && <option value={selectedId}>{translate('회사 선택')}</option>}{companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
      actions={<Button variant="secondary" aria-label={translate('회사 추가')} title={translate('회사 추가')} onClick={() => setCompanyModal('new')}><BusinessIcon name="plus" size={18} /><span className="business-header-action-label">{translate('회사 추가')}</span></Button>}
      moreActions={selectedId ? close => <Button variant="ghost" disabled={loading || !!busy} onClick={() => { close(); void reload().catch(e => showToast(e.message, 'error')); }}><BusinessIcon name="refresh" size={16} />{translate('워크플로 새로고침')}</Button> : undefined}
    />
    {view === 'connectors' && <section className="business-panel business-mail-catalog"><div><h2>{translate('메일 자동화 커넥터')}</h2><p className="business-muted">{translate('SMTP · IMAP · JMAP 연결을 등록하고 여러 업무 주소의 수신·발신 결과를 함께 확인합니다.')}</p></div><Link to="/business/mail?connections=1">{translate('메일 연결 관리 →')}</Link></section>}
    {startWork && company && <BusinessWorkStartForm company={company} onClose={() => setStartWork(false)} onStarted={async run => { await reload(); setStartWork(false); openTask(run.task_id); }} />}
    {error && <ErrorState message={error} onRetry={() => void (companies === null ? bootstrap() : loadDetail())} />}
    {companies === null && !error && <div className="business-loading" role="status">{translate('비즈니스를 불러오는 중…')}</div>}
    {companies?.length === 0 && !error && <section className="business-welcome">
      <div className="business-welcome-art" aria-hidden="true"><div className="business-welcome-center"><BusinessIcon name="formation" size={44} /></div>{STAGES.slice(1).map((s, i) => <span key={s.id} className={`business-orbit orbit-${i}`} style={{ color: s.color }}><BusinessIcon name={s.id} size={25} /></span>)}</div>
      <span className="business-eyebrow">{translate('BUILD → RUN → GROW')}</span><h2>{translate('회사를 만들고,')}<br />{translate('하나의 흐름으로 운영하세요.')}</h2><p>{translate('설립, 금융, 회계, 고객지원, 마케팅.')}<br />{translate('흩어진 업무와 서비스를 한곳에서 연결합니다.')}</p><p className="business-guide-note">{translate('먼저 AWB에 관리할 회사를 등록하세요.')}<br />{translate('등록한 회사에서 목표와 담당 에이전트를 선택하면 조사와 신청 준비를 시작합니다.')}</p>
      <Button size="lg" onClick={() => setCompanyModal('new')}><BusinessIcon name="plus" size={18} />{translate('첫 회사 등록하기')}</Button>
      <div className="business-welcome-stages">{STAGES.map(s => <span key={s.id}><BusinessIcon name={s.id} size={18} />{s.label}</span>)}</div>
    </section>}
    {selectedId && !detail && !error && companies !== null && <div className="business-loading" role="status">{translate('회사의 워크플로를 불러오는 중…')}</div>}
    {company && detail && <>
      {view === 'overview' && <>
        <section className="business-hero">
          <div className="business-hero-copy"><div className="business-company-meta"><span className="business-pill">{company.entity_type === 'other' ? translate('회사') : company.entity_type}</span><span>{[company.country, company.jurisdiction].filter(Boolean).join(' · ')}</span></div><h2>{company.name}</h2><p>{company.description || translate('설립부터 매일의 운영까지, 다음 단계를 이어가세요.')}</p>
            <div className="business-card-actions"><Button onClick={() => company.formation_task_id ? openTask(company.formation_task_id) : setStartWork(true)}>{company.formation_task_id ? translate('회사 설립 진행 보기') : translate('회사 설립 맡기기')} <BusinessIcon name="arrow" size={16} /></Button><Button variant="ghost" onClick={() => setCompanyModal('edit')}>{translate('회사 정보 · 캠페인 연결')}</Button></div>
          </div><ProgressRing done={done} total={tasks.length} />
        </section>
        {detail.formation_work && <BusinessExecutionStatus runs={[detail.formation_work]} onReply={() => openTask(detail.formation_work!.task_id)} onConfigure={() => setStartWork(true)} />}
        <BusinessHowItWorks onStart={() => company.formation_task_id ? openTask(company.formation_task_id) : setStartWork(true)} />
        <div className="business-stats">
          <button onClick={() => navigate(path('operations'))}><span className="business-stat-icon"><BusinessIcon name="check" /></span><div><small>{translate('완료한 업무')}</small><strong>{done}<em> / {tasks.length}</em></strong></div></button>
          <button onClick={() => chooseStage(tasks.find(t => t.status === 'in_progress')?.stage || 'formation')}><span className="business-stat-icon blue"><BusinessIcon name="workflow" /></span><div><small>{translate('진행 중')}</small><strong>{tasks.filter(t => t.status === 'in_progress').length}<em>{translate('건')}</em></strong></div></button>
          <button onClick={() => { chooseStage(late[0]?.stage || 'accounting'); setFilter('attention'); }}><span className={`business-stat-icon ${late.length ? 'amber' : ''}`}><BusinessIcon name="clock" /></span><div><small>{translate('기한 지난 업무')}</small><strong>{late.length}<em>{translate('건')}</em></strong></div></button>
          <button onClick={() => navigate(path('connectors'))}><span className="business-stat-icon mint"><BusinessIcon name="connector" /></span><div><small>{translate('연결된 서비스')}</small><strong>{connected}<em>{translate('개')}</em></strong></div></button>
        </div>
        <section className="business-journey-section"><div className="business-section-heading"><h2>{translate('회사의 성장 흐름')}</h2><span className="business-muted">{translate('단계를 선택해 업무를 관리하세요')}</span></div>
          <div className="business-journey">{STAGES.map((s, index) => {
            const stageTasks = tasks.filter(t => t.stage === s.id); const finished = stageTasks.filter(t => t.status === 'done').length;
            const allDone = stageTasks.length > 0 && finished === stageTasks.length;
            const waiting = stageTasks.filter(t => t.blocked_by.length && t.status !== 'done').length;
            return <button key={s.id} className={`business-stage-card ${allDone ? 'complete' : ''}`} style={{ '--stage-color': s.color } as React.CSSProperties} onClick={() => chooseStage(s.id)}>
              <div className="business-stage-top"><span className="business-stage-icon"><BusinessIcon name={s.id} size={25} /></span><span className="business-stage-number">{allDone ? <BusinessIcon name="check" size={16} /> : `0${index + 1}`}</span></div>
              <small>{s.eyebrow}</small><h3>{s.label}</h3><div className="business-progress-track" role="progressbar" aria-label={translate('{0} 업무 완료', { 0: s.label })} aria-valuenow={finished} aria-valuemin={0} aria-valuemax={stageTasks.length || 1}><span style={{ width: `${stageTasks.length ? finished / stageTasks.length * 100 : 0}%` }} /></div>
              <div className="business-stage-footer"><span>{finished} / {stageTasks.length} {translate('완료')}</span>{waiting > 0 ? <span title={translate('선행 업무 완료 후 진행')}>{translate('대기')} {waiting}</span> : <BusinessIcon name="arrow" size={15} />}</div>
            </button>;
          })}</div>
        </section>
        <div className="business-overview-grid"><section className="business-panel"><div className="business-section-heading"><h2>{translate('지금 할 수 있는 일')} <span className="business-count">{upcoming.length}</span></h2><Button variant="ghost" onClick={() => setTaskModal('new')}><BusinessIcon name="plus" size={14} />{translate('업무 추가')}</Button></div>
          {upcoming.length ? upcoming.slice(0, 5).map(renderTask) : <div className="business-small-empty"><BusinessIcon name="check" size={28} /><p>{done === tasks.length ? translate('등록한 업무를 모두 마쳤습니다.') : translate('선행 업무와 외부 응답을 확인하세요.')}</p><Button variant="ghost" onClick={() => navigate(path('operations'))}>{translate('운영 워크플로 열기')}</Button></div>}
        </section><section className="business-panel"><div className="business-section-heading"><h2>{translate('최근 활동')}</h2><BusinessIcon name="clock" size={16} /></div><ol className="business-timeline">{detail.events.slice(0, 6).map(event => <li key={event.id}><span className="business-timeline-dot" /><div><p>{event.message}</p><time>{dateTime(event.created_at)}</time></div></li>)}</ol></section></div>
        {canMarketing && <GrowthPanel detail={detail} onLink={() => setCompanyModal('edit')} />}
      </>}
      {view === 'operations' && <>
        <div ref={stageTabsRef} className="business-stage-tabs" role="group" aria-label={translate('운영 영역')}>{STAGES.map(s => <button key={s.id} aria-pressed={stage.id === s.id} onClick={() => chooseStage(s.id)} style={{ '--stage-color': s.color } as React.CSSProperties}><BusinessIcon name={s.id} size={19} /><span>{s.label}</span><small>{tasks.filter(t => t.stage === s.id && t.status !== 'done').length}</small></button>)}</div>
        <div className="business-operations-heading"><div><span className="business-eyebrow" style={{ color: stage.color }}>{stage.eyebrow}</span><h2>{stage.label}</h2><p>{stage.description}</p></div><Button onClick={() => setTaskModal('new')}><BusinessIcon name="plus" size={16} />{translate('업무 추가')}</Button></div>
        <BusinessStageGuide stage={stage.id} connectors={connectors} connectorsPath={path('connectors')} canMarketing={canMarketing} />
        {stage.id === 'formation' && company.service_choices?.formation?.provider === 'self_formation' && <BusinessSelfServiceSummary key={company.id} company={company} provider="self_formation" plan={company.service_choices.formation.plan} onReview={() => { const connector = connectors.find(c => c.id === 'self_formation'); if (connector) setSelfModal({ connector, plan: company.service_choices!.formation!.plan }); }} />}
        {stage.id === 'accounting' && <BusinessCashbook key={company.id} company={company} onChanged={reload} onSetup={() => { const connector = connectors.find(c => c.id === 'self_bookkeeping'); if (connector) setSelfModal({ connector, plan: 'cashbook' }); }} />}
        {stage.id === 'trademark' && <BusinessTrademarks key={company.id} company={company} hasTasks={activeStageTasks.length > 0} onChanged={reload} />}
        <section className="business-panel"><div className="business-section-heading"><h3>{translate('업무')} <span className="business-count">{activeStageTasks.length}</span></h3><select className="business-filter" aria-label={translate('업무 필터')} value={filter} onChange={e => setFilter(e.target.value)}><option value="all">{translate('모든 업무')}</option><option value="open">{translate('미완료')}</option><option value="attention">{translate('기한 초과 · 응답 대기')}</option><option value="done">{translate('완료')}</option></select></div>
          {visibleTasks.length ? visibleTasks.map(renderTask) : <div className="business-small-empty"><BusinessIcon name={stage.id} size={28} /><p>{translate('표시할 업무가 없습니다.')}</p><Button variant="ghost" onClick={() => setTaskModal('new')}>{translate('새 업무 추가')}</Button></div>}
        </section>
        {stage.id === 'growth' && canMarketing && <GrowthPanel detail={detail} onLink={() => setCompanyModal('edit')} />}
        <div className="business-section-heading business-spaced"><h2>{translate('연결 서비스')}</h2><Link to={path('connectors')}>{translate('모든 커넥터')} <BusinessIcon name="arrow" size={14} /></Link></div>
        <div className="business-connectors-grid">{connectors.filter(c => c.stage === stage.id).map(c => renderConnector(c))}</div>
        {stage.id === 'growth' && <div className="business-marketing-flow"><BusinessIcon name="growth" size={24} /><span>{translate('채널 탐색 → 콘텐츠 · 예산 승인 → 실행 → 분석 → 제품 개선')}</span>{canMarketing && <Link to="/marketing">{translate('마케팅 열기 ↗')}</Link>}</div>}
        {detail.connections.filter(c => c.snapshot && connectors.find(p => p.id === c.provider)?.stage === stage.id).map(connection => <SnapshotPanel key={connection.id} connection={connection} connector={connectors.find(c => c.id === connection.provider)!} />)}
      </>}
      {view === 'connectors' && <>
        <div className="business-connectors-intro"><div><h2>{translate('필요한 기능을 연결하세요.')}</h2><p>{translate('가격·기능·진행 방식을 비교하고 우리 회사에 맞는 서비스를 선택하세요. 내부 신청, 외부 처리 후 조회, 외부 서비스와 업무 기록을 한 흐름으로 연결합니다.')}</p></div><div className="business-connector-summary"><BusinessIcon name="connector" size={24} /><strong>{connected}</strong><span>{translate('서비스 연결됨')}</span></div></div>
        <BusinessCatalog key={company.id} company={company} connectors={connectors} initialStage={params.get('stage') || 'all'} renderCard={renderConnector} />
        <div className="business-marketing-flow"><BusinessIcon name="growth" size={25} /><div><strong>{translate('마케팅 채널과 결제 커넥터')}</strong><p>{translate('기존 캠페인의 커뮤니티, 메일, 광고 · 결제 연결을 그대로 사용합니다.')}</p></div>{canMarketing && <Link to="/marketing">{translate('캠페인 관리')} <BusinessIcon name="arrow" size={16} /></Link>}</div>
      </>}
    </>}
    {companyModal && <CompanyForm key={`${companyModal}-${selectedId}`} company={companyModal === 'edit' ? company : undefined} onClose={() => setCompanyModal(null)} onSaved={async id => { setCompanyModal(null); setCompanies(await api.listBusinessCompanies()); if (id !== selectedId) setParams({ company: id }); else await loadDetail(); showToast(translate('회사의 워크플로를 저장했습니다.'), 'success'); }} />}
    {company && taskModal && <TaskForm key={typeof taskModal === 'string' ? 'new' : taskModal.id} company={company} task={taskModal === 'new' ? undefined : taskModal} tasks={tasks} stage={stage.id} onClose={() => setTaskModal(null)} onSaved={async () => { setTaskModal(null); await reload(); }} />}
    {company && mcpModal && <BusinessMcpConnectForm key={`${company.id}-${mcpModal.id}`} company={company} connector={mcpModal} connection={mcp.find(row => row.provider === mcpModal.id)} onClose={() => setMcpModal(null)} onChanged={reload} />}
    {company && selfModal && <BusinessSelfServiceForm key={`${company.id}-${selfModal.connector.id}-${selfModal.plan}`} company={company} connector={selfModal.connector} plan={selfModal.plan} onClose={() => setSelfModal(null)} onSaved={async () => { const stageId = selfModal.connector.stage; setSelfModal(null); await reload(); chooseStage(stageId); }} />}
    {company && connectorModal && <ConnectorForm key={connectorModal.id} company={company} connector={connectorModal} connection={detail?.connections.find(c => c.provider === connectorModal.id)} onClose={() => setConnectorModal(null)} onSaved={async () => { setConnectorModal(null); await reload(); }} />}
  </div>;
}

function GrowthPanel({ detail, onLink }: { detail: BusinessDetail; onLink(): void }) {
  useLocale();
  return <section className="business-panel business-growth-panel"><div className="business-section-heading"><h2><BusinessIcon name="growth" size={20} />{translate('이 회사의 마케팅')}</h2><Button variant="ghost" onClick={onLink}>{translate('캠페인 연결')}</Button></div>
    {detail.campaigns.length ? <div className="business-campaigns">{detail.campaigns.map(c => <Link key={c.id} to={`/marketing/${encodeURIComponent(c.id)}`}><span className="business-campaign-icon"><BusinessIcon name="growth" /></span><div><strong>{c.name}</strong><p>{c.goal || translate('캠페인 운영 현황 보기')}</p><small>{c.cycle_count}{translate('회 사이클 ·')} {c.status}</small></div><BusinessIcon name="arrow" size={18} /></Link>)}</div> : <div className="business-empty-inline"><span>{translate('캠페인을 연결해 운영과 성장을 함께 관리하세요.')}</span><Link to="/marketing">{translate('마케팅 캠페인 열기 ↗')}</Link></div>}
  </section>;
}
