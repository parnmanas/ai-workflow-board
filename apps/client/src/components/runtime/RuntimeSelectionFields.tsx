import React, { useEffect, useId, useState } from 'react';
import { api } from '../../api';
import type { AgentTemplate } from '../../types';
import { hostEffortReport } from '../../cli/hostEfforts';
import { cliEffortKeys } from '../../cli/catalog';
import { cliModelChoices, loadHostModels, useHostModels } from '../../cli/hostModels';
import { Button, Input, Select } from '../common';
import RuntimeConfigFields, { buildRuntimeConfig, runtimeSelectionFromAgent } from '../admin/RuntimeConfigFields';
import SessionModelSelect from '../sessions/SessionModelSelect';

export interface RuntimeSelectionValue {
  host_id: string;
  cli: string;
  model: string | null;
  effort: string | null;
  runtime_config: Record<string, any>;
}
export interface RuntimeSelectionHost { id: string; name: string; clis?: string[] }

export function emptyRuntimeSelection(): RuntimeSelectionValue {
  return { host_id: '', cli: '', model: null, effort: null, runtime_config: { strategy: 'single', permission_mode: 'approve' } };
}

export function applyAgentTemplate(template: AgentTemplate): RuntimeSelectionValue {
  return {
    host_id: template.host_id, cli: template.cli, model: template.model, effort: template.effort,
    runtime_config: structuredClone(template.runtime_config),
  };
}

/** Shared by templates, sessions, board/chat declarations and team slots. */
export default function RuntimeSelectionFields({ value, onChange, hosts, disabled = false, showTemplates = true, session = false, idPrefix, modelConfigId }: {
  value: RuntimeSelectionValue;
  onChange(value: RuntimeSelectionValue, source?: 'template' | 'host' | 'cli'): void;
  hosts: RuntimeSelectionHost[];
  disabled?: boolean;
  showTemplates?: boolean;
  session?: boolean;
  idPrefix?: string;
  modelConfigId?: string;
}) {
  const generatedId = useId();
  const controlId = idPrefix || `runtime-${generatedId}`;
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<AgentTemplate | null>(null);
  const [templatesLoading, setTemplatesLoading] = useState(showTemplates);
  const [error, setError] = useState('');
  const hostModels = useHostModels(value.host_id || null, value.cli || null);
  const effortReport = hostEffortReport(hostModels.view, value.cli, value.model);
  const supportsLaunchEffort = session || cliEffortKeys(value.cli).includes('effort');
  const effortOptions = supportsLaunchEffort && effortReport?.config_id ? effortReport.options : [];
  useEffect(() => {
    // A session may have reported new options since another form cached this Host.
    if (value.host_id && value.cli) void loadHostModels(value.host_id);
  }, [value.host_id, value.cli, value.model]);
  const host = hosts.find((h) => h.id === value.host_id);
  const set = (patch: Partial<RuntimeSelectionValue>) => onChange({ ...value, ...patch });
  useEffect(() => {
    if (!showTemplates) return;
    let disposed = false;
    setTemplatesLoading(true);
    setError('');
    api.listAgentTemplates().then((rows) => { if (!disposed) setTemplates(rows); })
      .catch((e) => { if (!disposed) setError(e.message || 'Agent 템플릿을 불러오지 못했습니다.'); })
      .finally(() => { if (!disposed) setTemplatesLoading(false); });
    return () => { disposed = true; };
  }, [showTemplates]);
  const availableTemplates = templates.filter((t) => {
    const candidate = hosts.find((h) => h.id === t.host_id);
    return candidate && (!candidate.clis || (!session && !candidate.clis.length) || candidate.clis.includes(t.cli));
  });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {showTemplates && <div>
        <Select id={`${controlId}-template`} aria-label="Agent 템플릿 (선택 사항)" label="Agent 템플릿 (선택 사항)"
          aria-describedby={`${controlId}-template-help`} value={selectedTemplate?.id || ''} disabled={disabled || templatesLoading} options={[
            { value: '', label: '사용 안 함' },
            ...(selectedTemplate && !availableTemplates.some((t) => t.id === selectedTemplate.id)
              ? [{ value: selectedTemplate.id, label: selectedTemplate.name, disabled: true }] : []),
            ...availableTemplates.map((t) => ({ value: t.id, label: t.name })),
          ]} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
            const template = availableTemplates.find((t) => t.id === e.target.value) || null;
            setSelectedTemplate(template);
            // Clearing the starting template must not discard edits to the execution settings.
            if (template) onChange(applyAgentTemplate(template), 'template');
          }} />
        <p id={`${controlId}-template-help`} style={{ fontSize: 12, margin: '6px 0 0' }}>
          {selectedTemplate
            ? `‘${selectedTemplate.name}’에서 불러온 설정입니다. 아래 값을 수정해도 저장된 템플릿은 바뀌지 않습니다.`
            : '아래에서 직접 설정하거나, 템플릿을 선택해 저장된 설정을 불러온 뒤 수정할 수 있습니다.'}
        </p>
        {!templatesLoading && !error && !availableTemplates.length && <p style={{ fontSize: 12, margin: '6px 0 0' }}>
          {templates.length ? '현재 사용할 수 있는 Host·CLI에 맞는 Agent 템플릿이 없습니다.' : '등록된 Agent 템플릿이 없습니다.'}
          {' '}관리자는 Hosts → Agent 템플릿에서 템플릿을 등록할 수 있습니다.
        </p>}
      </div>}
      {error && <div role="alert">{error}</div>}
      <Select id={`${controlId}-host`} label="Runtime Host" value={value.host_id} disabled={disabled} options={[
        { value: '', label: '선택…' },
        ...(value.host_id && !host ? [{ value: value.host_id, label: `${value.host_id} (unavailable)` }] : []),
        ...hosts.map((h) => ({ value: h.id, label: h.name })),
      ]} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
        const nextHost = hosts.find((h) => h.id === e.target.value);
        const cli = nextHost?.clis && !nextHost.clis.includes(value.cli) ? nextHost.clis[0] || '' : value.cli;
        onChange({ ...emptyRuntimeSelection(), host_id: e.target.value, cli }, 'host');
      }} />
      {session ? <Select id={`${controlId}-cli`} label="CLI" value={value.cli} disabled={disabled || !host} options={[
        { value: '', label: '선택…' }, ...(!host && value.cli ? [{ value: value.cli, label: value.cli }] : []), ...(host?.clis || []).map((c) => ({ value: c, label: c })),
      ]} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onChange({ ...value, cli: e.target.value, model: null, effort: null }, 'cli')} /> :
        <RuntimeConfigFields value={runtimeSelectionFromAgent(value.cli, value.runtime_config as any)} disabled={disabled || !value.host_id}
          availableRuntimeIds={host?.clis?.length ? host.clis : undefined} onChange={(selection) => {
            const changed = selection.runtime !== value.cli;
            set({ cli: selection.runtime, runtime_config: buildRuntimeConfig(selection) || { strategy: 'single', permission_mode: 'approve' },
              ...(changed ? { model: null, effort: null } : {}) });
          }} />}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <div style={{ flex: 1 }}>
          {session ? <SessionModelSelect models={hostModels.models} labels={hostModels.labels}
            label="Model" data-config-id={modelConfigId} value={value.model} disabled={disabled || !value.cli}
            style={{ width: '100%', padding: '8px 10px' }}
            onChange={(model) => set({ model: model || null, effort: null })} /> :
            hostModels.models.length ? <Select data-config-id={modelConfigId} label="Model" value={value.model || ''} disabled={disabled || !value.cli} options={[
            { value: '', label: 'Default — CLI' }, ...cliModelChoices(hostModels.models, hostModels.labels, value.model),
            ...(value.model && !hostModels.models.includes(value.model) ? [{ value: value.model, label: `${value.model} (not listed by this host)` }] : []),
          ]} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => set({ model: e.target.value || null, effort: null })} /> :
            <Input label="Model" value={value.model || ''} disabled={disabled || !value.cli} placeholder="CLI default"
              onChange={(e) => set({ model: e.target.value || null, effort: null })} />}
        </div>
        <Button variant="ghost" size="sm" disabled={disabled || !value.cli || !value.host_id || hostModels.refreshing} onClick={() => void hostModels.refresh()}>
          {hostModels.refreshing ? '새로고침 중…' : '새로고침'}
        </Button>
      </div>
      <Select id={`${controlId}-effort`} aria-label="Effort" label="Effort" value={value.effort || ''}
        disabled={disabled || !value.cli || !value.host_id} options={[
          { value: '', label: 'CLI 기본값' }, ...effortOptions,
          ...(value.effort && !effortOptions.some((o) => o.value === value.effort)
            ? [{ value: value.effort, label: `${value.effort} (지원 여부 미확인)`, disabled: true }] : []),
        ]} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => set({ effort: e.target.value || null })} />
      {!effortOptions.length && value.cli && <div role="status" style={{ fontSize: 12 }}>
        {hostModels.loading ? 'Effort 선택지를 불러오는 중…'
          : !supportsLaunchEffort ? '이 CLI는 실행 설정의 Effort 지정을 지원하지 않습니다. CLI 기본값을 사용하세요.'
          : effortReport ? '이 모델의 ACP 보고에 Effort 선택지가 없습니다. CLI 기본값을 사용하세요.'
          : !value.model ? '모델을 선택하면 해당 모델의 Effort 선택지를 표시합니다.'
          : '이 Host·CLI·모델의 Effort 선택지가 아직 보고되지 않았습니다. 해당 모델로 세션을 연결한 뒤 새로고침하세요.'}
      </div>}
      {hostModels.error && <div role="status">{hostModels.error}</div>}
    </div>
  );
}
