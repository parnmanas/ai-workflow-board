import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import { cliCredentialPrefix, cliLabel, cliSupportsBackendProfile, cliSupportsCredential } from '../../cli/catalog';
import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import type { AgentSessionCliSettings } from '../../types';
import { Button, Select } from '../common';

type CredentialChoice = { id: string; name: string; provider: string; scope?: string };
type BackendChoice = { id: string; name: string; model?: string };

/** Login and backend choices, scoped to the selected host and CLI by the server. */
export default function RuntimeConnectionFields({ hostId, cli, credentialId, backendId, onCredentialChange,
  onBackendChange, settings, credentials, backendProfiles, idPrefix, allowBackendOptOut = true, disabled = false }: {
  hostId: string;
  idPrefix?: string;
  cli: string;
  credentialId: string;
  backendId?: string;
  onCredentialChange(id: string): void;
  onBackendChange?(id: string): void;
  settings?: AgentSessionCliSettings;
  credentials?: CredentialChoice[];
  backendProfiles?: BackendChoice[];
  disabled?: boolean;
  allowBackendOptOut?: boolean;
}) {
  useLocale();
  const [loaded, setLoaded] = useState<{ key: string; settings: AgentSessionCliSettings } | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const key = `${hostId}:${cli}`;
  const supplied = settings !== undefined || credentials !== undefined;
  const data = settings ?? (loaded?.key === key ? loaded.settings : undefined);
  const loading = !supplied && !!hostId && !!cli && !data && !error;
  useEffect(() => {
    setError('');
    if (supplied || !hostId || !cli) return;
    let cancelled = false;
    setLoaded(null);
    api.getHostCliSettings(hostId, cli).then((next) => {
      if (!cancelled) setLoaded({ key, settings: next });
    }).catch((e) => { if (!cancelled) setError(e.message || translate('Failed to load CLI settings')); });
    return () => { cancelled = true; };
  }, [hostId, cli, supplied, revision]);
  if (!cli) return null;
  const prefix = cliCredentialPrefix(cli);
  const candidates = (data?.candidates ?? credentials ?? []).filter((candidate) => prefix && candidate.provider.startsWith(prefix));
  const backends = data?.backend_candidates ?? backendProfiles ?? [];
  const supportsCredential = data?.supports_credential ?? cliSupportsCredential(cli);
  const supportsBackend = data?.supports_backend ?? cliSupportsBackendProfile(cli);
  const missing = !!credentialId && !candidates.some((candidate) => candidate.id === credentialId);
  return <div data-runtime-field="connection" style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
    {loading && <div role="status">{translate('Loading CLI settings…')}</div>}
    {supportsCredential ? <>
      <Select id={idPrefix ? `${idPrefix}-credential` : undefined} label={translate('Credential')} aria-label={translate('Session credential')}
        value={credentialId} disabled={disabled || loading || !hostId} onChange={(e) => onCredentialChange(e.target.value)}
        options={[
          { value: '', label: translate('Host\'s own login (no AWB credential)') },
          ...(missing ? [{ value: credentialId, label: `${translate('Unavailable credential ·')} ${credentialId.slice(0, 8)}`, disabled: true }] : []),
          ...candidates.map((candidate) => ({ value: candidate.id,
            label: `${candidate.name} · ${candidate.provider}${candidate.scope === 'global' ? translate(' · global') : ''}` })),
        ]} />
      {missing && !loading && <div role="status">{translate('The saved credential is unavailable. Choose another credential or the host’s own login.')}</div>}
      {!credentialId && <p style={{ fontSize: 12, margin: 0 }}>{translate('The host must already be signed in. On a new host, select an AWB credential or add one below.')}</p>}
      <a href="/settings/credentials" target="_blank" rel="noopener noreferrer" style={{ fontSize: 12 }}>{translate('Add / manage credentials ↗')}</a>
    </> : <div style={{ fontSize: 12 }}>{translate('Host 로그인 그대로 사용')}</div>}
    {supportsBackend && onBackendChange && <Select label={translate('Session backend')} aria-label={translate('Session backend')}
      data-session-backend value={backendId || ''} disabled={disabled || loading || !hostId}
      onChange={(e) => onBackendChange(e.target.value)} options={[
        { value: '', label: `${cliLabel(cli)} ${translate('default endpoint')}` },
        ...(allowBackendOptOut ? [{ value: 'none', label: translate('Anthropic (no custom backend)') }] : []),
        ...(backendId && backendId !== 'none' && !backends.some((backend) => backend.id === backendId)
          ? [{ value: backendId, label: backendId, disabled: true }] : []),
        ...backends.map((backend) => ({ value: backend.id, label: backend.model ? `${backend.name} · ${backend.model}` : backend.name })),
      ]} />}
    {supportsBackend && onBackendChange && !backends.length && !loading && <div style={{ fontSize: 12 }}>{translate('No Claude backend profile is defined on this instance yet (Admin → Claude backends).')}</div>}
    {error && <div role="alert">{error} <Button variant="ghost" size="sm" disabled={disabled}
      onClick={() => setRevision((value) => value + 1)}>{translate('새로고침')}</Button></div>}
  </div>;
}
