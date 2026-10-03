import React, { useEffect, useState } from 'react';
import { api, getActiveWorkspaceId } from '../../api';
import type { Credential } from '../../types';
import { Button, Input, Select } from '../common';
import { tokens } from '../../tokens';
import {
  cliModelSelectable,
  cliSupportsBackendProfile,
  cliSupportsCredential,
} from '../../cli/catalog';
import { cliModelChoices, useHostModels } from '../../cli/hostModels';
import RuntimeConfigFields, {
  buildRuntimeConfig,
  runtimeSelectionFromAgent,
} from '../admin/RuntimeConfigFields';
import {
  emptyRuntimeSpec,
  isAbsoluteHostPath,
  type RuntimeSpecDraft,
} from '../../runtime/runtimeSpec';

export type { RuntimeSpecDraft };
export { emptyRuntimeSpec };

export interface RuntimeHostChoice {
  id: string;
  name: string;
}

interface RuntimeSpecEditorProps {
  value: RuntimeSpecDraft;
  onChange(value: RuntimeSpecDraft): void;
  /** Runtime Host 후보 — 호출자가 listManagers/getAgents 에서 만든다. */
  hosts: RuntimeHostChoice[];
  workspaceId?: string;
  /** 폴더 공유 스코프 선택이 필요할 때만 (mission/step 계열). 기본 false. */
  showFolderScope?: boolean;
  disabled?: boolean;
}

/**
 * RuntimeSpecEditor — Agent 없는 greenfield의 실행 선언 에디터 (P3b).
 *
 * Host + CLI + model + working_dir + credential + runtime_config +
 * label/role_prompt 를 한 폼에서 선언한다. P4에서 Board/Ticket/Chat/Action/
 * QA picker들이 이 컴포넌트로 교체된다. 저장 shape 검증의 정본은 서버
 * `POST /api/runtime-specs/validate` — 이 폼은 필수키 + 절대경로만 본다.
 */
export default function RuntimeSpecEditor({
  value,
  onChange,
  hosts,
  workspaceId,
  showFolderScope = false,
  disabled = false,
}: RuntimeSpecEditorProps) {
  const set = (patch: Partial<RuntimeSpecDraft>) => onChange({ ...value, ...patch });
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const hostModels = useHostModels(value.manager_agent_id || null, value.cli || null);
  const models = hostModels.models;
  const labels = hostModels.labels;

  useEffect(() => {
    let cancelled = false;
    const wsId = workspaceId || getActiveWorkspaceId() || undefined;
    api.listCredentials(wsId).then((list) => {
      if (!cancelled) setCredentials(list as Credential[]);
    }).catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  const dirError = value.working_dir.trim() && !isAbsoluteHostPath(value.working_dir.trim())
    ? 'Host 절대 경로여야 합니다 (예: /home/user/work)'
    : '';

  return (
    <div>
      <Select
        label="Runtime Host"
        value={value.manager_agent_id}
        disabled={disabled}
        options={[
          { value: '', label: '선택…' },
          ...hosts.map((h) => ({ value: h.id, label: h.name })),
        ]}
        onChange={(e: React.ChangeEvent<HTMLSelectElement>) => set({ manager_agent_id: e.target.value })}
      />

      <div style={{ marginTop: 12 }}>
        <RuntimeConfigFields
          value={runtimeSelectionFromAgent(value.cli, value.runtime_config as any)}
          onChange={(sel) => {
            set({
              cli: sel.runtime,
              runtime_config: (buildRuntimeConfig(sel) ?? { strategy: 'single', permission_mode: 'approve' }) as any,
            });
          }}
          disabled={disabled}
        />
      </div>

      {cliModelSelectable(value.cli) && (
        <div style={{ marginTop: 12 }}>
          {models.length > 0 ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <div style={{ flex: 1 }}>
                <Select
                  label="Model"
                  value={value.model || ''}
                  disabled={disabled}
                  options={[
                    { value: '', label: 'Default — CLI 가 정함' },
                    ...cliModelChoices(models, labels, value.model).map((m) => ({ value: m.value, label: m.label })),
                  ]}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => set({ model: e.target.value || null })}
                />
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled || hostModels.refreshing}
                onClick={() => { void hostModels.refresh(); }}
              >
                {hostModels.refreshing ? '새로고침 중…' : '새로고침'}
              </Button>
            </div>
          ) : (
            <Input
              label="Model"
              value={value.model || ''}
              disabled={disabled}
              placeholder="비워두면 CLI 기본값 (예: opus)"
              onChange={(e) => set({ model: (e.target as HTMLInputElement).value.trim() || null })}
            />
          )}
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <Input
          label="Working dir (Host 절대 경로)"
          value={value.working_dir}
          disabled={disabled}
          placeholder="/home/user/work"
          onChange={(e) => set({ working_dir: (e.target as HTMLInputElement).value })}
        />
        {dirError && <div style={{ fontSize: 11, color: tokens.colors.danger, marginTop: 4 }}>{dirError}</div>}
      </div>

      {cliSupportsCredential(value.cli) && (
        <div style={{ marginTop: 12 }}>
          <Select
            label="Credential (선택)"
            value={value.credential_id || ''}
            disabled={disabled}
            options={[
              { value: '', label: 'Host 로그인 그대로 사용' },
              ...credentials.map((c) => ({ value: c.id, label: c.name })),
            ]}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => set({ credential_id: e.target.value || null })}
          />
        </div>
      )}

      {cliSupportsBackendProfile(value.cli) && (
        <div style={{ marginTop: 12 }}>
          <Input
            label="Backend profile id (선택)"
            value={value.cli_runtime_profile || ''}
            disabled={disabled}
            placeholder="비워두면 상속"
            onChange={(e) => set({ cli_runtime_profile: (e.target as HTMLInputElement).value.trim() || null })}
          />
        </div>
      )}

      {showFolderScope && (
        <div style={{ marginTop: 12 }}>
          <Select
            label="Folder scope"
            value={value.folder_scope}
            disabled={disabled}
            options={[
              { value: 'shared', label: 'shared — working_dir 자체에서 실행' },
              { value: 'isolated', label: 'isolated — step별 격리 폴더' },
            ]}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => set({ folder_scope: e.target.value as 'shared' | 'isolated' })}
          />
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <Input
          label="Label (표시명, 선택)"
          value={value.label}
          disabled={disabled}
          placeholder="비워두면 폴더/CLI 로 자동 표시"
          onChange={(e) => set({ label: (e.target as HTMLInputElement).value })}
        />
      </div>

      <div style={{ marginTop: 12 }}>
        <Input
          label="Role prompt (선택)"
          value={value.role_prompt}
          disabled={disabled}
          placeholder="실행 시 주입할 지시문"
          onChange={(e) => set({ role_prompt: (e.target as HTMLInputElement).value })}
        />
      </div>
    </div>
  );
}
