import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { AgentSessionProcessSettings, AgentSessionRestartSettings } from '../../types';
import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import { Button, Select } from '../common';
import RuntimeConnectionFields from '../runtime/RuntimeConnectionFields';

/** Mounted only inside the open menu; reading settings never starts a host RPC. */
export default function SessionProcessSettings({ managerId, cli, sessionId, disabled, onChange }: {
  managerId: string;
  cli: string;
  sessionId: string;
  disabled: boolean;
  onChange(settings: AgentSessionRestartSettings): void;
}) {
  useLocale();
  const [settings, setSettings] = useState<AgentSessionProcessSettings | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setSettings(null);
    setError('');
    api.getHostSessionSettings(managerId, cli, sessionId).then((value) => {
      if (!cancelled) setSettings(value);
    }).catch((err) => { if (!cancelled) setError(err.message || translate('Failed to load CLI settings')); });
    return () => { cancelled = true; };
  }, [managerId, cli, sessionId, reload]);
  if (error) return <div role="alert">{error} <Button variant="ghost" size="sm" onClick={() => setReload((value) => value + 1)}>{translate('새로고침')}</Button></div>;
  if (!settings) return <div role="status">{translate('Loading CLI settings…')}</div>;
  const apply = (patch: Omit<AgentSessionRestartSettings, 'expected_revision'>) => {
    if (!disabled) onChange({ ...patch, expected_revision: settings.revision });
  };
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
    <p style={{ margin: 0, fontSize: 12 }}>{translate('Changes apply only to this session. Restart confirmation appears before applying.')}</p>
    <RuntimeConnectionFields hostId={managerId} cli={cli} settings={settings} disabled={disabled}
      credentialId={settings.credential_id ?? ''} backendId={settings.backend?.id ?? ''} allowBackendOptOut={false}
      onCredentialChange={(id) => { if (id !== (settings.credential_id ?? '')) apply({ credential_id: id || null }); }}
      onBackendChange={(id) => { if (id !== (settings.backend?.id ?? '')) apply({ backend_profile_id: id || null }); }} />
    {(settings.launch_options ?? []).map((option) => <Select key={option.config_id} label={option.name} aria-label={option.name}
      title={option.description} data-session-launch-option={option.config_id} disabled={disabled}
      value={String(settings.default_config[option.config_id] ?? '')}
      options={[{ value: '', label: translate('CLI default') }, ...option.options.map((value) => ({ value: value.value, label: value.name }))]}
      onChange={(event) => {
        const value = event.target.value;
        if (value !== String(settings.default_config[option.config_id] ?? '')) apply({ config_overrides: { [option.config_id]: value || null } });
      }} />)}
  </div>;
}
