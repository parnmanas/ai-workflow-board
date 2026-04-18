import React, { useState } from 'react';
import { api } from '../../api';
import { Channel } from '../../types';
import { tokens } from '../../tokens';
import { Button, Input, Select, Badge, Modal, Card } from '../common';
import { useCrudList } from '../../hooks/useCrudList';

export default function ChannelManager({ workspaceId }: { workspaceId?: string } = {}) {
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
    if (!confirm('Delete this channel?')) return;
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

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
        gap: tokens.spacing.md,
      }}>
        {channels.map(ch => (
          <Card key={ch.id} padding="10px 12px">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{
                width: 32, height: 32, borderRadius: tokens.radii.lg,
                background: ch.is_active ? `${tokens.colors.successLight}20` : `${tokens.colors.border}40`,
                border: `1px solid ${ch.is_active ? tokens.colors.successLight : tokens.colors.borderStrong}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '12px', fontWeight: 700, color: ch.is_active ? tokens.colors.successLight : tokens.colors.textMuted,
                flexShrink: 0,
              }}>D</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '13px', fontWeight: 600, color: tokens.colors.textStrong }}>{ch.name}</div>
                <div style={{ fontSize: '11px', color: tokens.colors.textMuted }}>
                  Token: {ch.bot_token || 'Not set'} | Channel: {ch.channel_id || 'Not set'}
                </div>
              </div>
              {testResult[ch.id] && (
                testResult[ch.id].success
                  ? <Badge variant="success">Connected</Badge>
                  : <Badge variant="danger">Failed</Badge>
              )}
              <Button variant="secondary" size="sm" onClick={() => handleTest(ch.id)}>Test</Button>
              <Button variant={ch.is_active ? 'primary' : 'secondary'} size="sm" onClick={() => handleToggleActive(ch)}>
                {ch.is_active ? 'Active' : 'Inactive'}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => handleEdit(ch)}>Edit</Button>
              <Button variant="danger" size="sm" onClick={() => handleDelete(ch.id)}>Delete</Button>
            </div>
          </Card>
        ))}
        {channels.length === 0 && (
          <div style={{ textAlign: 'center', padding: '48px 24px', gridColumn: '1 / -1' }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: tokens.colors.textPrimary, marginBottom: 8 }}>No channels yet</div>
            <div style={{ fontSize: 13, color: tokens.colors.textSecondary }}>Add a Discord channel to receive notifications.</div>
          </div>
        )}
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
