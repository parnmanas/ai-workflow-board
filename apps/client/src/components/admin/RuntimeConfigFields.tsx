import React from 'react';
import type {
  AgentRuntimeConfig,
  ExecutionStrategy,
  ManagedAgentCreateBody,
  RuntimePermissionMode,
} from '../../types';
import { Input, Select } from '../common';
import { tokens } from '../../tokens';

export type RuntimeId = ManagedAgentCreateBody['cli'];

export interface RuntimeSelection {
  runtime: RuntimeId | '';
  strategy: ExecutionStrategy | '';
  permissionMode: RuntimePermissionMode | '';
  profile: string;
  maxChildren: string;
  maxIterations: string;
}

export const EMPTY_RUNTIME_SELECTION: RuntimeSelection = {
  runtime: '',
  strategy: '',
  permissionMode: '',
  profile: '',
  maxChildren: '',
  maxIterations: '',
};

export const RUNTIME_OPTIONS: Array<{ value: RuntimeId; label: string }> = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'codex', label: 'Codex' },
  { value: 'antigravity', label: 'Antigravity' },
  { value: 'pi', label: 'PI' },
  { value: 'hermes', label: 'Hermes ACP' },
];

export function runtimeSelectionFromAgent(
  runtime: string | undefined,
  config: AgentRuntimeConfig | null | undefined,
): RuntimeSelection {
  const knownRuntime = RUNTIME_OPTIONS.some((option) => option.value === runtime)
    ? runtime as RuntimeId
    : '';
  return {
    runtime: knownRuntime,
    strategy: config?.strategy ?? '',
    permissionMode: config?.permission_mode ?? '',
    profile: config?.profile ?? '',
    maxChildren: config?.max_children ? String(config.max_children) : '',
    maxIterations: config?.max_iterations ? String(config.max_iterations) : '',
  };
}

export function buildRuntimeConfig(selection: RuntimeSelection): AgentRuntimeConfig | null {
  if (!selection.runtime || !selection.strategy || !selection.permissionMode) return null;
  const config: AgentRuntimeConfig = {
    strategy: selection.strategy,
    permission_mode: selection.permissionMode,
  };
  if (selection.runtime === 'hermes') {
    if (selection.profile.trim()) config.profile = selection.profile.trim();
    if (selection.maxChildren) config.max_children = Number(selection.maxChildren);
    if (selection.maxIterations) config.max_iterations = Number(selection.maxIterations);
  }
  return config;
}

interface RuntimeConfigFieldsProps {
  value: RuntimeSelection;
  onChange(value: RuntimeSelection): void;
  availableRuntimeIds?: string[];
  disabled?: boolean;
  showRuntime?: boolean;
  /** 선택된 Runtime Host의 마지막 heartbeat가 보고한 Hermes 프로파일 이름 목록.
   *  `undefined` = Host가 아직 이 값을 리포트하지 않음(오프라인 Host, 또는 이
   *  기능보다 구버전 manager) — 편집이 막히지 않도록 자유 입력으로 폴백한다.
   *  `[]` = Host는 리포트했지만 named profile이 없음 — 역시 자유 입력 폴백.
   *  선택된 Runtime Host가 바뀔 때마다 Host의 `runtime_capabilities.hermes.profiles`
   *  에서 다시 파생시켜 목록이 최신 상태를 유지하게 할 것. */
  hermesProfiles?: string[];
}

export default function RuntimeConfigFields({
  value,
  onChange,
  availableRuntimeIds,
  disabled = false,
  showRuntime = true,
  hermesProfiles,
}: RuntimeConfigFieldsProps) {
  const available = availableRuntimeIds
    ? new Set(availableRuntimeIds)
    : null;
  const runtimeOptions = RUNTIME_OPTIONS
    .filter((option) => !available || available.has(option.value))
    .map((option) => ({ value: option.value, label: option.label }));
  const strategyOptions = value.runtime === 'hermes'
    ? [
        { value: 'single', label: 'Single — one Hermes session' },
        { value: 'delegated', label: 'Delegated — Hermes creates child workers' },
        { value: 'swarm', label: 'Swarm — coordinated Hermes workers' },
      ]
    : [{ value: 'single', label: 'Single' }];

  return (
    <>
      {showRuntime && (
        <Select
          label="Runtime *"
          value={value.runtime}
          disabled={disabled}
          options={[
            { value: '', label: runtimeOptions.length ? 'Select a runtime' : 'No healthy runtime reported by this Host' },
            ...runtimeOptions,
          ]}
          onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
            onChange({
              ...EMPTY_RUNTIME_SELECTION,
              runtime: event.target.value as RuntimeId | '',
            });
          }}
        />
      )}
      <Select
        label="Strategy *"
        value={value.strategy}
        disabled={disabled || !value.runtime}
        options={[
          { value: '', label: value.runtime ? 'Select a strategy' : 'Select a runtime first' },
          ...strategyOptions,
        ]}
        onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
          onChange({ ...value, strategy: event.target.value as ExecutionStrategy | '' });
        }}
      />
      <Select
        label="Permission mode *"
        value={value.permissionMode}
        disabled={disabled || !value.runtime}
        options={[
          { value: '', label: value.runtime ? 'Select a permission mode' : 'Select a runtime first' },
          { value: 'strict', label: 'Strict — deny unapproved actions' },
          { value: 'approve', label: 'Approve — ask through AWB' },
          { value: 'trusted', label: 'Trusted — pre-authorized scope' },
        ]}
        onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
          onChange({ ...value, permissionMode: event.target.value as RuntimePermissionMode | '' });
        }}
      />
      {value.runtime === 'hermes' && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          gap: 8,
          padding: 10,
          border: `1px solid ${tokens.colors.border}`,
          borderRadius: tokens.radii.md,
        }}>
          {hermesProfiles && hermesProfiles.length > 0 ? (
            <div>
              <Select
                label="Hermes profile"
                value={value.profile}
                options={[
                  { value: '', label: 'Default — no explicit profile' },
                  ...hermesProfiles.map((profile) => ({ value: profile, label: profile })),
                  ...(value.profile && !hermesProfiles.includes(value.profile)
                    ? [{ value: value.profile, label: `${value.profile} (Host에 없음)`, disabled: true }]
                    : []),
                ]}
                onChange={(event: React.ChangeEvent<HTMLSelectElement>) =>
                  onChange({ ...value, profile: event.target.value })
                }
              />
              {value.profile && !hermesProfiles.includes(value.profile) && (
                <div style={{ fontSize: 11, color: tokens.colors.danger, marginTop: 2, lineHeight: 1.5 }}>
                  저장된 프로파일 "{value.profile}"이(가) 이 Host에 더 이상 없습니다. 목록에서 다시 선택하거나 그대로 두면 값은 유지됩니다.
                </div>
              )}
            </div>
          ) : (
            <Input
              label="Hermes profile"
              value={value.profile}
              placeholder={hermesProfiles ? 'optional — Host에 등록된 프로파일 없음' : 'optional'}
              onChange={(event) => onChange({ ...value, profile: event.target.value })}
            />
          )}
          <Input
            label="Max children"
            type="number"
            min={1}
            max={1000}
            value={value.maxChildren}
            placeholder="optional"
            onChange={(event) => onChange({ ...value, maxChildren: event.target.value })}
          />
          <Input
            label="Max iterations"
            type="number"
            min={1}
            max={1000}
            value={value.maxIterations}
            placeholder="optional"
            onChange={(event) => onChange({ ...value, maxIterations: event.target.value })}
          />
        </div>
      )}
    </>
  );
}
