import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { tokens } from '../../tokens';
import type { TerminalHost, TerminalSummary } from '../../types';
import { Button, Input, Modal } from '../common';
import DirectoryPicker from '../admin/DirectoryPicker';

/**
 * 새 Terminal — Runtime Host 와 셸을 고른다. 셸 목록은 그 장비가 하트비트로 보고한
 * 것이고(`terminal_shells`), 작업 폴더를 비우면 장비 운영자의 홈에서 시작한다.
 */
export interface NewTerminalModalProps {
  open: boolean;
  onClose: () => void;
  hosts: TerminalHost[];
  initialManagerId?: string;
  onCreated: (terminal: TerminalSummary) => void;
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

function lastCwdKey(managerId: string): string {
  return `awb:terminal:lastCwd:${managerId}`;
}

export default function NewTerminalModal({ open, onClose, hosts, initialManagerId, onCreated }: NewTerminalModalProps) {
  const [managerId, setManagerId] = useState('');
  const [shell, setShell] = useState('');
  const [cwd, setCwd] = useState('');
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const host = useMemo(() => hosts.find((h) => h.manager_id === managerId) ?? null, [hosts, managerId]);

  useEffect(() => {
    if (open) return;
    setManagerId('');
    setShell('');
    setCwd('');
    setTitle('');
    setError(null);
    setPickerOpen(false);
  }, [open]);

  // 기본값은 **열릴 때만** 채운다 — `hosts` 는 하트비트마다 새 배열로 내려오므로 그것을
  // 초기화 트리거로 쓰면 고르던 호스트·폴더가 30초 간격으로 되돌아간다(세션 모달과 같은 함정).
  useEffect(() => {
    if (!open || managerId) return;
    const preferred = (initialManagerId && hosts.some((h) => h.manager_id === initialManagerId))
      ? initialManagerId
      : hosts[0]?.manager_id;
    if (!preferred) return;
    setManagerId(preferred);
    try {
      setCwd(window.localStorage.getItem(lastCwdKey(preferred)) || '');
    } catch {
      /* best-effort */
    }
  }, [open, managerId, hosts, initialManagerId]);

  // 호스트를 바꾸면 그 장비의 기본 셸로 맞춘다 — 셸 id 는 장비마다 다르다.
  useEffect(() => {
    if (!host) return;
    if (shell && host.shells.some((s) => s.id === shell)) return;
    setShell(host.shells.find((s) => s.default)?.id ?? host.shells[0]?.id ?? '');
  }, [host, shell]);

  const create = async () => {
    if (!managerId || creating) return;
    setCreating(true);
    setError(null);
    try {
      const terminal = await api.openHostTerminal(managerId, {
        shell: shell || null,
        cwd: cwd.trim(),
        title: title.trim(),
      });
      try {
        if (cwd.trim()) window.localStorage.setItem(lastCwdKey(managerId), cwd.trim());
      } catch {
        /* best-effort */
      }
      onCreated(terminal);
    } catch (err: any) {
      setError(err?.message || 'Failed to open the terminal');
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title="New terminal"
      maxWidth={520}
      footer={(
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="secondary" onClick={onClose} disabled={creating}>Cancel</Button>
          <Button variant="primary" onClick={() => void create()} disabled={!managerId || creating} loading={creating}>
            Start terminal
          </Button>
        </div>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p style={{ margin: 0, fontSize: 12.5, color: tokens.colors.textSecondary, lineHeight: 1.5 }}>
          Opens a real shell on that machine, running as the user that runs the Runtime Host.
          It lives only while it runs — nothing is recorded, and closing it ends the process.
        </p>

        <div>
          <label htmlFor="new-terminal-host" style={labelStyle}>Runtime Host</label>
          <select id="new-terminal-host" style={selectStyle} value={managerId} disabled={hosts.length === 0 && !managerId} onChange={(e) => setManagerId(e.target.value)}>
            {hosts.length === 0 && !managerId && <option value="">No Runtime Host can open terminals</option>}
            {hosts.map((h) => (
              <option key={h.manager_id} value={h.manager_id}>{h.name}{h.hostname && h.hostname !== h.name ? ` (${h.hostname})` : ''}</option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="new-terminal-shell" style={labelStyle}>Shell</label>
          <select id="new-terminal-shell" style={selectStyle} value={shell} disabled={!host || host.shells.length === 0} onChange={(e) => setShell(e.target.value)}>
            {(!host || host.shells.length === 0) && <option value="">No shell reported</option>}
            {host?.shells.map((s) => (
              <option key={s.id} value={s.id} title={s.path}>{s.label}{s.default ? ' (default)' : ''}</option>
            ))}
          </select>
        </div>

        <div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
            <div style={{ flex: 1 }}>
              <Input
                label="Working directory (optional)"
                value={cwd}
                placeholder="Defaults to the host user's home"
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
          placeholder="Defaults to the shell and folder"
          onChange={(e) => setTitle(e.target.value)}
        />

        {error && <div role="alert" style={{ fontSize: 12, color: tokens.colors.dangerLight }}>{error}</div>}
      </div>
    </Modal>
  );
}
