import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../api';
import { useToast } from '../../contexts/ToastContext';
import { tokens } from '../../tokens';
import { Button, Input, Card } from '../common';

interface SettingRow {
  key: string;
  value: string;
  description: string;
  is_secret: boolean;
  updated_at: string | null;
}

const PROVIDER_OPTIONS = [
  { value: 'none', label: 'None (disabled)' },
  { value: 'openai', label: 'OpenAI' },
];

export default function SettingsManager() {
  const { showToast } = useToast();
  const [settings, setSettings] = useState<SettingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.getSettings();
      setSettings(list);
      const vals: Record<string, string> = {};
      list.forEach((s) => { vals[s.key] = s.value; });
      setFormValues(vals);
      setDirty(false);
    } catch (err: any) {
      showToast(err?.message || 'Failed to load settings', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const handleChange = (key: string, value: string) => {
    setFormValues((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.updateSettings(formValues);
      showToast('Settings saved.', 'success');
      await loadSettings();
    } catch (err: any) {
      showToast(err?.message || 'Failed to save settings', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div style={{ fontSize: '13px', color: tokens.colors.textSecondary, padding: 24 }}>Loading…</div>;
  }

  const embeddingEnabled = formValues['embedding.provider'] === 'openai';
  const githubConfigured = !!(formValues['github.token'] && !formValues['github.token'].startsWith('••'));

  const labelStyle: React.CSSProperties = {
    fontSize: tokens.typography.fontSizeXs,
    fontWeight: tokens.typography.fontWeightSemibold,
    color: tokens.colors.textMuted,
    textTransform: 'uppercase',
    display: 'block',
    marginBottom: tokens.spacing.xs,
  };

  const hintStyle: React.CSSProperties = {
    fontSize: '11px',
    color: tokens.colors.textMuted,
    marginBottom: 4,
  };

  const selectStyle: React.CSSProperties = {
    width: '100%',
    background: tokens.colors.surface,
    border: `1px solid ${tokens.colors.border}`,
    borderRadius: tokens.radii.md,
    padding: '8px 10px',
    color: tokens.colors.textStrong,
    fontSize: '13px',
    fontFamily: 'inherit',
    boxSizing: 'border-box',
  };

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

  function StatusDot({ enabled, enabledText, disabledText }: { enabled: boolean; enabledText: string; disabledText: string }) {
    return (
      <div style={{
        marginTop: 16,
        padding: '10px 12px',
        borderRadius: tokens.radii.md,
        background: enabled ? `${tokens.colors.accent}15` : `${tokens.colors.border}40`,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        <div style={{
          width: 8, height: 8, borderRadius: '50%',
          background: enabled ? tokens.colors.accent : tokens.colors.textMuted,
        }} />
        <span style={{ fontSize: '12px', color: enabled ? tokens.colors.accent : tokens.colors.textMuted }}>
          {enabled ? enabledText : disabledText}
        </span>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 640, display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* ─── Embedding Configuration ─── */}
      <Card padding="20px">
        <div style={{ fontSize: '15px', fontWeight: 700, color: tokens.colors.textStrong, marginBottom: 4 }}>
          Embedding Configuration
        </div>
        <div style={{ fontSize: '12px', color: tokens.colors.textSecondary, marginBottom: 20, lineHeight: 1.5 }}>
          Configure vector embedding for semantic resource search. When enabled, resources are automatically
          embedded and searchable via natural language queries through MCP.
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <label style={labelStyle}>Provider</label>
            <div style={hintStyle}>Embedding provider (openai or none)</div>
            <select
              value={formValues['embedding.provider'] || 'none'}
              onChange={(e) => handleChange('embedding.provider', e.target.value)}
              style={selectStyle}
            >
              {PROVIDER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          {embeddingEnabled && (
            <>
              <div>
                <label style={labelStyle}>API Key</label>
                <div style={hintStyle}>API key for the embedding provider</div>
                <input
                  type="password"
                  value={formValues['embedding.api_key'] || ''}
                  onChange={(e) => handleChange('embedding.api_key', e.target.value)}
                  placeholder="sk-..."
                  style={secretInputStyle}
                />
              </div>
              <Input
                label="Model"
                value={formValues['embedding.model'] || 'text-embedding-3-small'}
                onChange={(e) => handleChange('embedding.model', e.target.value)}
                placeholder="text-embedding-3-small"
              />
            </>
          )}
        </div>

        <StatusDot
          enabled={embeddingEnabled}
          enabledText="Vector search enabled — resources will be auto-embedded"
          disabledText="Vector search disabled — text search only"
        />
      </Card>

      {/* ─── GitHub Connector ─── */}
      <Card padding="20px">
        <div style={{ fontSize: '15px', fontWeight: 700, color: tokens.colors.textStrong, marginBottom: 4 }}>
          GitHub Connector
        </div>
        <div style={{ fontSize: '12px', color: tokens.colors.textSecondary, marginBottom: 20, lineHeight: 1.5 }}>
          Connect to GitHub to sync repository metadata, README, and file trees into resources.
          Without a token, repository resources store URL only — agents use their own GitHub access.
          With a token, AWB fetches and indexes repo content for vector search.
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <label style={labelStyle}>Personal Access Token</label>
            <div style={hintStyle}>
              GitHub PAT with <code style={{ fontSize: '11px', background: tokens.colors.border, padding: '1px 4px', borderRadius: 3 }}>repo</code> scope.
              Encrypted at rest (AES-256-GCM).
            </div>
            <input
              type="password"
              value={formValues['github.token'] || ''}
              onChange={(e) => handleChange('github.token', e.target.value)}
              placeholder="ghp_..."
              style={secretInputStyle}
            />
          </div>

          <Input
            label="Default Organization"
            value={formValues['github.default_org'] || ''}
            onChange={(e) => handleChange('github.default_org', e.target.value)}
            placeholder="e.g. my-org (optional)"
          />
        </div>

        <StatusDot
          enabled={githubConfigured}
          enabledText="GitHub connector active — repos will be synced and indexed"
          disabledText="GitHub connector inactive — resources store URL metadata only"
        />
      </Card>

      {/* ─── Save ─── */}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button
          variant="primary"
          onClick={handleSave}
          disabled={!dirty || saving}
          loading={saving}
        >
          Save Settings
        </Button>
      </div>
    </div>
  );
}
