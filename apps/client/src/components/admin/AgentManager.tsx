import React, { useState } from 'react';
import { api } from '../../api';
import { Agent } from '../../types';
import { tokens } from '../../tokens';
import { Button, Input, Select, Badge, Modal, Card } from '../common';
import { useCrudList } from '../../hooks/useCrudList';

export default function AgentManager() {
  const { items: agents, showForm, setShowForm, editingId, setEditingId, refresh: load } =
    useCrudList<Agent>(() => api.getAgentsAll());
  const [form, setForm] = useState({ name: '', description: '', type: 'custom', role_prompt: '' });
  const [identityForm, setIdentityForm] = useState({ channel_type: 'discord', channel_external_id: '', display_name: '' });
  const [showIdentityFor, setShowIdentityFor] = useState<string | null>(null);

  const resetForm = () => {
    setForm({ name: '', description: '', type: 'custom', role_prompt: '' });
    setEditingId(null);
    setShowForm(false);
  };

  const handleSave = async () => {
    if (!form.name.trim()) return;
    if (editingId) {
      await api.updateAgent(editingId, form);
    } else {
      await api.createAgent(form);
    }
    resetForm();
    await load();
  };

  const handleEdit = (agent: Agent) => {
    setForm({
      name: agent.name,
      description: agent.description,
      type: agent.type,
      role_prompt: agent.role_prompt || '',
    });
    setEditingId(agent.id);
    setShowForm(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this agent?')) return;
    await api.deleteAgent(id);
    await load();
  };

  const handleAddIdentity = async (agentId: string) => {
    if (!identityForm.channel_external_id.trim()) return;
    await api.addAgentIdentity(agentId, identityForm);
    setIdentityForm({ channel_type: 'discord', channel_external_id: '', display_name: '' });
    setShowIdentityFor(null);
    await load();
  };

  const handleDeleteIdentity = async (identityId: string) => {
    await api.deleteAgentIdentity(identityId);
    await load();
  };

  const agentTypeBadgeVariant = (type: string): 'info' | 'success' | 'neutral' => {
    if (type === 'claude') return 'info';
    if (type === 'gpt') return 'success';
    return 'neutral';
  };

  // Used for the agent avatar icon color
  const typeColors: Record<string, string> = {
    claude: tokens.colors.accentLight,
    gpt: tokens.colors.successLight,
    custom: tokens.colors.info,
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <span style={{ fontSize: 13, color: tokens.colors.textMuted }}>{agents.length} agents</span>
        <Button variant="primary" onClick={() => { resetForm(); setShowForm(true); }}>+ Add Agent</Button>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
        gap: tokens.spacing.md,
      }}>
        {agents.map(agent => (
          <Card key={agent.id} padding={0} style={{ overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px' }}>
              <div style={{
                width: 32, height: 32, borderRadius: tokens.radii.lg,
                background: `${typeColors[agent.type] || tokens.colors.border}20`,
                border: `1px solid ${typeColors[agent.type] || tokens.colors.border}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '14px', fontWeight: 700, color: typeColors[agent.type] || tokens.colors.textSecondary,
              }}>AI</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '13px', fontWeight: 600, color: tokens.colors.textStrong }}>{agent.name}</div>
                <div style={{ fontSize: '11px', color: tokens.colors.textMuted }}>{agent.description || 'No description'}</div>
              </div>
              <Badge variant={agentTypeBadgeVariant(agent.type)}>{agent.type}</Badge>
              <Button variant="secondary" size="sm" onClick={() => setShowIdentityFor(showIdentityFor === agent.id ? null : agent.id)}>IDs</Button>
              <Button variant="secondary" size="sm" onClick={() => handleEdit(agent)}>Edit</Button>
              <Button variant="danger" size="sm" onClick={() => handleDelete(agent.id)}>Delete</Button>
            </div>

            {/* Channel Identities */}
            {(agent.channel_identities?.length > 0 || showIdentityFor === agent.id) && (
              <div style={{ padding: '0 12px 10px', borderTop: `1px solid ${tokens.colors.surfaceCard}` }}>
                <div style={{ fontSize: '11px', color: tokens.colors.textMuted, fontWeight: 600, margin: '8px 0 6px', textTransform: 'uppercase' }}>
                  Channel Identities
                </div>
                {(agent.channel_identities || []).map(identity => (
                  <div key={identity.id} style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px',
                    background: tokens.colors.surfaceCard, borderRadius: tokens.radii.sm, marginBottom: 4, fontSize: '12px',
                  }}>
                    <span style={{ color: tokens.colors.accentLight, fontWeight: 600 }}>{identity.channel_type}</span>
                    <span style={{ color: tokens.colors.textStrong }}>{identity.channel_external_id}</span>
                    {identity.display_name && <span style={{ color: tokens.colors.textMuted }}>({identity.display_name})</span>}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDeleteIdentity(identity.id)}
                      style={{ marginLeft: 'auto' }}
                    >x</Button>
                  </div>
                ))}

                {showIdentityFor === agent.id && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                    <div style={{ width: 120, flexShrink: 0 }}>
                      <Select
                        value={identityForm.channel_type}
                        onChange={e => setIdentityForm({ ...identityForm, channel_type: (e.target as HTMLSelectElement).value })}
                        options={[
                          { value: 'discord', label: 'Discord' },
                          { value: 'slack', label: 'Slack' },
                        ]}
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <Input
                        value={identityForm.channel_external_id}
                        onChange={e => setIdentityForm({ ...identityForm, channel_external_id: e.target.value })}
                        placeholder="External ID"
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <Input
                        value={identityForm.display_name}
                        onChange={e => setIdentityForm({ ...identityForm, display_name: e.target.value })}
                        placeholder="Display name"
                      />
                    </div>
                    <Button variant="primary" size="sm" onClick={() => handleAddIdentity(agent.id)}>Add</Button>
                  </div>
                )}
              </div>
            )}
          </Card>
        ))}
        {agents.length === 0 && (
          <div style={{ textAlign: 'center', padding: '48px 24px', gridColumn: '1 / -1' }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: tokens.colors.textPrimary, marginBottom: 8 }}>No agents yet</div>
            <div style={{ fontSize: 13, color: tokens.colors.textSecondary }}>Add your first agent to get started.</div>
          </div>
        )}
      </div>

      <Modal
        isOpen={showForm}
        onClose={resetForm}
        title={editingId ? 'Edit Agent' : 'Create Agent'}
        maxWidth={600}
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
              label="Name *"
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              placeholder="Agent name"
            />
            <Select
              label="Type"
              value={form.type}
              onChange={e => setForm({ ...form, type: (e.target as HTMLSelectElement).value })}
              options={[
                { value: 'claude', label: 'Claude' },
                { value: 'gpt', label: 'GPT' },
                { value: 'custom', label: 'Custom' },
              ]}
            />
          </div>
          <Input
            label="Description"
            value={form.description}
            onChange={e => setForm({ ...form, description: e.target.value })}
            placeholder="What does this agent do?"
          />
          {/* Role Prompt section — ROLE-02 / D-14 */}
          <div>
            <label style={{ fontSize: '11px', color: tokens.colors.textSecondary, fontWeight: 600, display: 'block', marginBottom: 6 }}>
              Role Prompt
            </label>
            <div style={{ fontSize: '11px', fontWeight: 400, color: tokens.colors.textMuted, marginBottom: 8, lineHeight: 1.5 }}>
              Markdown instructions delivered to this agent on every trigger. Persists across triggers and chat sessions.
            </div>
            <textarea
              value={form.role_prompt}
              onChange={e => setForm({ ...form, role_prompt: e.target.value })}
              placeholder="You are an agent responsible for..."
              style={{
                width: '100%',
                minHeight: 240,
                background: tokens.colors.surface,
                border: `1px solid ${tokens.colors.border}`,
                borderRadius: tokens.radii.md,
                padding: '10px 12px',
                color: tokens.colors.textStrong,
                fontSize: '12px',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                lineHeight: 1.5,
                resize: 'vertical',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
