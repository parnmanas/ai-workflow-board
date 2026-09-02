import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { ClaudeBackendProfile, Credential } from '../../types';
import { Button, Card, Input, Select } from '../common';
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
  const [saving, setSaving] = useState(false);

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
    setSaving(true);
    try {
      if (isNew) await api.createClaudeBackendProfile(payload);
      else await api.updateClaudeBackendProfile(editing.id, {
        ...payload,
        credential_ref: editing.credential_ref || null,
      });
      await load(); edit(); showToast('Claude backend profile saved', 'success');
    } catch (e: any) { showToast(`프로필 저장 실패: ${e.message || '요청을 처리하지 못했습니다'}`, 'error'); }
    finally { setSaving(false); }
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
    <Input label={label} aria-label={label} type={type} value={String(editing[key] ?? '')}
      disabled={!isNew && key === 'id'}
      onChange={e => setEditing({ ...editing, [key]: e.target.value })} />
  );
  const selectedCredential = credentials.find(credential => credential.id === editing.credential_ref);
  const invalidCredentialRef = Boolean(editing.credential_ref && !credentialsLoading && !credentialsError && !selectedCredential);
  const preservedCredentialRef = Boolean(editing.credential_ref && !selectedCredential);
  const preservedCredentialLabel = credentialsLoading
    ? '기존 선택 유지 (Credential 목록 확인 중)'
    : credentialsError
      ? '기존 선택 유지 (Credential 목록 로드 실패)'
      : '삭제되었거나 접근할 수 없는 Credential';
  const normalizedCredentialSearch = credentialSearch.trim().toLocaleLowerCase();
  const filteredCredentials = credentials.filter(credential =>
    credential.id === editing.credential_ref
    || !normalizedCredentialSearch
    || credential.name.toLocaleLowerCase().includes(normalizedCredentialSearch)
    || credential.provider.toLocaleLowerCase().includes(normalizedCredentialSearch)
  );
  const sectionTitle = (title: string, description: string) => (
    <div style={{ marginBottom: tokens.spacing.md }}>
      <h4 style={{ margin: 0, fontSize: tokens.typography.fontSizeLg, color: tokens.colors.textStrong }}>{title}</h4>
      <p style={{ margin: `${tokens.spacing.xs}px 0 0`, color: tokens.colors.textMuted, fontSize: tokens.typography.fontSizeMd }}>{description}</p>
    </div>
  );
  const fieldGrid: React.CSSProperties = {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: tokens.spacing.md,
  };
  return (
    <div data-testid="claude-profile-manager" style={{ maxWidth: 1120, display: 'grid', gap: tokens.spacing.lg }}>
      <div>
        <h3 style={{ margin: 0, color: tokens.colors.textStrong }}>Claude backend profiles</h3>
        <p style={{ margin: `${tokens.spacing.xs}px 0 0`, color: tokens.colors.textMuted, fontSize: tokens.typography.fontSizeMd }}>
          Claude CLI의 도구 흐름을 유지하면서 모델 요청을 호환 endpoint로 연결합니다.
        </p>
      </div>
      <div data-layout="responsive-profile-columns" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: tokens.spacing.lg }}>
        <Card padding={16} style={{ flex: '1 1 280px', minWidth: 0 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: tokens.spacing.sm, marginBottom: tokens.spacing.md }}>
            <div><strong style={{ color: tokens.colors.textStrong }}>프로필 목록</strong><div style={{ color: tokens.colors.textMuted, fontSize: tokens.typography.fontSizeXs }}>{profiles.length}개 등록됨</div></div>
            <Button size="sm" variant="primary" onClick={() => edit()}>새 프로필</Button>
          </div>
          <Select label="Global default" value={defaultId} options={[
            { value: '', label: 'Native Anthropic 상속' }, { value: 'none', label: 'Anthropic 기본값 명시' },
            ...profiles.map(profile => ({ value: profile.id, label: profile.name })),
          ]} onChange={async e => {
            const value = e.target.value; setDefaultId(value);
            try { await api.setDefaultClaudeBackendProfile(value || null); }
            catch (error: any) { showToast(error.message, 'error'); await load(); }
          }} />
          <div style={{ display: 'grid', gap: tokens.spacing.sm, marginTop: tokens.spacing.md }}>
            {profiles.length === 0 && <div style={{ padding: tokens.spacing.md, textAlign: 'center', color: tokens.colors.textMuted, fontSize: tokens.typography.fontSizeMd }}>아직 등록된 프로필이 없습니다.</div>}
            {profiles.map(profile => (
              <Card key={profile.id} selected={!isNew && editing.id === profile.id} padding="10px 12px" style={{ boxShadow: 'none' }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: tokens.spacing.sm }}>
                  <button onClick={() => edit(profile)} style={{ flex: '1 1 160px', minWidth: 0, border: 0, padding: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', textAlign: 'left' }}>
                    <strong>{profile.name}</strong><div style={{ color: tokens.colors.textMuted, fontSize: tokens.typography.fontSizeXs, overflowWrap: 'anywhere' }}>{profile.protocol} · {profile.model || '모델 미지정'}</div>
                  </button>
                  <Button size="sm" variant="danger" onClick={() => remove(profile)}>삭제</Button>
                </div>
              </Card>
            ))}
          </div>
        </Card>
        <Card padding={20} style={{ flex: '2 1 520px', minWidth: 0 }}>
          <h3 style={{ margin: `0 0 ${tokens.spacing.lg}px`, color: tokens.colors.textStrong }}>{isNew ? '프로필 만들기' : `${editing.name} 편집`}</h3>
          <section style={{ marginBottom: tokens.spacing.lg }}>
            {sectionTitle('기본 정보', '프로필을 식별하는 이름과 변경되지 않는 ID입니다.')}
            <div style={fieldGrid}>{field('Stable ID', 'id')}{field('Name', 'name')}</div>
          </section>
          <section style={{ marginBottom: tokens.spacing.lg }}>
            {sectionTitle('연결 설정', '호환 protocol, model, endpoint와 Credential을 설정합니다.')}
            <div style={fieldGrid}>
              <Select label="Protocol" aria-label="Protocol" value={editing.protocol} options={[{ value: 'anthropic-compatible', label: 'Anthropic-compatible' }, { value: 'openai-compatible', label: 'OpenAI-compatible' }]} onChange={e => setEditing({ ...editing, protocol: e.target.value as any })} />
              {field('Model', 'model')}{field('Base URL', 'base_url')}
              <div style={{ display: 'grid', gap: tokens.spacing.sm }}>
                <Input label="Credential 검색" type="search" value={credentialSearch} onChange={e => setCredentialSearch(e.target.value)} placeholder="이름 또는 provider로 검색" disabled={credentialsLoading || Boolean(credentialsError)} />
                <Select aria-label="Credential 선택" label="Credential" value={editing.credential_ref || ''} disabled={credentialsLoading || Boolean(credentialsError)} options={[
                  { value: '', label: '선택하지 않음' },
                  ...(preservedCredentialRef ? [{ value: editing.credential_ref!, label: preservedCredentialLabel }] : []),
                  ...filteredCredentials.map(credential => ({ value: credential.id, label: `${credential.name} · ${credential.provider}${credential.scope === 'global' ? ' · Global' : ''}` })),
                ]} onChange={e => setEditing({ ...editing, credential_ref: e.target.value || undefined })} />
                {credentialsLoading && <small style={{ color: tokens.colors.textMuted }}>Credential 목록을 불러오는 중…</small>}
                {credentialsError && <small style={{ color: tokens.colors.danger }}>Credential 목록을 불러오지 못했습니다. 기존 선택값은 변경되지 않습니다. <button type="button" onClick={loadCredentials}>다시 시도</button></small>}
                {invalidCredentialRef && <small style={{ color: tokens.colors.danger }}>저장된 Credential을 현재 workspace에서 찾을 수 없습니다. 다른 Credential을 선택하거나 해제하세요.</small>}
                {!credentialsLoading && !credentialsError && credentials.length === 0 && <small style={{ color: tokens.colors.textMuted }}>현재 workspace에서 선택 가능한 Credential이 없습니다.</small>}
              </div>
            </div>
          </section>
          <section>
            {sectionTitle('Claude 고유 설정', '인증 환경 변수, effort 전달과 adapter 변환을 제어합니다.')}
            <div style={fieldGrid}>
              {field('Auth environment variable', 'auth_env')}
              <label style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing.sm, fontSize: tokens.typography.fontSizeMd }}><input type="checkbox" checked={Boolean(editing.credential_required)} onChange={e => setEditing({ ...editing, credential_required: e.target.checked })} />Credential required</label>
              <label style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing.sm, fontSize: tokens.typography.fontSizeMd }}><input type="checkbox" checked={Boolean(editing.omit_effort)} onChange={e => setEditing({ ...editing, omit_effort: e.target.checked })} />Do not set effort</label>
            </div>
            <label style={{ display: 'grid', gap: tokens.spacing.xs, marginTop: tokens.spacing.md, color: tokens.colors.textMuted, fontSize: tokens.typography.fontSizeXs, fontWeight: tokens.typography.fontWeightSemibold, textTransform: 'uppercase' }}>Adapter config (JSON)
              <textarea rows={8} value={adapterText} onChange={e => setAdapterText(e.target.value)} placeholder="OpenAI-compatible 프로필에 필요합니다" style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'monospace', background: tokens.colors.surface, color: tokens.colors.textStrong, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md, padding: '8px 10px' }} />
            </label>
          </section>
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: tokens.spacing.sm, marginTop: tokens.spacing.lg }}>
            {!isNew && <Button variant="secondary" disabled={saving} onClick={() => edit()}>취소</Button>}
            <Button variant="primary" loading={saving} onClick={save}>프로필 저장</Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
