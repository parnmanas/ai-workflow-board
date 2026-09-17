import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { useToast } from '../../contexts/ToastContext';
import { tokens } from '../../tokens';
import type { AgentSessionCliSettings } from '../../types';
import { Button } from '../common';
import { runtimeLabel } from './sessionTranscript.logic';

/**
 * CLI 설정 — 이 Runtime Host 의 이 CLI 를 어떤 워크스페이스 Credential(Settings →
 * Credentials)로 인증할지. 비워 두면 장비 운영자의 CLI 로그인(`claude login` 등)을
 * 그대로 쓴다. 매니저는 credential 이 묶였을 때만 세션 전용 cli-home 을 만들고,
 * 운영자 홈의 로그인 파일은 건드리지 않는다.
 */
export interface CliSettingsPanelProps {
  wsId: string;
  managerId: string;
  cli: string;
  hostName: string;
  onChanged?: (settings: AgentSessionCliSettings) => void;
}

export default function CliSettingsPanel({ wsId, managerId, cli, hostName, onChanged }: CliSettingsPanelProps) {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [settings, setSettings] = useState<AgentSessionCliSettings | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getHostCliSettings(managerId, cli);
      setSettings(data);
      setSelected(data.credential?.id || '');
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Failed to load CLI settings');
    } finally {
      setLoading(false);
    }
  }, [managerId, cli]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = (settings?.credential?.id || '') !== selected;

  const save = async () => {
    if (!settings || saving) return;
    setSaving(true);
    try {
      const next = await api.setHostCliSettings(managerId, cli, selected || null);
      setSettings(next);
      setSelected(next.credential?.id || '');
      onChanged?.(next);
      showToast(next.credential ? `${runtimeLabel(cli)} on ${hostName} now signs in with "${next.credential.name}"` : `${runtimeLabel(cli)} on ${hostName} uses the host's own login`, 'success');
    } catch (err: any) {
      showToast(err?.message || 'Failed to save CLI settings', 'error');
    } finally {
      setSaving(false);
    }
  };

  const selectStyle: React.CSSProperties = {
    minWidth: 260,
    padding: '6px 10px',
    borderRadius: tokens.radii.md,
    border: `1px solid ${tokens.colors.border}`,
    background: tokens.colors.surface,
    color: tokens.colors.textPrimary,
    fontSize: 12.5,
  };

  return (
    <section
      aria-label="CLI settings"
      data-cli-settings={cli}
      style={{
        margin: '0 20px',
        border: `1px solid ${tokens.colors.border}`,
        borderRadius: tokens.radii.lg,
        background: tokens.colors.surfaceCard,
        padding: '10px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: tokens.colors.textPrimary }}>CLI settings</span>
        <span style={{ fontSize: 11.5, color: tokens.colors.textSecondary }}>
          Credential used when {runtimeLabel(cli)} runs on {hostName}
        </span>
      </div>
      {error ? (
        <div style={{ fontSize: 12, color: tokens.colors.dangerLight }}>{error}</div>
      ) : loading || !settings ? (
        <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>Loading…</div>
      ) : !settings.supports_credential ? (
        <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>
          {runtimeLabel(cli)} sessions use the host&apos;s own login. AWB credentials cannot be applied to this CLI yet.
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <select
            aria-label="Session credential"
            style={selectStyle}
            value={selected}
            disabled={saving}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">Host&apos;s own login (no AWB credential)</option>
            {settings.candidates.map((c) => (
              <option key={c.id} value={c.id}>{c.name} · {c.provider}{c.scope === 'global' ? ' · global' : ''}</option>
            ))}
          </select>
          <Button variant="primary" size="sm" onClick={() => void save()} disabled={!dirty || saving} loading={saving}>Save</Button>
          <Button variant="ghost" size="sm" onClick={() => navigate(`/ws/${wsId}/settings/credentials`)}>Manage credentials</Button>
          {settings.candidates.length === 0 && (
            <span style={{ fontSize: 11.5, color: tokens.colors.warningLight }}>
              No {runtimeLabel(cli)} credential in this workspace yet. Add one in Settings → Credentials, or log in on the host itself.
            </span>
          )}
        </div>
      )}
    </section>
  );
}
