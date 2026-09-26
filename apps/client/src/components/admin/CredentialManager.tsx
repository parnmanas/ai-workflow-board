import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api, getActiveWorkspaceId } from '../../api';
import type { CatalogScope, Credential } from '../../types';
import { useToast } from '../../contexts/ToastContext';
import { tokens } from '../../tokens';
import { Button, Input, Modal, Badge, ConfirmDialog } from '../common';
import { relativeTime } from '../../utils/time';
import { useAuth } from '../../contexts/AuthContext';
import CliCredentialImport from './CliCredentialImport';
import CliAutoLogin from './CliAutoLogin';
import { cliCredentialProviders, useCliCatalog, type FlattenedCredentialProvider } from '../../cli/catalog';
import { providerColor, providerIcon } from '../../cli/presentation';

export const CREDENTIAL_REVEAL_TTL_MS = 30_000;

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

interface FieldDef {
  label: string;
  placeholder: string;
  /** Render as a multi-line textarea (for OAuth credential file contents)
   *  rather than a single-line password input. */
  multiline?: boolean;
}

interface ProviderOption {
  value: string;
  label: string;
  icon: string;
}

/** Providers that are NOT tied to an LLM CLI (git hosts, generic API key,
 *  free-form secret). These stay local — the CLI catalog only knows CLIs. */
const NON_CLI_PROVIDERS: Array<ProviderOption & { fields: Record<string, FieldDef> }> = [
  { value: 'github', label: 'GitHub', icon: 'G', fields: { token: { label: 'Personal Access Token', placeholder: 'ghp_...' } } },
  { value: 'gitlab', label: 'GitLab', icon: 'L', fields: { token: { label: 'Access Token', placeholder: 'glpat-...' } } },
  { value: 'openai', label: 'OpenAI', icon: 'O', fields: { api_key: { label: 'API Key', placeholder: 'sk-...' } } },
  { value: 'custom', label: 'Custom', icon: 'C', fields: { token: { label: 'Token / Secret', placeholder: 'Enter secret value' } } },
];

/** Labels / placeholders for CLI credential fields, keyed by FIELD NAME (the
 *  catalog says which fields a provider has; this only decorates them). A
 *  `provider:field` key overrides the plain field key where the same field
 *  name means a different env var per CLI (`api_key`). Anything else gets a
 *  generic label derived from the field name. */
const FIELD_LABELS: Record<string, FieldDef> = {
  credentials_json: {
    label: '.credentials.json',
    placeholder: 'Paste the contents of ~/.claude/.credentials.json here (the file `claude login` produced).',
  },
  api_key: { label: 'API Key', placeholder: 'sk-...' },
  'claude_api_key:api_key': { label: 'ANTHROPIC_API_KEY', placeholder: 'sk-ant-...' },
  'deepseek_api_key:api_key': { label: 'DeepSeek API Key', placeholder: 'sk-... (from platform.deepseek.com)' },
  'codex_api_key:api_key': { label: 'OPENAI_API_KEY', placeholder: 'sk-...' },
  'antigravity_api_key:api_key': { label: 'GEMINI_API_KEY', placeholder: 'AI...' },
  'opencode_api_key:api_key': { label: 'OPENCODE_API_KEY', placeholder: 'OpenCode Go key — create one at https://opencode.ai/auth (the CLI calls this provider "OpenCode Zen")' },
  oauth_token: {
    label: 'CLAUDE_CODE_OAUTH_TOKEN',
    placeholder: 'Run `claude setup-token` on one machine and paste the output (sk-ant-oat...). Valid ~1 year, does NOT rotate, shared by every agent — no per-machine daily re-login.',
    multiline: true,
  },
  model: { label: 'Model', placeholder: 'deepseek-chat (default) · or deepseek-reasoner' },
  base_url: { label: 'Base URL', placeholder: 'https://api.deepseek.com/anthropic (default)' },
  auth_json: {
    label: 'auth.json',
    placeholder: 'Paste the contents of the auth.json the CLI login produced (`codex login` → ~/.codex/auth.json, `opencode auth login` → ~/.local/share/opencode/auth.json; one opencode file can hold several providers — paste it whole).',
  },
  config_toml: {
    label: 'config.toml',
    placeholder: 'Paste the contents of ~/.codex/config.toml — model / provider preferences. Leave blank to use codex defaults.',
  },
  oauth_creds_json: {
    label: 'oauth_creds.json',
    placeholder: 'Paste the contents of the Antigravity OAuth credential file (from the OAuth flow at antigravity.google).',
  },
};

function genericFieldDef(field: string): FieldDef {
  return { label: field.replace(/_/g, ' '), placeholder: `Enter ${field.replace(/_/g, ' ')}` };
}

/** Field definitions for a CLI credential provider from its catalog
 *  descriptor: field order, multiline and optional-ness come from the catalog;
 *  labels/placeholders from FIELD_LABELS. */
function cliProviderFieldDefs(provider: FlattenedCredentialProvider): Record<string, FieldDef> {
  const required = new Set(provider.required);
  const multiline = new Set(provider.multiline);
  const defs: Record<string, FieldDef> = {};
  for (const field of provider.fields) {
    const base = FIELD_LABELS[`${provider.id}:${field}`] ?? FIELD_LABELS[field] ?? genericFieldDef(field);
    defs[field] = {
      ...base,
      label: required.has(field) ? base.label : `${base.label} (optional)`,
      multiline: base.multiline || multiline.has(field),
    };
  }
  return defs;
}

export default function CredentialManager({
  workspaceId,
  workspaceName,
  globalMode = false,
  catalogMode = false,
  createScope = 'workspace',
  allScopes = false,
  canManageGlobal = false,
}: {
  workspaceId?: string;
  /** Names the destination in the Edit dialog's scope picker — moving a global
   *  credential down lands it in the Workspace currently being viewed, and
   *  "Current Workspace" is not a good enough label for that. */
  workspaceName?: string;
  globalMode?: boolean;
  catalogMode?: boolean;
  createScope?: CatalogScope;
  allScopes?: boolean;
  canManageGlobal?: boolean;
}) {
  const { showToast } = useToast();
  const { user } = useAuth();
  // CLI credential providers come from the catalog (re-rendered once the
  // server catalog lands); non-CLI providers are the local table above.
  const catalog = useCliCatalog();
  const cliProviders = cliCredentialProviders(catalog);
  const providerOptions: ProviderOption[] = [
    ...NON_CLI_PROVIDERS.map(({ value, label, icon }) => ({ value, label, icon })),
    ...cliProviders.map((p) => ({ value: p.id, label: p.label, icon: providerIcon(p.id) })),
  ];
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editCred, setEditCred] = useState<Credential | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Credential | null>(null);
  const [saving, setSaving] = useState(false);
  const [revealTarget, setRevealTarget] = useState<Credential | null>(null);
  const [revealPassword, setRevealPassword] = useState('');
  const [revealedFields, setRevealedFields] = useState<Record<string, string>>({});
  const [revealing, setRevealing] = useState(false);
  const [copiedField, setCopiedField] = useState('');
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revealRequestGeneration = useRef(0);

  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formProvider, setFormProvider] = useState('github');
  const [formFields, setFormFields] = useState<Record<string, string>>({});
  const [formScope, setFormScope] = useState<CatalogScope>('workspace');
  const [storedFieldPreviews, setStoredFieldPreviews] = useState<Record<string, string>>({});
  const [formErrors, setFormErrors] = useState<{ name?: string }>({});

  const effectiveWsId = globalMode ? '' : (workspaceId || (getActiveWorkspaceId() || ''));
  const effectiveCreateScope: CatalogScope = globalMode ? 'global' : createScope;

  const loadCredentials = useCallback(async () => {
    if (!globalMode && !effectiveWsId) { setCredentials([]); setLoading(false); return; }
    setLoading(true);
    try {
      const list = globalMode
        ? await api.listCredentials(undefined, { scope: 'global' })
        : await api.listCredentials(effectiveWsId, {
            includeAllScopes: catalogMode && allScopes,
          });
      setCredentials(list);
    } catch (err: any) {
      showToast(err?.message || 'Failed to load credentials', 'error');
    } finally {
      setLoading(false);
    }
  }, [globalMode, catalogMode, effectiveWsId, allScopes, showToast]);

  useEffect(() => { loadCredentials(); }, [loadCredentials]);

  const clearRevealedSecret = useCallback(() => {
    if (revealTimer.current) clearTimeout(revealTimer.current);
    revealTimer.current = null;
    setRevealedFields({});
    setRevealPassword('');
    setCopiedField('');
  }, []);

  const invalidateRevealRequest = useCallback(() => {
    revealRequestGeneration.current += 1;
    setRevealing(false);
  }, []);

  useEffect(() => () => {
    revealRequestGeneration.current += 1;
    clearRevealedSecret();
  }, [clearRevealedSecret]);

  const closeReveal = () => {
    invalidateRevealRequest();
    clearRevealedSecret();
    setRevealTarget(null);
  };

  const handleReveal = async () => {
    if (!revealTarget || !revealPassword) return;
    const targetId = revealTarget.id;
    const requestGeneration = ++revealRequestGeneration.current;
    setRevealing(true);
    try {
      const result = await api.revealCredential(targetId, revealPassword);
      if (revealRequestGeneration.current !== requestGeneration) return;
      setRevealPassword('');
      setRevealedFields(result.credential_fields);
      if (revealTimer.current) clearTimeout(revealTimer.current);
      revealTimer.current = setTimeout(clearRevealedSecret, CREDENTIAL_REVEAL_TTL_MS);
    } catch (err: any) {
      if (revealRequestGeneration.current !== requestGeneration) return;
      clearRevealedSecret();
      showToast(err?.message || 'Failed to reveal credential', 'error');
    } finally {
      if (revealRequestGeneration.current === requestGeneration) {
        setRevealing(false);
      }
    }
  };

  const copySecret = async (field: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    setCopiedField(field);
    showToast('Copied to clipboard.', 'success');
    setTimeout(() => setCopiedField((current) => current === field ? '' : current), 2_000);
  };

  const getFieldDefs = (provider: string): Record<string, FieldDef> => {
    const cliProvider = cliProviders.find((p) => p.id === provider);
    if (cliProvider) return cliProviderFieldDefs(cliProvider);
    return NON_CLI_PROVIDERS.find((p) => p.value === provider)?.fields
      ?? NON_CLI_PROVIDERS.find((p) => p.value === 'custom')!.fields;
  };

  const startCreate = () => {
    setFormName('');
    setFormDescription('');
    setFormProvider('github');
    setFormFields({});
    setFormScope(effectiveCreateScope);
    setStoredFieldPreviews({});
    setFormErrors({});
    setEditCred(null);
    setShowForm(true);
  };

  const startEdit = (cred: Credential) => {
    setFormName(cred.name);
    setFormDescription(cred.description || '');
    setFormProvider(cred.provider);
    // Never put a stored preview inside the replacement input. Browsers and
    // password managers re-mask password input values as ********, defeating
    // the purpose of showing an identifying prefix/suffix.
    setStoredFieldPreviews({ ...cred.credential_fields });
    setFormFields({});
    setFormScope(cred.scope ?? (cred.workspace_id ? 'workspace' : 'global'));
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
          scope: formScope,
          // Doubles as the ownership proof for a workspace credential and the
          // destination when a global one is narrowed — see the server's
          // update() doc comment.
          workspace_id: editCred.workspace_id ?? effectiveWsId,
          name: formName.trim(),
          description: formDescription,
          provider: formProvider,
          credentials: formFields,
        });
        showToast('Credential updated.', 'success');
      } else {
        await api.createCredential({
          scope: effectiveCreateScope,
          workspace_id: effectiveCreateScope === 'global' ? undefined : effectiveWsId,
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
      await api.deleteCredential(deleteTarget.id, deleteTarget.workspace_id === null ? undefined : effectiveWsId);
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

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <span style={{ fontSize: 13, color: tokens.colors.textMuted }}>{credentials.length} credentials</span>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <CliAutoLogin
            workspaceId={effectiveWsId}
            createScope={effectiveCreateScope}
            onCreated={loadCredentials}
          />
          <CliCredentialImport
            workspaceId={effectiveWsId}
            createScope={effectiveCreateScope}
            onCreated={loadCredentials}
          />
          <Button variant="primary" size="md" onClick={startCreate}>+ New Credential</Button>
        </div>
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
                const fieldsLabel = c.credential_status === 'unreadable'
                  ? 'Encryption key mismatch — re-enter credential'
                  : fieldKeys.length === 0
                  ? '—'
                  : fieldKeys.map((k) => {
                      const value = c.credential_fields[k];
                      return value ? `${k}: ${value}` : `${k}: (empty)`;
                    }).join(', ');
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
                        {providerOptions.find((p) => p.value === c.provider)?.icon || 'C'}
                      </span>
                      {c.name}
                    </td>
                    <td style={listCellStyle('left')}>
                      <Badge variant="neutral">{c.provider}</Badge>
                      {!globalMode && c.scope && (
                        <span style={{ marginLeft: 6 }}><Badge variant="info">{c.scope}</Badge></span>
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
                      {!globalMode && c.scope === 'global' && !canManageGlobal ? (
                        <span
                          style={{ fontSize: 11, color: tokens.colors.textMuted }}
                          title="Global credentials require global management permission"
                        >
                          Inherited (read-only)
                        </span>
                      ) : (
                        <div style={{ display: 'inline-flex', gap: 6 }}>
                          {user?.role === 'admin' && c.provider === 'claude_oauth_token' && (
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => {
                                invalidateRevealRequest();
                                clearRevealedSecret();
                                setRevealTarget(c);
                              }}
                            >
                              Reveal
                            </Button>
                          )}
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
                onChange={(e) => { setFormProvider(e.target.value); setFormFields({}); setStoredFieldPreviews({}); }}
                style={{ width: '100%', background: tokens.colors.surface, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md, padding: '8px 10px', color: tokens.colors.textStrong, fontSize: '12px', fontFamily: 'inherit', boxSizing: 'border-box' }}
              >
                {providerOptions.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
          </div>
          <Input label="Description" value={formDescription} onChange={(e) => setFormDescription(e.target.value)} placeholder="Optional note" />

          {/* Scope is fixed at create time by the page-level "Workspace for new
              item" picker; on an existing credential it is switchable, because
              the alternative is re-pasting a secret and re-pointing every
              binding by hand. Non-admins get the control read-only: the Actions
              column already hides Edit for inherited globals, so for them this
              row only ever states which Workspace owns the row. */}
          {editCred && !globalMode && (
            <div>
              <label style={{ fontSize: tokens.typography.fontSizeXs, fontWeight: tokens.typography.fontWeightSemibold, color: tokens.colors.textMuted, textTransform: 'uppercase', display: 'block', marginBottom: tokens.spacing.xs }}>Scope</label>
              <select
                value={formScope}
                disabled={!canManageGlobal}
                onChange={(e) => setFormScope(e.target.value as CatalogScope)}
                style={{ width: '100%', background: tokens.colors.surface, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md, padding: '8px 10px', color: canManageGlobal ? tokens.colors.textStrong : tokens.colors.textMuted, fontSize: '12px', fontFamily: 'inherit', boxSizing: 'border-box' }}
              >
                <option value="global">Not set (Global — every Workspace)</option>
                <option value="workspace">{workspaceName || 'Current Workspace'}</option>
              </select>
              <div style={{ fontSize: '11px', color: tokens.colors.textMuted, marginTop: 4 }}>
                {!canManageGlobal
                  ? 'Only an administrator can share a credential across Workspaces.'
                  : formScope === 'global'
                  ? 'Readable from every Workspace on this instance.'
                  : `Readable only from ${workspaceName || 'this Workspace'}. Agents, resources, CLI session settings and outreach channels elsewhere that use it must be re-pointed first.`}
              </div>
            </div>
          )}

          {Object.entries(getFieldDefs(formProvider)).map(([fieldKey, fieldDef]) => (
            <div key={fieldKey}>
              <label style={{ fontSize: tokens.typography.fontSizeXs, fontWeight: tokens.typography.fontWeightSemibold, color: tokens.colors.textMuted, textTransform: 'uppercase', display: 'block', marginBottom: tokens.spacing.xs }}>
                {fieldDef.label}
              </label>
              <div style={{ fontSize: '11px', color: tokens.colors.textMuted, marginBottom: 4 }}>Encrypted at rest (AES-256-GCM)</div>
              {storedFieldPreviews[fieldKey] && (
                <div style={{ fontSize: '12px', color: tokens.colors.textSecondary, marginBottom: 6 }}>
                  Stored: <code style={{ color: tokens.colors.textStrong }}>{storedFieldPreviews[fieldKey]}</code>
                </div>
              )}
              {fieldDef.multiline ? (
                <textarea
                  value={formFields[fieldKey] || ''}
                  onChange={(e) => setFormFields(prev => ({ ...prev, [fieldKey]: e.target.value }))}
                  placeholder={editCred ? 'Leave blank to keep the stored value' : fieldDef.placeholder}
                  rows={8}
                  style={{ width: '100%', minHeight: 140, background: tokens.colors.surface, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md, padding: '8px 10px', color: tokens.colors.textStrong, fontSize: '12px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', boxSizing: 'border-box', outline: 'none', resize: 'vertical' }}
                />
              ) : (
                <input
                  type="password"
                  autoComplete="new-password"
                  value={formFields[fieldKey] || ''}
                  onChange={(e) => setFormFields(prev => ({ ...prev, [fieldKey]: e.target.value }))}
                  placeholder={editCred ? 'Leave blank to keep the stored value' : fieldDef.placeholder}
                  style={{ width: '100%', background: tokens.colors.surface, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md, padding: '8px 10px', color: tokens.colors.textStrong, fontSize: '13px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', boxSizing: 'border-box', outline: 'none' }}
                />
              )}
            </div>
          ))}
        </div>
      </Modal>

      <Modal
        isOpen={!!revealTarget}
        onClose={closeReveal}
        title="Reveal credential"
        maxWidth={520}
        footer={
          <>
            <Button variant="secondary" onClick={closeReveal}>Close</Button>
            {Object.keys(revealedFields).length === 0 && (
              <Button
                variant="primary"
                onClick={handleReveal}
                disabled={!revealPassword || revealing}
                loading={revealing}
              >
                Confirm and Reveal
              </Button>
            )}
          </>
        }
      >
        {Object.keys(revealedFields).length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <p style={{ margin: 0, color: tokens.colors.textSecondary, fontSize: 13 }}>
              Re-enter your password to reveal {revealTarget?.name}. The value will be hidden again after 30 seconds.
            </p>
            <Input
              label="Password"
              type="password"
              autoComplete="current-password"
              value={revealPassword}
              onChange={(event) => setRevealPassword(event.target.value)}
            />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ color: tokens.colors.textMuted, fontSize: 12 }}>Automatically masks again after 30 seconds.</div>
            {Object.entries(revealedFields).map(([field, value]) => (
              <div key={field}>
                <div style={{ color: tokens.colors.textMuted, fontSize: 11, marginBottom: 4 }}>{field}</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <code style={{ flex: 1, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', color: tokens.colors.textStrong }}>
                    {value}
                  </code>
                  <Button variant="secondary" size="sm" onClick={() => copySecret(field, value)}>
                    {copiedField === field ? 'Copied' : 'Copy'}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
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
