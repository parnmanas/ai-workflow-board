import { getLocaleTag } from '../../i18n/core';
import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../api';
import { ApiKey } from '../../types';
import { tokens } from '../../tokens';
import { Button, Input, Select, Badge, Modal, Card } from '../common';
import { useConfirm } from '../../contexts/ConfirmContext';
import { formatAgentDisplayName } from '../../utils/agentName';

const apiKeyHeadStyle = (align: 'left' | 'right'): React.CSSProperties => ({
  textAlign: align,
  padding: '8px 12px',
  fontWeight: 600,
});

const apiKeyCellStyle = (align: 'left' | 'right'): React.CSSProperties => ({
  textAlign: align,
  padding: '10px 12px',
  verticalAlign: 'middle',
});

export default function ApiKeyManager({ accountId }: { accountId?: string } = {}) {
  useLocale();
  const confirm = useConfirm();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', scope: 'full', expires_in_days: '' });
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const keysData = await api.getApiKeys(accountId);
    setKeys(keysData);
  }, [accountId]);

  useEffect(() => { load(); }, [load]);

  const resetForm = () => {
    setForm({ name: '', scope: 'full', expires_in_days: '' });
    setEditingId(null);
    setShowForm(false);
    setCreatedKey(null);
    setCopied(false);
  };

  const handleSave = async () => {
    if (!form.name.trim()) return;

    if (editingId) {
      await api.updateApiKey(editingId, {
        name: form.name,
        scope: form.scope,
                expires_in_days: form.expires_in_days ? parseInt(form.expires_in_days) : undefined,
      });
      resetForm();
    } else {
      const result = await api.createApiKey({
        name: form.name,
        scope: form.scope,
                expires_in_days: form.expires_in_days ? parseInt(form.expires_in_days) : undefined,
      });
      setCreatedKey(result.raw_key);
    }
    await load();
  };

  const handleEdit = (key: ApiKey) => {
    setForm({
      name: key.name,
      scope: key.scope,
            expires_in_days: '',
    });
    setEditingId(key.id);
    setShowForm(true);
    setCreatedKey(null);
  };

  const handleRevoke = async (id: string) => {
    const ok = await confirm({
      title: translate('Revoke API key'),
      message: translate('Revoke this API key? It will no longer be usable.'),
      confirmLabel: translate('Revoke'),
    });
    if (!ok) return;
    await api.revokeApiKey(id);
    await load();
  };

  const handleDelete = async (id: string) => {
    const ok = await confirm({ title: translate('Delete API key'), message: translate('Permanently delete this API key?') });
    if (!ok) return;
    await api.deleteApiKey(id);
    await load();
  };

  const handleCopy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const getKeyStatus = (key: ApiKey): { label: string; variant: 'success' | 'danger' | 'warning' } => {
    if (!key.is_active) return { label: translate('REVOKED'), variant: 'danger' };
    if (key.expires_at && new Date(key.expires_at) < new Date()) return { label: translate('EXPIRED'), variant: 'warning' };
    return { label: translate('ACTIVE'), variant: 'success' };
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <span style={{ fontSize: 13, color: tokens.colors.textMuted }}>{keys.length} {translate('keys')}</span>
        <Button variant="primary" onClick={() => { resetForm(); setShowForm(true); }}>{translate('+ Create Key')}</Button>
      </div>

      {/* Create / Edit Modal (also shows created key) */}
      <Modal
        isOpen={showForm || !!createdKey}
        onClose={resetForm}
        title={createdKey ? translate('API Key Created') : (editingId ? translate('Edit API Key') : translate('Create API Key'))}
        maxWidth={520}
        footer={
          createdKey ? (
            <Button variant="secondary" onClick={resetForm}>{translate('Done')}</Button>
          ) : (
            <>
              <Button variant="secondary" onClick={resetForm}>{translate('Cancel')}</Button>
              <Button variant="primary" onClick={handleSave}>{editingId ? translate('Update') : translate('Create')}</Button>
            </>
          )
        }
      >
        {createdKey ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ fontSize: '12px', fontWeight: 600, color: tokens.colors.successLight }}>
              {translate('API Key Created Successfully')}</div>
            <div style={{ fontSize: '11px', color: tokens.colors.warningLight }}>
              {translate('Copy this key now. It will NOT be shown again.')}</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <code style={{
                flex: 1, background: tokens.colors.surface, padding: '8px 12px', borderRadius: tokens.radii.md,
                fontSize: '12px', color: tokens.colors.textStrong, fontFamily: 'monospace',
                wordBreak: 'break-all', border: `1px solid ${tokens.colors.border}`,
              }}>{createdKey}</code>
              <Button variant="secondary" onClick={() => handleCopy(createdKey)}>
                {copied ? translate('Copied!') : translate('Copy')}
              </Button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Input
                label={translate('Name *')}
                value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })}
                placeholder={translate('e.g. claude-prod')}
              />
              <Select
                label={translate('Scope')}
                value={form.scope}
                onChange={e => setForm({ ...form, scope: (e.target as HTMLSelectElement).value })}
                options={[
                  { value: 'full', label: translate('Full (Read + Write)') },
                  { value: 'read', label: translate('Read Only') },
                  { value: 'write', label: translate('Write Only') },
                  { value: 'migration_export', label: translate('Migration Export (server-to-server pull)') },
                ]}
              />

              <Input
                label={translate('Expires In (Days)')}
                type="number"
                value={form.expires_in_days}
                onChange={e => setForm({ ...form, expires_in_days: e.target.value })}
                placeholder={translate('Empty = never')}
              />
            </div>
          </div>
        )}
      </Modal>

      {/* Keys list — table layout so long names truncate with ellipsis
          while action buttons stay pinned in the rightmost column. The
          previous card grid hid actions whenever name + badges
          overflowed the card's min-width (320px). */}
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
              <th style={apiKeyHeadStyle('left')}>{translate('Name')}</th>
              <th style={apiKeyHeadStyle('left')}>{translate('Status')}</th>
              <th style={apiKeyHeadStyle('left')}>{translate('Scope')}</th>
              <th style={apiKeyHeadStyle('left')}>{translate('Masked Key')}</th>
              <th style={apiKeyHeadStyle('left')}>{translate('Host')}</th>
              <th style={apiKeyHeadStyle('right')}>{translate('Used')}</th>
              <th style={apiKeyHeadStyle('left')}>{translate('Last Used')}</th>
              <th style={apiKeyHeadStyle('left')}>{translate('Expires')}</th>
              <th style={apiKeyHeadStyle('right')}>{translate('Actions')}</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => {
              const status = getKeyStatus(key);
              return (
                <tr key={key.id} style={{ borderTop: `1px solid ${tokens.colors.border}` }}>
                  <td
                    style={{
                      ...apiKeyCellStyle('left'),
                      maxWidth: 240,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: tokens.colors.textStrong,
                      fontWeight: 600,
                    }}
                    title={key.name}
                  >
                    {key.name}
                  </td>
                  <td style={apiKeyCellStyle('left')}>
                    <Badge variant={status.variant}>{status.label}</Badge>
                  </td>
                  <td style={apiKeyCellStyle('left')}>
                    <Badge variant="neutral">{key.scope}</Badge>
                  </td>
                  <td
                    style={{
                      ...apiKeyCellStyle('left'),
                      fontFamily: 'monospace',
                      color: tokens.colors.textMuted,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {key.key_masked}
                  </td>
                  <td
                    style={{
                      ...apiKeyCellStyle('left'),
                      maxWidth: 200,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {key.host_id || '—'}
                  </td>
                  <td
                    style={{
                      ...apiKeyCellStyle('right'),
                      color: tokens.colors.textSecondary,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {key.use_count}
                  </td>
                  <td
                    style={{
                      ...apiKeyCellStyle('left'),
                      color: tokens.colors.textSecondary,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {key.last_used_at ? new Date(key.last_used_at).toLocaleDateString(getLocaleTag()) : '—'}
                  </td>
                  <td
                    style={{
                      ...apiKeyCellStyle('left'),
                      color: tokens.colors.textSecondary,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {key.expires_at ? new Date(key.expires_at).toLocaleDateString(getLocaleTag()) : translate('never')}
                  </td>
                  <td style={{ ...apiKeyCellStyle('right'), whiteSpace: 'nowrap' }}>
                    <div style={{ display: 'inline-flex', gap: 6 }}>
                      {key.is_active ? (
                        <>
                          <Button variant="secondary" size="sm" onClick={() => handleEdit(key)}>
                            {translate('Edit')}</Button>
                          <Button variant="danger" size="sm" onClick={() => handleRevoke(key.id)}>
                            {translate('Revoke')}</Button>
                        </>
                      ) : (
                        <Button variant="danger" size="sm" onClick={() => handleDelete(key.id)}>
                          {translate('Delete')}</Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {keys.length === 0 && (
              <tr>
                <td colSpan={9} style={{ textAlign: 'center', padding: '48px 24px' }}>
                  <div
                    style={{
                      fontSize: 18,
                      fontWeight: 700,
                      color: tokens.colors.textPrimary,
                      marginBottom: 8,
                    }}
                  >
                    {translate('No API keys yet')}</div>
                  <div style={{ fontSize: 13, color: tokens.colors.textSecondary }}>
                    {translate('Create your first key to enable MCP authentication.')}</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Usage Guide */}
      <Card style={{ marginTop: 20 }} padding={14}>
        <div style={{ fontSize: '12px', fontWeight: 600, color: tokens.colors.textSecondary, marginBottom: 8 }}>{translate('Usage')}</div>
        <div style={{ fontSize: '11px', color: tokens.colors.textMuted, lineHeight: 1.8, fontFamily: 'monospace' }}>
          <div>{translate('Authorization: Bearer awb_your_key_here')}</div>
          <div style={{ color: tokens.colors.borderStrong }}>{translate('or')}</div>
          <div>{translate('x-api-key: awb_your_key_here')}</div>
        </div>
      </Card>
    </div>
  );
}
