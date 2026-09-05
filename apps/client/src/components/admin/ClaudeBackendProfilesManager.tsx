import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { ClaudeBackendProfile, Credential } from '../../types';
import { Button, Card, ConfirmDialog, EmptyState, ErrorState, Input, Select, Textarea } from '../common';
import { useToast } from '../../contexts/ToastContext';
import { tokens } from '../../tokens';

const empty = (): ClaudeBackendProfile => ({
  id: '', name: '', kind: 'claude-backend', protocol: 'anthropic-compatible',
  base_url: '', model: '', omit_effort: false, credential_required: false, auth_env: 'ANTHROPIC_AUTH_TOKEN',
});

/** 삭제 확인 다이얼로그에 넣을 참조 요약. 서버 impact 응답을 사람이 읽는 문장으로. */
function impactSummary(impact: {
  workspaces?: unknown[]; boards?: unknown[]; agents?: unknown[]; runs?: unknown[]; global_default?: boolean;
}): string {
  const parts = [
    `워크스페이스 ${impact.workspaces?.length ?? 0}개`,
    `보드 ${impact.boards?.length ?? 0}개`,
    `에이전트 ${impact.agents?.length ?? 0}개`,
    `티켓 재정의 ${impact.runs?.length ?? 0}건`,
  ];
  return impact.global_default ? `전역 기본값 · ${parts.join(' · ')}` : parts.join(' · ');
}

export default function ClaudeBackendProfilesManager({ workspaceId }: { workspaceId: string }) {
  const { showToast } = useToast();
  const [profiles, setProfiles] = useState<ClaudeBackendProfile[]>([]);
  const [defaultId, setDefaultId] = useState('');
  const [profilesError, setProfilesError] = useState('');
  const [editing, setEditing] = useState<ClaudeBackendProfile>(empty());
  const [isNew, setIsNew] = useState(true);
  const [adapterText, setAdapterText] = useState('');
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [credentialSearch, setCredentialSearch] = useState('');
  const [credentialsLoading, setCredentialsLoading] = useState(true);
  const [credentialsError, setCredentialsError] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ClaudeBackendProfile | null>(null);
  const [deleteSummary, setDeleteSummary] = useState('');

  const load = useCallback(async () => {
    setProfilesError('');
    try {
      const data = await api.getClaudeBackendProfiles();
      setProfiles(data.profiles);
      setDefaultId(data.default_profile_id || '');
    } catch (error: any) {
      setProfiles([]);
      setProfilesError(error?.message || '프로필 목록을 불러오지 못했습니다.');
    }
  }, []);
  useEffect(() => { load(); }, [load]);
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
    catch { showToast('Adapter 설정이 올바른 JSON 이 아닙니다', 'error'); return; }
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
      await load(); edit(); showToast('프로필을 저장했습니다', 'success');
    } catch (e: any) { showToast(`프로필 저장 실패: ${e.message || '요청을 처리하지 못했습니다'}`, 'error'); }
    finally { setSaving(false); }
  };
  // 삭제는 두 단계다 — 먼저 서버에 영향 범위를 물어 확인 다이얼로그 본문에 담고,
  // 사용자가 승인하면 detach 로 지운다(참조하던 대상은 상속으로 되돌아간다).
  const requestRemove = async (profile: ClaudeBackendProfile) => {
    try {
      const impact = await api.getClaudeBackendProfileImpact(profile.id);
      setDeleteSummary(impactSummary(impact || {}));
    } catch {
      setDeleteSummary('참조 현황을 확인하지 못했습니다.');
    }
    setDeleteTarget(profile);
  };
  const confirmRemove = async () => {
    const profile = deleteTarget;
    setDeleteTarget(null);
    if (!profile) return;
    try {
      await api.deleteClaudeBackendProfile(profile.id, { detach: true });
      await load(); edit(); showToast('프로필을 삭제했습니다', 'success');
    } catch (e: any) { showToast(e.message || '프로필을 삭제하지 못했습니다', 'error'); }
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
        <h3 style={{ margin: 0, color: tokens.colors.textStrong }}>Claude backend 프로필</h3>
        <p style={{ margin: `${tokens.spacing.xs}px 0 0`, color: tokens.colors.textMuted, fontSize: tokens.typography.fontSizeMd }}>
          Claude CLI의 도구 흐름을 유지하면서 모델 요청을 호환 endpoint로 연결합니다.
          프로필은 인스턴스 전역이라 모든 워크스페이스가 같은 목록을 봅니다.
        </p>
      </div>
      <div data-layout="responsive-profile-columns" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: tokens.spacing.lg }}>
        <Card padding={16} style={{ flex: '1 1 280px', minWidth: 0 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: tokens.spacing.sm, marginBottom: tokens.spacing.md }}>
            <div><strong style={{ color: tokens.colors.textStrong }}>프로필 목록</strong><div style={{ color: tokens.colors.textMuted, fontSize: tokens.typography.fontSizeXs }}>{profiles.length}개 등록됨</div></div>
            <Button size="sm" variant="primary" onClick={() => edit()}>새 프로필</Button>
          </div>
          <Select label="전역 기본값" aria-label="전역 기본값" value={defaultId} options={[
            { value: '', label: 'Native Anthropic 상속' }, { value: 'none', label: 'Anthropic 기본값 명시' },
            ...profiles.map(profile => ({ value: profile.id, label: profile.name })),
          ]} onChange={async e => {
            const value = e.target.value; setDefaultId(value);
            try { await api.setDefaultClaudeBackendProfile(value || null); }
            catch (error: any) { showToast(error.message, 'error'); await load(); }
          }} />
          <div style={{ display: 'grid', gap: tokens.spacing.sm, marginTop: tokens.spacing.md }}>
            {profilesError
              ? <ErrorState message={profilesError} onRetry={() => { load(); }} />
              : profiles.length === 0
                ? <EmptyState title="등록된 프로필이 없습니다" description="새 프로필을 만들면 모든 워크스페이스에서 선택할 수 있습니다." />
                : null}
            {profiles.map(profile => (
              <Card key={profile.id} selected={!isNew && editing.id === profile.id} padding="10px 12px" style={{ boxShadow: 'none' }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: tokens.spacing.sm }}>
                  <button onClick={() => edit(profile)} style={{ flex: '1 1 160px', minWidth: 0, border: 0, padding: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', textAlign: 'left' }}>
                    <strong>{profile.name}</strong><div style={{ color: tokens.colors.textMuted, fontSize: tokens.typography.fontSizeXs, overflowWrap: 'anywhere' }}>{profile.protocol} · {profile.model || '모델 미지정'}</div>
                  </button>
                  <Button size="sm" variant="danger" onClick={() => requestRemove(profile)}>삭제</Button>
                </div>
              </Card>
            ))}
          </div>
        </Card>
        <Card padding={20} style={{ flex: '2 1 520px', minWidth: 0 }}>
          <h3 style={{ margin: `0 0 ${tokens.spacing.lg}px`, color: tokens.colors.textStrong }}>{isNew ? '프로필 만들기' : `${editing.name} 편집`}</h3>
          <section style={{ marginBottom: tokens.spacing.lg }}>
            {sectionTitle('기본 정보', '프로필을 식별하는 이름과 변경되지 않는 ID입니다.')}
            <div style={fieldGrid}>{field('고정 ID', 'id')}{field('이름', 'name')}</div>
          </section>
          <section style={{ marginBottom: tokens.spacing.lg }}>
            {sectionTitle('연결 설정', '호환 protocol, model, endpoint와 Credential을 설정합니다.')}
            <div style={fieldGrid}>
              <Select label="Protocol" aria-label="Protocol" value={editing.protocol} options={[{ value: 'anthropic-compatible', label: 'Anthropic-compatible' }, { value: 'openai-compatible', label: 'OpenAI-compatible' }]} onChange={e => setEditing({ ...editing, protocol: e.target.value as any })} />
              {field('모델', 'model')}{field('Base URL', 'base_url')}
              <div style={{ display: 'grid', gap: tokens.spacing.sm, minWidth: 0 }}>
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
              {field('인증 환경 변수', 'auth_env')}
              <label style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing.sm, fontSize: tokens.typography.fontSizeMd }}><input type="checkbox" checked={Boolean(editing.credential_required)} onChange={e => setEditing({ ...editing, credential_required: e.target.checked })} />Credential 필수</label>
              <label style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing.sm, fontSize: tokens.typography.fontSizeMd }}><input type="checkbox" checked={Boolean(editing.omit_effort)} onChange={e => setEditing({ ...editing, omit_effort: e.target.checked })} />effort 미전달</label>
            </div>
            <div style={{ marginTop: tokens.spacing.md }}>
              <Textarea
                label="Adapter 설정 (JSON)"
                aria-label="Adapter 설정 (JSON)"
                monospace
                rows={8}
                value={adapterText}
                onChange={e => setAdapterText(e.target.value)}
                placeholder="OpenAI-compatible 프로필에 필요합니다"
              />
            </div>
          </section>
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: tokens.spacing.sm, marginTop: tokens.spacing.lg }}>
            {!isNew && <Button variant="secondary" disabled={saving} onClick={() => edit()}>취소</Button>}
            <Button variant="primary" loading={saving} onClick={save}>프로필 저장</Button>
          </div>
        </Card>
      </div>
      <ConfirmDialog
        isOpen={Boolean(deleteTarget)}
        title="프로필을 삭제할까요?"
        confirmLabel="프로필 삭제"
        cancelLabel="취소"
        message={
          <>
            <strong>{deleteTarget?.name}</strong> 프로필을 삭제합니다. 현재 참조: {deleteSummary}.
            {'\n\n'}
            참조하던 보드·에이전트·티켓은 핀이 해제되어 전역 기본값을 상속합니다.
          </>
        }
        onConfirm={confirmRemove}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
