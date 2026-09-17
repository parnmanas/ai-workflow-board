import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { tokens } from '../../tokens';
import type { AgentSessionHost, AgentSessionLiveSnapshot } from '../../types';
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
  const [managerId, setManagerId] = useState(initialManagerId || '');
  const [cli, setCli] = useState(initialCli || '');
  const [cwd, setCwd] = useState('');
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setTitle('');
    const host = hosts.find((h) => h.manager_id === initialManagerId) ?? hosts[0] ?? null;
    const nextManager = host?.manager_id || '';
    const nextCli = host && initialCli && host.clis.includes(initialCli) ? initialCli : host?.clis[0] || '';
    setManagerId(nextManager);
    setCli(nextCli);
    // initialCwd(그룹 헤더 "+ New")가 있으면 우선 적용, 없으면 마지막 기억 cwd
    setCwd(initialCwd || (nextManager && nextCli ? readLastCwd(nextManager, nextCli) : ''));
  }, [open, hosts, initialManagerId, initialCli, initialCwd]);

  const host = useMemo(() => hosts.find((h) => h.manager_id === managerId) ?? null, [hosts, managerId]);

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
          <select id="new-session-host" style={selectStyle} value={managerId} disabled={hosts.length === 0} onChange={(e) => setManagerId(e.target.value)}>
            {hosts.length === 0 && <option value="">No Runtime Host is connected</option>}
            {hosts.map((h) => (
              <option key={h.manager_id} value={h.manager_id}>{h.name}{h.hostname && h.hostname !== h.name ? ` (${h.hostname})` : ''}</option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="new-session-cli" style={labelStyle}>CLI</label>
          <select id="new-session-cli" style={selectStyle} value={cli} disabled={!host || host.clis.length === 0} onChange={(e) => setCli(e.target.value)}>
            {(!host || host.clis.length === 0) && <option value="">No ACP-capable CLI on this host</option>}
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
