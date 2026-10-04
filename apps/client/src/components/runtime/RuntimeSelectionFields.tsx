import { cliEffortKeys } from '../../cli/catalog';
import React, { useEffect, useId, useState } from 'react';
import { api } from '../../api';
import type { AgentTemplate } from '../../types';
import { cliModelChoices, useHostModels } from '../../cli/hostModels';
import { Button, Input, Select } from '../common';
import RuntimeConfigFields, { buildRuntimeConfig, runtimeSelectionFromAgent } from '../admin/RuntimeConfigFields';

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
export default function RuntimeSelectionFields({ value, onChange, hosts, disabled = false, showTemplates = true, session = false, effortOptions, idPrefix, modelConfigId }: {
  value: RuntimeSelectionValue;
  onChange(value: RuntimeSelectionValue, source?: 'template' | 'host' | 'cli'): void;
  hosts: RuntimeSelectionHost[];
  disabled?: boolean;
  showTemplates?: boolean;
  session?: boolean;
  idPrefix?: string;
  modelConfigId?: string;
  effortOptions?: Array<{ value: string; label: string }>;
}) {
  const generatedId = useId();
  const controlId = idPrefix || `runtime-${generatedId}`;
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [error, setError] = useState('');
  const hostModels = useHostModels(value.host_id || null, value.cli || null);
  const supportsEffort = session ? !!effortOptions?.length : cliEffortKeys(value.cli).includes('effort');
  const host = hosts.find((h) => h.id === value.host_id);
  const set = (patch: Partial<RuntimeSelectionValue>) => onChange({ ...value, ...patch });
  useEffect(() => {
    if (!showTemplates) return;
    let disposed = false;
    api.listAgentTemplates().then((rows) => { if (!disposed) setTemplates(rows); })
      .catch((e) => { if (!disposed) setError(e.message || 'Could not load Agent templates'); });
    return () => { disposed = true; };
  }, [showTemplates]);
  const availableTemplates = templates.filter((t) => {
    const candidate = hosts.find((h) => h.id === t.host_id);
    return candidate && (!candidate.clis || (!session && !candidate.clis.length) || candidate.clis.includes(t.cli));
  });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {showTemplates && <Select label="Agent template" value="" disabled={disabled} options={[
        { value: '', label: '직접 설정 / 템플릿 불러오기…' },
        ...availableTemplates.map((t) => ({ value: t.id, label: t.name })),
      ]} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
        const template = availableTemplates.find((t) => t.id === e.target.value);
        if (template) onChange(applyAgentTemplate(template), 'template');
      }} />}
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
          {hostModels.models.length ? <Select data-config-id={modelConfigId} label="Model" value={value.model || ''} disabled={disabled || !value.cli} options={[
            { value: '', label: 'Default — CLI' }, ...cliModelChoices(hostModels.models, hostModels.labels, value.model),
            ...(value.model && !hostModels.models.includes(value.model) ? [{ value: value.model, label: `${value.model} (not listed by this host)` }] : []),
          ]} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => set({ model: e.target.value || null })} /> :
            <Input label="Model" value={value.model || ''} disabled={disabled || !value.cli} placeholder="CLI default"
              onChange={(e) => set({ model: e.target.value || null })} />}
        </div>
        <Button variant="ghost" size="sm" disabled={disabled || !value.cli || !value.host_id || hostModels.refreshing} onClick={() => void hostModels.refresh()}>
          {hostModels.refreshing ? '새로고침 중…' : '새로고침'}
        </Button>
      </div>
      {effortOptions?.length ? <Select label="Effort" value={value.effort || ''} disabled={disabled || !value.cli} options={[
        { value: '', label: 'CLI default' }, ...effortOptions,
        ...(value.effort && !effortOptions.some((o) => o.value === value.effort) ? [{ value: value.effort, label: value.effort }] : []),
      ]} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => set({ effort: e.target.value || null })} /> :
        <Input label="Effort" value={value.effort || ''} disabled={disabled || !value.cli || !supportsEffort} placeholder={supportsEffort ? "CLI default (e.g. high)" : "CLI default"}
          onChange={(e) => set({ effort: e.target.value.trim() || null })} />}
      {hostModels.error && <div role="status">{hostModels.error}</div>}
    </div>
  );
}
