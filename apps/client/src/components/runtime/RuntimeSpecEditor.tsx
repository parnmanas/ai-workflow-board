import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import RuntimeSelectionFields from './RuntimeSelectionFields';
import WorkingDirectoryField from './WorkingDirectoryField';
import ProjectFolderHelper from './ProjectFolderHelper';
import React from 'react';
import RuntimeConnectionFields from './RuntimeConnectionFields';
import { Input, Select } from '../common';
import {
  emptyRuntimeSpec,
  type RuntimeSpecDraft,
} from '../../runtime/runtimeSpec';

export type { RuntimeSpecDraft };
export { emptyRuntimeSpec };

import type { RuntimeHostChoice } from '../../runtime/useRuntimeHosts';
export type { RuntimeHostChoice };

interface RuntimeSpecEditorProps {
  value: RuntimeSpecDraft;
  onChange(value: RuntimeSpecDraft): void;
  /** Host catalog from useRuntimeHosts, including reported CLI capabilities. */
  hosts: RuntimeHostChoice[];
  hostsLoading?: boolean;
  hostsError?: string;
  accountId?: string;
  /** 폴더 공유 스코프 선택이 필요할 때만 (mission/step 계열). 기본 false. */
  showFolderScope?: boolean;
  /**
   * "Use project folder" helper under the working dir (pick a project → its
   * main clone folder on the selected host). Default true; pass false to hide.
   */
  showProjectFolderHelper?: boolean;
  /**
   * 작업 폴더를 비워도 되는 화면(새 채팅)만 준다 — 비웠을 때 무엇을 쓰는지
   * 안내한다. 기본값을 실제로 채우는 것은 호출자 몫이다(티켓·미션에서는 폴더가 필수다).
   */
  folderOptionalHint?: string | null;
  disabled?: boolean;
}

/** Shared execution editor for Business, tickets, chat and automation declarations. */
export default function RuntimeSpecEditor({
  value,
  onChange,
  hosts,
  hostsLoading = false,
  hostsError,
  accountId,
  showFolderScope = false,
  showProjectFolderHelper = true,
  folderOptionalHint = null,
  disabled = false,
}: RuntimeSpecEditorProps) {
  useLocale();
  const set = (patch: Partial<RuntimeSpecDraft>) => onChange({ ...value, ...patch });
  return (
    <div>
      {hostsLoading && <div role="status">{translate('Loading…')}</div>}
      {hostsError && <div role="alert">{hostsError}</div>}
      <RuntimeSelectionFields
        value={{ host_id: value.manager_agent_id, cli: value.cli, model: value.model,
          effort: value.runtime_config.extra?.effort || null, runtime_config: value.runtime_config }}
        hosts={hosts} disabled={disabled}
        onChange={(next) => set({ manager_agent_id: next.host_id, cli: next.cli, model: next.model,
          runtime_config: { ...next.runtime_config, extra: { ...next.runtime_config.extra, effort: next.effort } },
          ...(next.host_id !== value.manager_agent_id ? { working_dir: '', credential_id: null } : {}),
          ...(next.cli !== value.cli ? { credential_id: null, cli_runtime_profile: null } : {}),
        })}
      />

      <div style={{ marginTop: 12 }}>
        <WorkingDirectoryField hostId={value.manager_agent_id} value={value.working_dir}
          onChange={(working_dir) => set({ working_dir })} disabled={disabled} optionalHint={folderOptionalHint} />
        {showProjectFolderHelper && (
          <ProjectFolderHelper
            accountId={accountId}
            hostIds={value.manager_agent_id}
            currentDir={value.working_dir}
            disabled={disabled}
            onPick={(path) => set({ working_dir: path })}
          />
        )}
      </div>

      <div style={{ marginTop: 12 }}>
        <RuntimeConnectionFields hostId={value.manager_agent_id} cli={value.cli} disabled={disabled}
          credentialId={value.credential_id || ''} backendId={value.cli_runtime_profile || ''}
          onCredentialChange={(credential_id) => set({ credential_id: credential_id || null })}
          onBackendChange={(cli_runtime_profile) => set({ cli_runtime_profile: cli_runtime_profile || null })} />
      </div>

      {showFolderScope && (
        <div style={{ marginTop: 12 }}>
          <Select
            label={translate('Folder scope')}
            value={value.folder_scope}
            disabled={disabled}
            options={[
              { value: 'shared', label: translate('shared — working_dir 자체에서 실행') },
              { value: 'isolated', label: translate('isolated — step별 격리 폴더') },
            ]}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => set({ folder_scope: e.target.value as 'shared' | 'isolated' })}
          />
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <Input
          label={translate('Label (표시명, 선택)')}
          value={value.label}
          disabled={disabled}
          placeholder={translate('비워두면 폴더/CLI 로 자동 표시')}
          onChange={(e) => set({ label: (e.target as HTMLInputElement).value })}
        />
      </div>

      <div style={{ marginTop: 12 }}>
        <Input
          label={translate('Role prompt (선택)')}
          value={value.role_prompt}
          disabled={disabled}
          placeholder={translate('실행 시 주입할 지시문')}
          onChange={(e) => set({ role_prompt: (e.target as HTMLInputElement).value })}
        />
      </div>
    </div>
  );
}
