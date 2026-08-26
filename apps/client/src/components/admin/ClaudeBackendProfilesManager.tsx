import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { ClaudeBackendProfile, Credential } from '../../types';
import { Button } from '../common';
import { useToast } from '../../contexts/ToastContext';
import { tokens } from '../../tokens';

const empty = (): ClaudeBackendProfile => ({
  id: '', name: '', kind: 'claude-backend', protocol: 'anthropic-compatible',
  base_url: '', model: '', omit_effort: false, credential_required: false, auth_env: 'ANTHROPIC_AUTH_TOKEN',
});

export default function ClaudeBackendProfilesManager({ workspaceId }: { workspaceId: string }) {
  const { showToast } = useToast();
  const [profiles, setProfiles] = useState<ClaudeBackendProfile[]>([]);
  const [defaultId, setDefaultId] = useState('');
  const [editing, setEditing] = useState<ClaudeBackendProfile>(empty());
  const [isNew, setIsNew] = useState(true);
  const [adapterText, setAdapterText] = useState('');
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [credentialSearch, setCredentialSearch] = useState('');
  const [credentialsLoading, setCredentialsLoading] = useState(true);
  const [credentialsError, setCredentialsError] = useState('');

  const load = useCallback(async () => {
    const data = await api.getClaudeBackendProfiles();
    setProfiles(data.profiles);
    setDefaultId(data.default_profile_id || '');
  }, []);
  useEffect(() => { load().catch(e => showToast(e.message, 'error')); }, [load, showToast]);
  const loadCredentials = useCallback(async () => {
    setCredentialsLoading(true);
    setCredentialsError('');
    try {
      setCredentials(await api.listCredentials(workspaceId));
    } catch (error: any) {
      setCredentials([]);
      setCredentialsError(error.message || 'Credential 목록을 불러오지 못했습니다.');
    } finally {
      setCredentialsLoading(false);
    }
  }, [workspaceId]);
  useEffect(() => { loadCredentials(); }, [loadCredentials]);

  const edit = (profile?: ClaudeBackendProfile) => {
    const next = profile ? { ...profile } : empty();
    setEditing(next);
    setAdapterText(next.adapter ? JSON.stringify(next.adapter, null, 2) : '');
    setCredentialSearch('');
    setIsNew(!profile);
  };
  const save = async () => {
    let adapter;
    try { adapter = adapterText.trim() ? JSON.parse(adapterText) : undefined; }
    catch { showToast('Adapter config must be valid JSON', 'error'); return; }
    // 조회 응답 전용 필드는 strict 서버 스키마로 다시 보내지 않는다.
    const { credential_status: _credentialStatus, ...editable } = editing;
    const payload = { ...editable, ...(adapter ? { adapter } : {}) };
    if (!adapter) delete payload.adapter;
    try {
      if (isNew) await api.createClaudeBackendProfile(payload);
      else await api.updateClaudeBackendProfile(editing.id, {
        ...payload,
        credential_ref: editing.credential_ref || null,
      });
      await load(); edit(); showToast('Claude backend profile saved', 'success');
    } catch (e: any) { showToast(`프로필 저장 실패: ${e.message || '요청을 처리하지 못했습니다'}`, 'error'); }
  };
  const remove = async (profile: ClaudeBackendProfile) => {
    try {
      const impact = await api.getClaudeBackendProfileImpact(profile.id);
      const summary = `${impact.workspaces.length} workspace(s), ${impact.boards.length} board(s), ${impact.agents.length} agent(s), ${impact.runs.length} run override(s)`;
      if (!window.confirm(`Delete “${profile.name}”? References: ${summary}.\n\nReferenced profiles will be detached to inherit.`)) return;
      await api.deleteClaudeBackendProfile(profile.id, { detach: true });
      await load(); edit(); showToast('Profile deleted safely', 'success');
    } catch (e: any) { showToast(e.message || 'Delete failed', 'error'); }
  };
  const field = (label: string, key: keyof ClaudeBackendProfile, type = 'text') => (
    <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
      {label}
      <input type={type} value={String(editing[key] ?? '')}
        disabled={!isNew && key === 'id'}
        onChange={e => setEditing({ ...editing, [key]: e.target.value })} />
    </label>
  );
  const selectedCredential = credentials.find(credential => credential.id === editing.credential_ref);
  const invalidCredentialRef = Boolean(editing.credential_ref && !credentialsLoading && !credentialsError && !selectedCredential);
  const normalizedCredentialSearch = credentialSearch.trim().toLocaleLowerCase();
  const filteredCredentials = credentials.filter(credential =>
    credential.id === editing.credential_ref
    || !normalizedCredentialSearch
    || credential.name.toLocaleLowerCase().includes(normalizedCredentialSearch)
    || credential.provider.toLocaleLowerCase().includes(normalizedCredentialSearch)
  );
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 1fr) minmax(380px, 2fr)', gap: 20 }}>
      <section>
        <Button size="sm" variant="primary" onClick={() => edit()}>New profile</Button>
        <label style={{ display: 'block', margin: '16px 0', fontSize: 13 }}>
          Global default
          <select value={defaultId} onChange={async e => {
            const value = e.target.value; setDefaultId(value);
            try { await api.setDefaultClaudeBackendProfile(value || null); }
            catch (error: any) { showToast(error.message, 'error'); await load(); }
          }} style={{ display: 'block', width: '100%', marginTop: 4 }}>
            <option value="">Inherit native Anthropic</option>
            <option value="none">Explicit Anthropic default</option>
            {profiles.map(p => <option value={p.id} key={p.id}>{p.name}</option>)}
          </select>
        </label>
        {profiles.map(profile => (
          <div key={profile.id} style={{ border: `1px solid ${tokens.colors.border}`, borderRadius: 6, padding: 10, marginBottom: 8 }}>
            <button onClick={() => edit(profile)} style={{ border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', textAlign: 'left' }}>
              <strong>{profile.name}</strong><br />
              <small>{profile.protocol} · {profile.model}</small>
            </button>
            <Button size="sm" variant="danger" onClick={() => remove(profile)} style={{ float: 'right' }}>Delete</Button>
          </div>
        ))}
      </section>
      <section style={{ border: `1px solid ${tokens.colors.border}`, borderRadius: 8, padding: 16 }}>
        <h3 style={{ marginTop: 0 }}>{isNew ? 'Create profile' : `Edit ${editing.name}`}</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {field('Stable ID', 'id')}{field('Name', 'name')}
          <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>Protocol
            <select value={editing.protocol} onChange={e => setEditing({ ...editing, protocol: e.target.value as any })}>
              <option value="anthropic-compatible">Anthropic-compatible</option>
              <option value="openai-compatible">OpenAI-compatible</option>
            </select>
          </label>
          {field('Model', 'model')}{field('Base URL', 'base_url')}
          <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
            Credential
            <input type="search" value={credentialSearch}
              onChange={e => setCredentialSearch(e.target.value)}
              placeholder="이름 또는 provider로 검색" disabled={credentialsLoading || Boolean(credentialsError)} />
            <select aria-label="Credential 선택" value={editing.credential_ref || ''}
              disabled={credentialsLoading || Boolean(credentialsError)}
              onChange={e => setEditing({ ...editing, credential_ref: e.target.value || undefined })}>
              <option value="">선택하지 않음</option>
              {invalidCredentialRef && <option value={editing.credential_ref}>삭제되었거나 접근할 수 없는 Credential</option>}
              {filteredCredentials.map(credential => (
                <option value={credential.id} key={credential.id}>
                  {credential.name} · {credential.provider}{credential.scope === 'global' ? ' · Global' : ''}
                </option>
              ))}
            </select>
            {credentialsLoading && <small style={{ color: tokens.colors.textMuted }}>Credential 목록을 불러오는 중…</small>}
            {credentialsError && (
              <small style={{ color: tokens.colors.danger }}>
                Credential 목록을 불러오지 못했습니다. 기존 선택값은 변경되지 않습니다.{' '}
                <button type="button" onClick={loadCredentials}>다시 시도</button>
              </small>
            )}
            {invalidCredentialRef && (
              <small style={{ color: tokens.colors.danger }}>
                저장된 Credential을 현재 workspace에서 찾을 수 없습니다. 다른 Credential을 선택하거나 해제하세요.
              </small>
            )}
            {!credentialsLoading && !credentialsError && credentials.length === 0 && (
              <small style={{ color: tokens.colors.textMuted }}>현재 workspace에서 선택 가능한 Credential이 없습니다.</small>
            )}
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={Boolean(editing.credential_required)}
              onChange={e => setEditing({ ...editing, credential_required: e.target.checked })} />
            Credential required
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={Boolean(editing.omit_effort)}
              onChange={e => setEditing({ ...editing, omit_effort: e.target.checked })} />
            Do not set effort
          </label>
        </div>
        <label style={{ display: 'block', marginTop: 12, fontSize: 13 }}>Adapter config (JSON)
          <textarea rows={8} value={adapterText} onChange={e => setAdapterText(e.target.value)}
            placeholder='Required for openai-compatible profiles' style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'monospace' }} />
        </label>
        <Button variant="primary" onClick={save}>Save profile</Button>
      </section>
    </div>
  );
}
