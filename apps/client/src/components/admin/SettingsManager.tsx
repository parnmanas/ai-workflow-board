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

  const providerSetting = settings.find((s) => s.key === 'embedding.provider');
  const apiKeySetting = settings.find((s) => s.key === 'embedding.api_key');
  const modelSetting = settings.find((s) => s.key === 'embedding.model');
  const isEnabled = formValues['embedding.provider'] === 'openai';

  return (
    <div style={{ maxWidth: 640 }}>
      <Card padding="20px">
        <div style={{ fontSize: '15px', fontWeight: 700, color: tokens.colors.textStrong, marginBottom: 4 }}>
          Embedding Configuration
        </div>
        <div style={{ fontSize: '12px', color: tokens.colors.textSecondary, marginBottom: 20, lineHeight: 1.5 }}>
          Configure vector embedding for semantic resource search. When enabled, resources are automatically
          embedded and searchable via natural language queries through MCP.
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Provider */}
          <div>
            <label style={{
              fontSize: tokens.typography.fontSizeXs,
              fontWeight: tokens.typography.fontWeightSemibold,
              color: tokens.colors.textMuted,
              textTransform: 'uppercase',
              display: 'block',
              marginBottom: tokens.spacing.xs,
            }}>Provider</label>
            {providerSetting && (
              <div style={{ fontSize: '11px', color: tokens.colors.textMuted, marginBottom: 4 }}>
                {providerSetting.description}
              </div>
            )}
            <select
              value={formValues['embedding.provider'] || 'none'}
              onChange={(e) => handleChange('embedding.provider', e.target.value)}
              style={{
                width: '100%',
                background: tokens.colors.surface,
                border: `1px solid ${tokens.colors.border}`,
                borderRadius: tokens.radii.md,
                padding: '8px 10px',
                color: tokens.colors.textStrong,
                fontSize: '13px',
                fontFamily: 'inherit',
                boxSizing: 'border-box',
              }}
            >
              {PROVIDER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          {/* API Key */}
          {isEnabled && (
            <div>
              <label style={{
                fontSize: tokens.typography.fontSizeXs,
                fontWeight: tokens.typography.fontWeightSemibold,
                color: tokens.colors.textMuted,
                textTransform: 'uppercase',
                display: 'block',
                marginBottom: tokens.spacing.xs,
              }}>API Key</label>
              {apiKeySetting && (
                <div style={{ fontSize: '11px', color: tokens.colors.textMuted, marginBottom: 4 }}>
                  {apiKeySetting.description}
                </div>
              )}
              <input
                type="password"
                value={formValues['embedding.api_key'] || ''}
                onChange={(e) => handleChange('embedding.api_key', e.target.value)}
                placeholder="sk-..."
                style={{
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
                }}
              />
            </div>
          )}

          {/* Model */}
          {isEnabled && (
            <Input
              label="Model"
              value={formValues['embedding.model'] || 'text-embedding-3-small'}
              onChange={(e) => handleChange('embedding.model', e.target.value)}
              placeholder="text-embedding-3-small"
            />
          )}
        </div>

        {/* Status indicator */}
        <div style={{
          marginTop: 20,
          padding: '10px 12px',
          borderRadius: tokens.radii.md,
          background: isEnabled ? `${tokens.colors.accent}15` : `${tokens.colors.border}40`,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <div style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: isEnabled ? tokens.colors.accent : tokens.colors.textMuted,
          }} />
          <span style={{ fontSize: '12px', color: isEnabled ? tokens.colors.accent : tokens.colors.textMuted }}>
            {isEnabled ? 'Vector search enabled — resources will be auto-embedded' : 'Vector search disabled — text search only'}
          </span>
        </div>

        {/* Save button */}
        <div style={{ marginTop: 20, display: 'flex', justifyContent: 'flex-end' }}>
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={!dirty || saving}
            loading={saving}
          >
            Save Settings
          </Button>
        </div>
      </Card>
    </div>
  );
}
