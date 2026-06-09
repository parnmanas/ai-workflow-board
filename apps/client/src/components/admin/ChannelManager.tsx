import React, { useState } from 'react';
import { api } from '../../api';
import { Channel } from '../../types';
import { tokens } from '../../tokens';
import { Button, Input, Select, Badge, Modal } from '../common';
import { useCrudList } from '../../hooks/useCrudList';
import { useConfirm } from '../../contexts/ConfirmContext';

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

export default function ChannelManager({ workspaceId }: { workspaceId?: string } = {}) {
  const confirm = useConfirm();
  const { items: channels, showForm, setShowForm, editingId, setEditingId, refresh: load } =
    useCrudList<Channel>(() => api.getChannels());
  const [testResult, setTestResult] = useState<Record<string, { success: boolean; error?: string }>>({});
  const [form, setForm] = useState({
    name: '', type: 'discord', bot_token: '', channel_id: '',
    notify_on_status_change: 1, notify_on_update: 1, notify_on_comment: 1,
  });

  const resetForm = () => {
    setForm({
      name: '', type: 'discord', bot_token: '', channel_id: '',
      notify_on_status_change: 1, notify_on_update: 1, notify_on_comment: 1,
    });
    setEditingId(null);
    setShowForm(false);
  };

  const handleSave = async () => {
    if (!form.name.trim()) return;
    if (editingId) {
      // bot_token 이 비어있으면 기존 토큰 유지 (서버에 보내지 않음)
      const payload: Record<string, any> = { ...form };
      if (!payload.bot_token) {
        delete payload.bot_token;
      }
      await api.updateChannel(editingId, payload);
    } else {
      await api.createChannel(form);
    }
    resetForm();
    await load();
  };

  const handleEdit = (ch: Channel) => {
    setForm({
      name: ch.name, type: ch.type, bot_token: '',
      channel_id: ch.channel_id,
      notify_on_status_change: ch.notify_on_status_change,
      notify_on_update: ch.notify_on_update, notify_on_comment: ch.notify_on_comment,
    });
    setEditingId(ch.id);
    setShowForm(true);
  };

  const handleDelete = async (id: string) => {
    const ok = await confirm({ title: 'Delete channel', message: 'Delete this channel?' });
    if (!ok) return;
    await api.deleteChannel(id);
    await load();
  };

  const handleTest = async (id: string) => {
    const result = await api.testChannel(id);
    setTestResult({ ...testResult, [id]: result });
  };

  const handleToggleActive = async (ch: Channel) => {
    await api.updateChannel(ch.id, { is_active: ch.is_active ? 0 : 1 });
    await load();
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <span style={{ fontSize: 13, color: tokens.colors.textMuted }}>{channels.length} channels</span>
        <Button variant="primary" onClick={() => { resetForm(); setShowForm(true); }}>+ Add Channel</Button>
      </div>

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
              <th style={listHeadStyle('left')}>Type</th>
              <th style={listHeadStyle('left')}>Channel ID</th>
              <th style={listHeadStyle('left')}>Notifications</th>
              <th style={listHeadStyle('left')}>Test</th>
              <th style={listHeadStyle('right')}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {channels.map((ch) => {
              const notifyParts: string[] = [];
              if (ch.notify_on_status_change) notifyParts.push('status');
              if (ch.notify_on_update) notifyParts.push('updates');
              if (ch.notify_on_comment) notifyParts.push('comments');
              return (
                <tr key={ch.id} style={{ borderTop: `1px solid ${tokens.colors.border}` }}>
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
                    title={ch.name}
                  >
                    {ch.name}
                  </td>
                  <td style={listCellStyle('left')}>
                    <Badge variant="neutral">{ch.type}</Badge>
                  </td>
                  <td
                    style={{
                      ...listCellStyle('left'),
                      fontFamily: 'monospace',
                      color: tokens.colors.textMuted,
                      maxWidth: 200,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={ch.channel_id || ''}
                  >
                    {ch.channel_id || <span style={{ color: tokens.colors.textMuted }}>not set</span>}
                  </td>
                  <td style={{ ...listCellStyle('left'), color: tokens.colors.textSecondary, whiteSpace: 'nowrap' }}>
                    {notifyParts.length ? notifyParts.join(', ') : <span style={{ color: tokens.colors.textMuted }}>—</span>}
                  </td>
                  <td style={listCellStyle('left')}>
                    {testResult[ch.id] ? (
                      testResult[ch.id].success ? (
                        <Badge variant="success">Connected</Badge>
                      ) : (
                        <Badge variant="danger">Failed</Badge>
                      )
                    ) : (
                      <span style={{ color: tokens.colors.textMuted }}>—</span>
                    )}
                  </td>
                  <td style={{ ...listCellStyle('right'), whiteSpace: 'nowrap' }}>
                    <div style={{ display: 'inline-flex', gap: 6 }}>
                      <Button variant="secondary" size="sm" onClick={() => handleTest(ch.id)}>Test</Button>
                      <Button
                        variant={ch.is_active ? 'primary' : 'secondary'}
                        size="sm"
                        onClick={() => handleToggleActive(ch)}
                      >
                        {ch.is_active ? 'Active' : 'Inactive'}
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => handleEdit(ch)}>Edit</Button>
                      <Button variant="danger" size="sm" onClick={() => handleDelete(ch.id)}>Delete</Button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {channels.length === 0 && (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', padding: '48px 24px' }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: tokens.colors.textPrimary, marginBottom: 8 }}>
                    No channels yet
                  </div>
                  <div style={{ fontSize: 13, color: tokens.colors.textSecondary }}>
                    Add a Discord channel to receive notifications.
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Modal
        isOpen={showForm}
        onClose={resetForm}
        title={editingId ? 'Edit Channel' : 'Create Channel'}
        maxWidth={520}
        footer={
          <>
            <Button variant="secondary" onClick={resetForm}>Cancel</Button>
            <Button variant="primary" onClick={handleSave}>{editingId ? 'Update' : 'Create'}</Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input
              label="Channel Name *"
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              placeholder="My Discord Channel"
            />
            <Select
              label="Type"
              value={form.type}
              onChange={e => setForm({ ...form, type: e.target.value })}
              options={[{ value: 'discord', label: 'Discord' }]}
            />
            <Input
              label="Bot Token"
              type="password"
              value={form.bot_token}
              onChange={e => setForm({ ...form, bot_token: e.target.value })}
              placeholder={editingId ? 'Leave empty to keep current token' : 'Discord bot token'}
            />
            <Input
              label="Channel ID"
              value={form.channel_id}
              onChange={e => setForm({ ...form, channel_id: e.target.value })}
              placeholder="Discord channel ID for notifications"
            />
          </div>

          {/* Notification checkboxes */}
          <div style={{ display: 'flex', gap: 16, padding: '8px 0' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '12px', color: tokens.colors.textSecondary, cursor: 'pointer' }}>
              <input type="checkbox" checked={!!form.notify_on_status_change} onChange={e => setForm({ ...form, notify_on_status_change: e.target.checked ? 1 : 0 })} style={{ accentColor: tokens.colors.accent }} />
              Status Changes
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '12px', color: tokens.colors.textSecondary, cursor: 'pointer' }}>
              <input type="checkbox" checked={!!form.notify_on_update} onChange={e => setForm({ ...form, notify_on_update: e.target.checked ? 1 : 0 })} style={{ accentColor: tokens.colors.accent }} />
              Content Updates
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '12px', color: tokens.colors.textSecondary, cursor: 'pointer' }}>
              <input type="checkbox" checked={!!form.notify_on_comment} onChange={e => setForm({ ...form, notify_on_comment: e.target.checked ? 1 : 0 })} style={{ accentColor: tokens.colors.accent }} />
              New Comments
            </label>
          </div>
        </div>
      </Modal>
    </div>
  );
}
