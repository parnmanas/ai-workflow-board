import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { tokens } from '../../tokens';
import type { AgentSessionConfigOption, AgentSessionHost, AgentSessionLiveSnapshot } from '../../types';
import { Button, Input, Modal } from '../common';
import DirectoryPicker from '../admin/DirectoryPicker';
import { lastCwdStorageKey } from './sessionList.logic';
import { runtimeLabel } from './sessionTranscript.logic';

/**
 * 새 Agent Session — Runtime Host 와 CLI 를 고르고 작업 폴더를 준다. Chat 의
 * NewChatModal(참여자 여러 명, DM/그룹)과 의도적으로 다른 모양이다. 세션은 AWB Agent 가
 * 아니라 그 장비의 CLI(운영자 홈)로 열린다.
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
  const [cwd, setCwd] = useState('');
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // 세션 설정(approval 모드·모델). 선택지는 어댑터가 살아 있어야 알 수 있어 서버가 마지막 목록을
  // 캐시해 준다 — 그래서 세션을 열기 전에도 고를 수 있다. 고른 값은 호스트×CLI 에 기억되고,
  // 이 세션을 포함해 이후 열리는 모든 세션에 다시 걸린다(프로세스가 회수돼도 유지된다).
  const [knownOptions, setKnownOptions] = useState<AgentSessionConfigOption[]>([]);
  const [chosenConfig, setChosenConfig] = useState<Record<string, string | boolean>>({});

  // 닫힐 때 폼을 비운다 — 다음에 열릴 때 아래 effect 가 "아직 고른 호스트가 없다" 를
  // 보고 기본값을 채우게 하려는 것이지, 열려 있는 동안 되돌리려는 것이 아니다.
  useEffect(() => {
    if (open) return;
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
      setKnownOptions([]);
      setChosenConfig({});
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const settings = await api.getHostCliSettings(managerId, cli);
        if (cancelled) return;
        setKnownOptions(settings.known_config_options ?? []);
        setChosenConfig(settings.default_config ?? {});
      } catch {
        if (cancelled) return;
        // 설정을 못 읽어도 세션은 열 수 있어야 한다 — 선택기만 감춘다.
        setKnownOptions([]);
        setChosenConfig({});
      }
    })();
    return () => { cancelled = true; };
  }, [open, managerId, cli]);

  // 모달에서 고르는 것은 세션의 성격을 정하는 둘뿐이다(그 밖의 설정은 세션 헤더에서 바꾼다).
  const modalOptions = useMemo(
    () => knownOptions.filter((o) => o.type === 'select' && (o.category === 'mode' || o.category === 'model') && o.options.length > 0),
    [knownOptions],
  );

  const host = useMemo(() => hosts.find((h) => h.manager_id === managerId) ?? null, [hosts, managerId]);
  // 하트비트 TTL 사이에 잠깐 목록에서 빠진 호스트는 선택을 유지한다(다음 하트비트에 돌아온다).
  const selectedHostMissing = !!managerId && !host;

  useEffect(() => {
    if (!host) return;
    if (!host.clis.includes(cli)) setCli(host.clis[0] || '');
  }, [host, cli]);

  useEffect(() => {
    if (managerId && cli) setCwd((prev) => prev || readLastCwd(managerId, cli));
  }, [managerId, cli]);

  const create = async () => {
    if (!managerId || !cli || creating) return;
    const trimmed = cwd.trim();
    if (!trimmed) {
      setError('A working directory on the Runtime Host is required.');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      // 고른 설정을 먼저 기억시킨다 — 매니저는 세션을 연 직후 이 값을 다시 걸고, 다음에 다시 열 때도 쓴다.
      const changed = Object.fromEntries(
        modalOptions
          .map((o) => [o.config_id, chosenConfig[o.config_id]] as const)
          .filter(([, value]) => typeof value === 'string' && value),
      );
      if (Object.keys(changed).length) {
        await api.setHostCliSettings(managerId, cli, host?.cli_settings?.[cli]?.id ?? null, changed);
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
          <Button variant="primary" onClick={() => void create()} disabled={!managerId || !cli || creating} loading={creating}>
            Start session
          </Button>
        </div>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p style={{ margin: 0, fontSize: 12.5, color: tokens.colors.textSecondary, lineHeight: 1.5 }}>
          Opens the CLI on that machine with its own login and history — the same session you would
          see in a terminal there. Output streams here and tool permissions are yours to approve.
        </p>

        <div>
          <label htmlFor="new-session-host" style={labelStyle}>Runtime Host</label>
          <select id="new-session-host" style={selectStyle} value={managerId} disabled={hosts.length === 0 && !managerId} onChange={(e) => setManagerId(e.target.value)}>
            {hosts.length === 0 && !managerId && <option value="">No Runtime Host is connected</option>}
            {selectedHostMissing && <option value={managerId}>Reconnecting…</option>}
            {hosts.map((h) => (
              <option key={h.manager_id} value={h.manager_id}>{h.name}{h.hostname && h.hostname !== h.name ? ` (${h.hostname})` : ''}</option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="new-session-cli" style={labelStyle}>CLI</label>
          <select id="new-session-cli" style={selectStyle} value={cli} disabled={!host || host.clis.length === 0} onChange={(e) => setCli(e.target.value)}>
            {!host && cli && <option value={cli}>{runtimeLabel(cli)}</option>}
            {(!host || host.clis.length === 0) && !cli && <option value="">No ACP-capable CLI on this host</option>}
            {host?.clis.map((c) => <option key={c} value={c}>{runtimeLabel(c)}</option>)}
          </select>
        </div>

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
