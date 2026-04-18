import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../api';
import type { Credential } from '../../types';
import { useToast } from '../../contexts/ToastContext';
import { tokens } from '../../tokens';
import { Button, Input, Modal, Badge, Card } from '../common';
import { relativeTime } from '../../utils/time';

const PROVIDERS = [
  { value: 'github', label: 'GitHub', icon: 'G' },
  { value: 'gitlab', label: 'GitLab', icon: 'L' },
  { value: 'openai', label: 'OpenAI', icon: 'O' },
  { value: 'custom', label: 'Custom', icon: 'C' },
];

const PROVIDER_FIELD_LABELS: Record<string, Record<string, { label: string; placeholder: string }>> = {
  github: { token: { label: 'Personal Access Token', placeholder: 'ghp_...' } },
  gitlab: { token: { label: 'Access Token', placeholder: 'glpat-...' } },
  openai: { api_key: { label: 'API Key', placeholder: 'sk-...' } },
  custom: { token: { label: 'Token / Secret', placeholder: 'Enter secret value' } },
};

export default function CredentialManager({ workspaceId }: { workspaceId?: string }) {
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

  const effectiveWsId = workspaceId ||
    (typeof window !== 'undefined' ? localStorage.getItem('currentWorkspaceId') || '' : '');

  const loadCredentials = useCallback(async () => {
    if (!effectiveWsId) { setCredentials([]); setLoading(false); return; }
    setLoading(true);
    try {
      const list = await api.listCredentials(effectiveWsId);
      setCredentials(list);
    } catch (err: any) {
      showToast(err?.message || 'Failed to load credentials', 'error');
    } finally {
      setLoading(false);
    }
  }, [effectiveWsId, showToast]);

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
    if (!effectiveWsId) { showToast('Select a workspace first.', 'error'); return; }

    setSaving(true);
    try {
      if (editCred) {
        await api.updateCredential(editCred.id, {
          workspace_id: effectiveWsId,
          name: formName.trim(),
          description: formDescription,
          provider: formProvider,
          credentials: formFields,
        });
        showToast('Credential updated.', 'success');
      } else {
        await api.createCredential({
          workspace_id: effectiveWsId,
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
      await api.deleteCredential(deleteTarget.id, effectiveWsId);
      showToast('Credential deleted.', 'success');
      setDeleteTarget(null);
      await loadCredentials();
    } catch (err: any) {
      showToast(err?.message || 'Failed to delete credential', 'error');
    }
  };

  if (!effectiveWsId) {
    return <div style={{ fontSize: '13px', color: tokens.colors.textSecondary }}>Select a workspace first.</div>;
  }

  const providerColor = (p: string) => {
    const map: Record<string, string> = { github: '#24292f', gitlab: '#fc6d26', openai: '#10a37f', custom: tokens.colors.textSecondary };
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
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: tokens.spacing.md }}>
          {credentials.map((c) => (
            <Card key={c.id} padding="12px 14px">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <div style={{
                  width: 28, height: 28, borderRadius: tokens.radii.md,
                  background: `${providerColor(c.provider)}20`,
                  color: providerColor(c.provider),
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '12px', fontWeight: 700, flexShrink: 0,
                }}>
                  {(PROVIDERS.find(p => p.value === c.provider)?.icon || 'C')}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: tokens.colors.textStrong, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.name}
                    </div>
                    <Badge variant="neutral">{c.provider}</Badge>
                  </div>
                  {c.description && (
                    <div style={{ fontSize: '12px', color: tokens.colors.textSecondary, marginTop: 2 }}>{c.description}</div>
                  )}
                </div>
              </div>
              <div style={{ fontSize: '11px', color: tokens.colors.textMuted, marginBottom: 6 }}>
                {Object.entries(c.credential_fields).map(([k, v]) => (
                  <div key={k}>{k}: <span style={{ fontFamily: 'monospace' }}>{v || '(empty)'}</span></div>
                ))}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ fontSize: '11px', color: tokens.colors.textMuted }}>{relativeTime(c.updated_at || c.created_at)}</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <Button variant="secondary" size="sm" onClick={() => startEdit(c)}>Edit</Button>
                  <Button variant="danger" size="sm" onClick={() => setDeleteTarget(c)}>Delete</Button>
                </div>
              </div>
            </Card>
          ))}
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
              <input
                type="password"
                value={formFields[fieldKey] || ''}
                onChange={(e) => setFormFields(prev => ({ ...prev, [fieldKey]: e.target.value }))}
                placeholder={fieldDef.placeholder}
                style={{ width: '100%', background: tokens.colors.surface, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md, padding: '8px 10px', color: tokens.colors.textStrong, fontSize: '13px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', boxSizing: 'border-box', outline: 'none' }}
              />
            </div>
          ))}
        </div>
      </Modal>

      {/* Delete Modal */}
      <Modal
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Delete credential?"
        maxWidth={440}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="danger" onClick={handleConfirmDelete}>Delete Credential</Button>
          </>
        }
      >
        <div style={{ fontSize: tokens.typography.fontSizeMd, color: tokens.colors.textSecondary, lineHeight: 1.5 }}>
          <strong>{deleteTarget?.name}</strong> will be permanently removed. Resources using this credential will lose access.
        </div>
      </Modal>
    </div>
  );
}
