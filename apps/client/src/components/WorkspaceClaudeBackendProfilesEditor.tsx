import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { WorkspaceClaudeBackendProfiles } from '../types';
import { Button } from './common';
import { useToast } from '../contexts/ToastContext';
import { tokens } from '../tokens';

export default function WorkspaceClaudeBackendProfilesEditor({ workspaceId }: { workspaceId: string }) {
  const { showToast } = useToast();
  const [data, setData] = useState<WorkspaceClaudeBackendProfiles | null>(null);
  const load = () => Promise.all([
    api.getWorkspaceClaudeBackendProfiles(workspaceId),
    api.getWorkspaceClaudeBackendProfileCatalog(workspaceId),
  ]).then(([assigned, catalog]) => setData({ ...assigned, profiles: catalog.profiles }));
  useEffect(() => { load().catch(e => showToast(e.message, 'error')); }, [workspaceId]);
  if (!data) return null;
  const allowed = new Set(data.allowed_profile_ids);
  return (
    <section style={{ border: `1px solid ${tokens.colors.border}`, borderRadius: 8, padding: 16, marginBottom: 20 }}>
      <h3 style={{ marginTop: 0 }}>Claude backend profiles</h3>
      <p style={{ color: tokens.colors.textMuted, fontSize: 13 }}>
        Allow instance profiles in this workspace and optionally choose a workspace default.
        Profile definitions and credentials remain controlled by global admins.
      </p>
      {data.profiles.map(profile => (
        <label key={profile.id} style={{ display: 'block', margin: '7px 0' }}>
          <input type="checkbox" checked={allowed.has(profile.id)} onChange={e => {
            const next = e.target.checked
              ? [...data.allowed_profile_ids, profile.id]
              : data.allowed_profile_ids.filter(id => id !== profile.id);
            setData({ ...data, allowed_profile_ids: next,
              default_profile_id: data.default_profile_id === profile.id ? null : data.default_profile_id });
          }} /> {profile.name} <small>({profile.protocol} · {profile.model} · {profile.base_url})</small>
        </label>
      ))}
      <label style={{ display: 'block', marginTop: 12 }}>Workspace default
        <select value={data.default_profile_id || ''} onChange={e => setData({ ...data, default_profile_id: e.target.value || null })}
          style={{ display: 'block', minWidth: 260, marginTop: 4 }}>
          <option value="">Inherit global default</option>
          <option value="none">Explicit Anthropic default</option>
          {data.profiles.filter(p => allowed.has(p.id)).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <Button variant="primary" size="sm" style={{ marginTop: 12 }} onClick={async () => {
        try {
          const saved = await api.updateWorkspaceClaudeBackendProfiles(workspaceId, {
            allowed_profile_ids: data.allowed_profile_ids, default_profile_id: data.default_profile_id,
          });
          setData({ ...data, ...saved }); showToast('Workspace profile assignment saved', 'success');
        } catch (e: any) { showToast(e.message, 'error'); }
      }}>Save assignment</Button>
    </section>
  );
}
