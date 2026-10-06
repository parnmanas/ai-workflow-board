import RuntimeSelectionFields, { emptyRuntimeSelection, type RuntimeSelectionValue } from '../runtime/RuntimeSelectionFields';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { tokens } from '../../tokens';
import type { AgentSessionCliSettings, AgentSessionConfigOption, AgentSessionHost, AgentSessionLiveSnapshot } from '../../types';
import { Button, Input, Modal } from '../common';
import DirectoryPicker from '../admin/DirectoryPicker';
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

const selectStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  borderRadius: tokens.radii.md,
  border: `1px solid ${tokens.colors.border}`,
  background: tokens.colors.surface,
  color: tokens.colors.textPrimary,
  fontSize: 13,
};

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
  const [managerId, setManagerId] = useState('');
  const [cli, setCli] = useState('');
  const [selection, setSelection] = useState<RuntimeSelectionValue>(emptyRuntimeSelection());
  const selectionEdited = useRef(false);
  const [cwd, setCwd] = useState('');
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // 세션 설정(approval 모드·모델). 선택지는 어댑터가 살아 있어야 알 수 있어 서버가 마지막 목록을
  // 캐시해 준다 — 그래서 세션을 열기 전에도 고를 수 있다. 고른 값은 호스트×CLI 에 기억되고,
  // 이 세션을 포함해 이후 열리는 모든 세션에 다시 걸린다(프로세스가 회수돼도 유지된다).
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settings, setSettings] = useState<AgentSessionCliSettings | null>(null);
  const [credentialId, setCredentialId] = useState('');
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsRefresh, setSettingsRefresh] = useState(0);
  const settingsKey = useRef('');
  const [knownOptions, setKnownOptions] = useState<AgentSessionConfigOption[]>([]);
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
    setError(null);
    setPickerOpen(false);
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
        setSettingsError(err?.message || 'Failed to load CLI settings. Refresh before starting the session.');
        settingsKey.current = '';
      } finally { if (!cancelled) setSettingsLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [open, managerId, cli, settingsRefresh]);

  // 모델 목록은 모든 화면이 공유하는 스토어에서 온다(src/cli/hostModels.ts) — 오래된/빈
  // 목록은 열릴 때 재열거된다. 어댑터가 보고한 목록이 있으면 스토어도 그것만 준다(세션 안과 같은 목록).
  const hostModels = useHostModels(open ? managerId : null, cli);
  // 모달에서 고르는 것은 세션의 성격을 정하는 둘뿐이다(그 밖의 설정은 세션 헤더에서 바꾼다).
  const modalOptions = useMemo(
    () => withHostModelOption(knownOptions, hostModels.models, hostModels.labels)
      .filter((o) => o.type === 'select' && (o.category === 'mode') && o.options.length > 0),
    [knownOptions, hostModels.models, hostModels.labels],
  );

  const host = useMemo(() => hosts.find((h) => h.manager_id === managerId) ?? null, [hosts, managerId]);
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
      setError('A working directory on the Runtime Host is required.');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      // 고른 설정을 먼저 기억시킨다 — 매니저는 세션을 연 직후 이 값을 다시 걸고, 다음에 다시 열 때도 쓴다.
      const changed: Record<string, string | boolean | null> = Object.fromEntries(
        modalOptions
          .map((o) => [o.config_id, chosenConfig[o.config_id]] as const)
          .filter(([, value]) => typeof value === 'string' && value),
      );
      const modelOption = withHostModelOption(knownOptions, hostModels.models, hostModels.labels).find((o) => o.category === 'model');
      const effortOption = hostEffortReport(hostModels.view, cli, selection.model);
      if (selectionEdited.current && selection.effort && (!effortOption?.config_id || !effortOption.options.some((o) => o.value === selection.effort))) throw new Error('선택한 모델의 Effort 지원 여부를 확인할 수 없습니다. CLI 기본값을 선택하거나 목록을 새로고침하세요.');
      if (selection.model && !modelOption) throw new Error('이 CLI의 model 설정을 아직 확인할 수 없습니다.');
      if (modelOption && (selection.model || selectionEdited.current)) changed[modelOption.config_id] = selection.model;
      if (effortOption?.config_id && (selection.effort || selectionEdited.current)) changed[effortOption.config_id] = selection.effort;
      // Clear remembered effort on model changes even when the new model has no reported selector.
      if (!selection.effort && selectionEdited.current) {
        for (const option of knownOptions.filter((o) => o.category === 'thought_level')) changed[option.config_id] = null;
      }
      const credentialChanged = credentialId !== (settings.credential_id ?? settings.credential?.id ?? '');
      if (Object.keys(changed).length || credentialChanged) {
        await api.setHostCliSettings(managerId, cli, credentialId || null, changed);
      }
      const live = await api.openHostSession(managerId, cli, { cwd: trimmed, title: title.trim() });
      rememberCwd(managerId, cli, trimmed);
      onCreated(live);
    } catch (err: any) {
      setError(err?.message || 'Failed to open the session');
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title="New session"
      maxWidth={520}
      footer={(
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="secondary" onClick={onClose} disabled={creating}>Cancel</Button>
          <Button variant="primary" onClick={() => void create()} disabled={!managerId || !cli || creating || settingsLoading || !settings || !!settingsError || credentialUnavailable} loading={creating}>
            Start session
          </Button>
        </div>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p style={{ margin: 0, fontSize: 12.5, color: tokens.colors.textSecondary, lineHeight: 1.5 }}>
          Choose how the CLI signs in on the Runtime Host. Its session history stays on that machine,
          and output streams here with tool permissions for you to approve.
        </p>

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
            {settingsLoading && <div role="status" style={labelStyle}>Loading CLI settings…</div>}
            {settings?.supports_credential && (
              <>
                <label htmlFor="new-session-credential" style={labelStyle}>Credential</label>
                <select id="new-session-credential" aria-label="Session credential" style={selectStyle}
                  value={credentialId} disabled={creating || settingsLoading}
                  onChange={(e) => setCredentialId(e.target.value)}>
                  <option value="">Host&apos;s own login (no AWB credential)</option>
                  {credentialUnavailable && <option value={credentialId} disabled>Unavailable credential · {credentialId.slice(0, 8)}</option>}
                  {settings.candidates.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name} · {candidate.provider}{candidate.scope === 'global' ? ' · global' : ''}
                    </option>
                  ))}
                </select>
                <p style={{ ...labelStyle, marginTop: 6, lineHeight: 1.5 }}>
                  {credentialUnavailable
                    ? 'The saved credential is unavailable. Choose another credential or the host’s own login.'
                    : credentialId
                    ? 'Remembered for new sessions on this host and CLI. Existing sessions keep their saved login.'
                    : 'The host must already be signed in. On a new host, select an AWB credential or add one below.'}
                </p>
                <a href="/settings/credentials" target="_blank" rel="noopener noreferrer"
                  style={{ fontSize: 12, color: tokens.colors.accent }}>Add / manage credentials ↗</a>
              </>
            )}
            {settings && !settings.supports_credential && (
              <p style={labelStyle}>{runtimeLabel(cli)} uses the host&apos;s own login. Sign in on the host before starting.</p>
            )}
            {settingsError && <div role="alert" style={{ fontSize: 12, color: tokens.colors.dangerLight }}>{settingsError}</div>}
            <Button variant="ghost" size="sm" disabled={creating || settingsLoading}
              onClick={() => setSettingsRefresh((value) => value + 1)}>Refresh credentials</Button>
          </div>
        )}

        <div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
            <div style={{ flex: 1 }}>
              <Input
                label="Working directory (on the Runtime Host)"
                value={cwd}
                placeholder="/path/to/repo"
                onChange={(e) => setCwd(e.target.value)}
              />
            </div>
            <Button
              variant="secondary"
              size="sm"
              disabled={!managerId}
              onClick={() => setPickerOpen(true)}
              style={{ marginBottom: 1, whiteSpace: 'nowrap' }}
            >
              Browse…
            </Button>
          </div>
        </div>
        {managerId && (
          <DirectoryPicker
            isOpen={pickerOpen}
            onClose={() => setPickerOpen(false)}
            managerAgentId={managerId}
            initialPath={cwd.trim() || undefined}
            onPick={(picked) => setCwd(picked)}
          />
        )}

        {modalOptions.map((option) => (
          <div key={option.config_id}>
            <label htmlFor={`new-session-config-${option.config_id}`} style={labelStyle}>
              {option.name}
              <span style={{ color: tokens.colors.textMuted }}> — kept for every session on this host</span>
              {option.category === 'model' && (
                <button
                  type="button"
                  disabled={hostModels.refreshing}
                  onClick={() => void hostModels.refresh()}
                  style={{ marginLeft: 8, fontSize: 11, background: 'none', border: 'none', color: tokens.colors.textSecondary, cursor: hostModels.refreshing ? 'wait' : 'pointer', textDecoration: 'underline' }}
                >
                  {hostModels.refreshing ? 'refreshing…' : 'refresh'}
                </button>
              )}
            </label>
            <select
              id={`new-session-config-${option.config_id}`}
              data-config-id={option.config_id}
              style={selectStyle}
              value={typeof chosenConfig[option.config_id] === 'string' ? String(chosenConfig[option.config_id]) : ''}
              onChange={(e) => setChosenConfig((prev) => ({ ...prev, [option.config_id]: e.target.value }))}
            >
              <option value="">{`${runtimeLabel(cli)} default`}</option>
              {option.options.map((choice) => (
                <option key={choice.value} value={choice.value} title={choice.description}>{choice.name}</option>
              ))}
            </select>
          </div>
        ))}

        <Input
          label="Title (optional)"
          value={title}
          placeholder="Defaults to your first prompt"
          onChange={(e) => setTitle(e.target.value)}
        />

        {error && <div role="alert" style={{ fontSize: 12, color: tokens.colors.dangerLight }}>{error}</div>}
      </div>
    </Modal>
  );
}
