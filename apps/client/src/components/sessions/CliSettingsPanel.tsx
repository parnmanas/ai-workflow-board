import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { useToast } from '../../contexts/ToastContext';
import { tokens } from '../../tokens';
import type { AgentSessionCliSettings } from '../../types';
import { Button } from '../common';
import { runtimeLabel } from './sessionTranscript.logic';
import { useHostModels, withHostModelOption } from '../../cli/hostModels';

/**
 * CLI 설정 — 이 Runtime Host 의 이 CLI 에 대해 두 가지를 정한다.
 *
 *  1. **인증**: 어떤 워크스페이스 Credential(Settings → Credentials)로 로그인할지. 비워 두면 장비
 *     운영자의 CLI 로그인(`claude login` 등)을 그대로 쓴다. 매니저는 credential 이 묶였을 때만 세션
 *     전용 cli-home 을 만들고, 운영자 홈의 로그인 파일은 건드리지 않는다.
 *  2. **기본 설정**: 새 세션의 approval 모드·모델. 어댑터 프로세스는 매번 자기 기본값으로 시작하므로
 *     여기 정해 둔 값을 세션이 열릴 때마다 다시 건다. 선택지는 어댑터가 알려 준 것을 그대로 쓴다 —
 *     이 호스트에서 세션을 한 번도 연 적이 없으면 아직 알 수 없어 그 줄이 나오지 않는다.
 */
export interface CliSettingsPanelProps {
  wsId: string;
  managerId: string;
  cli: string;
  hostName: string;
  onChanged?: (settings: AgentSessionCliSettings) => void;
}

/** 저장된 기본 설정 중 이 패널이 다루는 문자열 값만 추린다(boolean 설정은 세션 헤더에서 바꾼다). */
function defaultsOf(settings: AgentSessionCliSettings | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(settings?.default_config ?? {})) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

export default function CliSettingsPanel({ wsId, managerId, cli, hostName, onChanged }: CliSettingsPanelProps) {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [settings, setSettings] = useState<AgentSessionCliSettings | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [defaults, setDefaults] = useState<Record<string, string>>({});
  const [backend, setBackend] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getHostCliSettings(managerId, cli);
      setSettings(data);
      setSelected(data.credential?.id || '');
      setDefaults(defaultsOf(data));
      setBackend(data.backend?.id || '');
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

  // 모델 목록은 모든 화면이 공유하는 스토어에서 온다 — 세션을 한 번 열어야만 갱신되던 옛
  // 동작 대신, 열릴 때 오래된/빈 목록을 훅이 재열거하고 버튼으로도 바로 새로고침한다.
  const hostModels = useHostModels(managerId, cli);
  // 모달과 같은 규약: approval 모드(category 'mode') 와 모델(category 'model') 만 여기서 정한다.
  const defaultOptions = withHostModelOption(settings?.known_config_options ?? [], hostModels.models)
    .filter((o) => o.type === 'select' && (o.category === 'mode' || o.category === 'model') && o.options.length > 0);
  const savedDefaults = defaultsOf(settings);
  const dirty = (settings?.credential?.id || '') !== selected
    || (settings?.backend?.id || '') !== backend
    || defaultOptions.some((o) => (defaults[o.config_id] || '') !== (savedDefaults[o.config_id] || ''));

  const save = async () => {
    if (!settings || saving) return;
    setSaving(true);
    try {
      // 바뀐 키만 보낸다 — 빈 값은 null 로 지워 어댑터 기본값으로 되돌린다(PUT 은 부분 갱신).
      const patch: Record<string, string | null> = {};
      for (const option of defaultOptions) {
        const value = defaults[option.config_id] || '';
        if (value === (savedDefaults[option.config_id] || '')) continue;
        patch[option.config_id] = value || null;
      }
      const backendChanged = (settings.backend?.id || '') !== backend;
      const next = await api.setHostCliSettings(
        managerId,
        cli,
        selected || null,
        Object.keys(patch).length ? patch : undefined,
        backendChanged ? (backend || null) : undefined,
      );
      setSettings(next);
      setSelected(next.credential?.id || '');
      setDefaults(defaultsOf(next));
      setBackend(next.backend?.id || '');
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
          {settings.candidates.length === 0 && (
            <span style={{ fontSize: 11.5, color: tokens.colors.warningLight }}>
              No {runtimeLabel(cli)} credential in this workspace yet. Add one in Settings → Credentials, or log in on the host itself.
            </span>
          )}
        </div>
      )}
      {settings && !error && !loading && settings.supports_backend && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, borderTop: `1px solid ${tokens.colors.border}`, paddingTop: 8 }}>
          <span style={{ fontSize: 11.5, color: tokens.colors.textSecondary }}>
            Backend that {runtimeLabel(cli)} talks to on {hostName} — leave it on the CLI default to use Anthropic directly.
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <select
              aria-label="Session backend"
              data-session-backend
              style={selectStyle}
              value={backend}
              disabled={saving}
              onChange={(e) => setBackend(e.target.value)}
            >
              <option value="">{runtimeLabel(cli)} default endpoint</option>
              {settings.backend_candidates.map((b) => (
                <option key={b.id} value={b.id} title={b.base_url}>{b.name} · {b.model}</option>
              ))}
            </select>
            {settings.backend_candidates.length === 0 && (
              <span style={{ fontSize: 11.5, color: tokens.colors.textMuted }}>
                No Claude backend profile is defined on this instance yet (Admin → Claude backends).
              </span>
            )}
          </div>
        </div>
      )}
      {settings && !error && !loading && (
        defaultOptions.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, borderTop: `1px solid ${tokens.colors.border}`, paddingTop: 8 }}>
            <span style={{ fontSize: 11.5, color: tokens.colors.textSecondary }}>
              Applied to every {runtimeLabel(cli)} session on {hostName} — including ones you reopen.
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {defaultOptions.map((option) => (
                <label key={option.config_id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: tokens.colors.textSecondary }}>
                  {option.name}
                  <select
                    aria-label={`Default ${option.name}`}
                    data-default-config-id={option.config_id}
                    style={{ ...selectStyle, minWidth: 180 }}
                    value={defaults[option.config_id] || ''}
                    disabled={saving}
                    onChange={(e) => setDefaults((prev) => ({ ...prev, [option.config_id]: e.target.value }))}
                  >
                    <option value="">{runtimeLabel(cli)} default</option>
                    {option.options.map((choice) => (
                      <option key={choice.value} value={choice.value} title={choice.description}>{choice.name}</option>
                    ))}
                  </select>
                </label>
              ))}
              <Button
                variant="ghost"
                size="sm"
                disabled={saving || hostModels.refreshing || !(hostModels.view?.is_online ?? true)}
                title="Ask the host to re-list the models its CLI accepts"
                onClick={() => void hostModels.refresh()}
              >
                {hostModels.refreshing ? 'Refreshing models…' : 'Refresh models'}
              </Button>
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 11.5, color: tokens.colors.textMuted, borderTop: `1px solid ${tokens.colors.border}`, paddingTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span>
              {hostModels.refreshing
                ? `Asking ${hostName} to list the models ${runtimeLabel(cli)} accepts…`
                : `Approval mode and model defaults appear here once ${hostName} reports what ${runtimeLabel(cli)} offers.`}
            </span>
            <Button variant="ghost" size="sm" disabled={saving || hostModels.refreshing} onClick={() => void hostModels.refresh()}>
              Refresh models
            </Button>
          </div>
        )
      )}
      {/* 저장은 한 곳에만 둔다 — credential 을 못 받는 CLI(hermes) 도 기본 설정은 저장할 수 있어야 한다. */}
      {settings && !error && !loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Button variant="primary" size="sm" onClick={() => void save()} disabled={!dirty || saving} loading={saving}>Save</Button>
          {settings.supports_credential && (
            <Button variant="ghost" size="sm" onClick={() => navigate(`/ws/${wsId}/settings/credentials`)}>Manage credentials</Button>
          )}
        </div>
      )}
    </section>
  );
}
