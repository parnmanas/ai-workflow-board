import React from 'react';
import type {
  AgentRuntimeConfig,
  ExecutionStrategy,
  RuntimePermissionMode,
} from '../../types';
import { Input, Select } from '../common';
import { tokens } from '../../tokens';
import {
  cliCatalog,
  cliCollaboration,
  cliLabel,
  cliRuntimeConfig,
  executableClis,
  useCliCatalog,
  type CliCollaboration,
  type CliDescriptor,
} from '../../cli/catalog';

/** Catalog CLI id (the server validates it against the catalog). */
export type RuntimeId = string;

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

/** Runtime <select> options — every executable CLI in the catalog. Pass the
 *  catalog from `useCliCatalog()` inside components so the list refreshes
 *  once the server catalog replaces the static mirror. */
export function runtimeOptions(catalog: CliDescriptor[] = cliCatalog()): Array<{ value: RuntimeId; label: string }> {
  return executableClis(catalog).map((d) => ({ value: d.id, label: d.label }));
}

export function runtimeSelectionFromAgent(
  runtime: string | undefined,
  config: AgentRuntimeConfig | null | undefined,
): RuntimeSelection {
  const knownRuntime = runtime && executableClis().some((d) => d.id === runtime)
    ? runtime
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
  // Which extra knobs a runtime accepts is a catalog fact (`runtime_config`),
  // not a CLI-id branch.
  const knobs = cliRuntimeConfig(selection.runtime);
  if (knobs.profiles && selection.profile.trim()) config.profile = selection.profile.trim();
  if (knobs.child_limits) {
    if (selection.maxChildren) config.max_children = Number(selection.maxChildren);
    if (selection.maxIterations) config.max_iterations = Number(selection.maxIterations);
  }
  return config;
}

const STRATEGY_COPY: Record<CliCollaboration, (label: string) => string> = {
  single: (label) => `Single — one ${label} session`,
  delegated: (label) => `Delegated — ${label} creates child workers`,
  swarm: (label) => `Swarm — coordinated ${label} workers`,
};

/** Strategy options for a runtime, from its catalog `collaboration` list. A
 *  runtime that only ever runs single gets the plain "Single" label. */
export function strategyOptionsFor(runtime: string): Array<{ value: ExecutionStrategy; label: string }> {
  const modes = cliCollaboration(runtime);
  if (modes.length <= 1) return [{ value: 'single', label: 'Single' }];
  const label = cliLabel(runtime);
  return modes.map((mode) => ({ value: mode, label: STRATEGY_COPY[mode](label) }));
}

interface RuntimeConfigFieldsProps {
  value: RuntimeSelection;
  onChange(value: RuntimeSelection): void;
  availableRuntimeIds?: string[];
  disabled?: boolean;
  showRuntime?: boolean;
  /**
   * 선택된 Runtime Host가 보고한 런타임별 권한 등급 표현력
   * (`runtime_capabilities[<runtime>].capabilities.permission_tiers`,
   * ticket 5851e435). `approve` 를 고르는 순간 그 런타임이 실제로 AWB 승인을
   * 요청할 수 있는지 여기서 알려준다 — 아래 select 의 "Approve — ask through
   * AWB" 라벨이 지키지 못하는 약속이 되는 경우가 있기 때문이다.
   * `undefined` = Host가 아직 이 값을 보고하지 않음(구버전 매니저) → 경고를
   * 띄우지 않는다(보고된 적 없는 사실을 지어내지 않는다).
   */
  permissionTiers?: Record<string, Record<'strict' | 'approve' | 'trusted', string> | undefined>;
  /** 선택된 Runtime Host의 마지막 heartbeat가 보고한, 이 런타임의 named profile
   *  목록(`runtime_capabilities[<runtime>].profiles`). 카탈로그가
   *  `runtime_config.profiles` 를 켠 런타임에서만 렌더된다.
   *  `undefined` = Host가 아직 이 값을 리포트하지 않음(오프라인 Host, 또는 이
   *  기능보다 구버전 manager) — 편집이 막히지 않도록 자유 입력으로 폴백한다.
   *  `[]` = Host는 리포트했지만 named profile이 없음 — 역시 자유 입력 폴백.
   *  선택된 Runtime Host가 바뀔 때마다 다시 파생시켜 목록을 최신으로 유지할 것. */
  namedProfiles?: string[];
}

export default function RuntimeConfigFields({
  value,
  onChange,
  availableRuntimeIds,
  disabled = false,
  showRuntime = true,
  namedProfiles,
  permissionTiers,
}: RuntimeConfigFieldsProps) {
  const catalog = useCliCatalog();
  // ticket 5851e435 — approve 를 골랐는데 그 런타임이 승인 요청을 실제로
  // 만들지 못하면(native 가 아니면) 경고한다. 매니저는 이 조합의 spawn 을
  // 거부하므로, 저장 후 디스패치가 막히기 전에 여기서 먼저 알린다.
  const approveUnsupported =
    value.permissionMode === 'approve'
    && !!value.runtime
    && !!permissionTiers?.[value.runtime]
    && permissionTiers[value.runtime]!.approve !== 'native';
  const available = availableRuntimeIds
    ? new Set(availableRuntimeIds)
    : null;
  const options = runtimeOptions(catalog)
    .filter((option) => !available || available.has(option.value));
  const strategyOptions = strategyOptionsFor(value.runtime);
  const knobs = cliRuntimeConfig(value.runtime);
  const showKnobs = knobs.profiles || knobs.child_limits;
  const knobCount = (knobs.profiles ? 1 : 0) + (knobs.child_limits ? 2 : 0);
  const runtimeName = value.runtime ? cliLabel(value.runtime) : 'Runtime';

  return (
    <>
      {showRuntime && (
        <Select
          label="Runtime *"
          value={value.runtime}
          disabled={disabled}
          options={[
            { value: '', label: options.length ? 'Select a runtime' : 'No healthy runtime reported by this Host' },
            ...options,
          ]}
          onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
            onChange({
              ...EMPTY_RUNTIME_SELECTION,
              runtime: event.target.value,
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
      {approveUnsupported && (
        <div
          data-testid="approve-unsupported-warning"
          style={{
            padding: 10,
            border: `1px solid ${tokens.colors.border}`,
            borderRadius: tokens.radii.md,
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          {`⚠️ 런타임 "${value.runtime}" 는 실행 중 권한 요청을 AWB 승인 경로로 올릴 수 없습니다. `
            + `이 조합으로 저장하면 디스패치가 실행되지 않고 차단됩니다 — 승인 대신 조용히 `
            + `제한 모드로 도는 일을 막기 위해서입니다. 명시적으로 허용하려면 Trusted, `
            + `거부하려면 Strict 를 고르거나, 승인 요청을 지원하는 런타임(Hermes ACP)으로 `
            + `옮기세요.`}
        </div>
      )}
      {showKnobs && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${knobCount}, minmax(0, 1fr))`,
          gap: 8,
          padding: 10,
          border: `1px solid ${tokens.colors.border}`,
          borderRadius: tokens.radii.md,
        }}>
          {knobs.profiles && (
            namedProfiles && namedProfiles.length > 0 ? (
              <div>
                <Select
                  label={`${runtimeName} profile`}
                  value={value.profile}
                  options={[
                    { value: '', label: 'Default — no explicit profile' },
                    ...namedProfiles.map((profile) => ({ value: profile, label: profile })),
                    ...(value.profile && !namedProfiles.includes(value.profile)
                      ? [{ value: value.profile, label: `${value.profile} (Host에 없음)`, disabled: true }]
                      : []),
                  ]}
                  onChange={(event: React.ChangeEvent<HTMLSelectElement>) =>
                    onChange({ ...value, profile: event.target.value })
                  }
                />
                {value.profile && !namedProfiles.includes(value.profile) && (
                  <div style={{ fontSize: 11, color: tokens.colors.danger, marginTop: 2, lineHeight: 1.5 }}>
                    저장된 프로파일 "{value.profile}"이(가) 이 Host에 더 이상 없습니다. 목록에서 다시 선택하거나 그대로 두면 값은 유지됩니다.
                  </div>
                )}
              </div>
            ) : (
              <Input
                label={`${runtimeName} profile`}
                value={value.profile}
                placeholder={namedProfiles ? 'optional — Host에 등록된 프로파일 없음' : 'optional'}
                onChange={(event) => onChange({ ...value, profile: event.target.value })}
              />
            )
          )}
          {knobs.child_limits && (
            <>
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
            </>
          )}
        </div>
      )}
    </>
  );
}
