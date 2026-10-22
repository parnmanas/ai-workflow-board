import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../../api';
import type { Credential } from '../../types';
import { useToast } from '../../contexts/ToastContext';
import { tokens } from '../../tokens';
import { Button, Input, Modal, Badge, ConfirmDialog } from '../common';
import { relativeTime } from '../../utils/time';
import { useAuth } from '../../contexts/AuthContext';
import CliCredentialImport from './CliCredentialImport';
import { PaymentCredentialGuide } from '../marketing/PaymentCredentialGuide';
import { isDirectPaymentProvider } from '../marketing/marketing.logic';
import CliAutoLogin from './CliAutoLogin';
import { cliCredentialProviders, useCliCatalog, type FlattenedCredentialProvider } from '../../cli/catalog';
import { providerColor, providerIcon } from '../../cli/presentation';
import {
  AGENT_ENV_PROVIDERS,
  DEFAULT_AGENT_ENV_PREFIX,
  agentEnvNames,
  customRowsProblem,
  gitHostOrigin,
  GIT_HOST_PROVIDER,
  npmRegistryUrl,
  NPM_PROVIDER,
  normalizeAgentEnvPrefix,
  parseGoogleOAuthJson,
  type CustomRow,
} from './credentialAgentEnv.logic';

export const CREDENTIAL_REVEAL_TTL_MS = 30_000;

const listHeadStyle = (align: 'left' | 'right'): React.CSSProperties => ({
  textAlign: align,
  padding: '8px 12px',
  fontWeight: 600,
});

const fieldLabelStyle: React.CSSProperties = {
  fontSize: tokens.typography.fontSizeXs,
  fontWeight: tokens.typography.fontWeightSemibold,
  color: tokens.colors.textMuted,
  textTransform: 'uppercase',
  display: 'block',
  marginBottom: tokens.spacing.xs,
};

const fieldHintStyle: React.CSSProperties = { fontSize: '11px', color: tokens.colors.textMuted, marginBottom: 4 };

const secretInputStyle: React.CSSProperties = {
  width: '100%',
  background: tokens.colors.surface,
  border: `1px solid ${tokens.colors.border}`,
  borderRadius: tokens.radii.md,
  padding: '8px 10px',
  color: tokens.colors.textStrong,
  fontSize: '13px',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  boxSizing: 'border-box',
  outline: 'none',
};

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
  { value: 'cloudflare', label: 'Cloudflare', icon: 'C', fields: { api_token: { label: 'API Token', placeholder: 'Paste your Cloudflare API token' } } },
  { value: 'openai', label: 'OpenAI', icon: 'O', fields: { api_key: { label: 'API Key', placeholder: 'sk-...' } } },
  {
    value: 'google_oauth',
    label: 'Google OAuth',
    icon: 'G',
    fields: {
      client_id: { label: 'Client ID', placeholder: '1234567890-abc.apps.googleusercontent.com' },
      client_secret: { label: 'Client secret', placeholder: 'GOCSPX-...' },
      refresh_token: {
        label: 'Refresh token (optional)',
        placeholder: '1//... — without it an agent cannot call Google APIs (no browser for the consent screen)',
      },
    },
  },
  {
    value: 'git_http',
    label: 'Git (HTTPS host)',
    icon: 'G',
    fields: {
      url: { label: 'Host URL', placeholder: 'https://lfs.example.com — any URL on the host works (e.g. the .lfsconfig url)' },
      username: { label: 'Username', placeholder: 'Account the token belongs to' },
      token: { label: 'Access token', placeholder: 'Personal access token (used as the password)' },
    },
  },
  {
    value: 'npm',
    label: 'npm registry',
    icon: 'N',
    fields: {
      token: { label: 'Access token', placeholder: 'npm_... — granular access token from npmjs.com' },
      registry: { label: 'Registry (optional)', placeholder: 'https://registry.npmjs.org/ (default)' },
    },
  },
  // Marketing direct payments (docs/marketing.md "직접 결제 어댑터"). Server-only: the
  // marketing module accepts only credentials made with these providers, and they
  // are never exposed to agents (not in AGENT_ENV_PROVIDERS). Field names must match
  // the server's DIRECT_PROVIDER_CREDENTIAL_FIELDS (test/marketing-payment-contract).
  {
    value: 'meta_ads',
    label: 'Meta Ads (marketing payments)',
    icon: 'M',
    fields: {
      access_token: { label: 'System user access token', placeholder: 'EAAB... — ads_management on the ad account; the server raises campaign spend caps with it' },
      app_secret: { label: 'App secret (optional)', placeholder: 'Adds appsecret_proof — needed when the app has "Require App Secret" on' },
    },
  },
  {
    value: 'google_ads',
    label: 'Google Ads (marketing payments)',
    icon: 'G',
    fields: {
      client_id: { label: 'OAuth client ID', placeholder: '1234567890-abc.apps.googleusercontent.com' },
      client_secret: { label: 'OAuth client secret', placeholder: 'GOCSPX-...' },
      refresh_token: { label: 'Refresh token', placeholder: '1//... — adwords scope; publish the OAuth app (refresh tokens of apps in "Testing" expire in 7 days)' },
      login_customer_id: { label: 'Manager account id (optional)', placeholder: '123-456-7890 — only when access goes through a manager (MCC) account' },
      developer_token: { label: 'Developer token (leave empty)', placeholder: 'Retired by Google on 2026-09-09 — ignored now, rejected by later API versions; access follows the OAuth client\'s Cloud project' },
    },
  },
  {
    value: 'stripe_issuing',
    label: 'Stripe Issuing (marketing payments)',
    icon: 'S',
    fields: {
      secret_key: { label: 'Restricted API key', placeholder: 'rk_live_... (sandbox rk_test_...) — Issuing Cards: Write; Cardholders, Transactions, Authorizations: Read; a full live key sk_live_ is refused' },
    },
  },
  // Custom renders a key/value editor instead of these fields; `token` is the
  // first row's default key (what outreach/resources read).
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
  globalMode = false,
  catalogMode = false,
  createAccountId = null,
  allScopes = false,
  canManageGlobal = false,
}: {
  /** Global credentials only — listing and creating. */
  globalMode?: boolean;
  catalogMode?: boolean;
  /** Owner of new credentials: an Account id, or null for Global. The list
   *  itself is never filtered by it — it shows every accessible Account's
   *  credentials plus Global ones. */
  createAccountId?: string | null;
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
  const [storedFieldPreviews, setStoredFieldPreviews] = useState<Record<string, string>>({});
  const [formErrors, setFormErrors] = useState<{ name?: string; fields?: string }>({});
  const [formAgentEnv, setFormAgentEnv] = useState(false);
  const [formEnvPrefix, setFormEnvPrefix] = useState('');
  // Custom provider: new key/value rows, and stored keys marked for deletion.
  const [customRows, setCustomRows] = useState<CustomRow[]>([]);
  const [removedFields, setRemovedFields] = useState<string[]>([]);
  const [googleJson, setGoogleJson] = useState('');

  const effectiveCreateOwner: string | null = globalMode ? null : createAccountId;

  const loadCredentials = useCallback(async () => {
    setLoading(true);
    try {
      // No account_id: the server lists every accessible Account + Global.
      const list = globalMode
        ? await api.listCredentials(undefined, { scope: 'global' })
        : await api.listCredentials(undefined, {
            includeAllScopes: catalogMode && allScopes,
          });
      setCredentials(list);
    } catch (err: any) {
      showToast(err?.message || 'Failed to load credentials', 'error');
    } finally {
      setLoading(false);
    }
  }, [globalMode, catalogMode, allScopes, showToast]);

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

  const resetProviderInputs = (provider: string) => {
    setFormFields({});
    setStoredFieldPreviews({});
    setCustomRows(provider === 'custom' ? [{ key: 'token', value: '' }] : []);
    setRemovedFields([]);
    setGoogleJson('');
    setFormEnvPrefix(DEFAULT_AGENT_ENV_PREFIX[provider] ?? '');
    if (!AGENT_ENV_PROVIDERS.has(provider)) setFormAgentEnv(false);
  };

  const startCreate = () => {
    setFormName('');
    setFormDescription('');
    setFormProvider('github');
    resetProviderInputs('github');
    setFormAgentEnv(false);
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
    setCustomRows([]);
    setRemovedFields([]);
    setGoogleJson('');
    setFormAgentEnv(!!cred.agent_env);
    setFormEnvPrefix(cred.env_prefix || '');
    setFormErrors({});
    setEditCred(cred);
    setShowForm(true);
  };

  const cancelForm = () => { setShowForm(false); setEditCred(null); };

  const isCustom = formProvider === 'custom';
  const storedKeys = Object.keys(storedFieldPreviews);
  const keptStoredKeys = storedKeys.filter((k) => !removedFields.includes(k));
  // Keys that will hold a value after saving — what the env preview names.
  const previewFieldKeys = Array.from(new Set([
    ...keptStoredKeys.filter((k) => storedFieldPreviews[k]),
    ...Object.keys(formFields).filter((k) => formFields[k]),
    ...(isCustom ? customRows.filter((r) => r.key.trim() && r.value).map((r) => r.key.trim()) : []),
  ]));

  const applyGoogleJson = () => {
    const parsed = parseGoogleOAuthJson(googleJson);
    if (!parsed.ok) { showToast(parsed.error, 'error'); return; }
    setFormFields((prev) => ({ ...prev, ...parsed.fields }));
    setGoogleJson('');
    showToast(
      parsed.fields.refresh_token
        ? 'Filled client ID, client secret and refresh token.'
        : 'Filled client ID and client secret. Add a refresh token for agents to call Google APIs.',
      'success',
    );
  };

  const handleSave = async () => {
    const errors: { name?: string; fields?: string } = {};
    if (!formName.trim()) errors.name = 'Name is required.';
    const customProblem = isCustom ? customRowsProblem(customRows, keptStoredKeys) : null;
    if (customProblem) errors.fields = customProblem;
    if (Object.keys(errors).length > 0) { setFormErrors(errors); return; }
    const credentials: Record<string, string> = { ...formFields };
    if (isCustom) {
      for (const row of customRows) {
        if (row.key.trim() && row.value) credentials[row.key.trim()] = row.value;
      }
    }
    const agentEnvFields = AGENT_ENV_PROVIDERS.has(formProvider)
      ? { agent_env: formAgentEnv, env_prefix: normalizeAgentEnvPrefix(formEnvPrefix) }
      : { agent_env: false };

    setSaving(true);
    try {
      if (editCred) {
        const saved = await api.updateCredential(editCred.id, {
          // Editing preserves ownership; scope is not an editable form field.
          scope: editCred.scope,
          ...(editCred.account_id ? { account_id: editCred.account_id } : {}),
          name: formName.trim(),
          description: formDescription,
          provider: formProvider,
          credentials,
          ...(removedFields.length ? { remove_fields: removedFields } : {}),
          ...agentEnvFields,
        });
        showToast('Credential updated.', 'success');
        for (const warning of saved.warnings ?? []) showToast(warning, 'info', { durationMs: 15000 });
      } else {
        await api.createCredential({
          scope: effectiveCreateOwner === null ? 'global' : 'account',
          account_id: effectiveCreateOwner ?? undefined,
          name: formName.trim(),
          description: formDescription,
          provider: formProvider,
          credentials,
          ...agentEnvFields,
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
      // The row's own owner — never the page's owner for new items.
      await api.deleteCredential(deleteTarget.id, deleteTarget.account_id ?? undefined);
      showToast('Credential deleted.', 'success');
      setDeleteTarget(null);
      await loadCredentials();
    } catch (err: any) {
      showToast(err?.message || 'Failed to delete credential', 'error');
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <span style={{ fontSize: 13, color: tokens.colors.textMuted }}>{credentials.length} credentials</span>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <CliAutoLogin
            credentials={credentials.filter((c) => c.scope !== 'global' || canManageGlobal)}
            accountId={effectiveCreateOwner ?? ''}
            createScope={effectiveCreateOwner === null ? 'global' : 'account'}
            onCreated={loadCredentials}
          />
          <CliCredentialImport
            credentials={credentials.filter((c) => c.scope !== 'global' || canManageGlobal)}
            accountId={effectiveCreateOwner ?? ''}
            createScope={effectiveCreateOwner === null ? 'global' : 'account'}
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
                      {c.agent_env && (
                        <span
                          style={{ marginLeft: 6 }}
                          title={[
                            c.agent_git_host ? `Agents' git authenticates to ${c.agent_git_host}` : '',
                            c.agent_npm_registry ? `Agents' npm authenticates to ${c.agent_npm_registry}` : '',
                            (c.agent_env_names ?? []).length ? `Env: ${(c.agent_env_names ?? []).join(', ')}` : '',
                          ].filter(Boolean).join(' · ') || '—'}
                        >
                          <Badge variant="success">agent env</Badge>
                        </span>
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
                          title="You do not have permission to edit this credential"
                        >
                          Read-only
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
                onChange={(e) => { setFormProvider(e.target.value); resetProviderInputs(e.target.value); }}
                style={{ width: '100%', background: tokens.colors.surface, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md, padding: '8px 10px', color: tokens.colors.textStrong, fontSize: '12px', fontFamily: 'inherit', boxSizing: 'border-box' }}
              >
                {providerOptions.filter((p) => !isDirectPaymentProvider(p.value)).map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                {/* 마케팅 직접 결제 — 서버만 쓰고 에이전트에게는 노출할 수 없다. 고르면 아래에 발급 방법이 나온다. */}
                <optgroup label="Marketing payments (server only)">
                  {providerOptions.filter((p) => isDirectPaymentProvider(p.value)).map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                </optgroup>
              </select>
            </div>
          </div>
          <Input label="Description" value={formDescription} onChange={(e) => setFormDescription(e.target.value)} placeholder="Optional note" />

          {isDirectPaymentProvider(formProvider) && (
            <PaymentCredentialGuide provider={formProvider} defaultOpen={!editCred} />
          )}

          {formProvider === 'google_oauth' && (
            <div>
              <label style={fieldLabelStyle}>Import from JSON (optional)</label>
              <div style={fieldHintStyle}>
                Paste the client JSON downloaded from Google Cloud Console, or an authorized-user JSON that also
                carries a refresh_token. Only client_id, client_secret and refresh_token are kept.
              </div>
              <textarea
                value={googleJson}
                onChange={(e) => setGoogleJson(e.target.value)}
                placeholder='{"installed": {"client_id": "…", "client_secret": "…"}}'
                rows={4}
                style={{ ...secretInputStyle, fontSize: '12px', resize: 'vertical' }}
              />
              <div style={{ marginTop: 6 }}>
                <Button variant="secondary" size="sm" onClick={applyGoogleJson} disabled={!googleJson.trim()}>
                  Fill fields from JSON
                </Button>
              </div>
            </div>
          )}

          {isCustom && (
            <div>
              <label style={fieldLabelStyle}>Fields</label>
              <div style={fieldHintStyle}>
                Encrypted at rest (AES-256-GCM). One secret per key — e.g. CLIENT_ID and CLIENT_SECRET.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {storedKeys.map((key) => {
                  const removed = removedFields.includes(key);
                  return (
                    <div key={`stored-${key}`} style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr auto', gap: 6, alignItems: 'center' }}>
                      <code style={{ fontSize: 12, color: removed ? tokens.colors.textMuted : tokens.colors.textStrong, textDecoration: removed ? 'line-through' : 'none' }}>
                        {key}
                      </code>
                      {removed ? (
                        <span style={{ fontSize: 12, color: tokens.colors.textMuted }}>Removed on save</span>
                      ) : (
                        <input
                          type="password"
                          autoComplete="new-password"
                          value={formFields[key] || ''}
                          onChange={(e) => setFormFields((prev) => ({ ...prev, [key]: e.target.value }))}
                          placeholder={`Stored: ${storedFieldPreviews[key] || '(empty)'} — blank keeps it`}
                          style={secretInputStyle}
                        />
                      )}
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setRemovedFields((prev) => (removed ? prev.filter((k) => k !== key) : [...prev, key]))}
                      >
                        {removed ? 'Undo' : 'Remove'}
                      </Button>
                    </div>
                  );
                })}
                {customRows.map((row, index) => (
                  <div key={`new-${index}`} style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr auto', gap: 6, alignItems: 'center' }}>
                    <input
                      value={row.key}
                      onChange={(e) => setCustomRows((prev) => prev.map((r, i) => (i === index ? { ...r, key: e.target.value } : r)))}
                      placeholder="KEY"
                      style={secretInputStyle}
                    />
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={row.value}
                      onChange={(e) => setCustomRows((prev) => prev.map((r, i) => (i === index ? { ...r, value: e.target.value } : r)))}
                      placeholder="Secret value"
                      style={secretInputStyle}
                    />
                    <Button variant="secondary" size="sm" onClick={() => setCustomRows((prev) => prev.filter((_, i) => i !== index))}>
                      ×
                    </Button>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 6 }}>
                <Button variant="secondary" size="sm" onClick={() => setCustomRows((prev) => [...prev, { key: '', value: '' }])}>
                  + Add field
                </Button>
              </div>
              {formErrors.fields && (
                <div style={{ fontSize: '12px', color: tokens.colors.danger, marginTop: 6 }}>{formErrors.fields}</div>
              )}
            </div>
          )}

          {!isCustom && Object.entries(getFieldDefs(formProvider)).map(([fieldKey, fieldDef]) => (
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

          {AGENT_ENV_PROVIDERS.has(formProvider) && (
            <div style={{ borderTop: `1px solid ${tokens.colors.border}`, paddingTop: 12 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: tokens.colors.textStrong, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={formAgentEnv}
                  onChange={(e) => {
                    setFormAgentEnv(e.target.checked);
                    if (e.target.checked && !formEnvPrefix) setFormEnvPrefix(DEFAULT_AGENT_ENV_PREFIX[formProvider] ?? '');
                  }}
                />
                Expose to agents as environment variables
              </label>
              <div style={{ ...fieldHintStyle, marginTop: 4 }}>
                Agent runs with access to this credential receive these variables — tickets, missions, chat and
                sessions. A session that is already running picks a change up when it next starts.
              </div>
              {formAgentEnv && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                  {formProvider === GIT_HOST_PROVIDER && (
                    <div style={{ fontSize: '12px', color: tokens.colors.textSecondary }}>
                      Agents' git and git-lfs authenticate to{' '}
                      <code style={{ color: tokens.colors.textStrong }}>
                        {gitHostOrigin(formFields.url || '') || editCred?.agent_git_host || '(enter the host URL)'}
                      </code>
                      {' '}with this token — so does the Runtime Host when it prepares their worktrees.
                    </div>
                  )}
                  {formProvider === NPM_PROVIDER && (
                    <div style={{ fontSize: '12px', color: tokens.colors.textSecondary }}>
                      Agents' npm authenticates to{' '}
                      <code style={{ color: tokens.colors.textStrong }}>
                        {npmRegistryUrl(formFields.registry || '') || editCred?.agent_npm_registry || '(enter a valid registry URL)'}
                      </code>
                      {' '}with this token (npm publish, private installs) — no .npmrc needed.
                    </div>
                  )}
                  <Input
                    label={formProvider === GIT_HOST_PROVIDER || formProvider === NPM_PROVIDER ? 'Env prefix (optional)' : 'Env prefix'}
                    value={formEnvPrefix}
                    onChange={(e) => setFormEnvPrefix(e.target.value.toUpperCase())}
                    placeholder={formProvider === GIT_HOST_PROVIDER
                      ? 'e.g. FORGEJO — also export the token as env vars; blank = git only'
                      : formProvider === NPM_PROVIDER
                      ? 'e.g. NPM — also export NPM_TOKEN for .npmrc ${NPM_TOKEN}; blank = npm auth only'
                      : 'e.g. GOOGLE — blank uses the keys as-is'}
                  />
                  <div style={{ fontSize: '12px', color: tokens.colors.textSecondary }}>
                    Env vars:{' '}
                    <code style={{ color: tokens.colors.textStrong }}>
                      {agentEnvNames(formProvider, formEnvPrefix, previewFieldKeys).join(', ') || '—'}
                    </code>
                  </div>
                </div>
              )}
            </div>
          )}
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
