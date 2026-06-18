import React, { useState, useEffect, useCallback } from 'react';
import { api, getActiveWorkspaceId } from '../../api';
import type { Credential } from '../../types';
import { useToast } from '../../contexts/ToastContext';
import { tokens } from '../../tokens';
import { Button, Input, Modal, Badge, ConfirmDialog } from '../common';
import { relativeTime } from '../../utils/time';

const listHeadStyle = (align: 'left' | 'right'): React.CSSProperties => ({
  textAlign: align,
  padding: '8px 12px',
  fontWeight: 600,
});

const listCellStyle = (align: 'left' | 'right'): React.CSSProperties => ({
  textAlign: align,
  padding: '10px 12px',
  verticalAlign: 'middle',
});

const PROVIDERS = [
  { value: 'github', label: 'GitHub', icon: 'G' },
  { value: 'gitlab', label: 'GitLab', icon: 'L' },
  { value: 'openai', label: 'OpenAI', icon: 'O' },
  { value: 'custom', label: 'Custom', icon: 'C' },
  { value: 'claude_subscription', label: 'Claude · Subscription', icon: 'CS' },
  { value: 'claude_api_key', label: 'Claude · API Key', icon: 'CK' },
  { value: 'deepseek_api_key', label: 'DeepSeek · API Key', icon: 'DS' },
  { value: 'codex_subscription', label: 'Codex · Subscription', icon: 'OS' },
  { value: 'codex_api_key', label: 'Codex · API Key', icon: 'OK' },
  { value: 'antigravity_subscription', label: 'Antigravity · Subscription', icon: 'AS' },
  { value: 'antigravity_api_key', label: 'Antigravity · API Key', icon: 'AK' },
];

interface FieldDef {
  label: string;
  placeholder: string;
  /** Render as a multi-line textarea (for OAuth credential file contents)
   *  rather than a single-line password input. */
  multiline?: boolean;
}

const PROVIDER_FIELD_LABELS: Record<string, Record<string, FieldDef>> = {
  github: { token: { label: 'Personal Access Token', placeholder: 'ghp_...' } },
  gitlab: { token: { label: 'Access Token', placeholder: 'glpat-...' } },
  openai: { api_key: { label: 'API Key', placeholder: 'sk-...' } },
  custom: { token: { label: 'Token / Secret', placeholder: 'Enter secret value' } },
  claude_subscription: {
    credentials_json: {
      label: '.credentials.json',
      placeholder: 'Paste the contents of ~/.claude/.credentials.json here (the file `claude login` produced).',
      multiline: true,
    },
  },
  claude_api_key: {
    api_key: { label: 'ANTHROPIC_API_KEY', placeholder: 'sk-ant-...' },
  },
  deepseek_api_key: {
    api_key: { label: 'DeepSeek API Key', placeholder: 'sk-... (from platform.deepseek.com)' },
    model: { label: 'Model (optional)', placeholder: 'deepseek-chat (default) · or deepseek-reasoner' },
    base_url: { label: 'Base URL (optional)', placeholder: 'https://api.deepseek.com/anthropic (default)' },
  },
  codex_subscription: {
    auth_json: {
      label: 'auth.json',
      placeholder: 'Paste the contents of ~/.codex/auth.json (produced by `codex login`).',
      multiline: true,
    },
    config_toml: {
      label: 'config.toml (optional)',
      placeholder: 'Paste the contents of ~/.codex/config.toml — model / provider preferences. Leave blank to use codex defaults.',
      multiline: true,
    },
  },
  codex_api_key: {
    api_key: { label: 'OPENAI_API_KEY', placeholder: 'sk-...' },
  },
  antigravity_subscription: {
    oauth_creds_json: {
      label: 'oauth_creds.json',
      placeholder: 'Paste the contents of the Antigravity OAuth credential file (from the OAuth flow at antigravity.google).',
      multiline: true,
    },
  },
  antigravity_api_key: {
    api_key: { label: 'GEMINI_API_KEY', placeholder: 'AI...' },
  },
};

export default function CredentialManager({ workspaceId, globalMode = false }: { workspaceId?: string; globalMode?: boolean }) {
  const { showToast } = useToast();
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editCred, setEditCred] = useState<Credential | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Credential | null>(null);
  const [saving, setSaving] = useState(false);

  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formProvider, setFormProvider] = useState('github');
  const [formFields, setFormFields] = useState<Record<string, string>>({});
  const [formErrors, setFormErrors] = useState<{ name?: string }>({});

  const effectiveWsId = globalMode ? '' : (workspaceId || (getActiveWorkspaceId() || ''));

  const loadCredentials = useCallback(async () => {
    if (!globalMode && !effectiveWsId) { setCredentials([]); setLoading(false); return; }
    setLoading(true);
    try {
      const list = globalMode
        ? await api.listCredentials(undefined, { scope: 'global' })
        : await api.listCredentials(effectiveWsId);
      setCredentials(list);
    } catch (err: any) {
      showToast(err?.message || 'Failed to load credentials', 'error');
    } finally {
      setLoading(false);
    }
  }, [globalMode, effectiveWsId, showToast]);

  useEffect(() => { loadCredentials(); }, [loadCredentials]);

  const getFieldDefs = (provider: string) =>
    PROVIDER_FIELD_LABELS[provider] || PROVIDER_FIELD_LABELS.custom;

  const startCreate = () => {
    setFormName('');
    setFormDescription('');
    setFormProvider('github');
    setFormFields({});
    setFormErrors({});
    setEditCred(null);
    setShowForm(true);
  };

  const startEdit = (cred: Credential) => {
    setFormName(cred.name);
    setFormDescription(cred.description || '');
    setFormProvider(cred.provider);
    setFormFields({ ...cred.credential_fields });
    setFormErrors({});
    setEditCred(cred);
    setShowForm(true);
  };

  const cancelForm = () => { setShowForm(false); setEditCred(null); };

  const handleSave = async () => {
    const errors: { name?: string } = {};
    if (!formName.trim()) errors.name = 'Name is required.';
    if (Object.keys(errors).length > 0) { setFormErrors(errors); return; }
    if (!globalMode && !effectiveWsId) { showToast('Select a workspace first.', 'error'); return; }

    setSaving(true);
    try {
      if (editCred) {
        await api.updateCredential(editCred.id, {
          ...(globalMode ? {} : { workspace_id: effectiveWsId }),
          name: formName.trim(),
          description: formDescription,
          provider: formProvider,
          credentials: formFields,
        });
        showToast('Credential updated.', 'success');
      } else {
        await api.createCredential({
          ...(globalMode ? { scope: 'global' as const } : { workspace_id: effectiveWsId }),
          name: formName.trim(),
          description: formDescription,
          provider: formProvider,
          credentials: formFields,
        });
        showToast('Credential created.', 'success');
      }
      setShowForm(false);
      setEditCred(null);
      await loadCredentials();
    } catch (err: any) {
      showToast(err?.message || 'Failed to save credential', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await api.deleteCredential(deleteTarget.id, globalMode ? undefined : effectiveWsId);
      showToast('Credential deleted.', 'success');
      setDeleteTarget(null);
      await loadCredentials();
    } catch (err: any) {
      showToast(err?.message || 'Failed to delete credential', 'error');
    }
  };

  if (!globalMode && !effectiveWsId) {
    return <div style={{ fontSize: '13px', color: tokens.colors.textSecondary }}>Select a workspace first.</div>;
  }

  const providerColor = (p: string) => {
    const map: Record<string, string> = {
      github: '#24292f',
      gitlab: '#fc6d26',
      openai: '#10a37f',
      custom: tokens.colors.textSecondary,
      claude_subscription: '#cc785c',
      claude_api_key: '#cc785c',
      deepseek_api_key: '#4d6bfe',
      codex_subscription: '#10a37f',
      codex_api_key: '#10a37f',
      antigravity_subscription: '#4285f4',
      antigravity_api_key: '#4285f4',
    };
    return map[p] || tokens.colors.textSecondary;
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <span style={{ fontSize: 13, color: tokens.colors.textMuted }}>{credentials.length} credentials</span>
        <Button variant="primary" size="md" onClick={startCreate}>+ New Credential</Button>
      </div>

      {loading ? (
        <div style={{ fontSize: '13px', color: tokens.colors.textSecondary, padding: 24 }}>Loading…</div>
      ) : credentials.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '48px 24px' }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: tokens.colors.textPrimary, marginBottom: 8 }}>No credentials yet</div>
          <div style={{ fontSize: 13, color: tokens.colors.textSecondary }}>
            Add credentials for GitHub, GitLab, or other services. Resources can reference these for authenticated access.
          </div>
        </div>
      ) : (
        <div
          style={{
            background: tokens.colors.surfaceCard,
            border: `1px solid ${tokens.colors.border}`,
            borderRadius: tokens.radii.md,
            overflowX: 'auto',
          }}
        >
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr
                style={{
                  background: tokens.colors.surface,
                  color: tokens.colors.textMuted,
                  fontSize: 11,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                <th style={listHeadStyle('left')}>Name</th>
                <th style={listHeadStyle('left')}>Provider</th>
                <th style={listHeadStyle('left')}>Description</th>
                <th style={listHeadStyle('left')}>Fields</th>
                <th style={listHeadStyle('left')}>Updated</th>
                <th style={listHeadStyle('right')}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {credentials.map((c) => {
                const fieldKeys = Object.keys(c.credential_fields);
                const fieldsLabel = fieldKeys.length === 0
                  ? '—'
                  : fieldKeys.map((k) => `${k}${c.credential_fields[k] ? '' : ' (empty)'}`).join(', ');
                return (
                  <tr key={c.id} style={{ borderTop: `1px solid ${tokens.colors.border}` }}>
                    <td
                      style={{
                        ...listCellStyle('left'),
                        maxWidth: 240,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        color: tokens.colors.textStrong,
                        fontWeight: 600,
                      }}
                      title={c.name}
                    >
                      <span
                        style={{
                          display: 'inline-block',
                          width: 18,
                          height: 18,
                          borderRadius: tokens.radii.sm,
                          background: `${providerColor(c.provider)}20`,
                          color: providerColor(c.provider),
                          textAlign: 'center',
                          lineHeight: '18px',
                          fontSize: 10,
                          fontWeight: 700,
                          marginRight: 8,
                          verticalAlign: 'middle',
                        }}
                      >
                        {PROVIDERS.find((p) => p.value === c.provider)?.icon || 'C'}
                      </span>
                      {c.name}
                    </td>
                    <td style={listCellStyle('left')}>
                      <Badge variant="neutral">{c.provider}</Badge>
                      {!globalMode && c.scope === 'global' && (
                        <span style={{ marginLeft: 6 }}><Badge variant="info">Global</Badge></span>
                      )}
                    </td>
                    <td
                      style={{
                        ...listCellStyle('left'),
                        maxWidth: 280,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        color: tokens.colors.textSecondary,
                      }}
                      title={c.description || ''}
                    >
                      {c.description || <span style={{ color: tokens.colors.textMuted }}>—</span>}
                    </td>
                    <td
                      style={{
                        ...listCellStyle('left'),
                        color: tokens.colors.textMuted,
                        fontFamily: 'monospace',
                        whiteSpace: 'nowrap',
                      }}
                      title={fieldsLabel}
                    >
                      {fieldsLabel}
                    </td>
                    <td style={{ ...listCellStyle('left'), color: tokens.colors.textMuted, whiteSpace: 'nowrap' }}>
                      {relativeTime(c.updated_at || c.created_at)}
                    </td>
                    <td style={{ ...listCellStyle('right'), whiteSpace: 'nowrap' }}>
                      {!globalMode && c.scope === 'global' ? (
                        <span
                          style={{ fontSize: 11, color: tokens.colors.textMuted }}
                          title="Global credentials are managed in Admin → Global Credentials"
                        >
                          Inherited (read-only)
                        </span>
                      ) : (
                        <div style={{ display: 'inline-flex', gap: 6 }}>
                          <Button variant="secondary" size="sm" onClick={() => startEdit(c)}>Edit</Button>
                          <Button variant="danger" size="sm" onClick={() => setDeleteTarget(c)}>Delete</Button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Create/Edit Modal */}
      <Modal
        isOpen={showForm}
        onClose={cancelForm}
        title={editCred ? 'Edit Credential' : 'New Credential'}
        maxWidth={480}
        footer={
          <>
            <Button variant="secondary" onClick={cancelForm} disabled={saving}>Cancel</Button>
            <Button variant="primary" onClick={handleSave} disabled={saving} loading={saving}>Save Credential</Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
            <Input label="Name" value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="e.g. My GitHub PAT" error={formErrors.name} />
            <div>
              <label style={{ fontSize: tokens.typography.fontSizeXs, fontWeight: tokens.typography.fontWeightSemibold, color: tokens.colors.textMuted, textTransform: 'uppercase', display: 'block', marginBottom: tokens.spacing.xs }}>Provider</label>
              <select
                value={formProvider}
                onChange={(e) => { setFormProvider(e.target.value); setFormFields({}); }}
                style={{ width: '100%', background: tokens.colors.surface, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md, padding: '8px 10px', color: tokens.colors.textStrong, fontSize: '12px', fontFamily: 'inherit', boxSizing: 'border-box' }}
              >
                {PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
          </div>
          <Input label="Description" value={formDescription} onChange={(e) => setFormDescription(e.target.value)} placeholder="Optional note" />

          {Object.entries(getFieldDefs(formProvider)).map(([fieldKey, fieldDef]) => (
            <div key={fieldKey}>
              <label style={{ fontSize: tokens.typography.fontSizeXs, fontWeight: tokens.typography.fontWeightSemibold, color: tokens.colors.textMuted, textTransform: 'uppercase', display: 'block', marginBottom: tokens.spacing.xs }}>
                {fieldDef.label}
              </label>
              <div style={{ fontSize: '11px', color: tokens.colors.textMuted, marginBottom: 4 }}>Encrypted at rest (AES-256-GCM)</div>
              {fieldDef.multiline ? (
                <textarea
                  value={formFields[fieldKey] || ''}
                  onChange={(e) => setFormFields(prev => ({ ...prev, [fieldKey]: e.target.value }))}
                  placeholder={fieldDef.placeholder}
                  rows={8}
                  style={{ width: '100%', minHeight: 140, background: tokens.colors.surface, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md, padding: '8px 10px', color: tokens.colors.textStrong, fontSize: '12px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', boxSizing: 'border-box', outline: 'none', resize: 'vertical' }}
                />
              ) : (
                <input
                  type="password"
                  value={formFields[fieldKey] || ''}
                  onChange={(e) => setFormFields(prev => ({ ...prev, [fieldKey]: e.target.value }))}
                  placeholder={fieldDef.placeholder}
                  style={{ width: '100%', background: tokens.colors.surface, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md, padding: '8px 10px', color: tokens.colors.textStrong, fontSize: '13px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', boxSizing: 'border-box', outline: 'none' }}
                />
              )}
            </div>
          ))}
        </div>
      </Modal>

      {/* Delete confirmation */}
      <ConfirmDialog
        isOpen={!!deleteTarget}
        title="Delete credential?"
        confirmLabel="Delete Credential"
        message={<><strong>{deleteTarget?.name}</strong> will be permanently removed. Resources using this credential will lose access.</>}
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
