import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import type { BusinessCompany, BusinessRunInput, BusinessTaskRun } from '../../business.types';
import { t } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import { assigneeDisplayName } from '../../tickets/assignee';
import { useHostNames } from '../../runtime/useHostNames';
import { isRuntimeSpecComplete } from '../../runtime/runtimeSpec';
import RuntimeSpecEditor, { emptyRuntimeSpec, type RuntimeHostChoice, type RuntimeSpecDraft } from '../runtime/RuntimeSpecEditor';
import { Button, Modal, Textarea } from '../common';
import Markdown from '../common/Markdown';
import { dateTime } from './business.logic';

export const FORMATION_GOAL = '회사 설립을 진행해 주세요. 현재 회사 정보를 바탕으로 설립 방식과 비용을 조사·비교하고, 신청서와 필요한 문서를 준비해 주세요. 제가 결정하거나 입력해야 할 사항은 추천안과 이유를 모아 질문해 주세요. 신청 제출·비용 승인·본인 서명이 필요한 단계에서 확인을 요청하고, 진행 과정과 결과를 이 업무에 계속 남겨 주세요.';
const states = { queued: '실행 대기', running: '에이전트 작업 중', needs_input: '내 확인이 필요합니다', completed: '작업 완료', failed: '실행 확인 필요' };

export function BusinessExecutionStatus({ runs, onReply, onConfigure }: { runs: BusinessTaskRun[]; onReply(): void; onConfigure(): void }) {
  useLocale();
  const names = useHostNames();
  const run = runs.find(item => item.status === 'running') || runs[0];
  if (!run) return null;
  const queued = runs.filter(item => item.status === 'queued').length;
  return <section className={`business-panel business-execution ${run.status}`} aria-label={t('에이전트 실행')}>
    <div className="business-section-heading"><h2>{t(states[run.status])}</h2><span className="business-muted">{dateTime(run.started_at || run.created_at)}</span></div>
    <p className="business-muted">{assigneeDisplayName(run.agent_runtime, names)}</p>
    {run.last_error && <p role="status">{t(run.last_error)}</p>}
    {run.status === 'running' && <p>{t('에이전트가 이 업무를 진행하고 있습니다. 결과와 필요한 질문이 여기에 표시됩니다.')}</p>}
    {queued > 0 && <p role="status">{t('요청 {0}건이 순서대로 실행을 기다립니다.', { 0: queued })}</p>}
    {run.status === 'needs_input' && <div className="business-execution-question"><Markdown text={run.question} /></div>}
    <div className="business-card-actions">
      {(run.status === 'needs_input' || run.status === 'failed') && <Button onClick={onReply}>{run.status === 'needs_input' ? t('답변하고 이어서 진행') : t('이어서 요청하기')}</Button>}
      <Button variant="ghost" onClick={onConfigure}>{t('담당 에이전트 설정')}</Button>
    </div>
  </section>;
}

export function BusinessWorkStartForm({ company, taskId, initialContent, onClose, onStarted }: {
  company: BusinessCompany; taskId?: string; initialContent?: string; onClose(): void; onStarted(run: BusinessTaskRun): Promise<void>;
}) {
  useLocale();
  const [runtime, setRuntime] = useState<RuntimeSpecDraft>(() => ({ ...emptyRuntimeSpec(), ...company.agent_runtime }));
  const [content, setContent] = useState(initialContent ?? (taskId ? t('이 업무의 기존 결과와 요청을 확인하고 이어서 진행해 주세요.') : t(FORMATION_GOAL)));
  const [hosts, setHosts] = useState<RuntimeHostChoice[]>([]);
  const [hostError, setHostError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const pending = useRef<BusinessRunInput | null>(null);
  const names = useHostNames();
  useEffect(() => {
    let active = true;
    api.listTemplateHosts().then(rows => { if (active) { setHosts(rows); setHostError(''); } })
      .catch(e => { if (active) setHostError(e.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [company.account_id]);
  const start = async () => {
    setBusy(true); setError('');
    try {
      const validated = await api.validateRuntimeSpec(company.account_id, runtime);
      if (!validated.ok || !validated.spec) throw new Error(validated.error || t('담당 에이전트 설정을 확인하세요.'));
      const draft = { content: content.trim(), agent_runtime: validated.spec };
      const previous = pending.current;
      const input = previous && JSON.stringify({ content: previous.content, agent_runtime: previous.agent_runtime }) === JSON.stringify(draft)
        ? previous : { ...draft, request_id: crypto.randomUUID() };
      pending.current = input;
      const run = await api.startBusinessWork(company.id, taskId || null, input);
      await onStarted(run);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <Modal isOpen className="business-execution-dialog" title={t('에이전트에게 업무 맡기기')} maxWidth={680} onClose={() => { if (!busy) onClose(); }} footer={<div className="business-execution-footer">
    {error && <p role="alert" className="business-error">{error}</p>}
    <div className="business-card-actions"><Button variant="secondary" disabled={busy} onClick={onClose}>{t('취소')}</Button><Button loading={busy} disabled={!content.trim() || !isRuntimeSpecComplete(runtime)} onClick={() => void start()}>{t('이 설정으로 실행')}</Button></div>
  </div>}>
    <div className="business-form">
      <p>{t('목표를 맡기면 에이전트가 조사와 준비를 진행합니다. 필요한 결정과 승인만 이 업무에서 요청합니다.')}</p>
      <Textarea label={t('맡길 목표 · 요청')} aria-label={t('맡길 목표 · 요청')} value={content} onChange={e => setContent(e.target.value)} disabled={busy} rows={6} maxLength={20000} />
      <details className="business-execution-settings" open={!company.agent_runtime || undefined}>
        <summary>{t('담당 에이전트 설정')}{company.agent_runtime && ` · ${assigneeDisplayName(company.agent_runtime, names)}`}</summary>
        <p className="business-muted">{t('한 번 선택하면 이 회사의 다음 요청에도 사용합니다. 작업 폴더에는 에이전트가 만든 문서가 보관됩니다.')}</p>
        {loading && <p role="status">{t('Host 목록을 불러오는 중…')}</p>}
        {hostError && <p role="alert">{hostError}</p>}
        {!loading && !hosts.length && <p>{t('연결된 Runtime Host가 없습니다.')} <Link to="/hosts">{t('Hosts에서 연결하기')}</Link></p>}
        <RuntimeSpecEditor value={runtime} onChange={setRuntime} hosts={hosts} accountId={company.account_id} disabled={busy} showProjectFolderHelper={false} />
      </details>
    </div>
  </Modal>;
}
