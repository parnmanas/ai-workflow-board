import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { ClaudeBackendProfile } from '../../types';
import { Button, Card, Input, Select } from '../common';
import { useToast } from '../../contexts/ToastContext';
import { tokens } from '../../tokens';

const empty = (): ClaudeBackendProfile => ({
  id: '', name: '', kind: 'claude-backend', protocol: 'anthropic-compatible',
  base_url: '', model: '', omit_effort: false, credential_required: false, auth_env: 'ANTHROPIC_AUTH_TOKEN',
});

const sectionTitleStyle: React.CSSProperties = {
  margin: 0,
  color: tokens.colors.textStrong,
  fontSize: tokens.typography.fontSizeLg,
  fontWeight: tokens.typography.fontWeightSemibold,
};

const helpTextStyle: React.CSSProperties = {
  margin: '4px 0 0',
  color: tokens.colors.textMuted,
  fontSize: tokens.typography.fontSizeMd,
  lineHeight: tokens.typography.lineHeightBody,
};

export default function ClaudeBackendProfilesManager() {
  const { showToast } = useToast();
  const [profiles, setProfiles] = useState<ClaudeBackendProfile[]>([]);
  const [defaultId, setDefaultId] = useState('');
  const [editing, setEditing] = useState<ClaudeBackendProfile>(empty());
  const [isNew, setIsNew] = useState(true);
  const [adapterText, setAdapterText] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const data = await api.getClaudeBackendProfiles();
    setProfiles(data.profiles);
    setDefaultId(data.default_profile_id || '');
  }, []);
  useEffect(() => { load().catch(e => showToast(e.message, 'error')); }, [load, showToast]);

  const edit = (profile?: ClaudeBackendProfile) => {
    const next = profile ? { ...profile } : empty();
    setEditing(next);
    setAdapterText(next.adapter ? JSON.stringify(next.adapter, null, 2) : '');
    setIsNew(!profile);
  };
  const save = async () => {
    let adapter;
    try { adapter = adapterText.trim() ? JSON.parse(adapterText) : undefined; }
    catch { showToast('Adapter config must be valid JSON', 'error'); return; }
    const payload = { ...editing, ...(adapter ? { adapter } : {}) };
    if (!adapter) delete payload.adapter;
    setSaving(true);
    try {
      if (isNew) await api.createClaudeBackendProfile(payload);
      else await api.updateClaudeBackendProfile(editing.id, payload);
      await load(); edit(); showToast('Claude backend profile saved', 'success');
    } catch (e: any) { showToast(e.message || 'Save failed', 'error'); }
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
    <Input
      label={label}
      type={type}
      value={String(editing[key] ?? '')}
      disabled={!isNew && key === 'id'}
      onChange={event => setEditing({ ...editing, [key]: event.target.value })}
    />
  );

  return (
    <div
      data-testid="claude-profile-shell"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        flexWrap: 'wrap',
        gap: tokens.spacing.lg,
        width: '100%',
        maxWidth: 1120,
      }}
    >
      <section data-testid="claude-profile-list" aria-labelledby="claude-profile-list-title" style={{ flex: '1 1 280px', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: tokens.spacing.sm, marginBottom: tokens.spacing.md }}>
          <div>
            <h2 id="claude-profile-list-title" style={sectionTitleStyle}>Global profiles</h2>
            <p style={helpTextStyle}>Reusable Claude backend definitions.</p>
          </div>
          <Button size="sm" variant="primary" onClick={() => edit()}>New profile</Button>
        </div>
        <Select
          label="Global default"
          value={defaultId}
          onChange={async event => {
            const value = event.target.value;
            setDefaultId(value);
            try { await api.setDefaultClaudeBackendProfile(value || null); }
            catch (error: any) { showToast(error.message, 'error'); await load(); }
          }}
          options={[
            { value: '', label: 'Inherit native Anthropic' },
            { value: 'none', label: 'Explicit Anthropic default' },
            ...profiles.map(profile => ({ value: profile.id, label: profile.name })),
          ]}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing.sm, marginTop: tokens.spacing.md }}>
          {profiles.length === 0 && (
            <Card padding={tokens.spacing.md} style={{ boxShadow: 'none' }}>
              <p style={{ ...helpTextStyle, margin: 0 }}>No backend profiles yet. Create one to route Claude requests to another endpoint.</p>
            </Card>
          )}
          {profiles.map(profile => (
            <Card key={profile.id} selected={!isNew && editing.id === profile.id} padding={tokens.spacing.sm} style={{ boxShadow: 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing.sm }}>
                <button
                  type="button"
                  onClick={() => edit(profile)}
                  aria-label={`Edit ${profile.name}`}
                  style={{ flex: 1, minWidth: 0, padding: 4, border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', textAlign: 'left' }}
                >
                  <strong style={{ display: 'block', color: tokens.colors.textStrong, fontSize: tokens.typography.fontSizeMd }}>{profile.name}</strong>
                  <span style={{ display: 'block', marginTop: 2, color: tokens.colors.textMuted, fontSize: tokens.typography.fontSizeXs, overflowWrap: 'anywhere' }}>
                    {profile.protocol} · {profile.model}
                  </span>
                </button>
                <Button size="sm" variant="danger" onClick={() => remove(profile)}>Delete</Button>
              </div>
            </Card>
          ))}
        </div>
      </section>

      <Card padding={tokens.spacing.md} style={{ flex: '2 1 520px', minWidth: 0, boxShadow: 'none' }}>
        <section data-testid="claude-profile-editor" aria-labelledby="claude-profile-editor-title">
          <div style={{ marginBottom: tokens.spacing.lg }}>
            <h2 id="claude-profile-editor-title" style={sectionTitleStyle}>{isNew ? 'Create profile' : `Edit ${editing.name}`}</h2>
            <p style={helpTextStyle}>Configure identity and connection details, then add Claude-specific behavior if needed.</p>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing.lg }}>
            <section aria-labelledby="claude-profile-basic-title">
              <h3 id="claude-profile-basic-title" style={sectionTitleStyle}>Basic information</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: tokens.spacing.md, marginTop: tokens.spacing.md }}>
                {field('Stable ID', 'id')}
                {field('Name', 'name')}
              </div>
            </section>

            <section aria-labelledby="claude-profile-connection-title">
              <h3 id="claude-profile-connection-title" style={sectionTitleStyle}>Connection</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: tokens.spacing.md, marginTop: tokens.spacing.md }}>
                <Select
                  label="Protocol"
                  value={editing.protocol}
                  onChange={event => setEditing({ ...editing, protocol: event.target.value as ClaudeBackendProfile['protocol'] })}
                  options={[
                    { value: 'anthropic-compatible', label: 'Anthropic-compatible' },
                    { value: 'openai-compatible', label: 'OpenAI-compatible' },
                  ]}
                />
                {field('Model', 'model')}
                {field('Base URL', 'base_url')}
                {field('Credential ref (UUID)', 'credential_ref')}
              </div>
            </section>

            <section aria-labelledby="claude-profile-advanced-title">
              <h3 id="claude-profile-advanced-title" style={sectionTitleStyle}>Claude-specific settings</h3>
              <div style={{ marginTop: tokens.spacing.md }}>
                {field('Authentication environment variable', 'auth_env')}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacing.sm, marginTop: tokens.spacing.md }}>
                {[
                  { key: 'credential_required' as const, label: 'Credential required' },
                  { key: 'omit_effort' as const, label: 'Do not set effort' },
                ].map(option => (
                  <label key={option.key} style={{ flex: '1 1 220px', display: 'flex', alignItems: 'center', gap: tokens.spacing.sm, minHeight: 38, padding: '0 10px', border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md, color: tokens.colors.textSecondary, fontSize: tokens.typography.fontSizeMd }}>
                    <input
                      type="checkbox"
                      checked={Boolean(editing[option.key])}
                      onChange={event => setEditing({ ...editing, [option.key]: event.target.checked })}
                    />
                    {option.label}
                  </label>
                ))}
              </div>
              <label htmlFor="claude-adapter-config" style={{ display: 'block', marginTop: tokens.spacing.md, color: tokens.colors.textMuted, fontSize: tokens.typography.fontSizeXs, fontWeight: tokens.typography.fontWeightSemibold, textTransform: 'uppercase' }}>
                Adapter config (JSON)
              </label>
              <textarea
                id="claude-adapter-config"
                rows={8}
                value={adapterText}
                onChange={event => setAdapterText(event.target.value)}
                placeholder="Required for openai-compatible profiles"
                style={{ width: '100%', marginTop: tokens.spacing.xs, boxSizing: 'border-box', resize: 'vertical', padding: '8px 10px', border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md, background: tokens.colors.surface, color: tokens.colors.textStrong, fontFamily: 'monospace', fontSize: tokens.typography.fontSizeMd, lineHeight: tokens.typography.lineHeightBody }}
              />
            </section>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: tokens.spacing.sm, marginTop: tokens.spacing.lg, paddingTop: tokens.spacing.md, borderTop: `1px solid ${tokens.colors.border}` }}>
            {!isNew && <Button variant="secondary" onClick={() => edit()} disabled={saving}>Cancel</Button>}
            <Button variant="primary" onClick={save} loading={saving}>Save profile</Button>
          </div>
        </section>
      </Card>
    </div>
  );
}
