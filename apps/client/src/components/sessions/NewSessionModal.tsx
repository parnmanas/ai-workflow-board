import { t as translate, getLocale } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import RuntimeSelectionFields, { emptyRuntimeSelection, type RuntimeSelectionValue } from '../runtime/RuntimeSelectionFields';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { tokens } from '../../tokens';
import type { AgentSessionCliSettings, AgentSessionConfigOption, AgentSessionHost, AgentSessionLiveSnapshot } from '../../types';
import { Button, Input, Modal } from '../common';
import RuntimeConnectionFields from '../runtime/RuntimeConnectionFields';
import RuntimeOptionControl from '../runtime/RuntimeOptionControl';
import WorkingDirectoryField from '../runtime/WorkingDirectoryField';
import { lastCwdStorageKey } from './sessionList.logic';
import { runtimeLabel } from './sessionTranscript.logic';
import { hostEffortReport } from '../../cli/hostEfforts';
import { useHostModels, withHostModelOption } from '../../cli/hostModels';

/**
 * 새 Agent Session — Runtime Host 와 CLI 를 고르고 작업 폴더를 준다. Chat 의
 * NewChatModal(참여자 여러 명, DM/그룹)과 의도적으로 다른 모양이다. 세션은 AWB Agent 가
 * 아니라 그 장비의 CLI로 열고, 선택한 credential 또는 장비 자체 로그인으로 인증한다.
 */
export interface NewSessionModalProps {
  open: boolean;
  onClose: () => void;
  hosts: AgentSessionHost[];
  initialManagerId?: string;
  initialCli?: string;
  /** 그룹 헤더의 "+ New" 버튼에서 전달되는 cwd 프리필 값. */
  initialCwd?: string;
  onCreated: (live: AgentSessionLiveSnapshot) => void;
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  color: tokens.colors.textSecondary,
  marginBottom: 4,
};

function readLastCwd(managerId: string, cli: string): string {
  try {
    return window.localStorage.getItem(lastCwdStorageKey(managerId, cli)) || '';
  } catch {
    return '';
  }
}

function rememberCwd(managerId: string, cli: string, cwd: string): void {
  try {
    window.localStorage.setItem(lastCwdStorageKey(managerId, cli), cwd);
  } catch {
    /* best-effort */
  }
}

export default function NewSessionModal({ open, onClose, hosts, initialManagerId, initialCli, initialCwd, onCreated }: NewSessionModalProps) {
  useLocale();
  const [managerId, setManagerId] = useState('');
  const [cli, setCli] = useState('');
  const [selection, setSelection] = useState<RuntimeSelectionValue>(emptyRuntimeSelection());
  const selectionEdited = useRef(false);
  const [cwd, setCwd] = useState('');
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Launch options come from the host CLI modules; model/config options come from ACP.
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settings, setSettings] = useState<AgentSessionCliSettings | null>(null);
  const [credentialId, setCredentialId] = useState('');
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsRefresh, setSettingsRefresh] = useState(0);
  const settingsKey = useRef('');
  const [knownOptions, setKnownOptions] = useState<AgentSessionConfigOption[]>([]);
  const [saveDefaults, setSaveDefaults] = useState(false);
  const [chosenConfig, setChosenConfig] = useState<Record<string, string | boolean>>({});

  // 닫힐 때 폼을 비운다 — 다음에 열릴 때 아래 effect 가 "아직 고른 호스트가 없다" 를
  // 보고 기본값을 채우게 하려는 것이지, 열려 있는 동안 되돌리려는 것이 아니다.
  useEffect(() => {
    if (open) return;
    selectionEdited.current = false;
    setSelection(emptyRuntimeSelection());
    setManagerId('');
    setCli('');
    setCwd('');
    setTitle('');
    setSaveDefaults(false);
    setError(null);
  }, [open]);

  // 기본 호스트/CLI/cwd 는 **아직 아무것도 고르지 않았을 때만** 채운다. `hosts` 는 매니저
  // 하트비트마다(`agent_instance_update` → useAgentSessionsNav 재조회) 새 배열로 내려오므로,
  // 예전처럼 hosts 가 바뀔 때마다 초기화하면 사용자가 고르던 호스트가 30초 간격으로
  // 첫 번째 호스트로 되돌아가고 cwd·제목·DirectoryPicker 트리까지 함께 리셋됐다.
  // 모달이 호스트 목록보다 먼저 열린 경우(사이드바 "New session" 직후)에도 이 effect 가
  // 목록 도착 시 한 번만 기본값을 채운다.
  useEffect(() => {
    if (!open || managerId) return;
    const host = hosts.find((h) => h.manager_id === initialManagerId) ?? hosts[0] ?? null;
    if (!host) return;
    const nextCli = initialCli && host.clis.includes(initialCli) ? initialCli : host.clis[0] || '';
    setManagerId(host.manager_id);
    setCli(nextCli);
    // initialCwd(그룹 헤더 "+ New")가 있으면 우선 적용, 없으면 마지막 기억 cwd
    setCwd((prev) => prev || initialCwd || (nextCli ? readLastCwd(host.manager_id, nextCli) : ''));
  }, [open, hosts, managerId, initialManagerId, initialCli, initialCwd]);

  // 호스트/CLI 가 정해지면 그 조합의 기억된 설정과 선택지를 불러온다.
  useEffect(() => {
    if (!open || !managerId || !cli) {
      settingsKey.current = '';
      setSettings(null);
      setCredentialId('');
      setSettingsError(null);
      setSettingsLoading(false);
      setKnownOptions([]);
      setChosenConfig({});
      return;
    }
    let cancelled = false;
    const key = `${managerId}/${cli}`;
    const reset = settingsKey.current !== key;
    setSettingsLoading(true);
    setSettingsError(null);
    if (reset) {
      setSettings(null);
      setCredentialId('');
      setKnownOptions([]);
      setChosenConfig({});
    }
    void (async () => {
      try {
        const settings = await api.getHostCliSettings(managerId, cli);
        if (cancelled) return;
        settingsKey.current = key;
        setSettings(settings);
        setKnownOptions(settings.known_config_options ?? []);
        if (reset) {
          setCredentialId(settings.credential_id ?? settings.credential?.id ?? '');
          setChosenConfig(settings.default_config ?? {});
        }
        if (reset && !selectionEdited.current) {
          const model = settings.known_config_options?.find((o) => o.category === 'model');
          const effort = settings.known_config_options?.find((o) => o.category === 'thought_level');
          setSelection((prev) => ({ ...prev,
            model: model ? String(settings.default_config?.[model.config_id] || '') || null : null,
            effort: effort ? String(settings.default_config?.[effort.config_id] || '') || null : null,
          }));
        }
      } catch (err: any) {
        if (cancelled) return;
        setSettingsError(err?.message || translate('Failed to load CLI settings. Refresh before starting the session.'));
        settingsKey.current = '';
      } finally { if (!cancelled) setSettingsLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [open, managerId, cli, settingsRefresh]);

  // 모델 목록은 모든 화면이 공유하는 스토어에서 온다(src/cli/hostModels.ts) — 오래된/빈
  // 목록은 열릴 때 재열거된다. 어댑터가 보고한 목록이 있으면 스토어도 그것만 준다(세션 안과 같은 목록).
  const hostModels = useHostModels(open ? managerId : null, cli);
  // Host-declared launch choices are available even before the first ACP session.
  const modalOptions = useMemo(
    () => [
      ...(settings?.launch_options ?? []),
      ...withHostModelOption(knownOptions, hostModels.models, hostModels.labels)
        .filter((o) => o.type === 'select' && o.category === 'mode' && o.options.length > 0
          && !settings?.launch_options?.some((launch) => launch.config_id === '__permission_mode')),
    ],
    [settings, knownOptions, hostModels.models, hostModels.labels, getLocale()],
  );

  const host = useMemo(() => hosts.find((h) => h.manager_id === managerId) ?? null, [hosts, managerId, getLocale()]);
  // 하트비트 TTL 사이에 잠깐 목록에서 빠진 호스트는 선택을 유지한다(다음 하트비트에 돌아온다).
  const selectedHostMissing = !!managerId && !host;
  const credentialUnavailable = !!credentialId && !!settings
    && !settings.candidates.some((candidate) => candidate.id === credentialId);

  useEffect(() => {
    if (!host) return;
    if (!host.clis.includes(cli)) setCli(host.clis[0] || '');
  }, [host, cli]);

  useEffect(() => {
    if (managerId && cli) setCwd((prev) => prev || readLastCwd(managerId, cli));
  }, [managerId, cli]);

  const create = async () => {
    if (!managerId || !cli || creating || settingsLoading || !settings || settingsError || credentialUnavailable) return;
    const trimmed = cwd.trim();
    if (!trimmed) {
      setError(translate('A working directory on the Runtime Host is required.'));
      return;
    }
    setCreating(true);
    setError(null);
    try {
      // Per-session overrides are pinned by the server. Saving defaults is an explicit choice.
      const changed: Record<string, string | boolean | null> = Object.fromEntries(
        modalOptions
          .map((o) => [o.config_id, chosenConfig[o.config_id] || null] as const),
      );
      if (settings.launch_options?.some((o) => o.config_id === '__permission_mode')) {
        changed.__mode = null;
        for (const option of knownOptions.filter((o) => o.category === 'mode')) changed[option.config_id] = null;
      }
      const modelOption = withHostModelOption(knownOptions, hostModels.models, hostModels.labels).find((o) => o.category === 'model');
      const effortOption = hostEffortReport(hostModels.view, cli, selection.model);
      if (selectionEdited.current && selection.effort && (!effortOption?.config_id || !effortOption.options.some((o) => o.value === selection.effort))) throw new Error(translate('선택한 모델의 Effort 지원 여부를 확인할 수 없습니다. CLI 기본값을 선택하거나 목록을 새로고침하세요.'));
      if (selection.model && !modelOption) throw new Error(translate('이 CLI의 model 설정을 아직 확인할 수 없습니다.'));
      if (modelOption && (selection.model || selectionEdited.current)) changed[modelOption.config_id] = selection.model;
      if (effortOption?.config_id && (selection.effort || selectionEdited.current)) changed[effortOption.config_id] = selection.effort;
      // Clear remembered effort on model changes even when the new model has no reported selector.
      if (!selection.effort && selectionEdited.current) {
        for (const option of knownOptions.filter((o) => o.category === 'thought_level')) changed[option.config_id] = null;
      }
      const credentialChanged = credentialId !== (settings.credential_id ?? settings.credential?.id ?? '');
      if (saveDefaults || credentialChanged) {
        await api.setHostCliSettings(managerId, cli, credentialId || null, saveDefaults ? changed : undefined);
      }
      const live = await api.openHostSession(managerId, cli, { cwd: trimmed, title: title.trim(), config_overrides: changed });
      rememberCwd(managerId, cli, trimmed);
      onCreated(live);
    } catch (err: any) {
      setError(err?.message || translate('Failed to open the session'));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={translate('New session')}
      maxWidth={520}
      footer={(
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="secondary" onClick={onClose} disabled={creating}>{translate('Cancel')}</Button>
          <Button variant="primary" onClick={() => void create()} disabled={!managerId || !cli || creating || settingsLoading || !settings || !!settingsError || credentialUnavailable} loading={creating}>
            {translate('Start session')}</Button>
        </div>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p style={{ margin: 0, fontSize: 12.5, color: tokens.colors.textSecondary, lineHeight: 1.5 }}>
          {translate('Choose how the CLI signs in on the Runtime Host. Its session history stays on that machine, and output streams here. Choose permissions and a Git workflow before starting.')}</p>

        <RuntimeSelectionFields session idPrefix="new-session"
          value={{ ...selection, host_id: managerId, cli }}
          hosts={hosts.map((h) => ({ id: h.manager_id, name: h.name, clis: h.clis }))}
          disabled={creating}
          modelConfigId={knownOptions.find((o) => o.category === 'model')?.config_id}
          onChange={(next, source) => {
            selectionEdited.current = source !== 'host' && source !== 'cli';
            setSelection(next);
            if (next.host_id !== managerId) setCwd('');
            setManagerId(next.host_id); setCli(next.cli);
          }}
        />

        {managerId && cli && (
          <div>
            {settingsLoading && <div role="status" style={labelStyle}>{translate('Loading CLI settings…')}</div>}
            {settings && <RuntimeConnectionFields idPrefix="new-session" hostId={managerId} cli={cli} settings={settings}
              credentialId={credentialId} onCredentialChange={setCredentialId} disabled={creating || settingsLoading} />}
            {settingsError && <div role="alert" style={{ fontSize: 12, color: tokens.colors.dangerLight }}>{settingsError}</div>}
            <Button variant="ghost" size="sm" disabled={creating || settingsLoading}
              onClick={() => setSettingsRefresh((value) => value + 1)}>{translate('Refresh credentials')}</Button>
          </div>
        )}

        <WorkingDirectoryField hostId={managerId} value={cwd} onChange={setCwd} disabled={creating} />

        {modalOptions.map((option) => (
          <div key={option.config_id}>
            <label htmlFor={`new-session-config-${option.config_id}`} style={labelStyle}>
              {option.name}
            </label>
            <RuntimeOptionControl option={option} id={`new-session-config-${option.config_id}`}
              style={{ width: '100%' }} disabled={creating || settingsLoading}
              value={chosenConfig[option.config_id] ?? ''}
              defaultLabel={option.config_id === '__git_workflow' ? translate('Main / master (default)') : translate('{0} default', { 0: runtimeLabel(cli) })}
              onChange={(value) => setChosenConfig((prev) => ({ ...prev, [option.config_id]: value }))} />
            <p style={{ ...labelStyle, marginTop: 6, lineHeight: 1.5 }}>
              {option.options.find((choice) => choice.value === (chosenConfig[option.config_id] || option.current_value))?.description || option.description}
            </p>
          </div>
        ))}

        <label style={{ ...labelStyle, display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={saveDefaults} disabled={creating || settingsLoading}
            onChange={(e) => setSaveDefaults(e.target.checked)} />
          {translate('Save these options as defaults for new sessions on this host and CLI')}</label>

        <Input
          label={translate('Title (optional)')}
          value={title}
          placeholder={translate('Defaults to your first prompt')}
          onChange={(e) => setTitle(e.target.value)}
        />

        {error && <div role="alert" style={{ fontSize: 12, color: tokens.colors.dangerLight }}>{error}</div>}
      </div>
    </Modal>
  );
}
