import React, { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import PageHeader from './PageHeader';
import { tokens } from '../tokens';
import { Button, Select, Modal, Badge, Card } from './common';

interface WorkspaceMember {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  avatar_url: string;
  relation: 'member' | 'owner';
}

export default function WorkspaceUsersPage() {
  const { wsId } = useParams<{ wsId: string }>();
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [allUsers, setAllUsers] = useState<any[]>([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [selectedRelation, setSelectedRelation] = useState('member');

  const load = useCallback(async () => {
    if (!wsId) return;
    const data = await api.getWorkspaceMembers(wsId);
    setMembers(data);
  }, [wsId]);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    if (!wsId || !selectedUserId) return;
    await api.addWorkspaceMember(wsId, selectedUserId, selectedRelation);
    setShowAddModal(false);
    setSelectedUserId('');
    setSelectedRelation('member');
    await load();
  };

  const handleRemove = async (userId: string, userName: string) => {
    if (!wsId) return;
    if (!confirm(`Remove ${userName} from this workspace?`)) return;
    await api.removeWorkspaceMember(wsId, userId);
    await load();
  };

  const handleRoleChange = async (userId: string, newRelation: string) => {
    if (!wsId) return;
    await api.updateWorkspaceMemberRole(wsId, userId, newRelation);
    await load();
  };

  const openAddModal = async () => {
    const users = await api.getUsers();
    setAllUsers(users);
    setShowAddModal(true);
  };

  const memberIds = new Set(members.map(m => m.id));
  const nonMembers = allUsers.filter(u => !memberIds.has(u.id) && u.status === 'active');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <PageHeader
        title="Workspace Members"
        description="Manage who has access to this workspace"
        actions={
          <Button variant="primary" size="md" onClick={openAddModal}>+ Add Member</Button>
        }
      />

      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
        {/* Empty state */}
        {members.length === 0 && (
          <div style={{ textAlign: 'center', padding: '48px 24px' }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: tokens.colors.textPrimary }}>No members yet</h2>
            <p style={{ fontSize: 13, color: tokens.colors.textSecondary, marginTop: 8 }}>
              Add members to this workspace to collaborate.
            </p>
          </div>
        )}

        {/* Member card grid */}
        {members.length > 0 && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
            gap: 16,
          }}>
            {members.map(m => (
              <Card key={m.id} padding={16}>
                {/* Avatar */}
                <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 12 }}>
                  <div style={{
                    width: 40, height: 40, borderRadius: '50%',
                    background: m.relation === 'owner' ? tokens.colors.accent : tokens.colors.border,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '16px', fontWeight: 700, color: tokens.colors.textStrong, flexShrink: 0,
                  }}>{m.name.charAt(0).toUpperCase()}</div>
                </div>

                {/* Name and email */}
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: tokens.colors.textPrimary, marginBottom: 2 }}>
                    {m.name}
                  </div>
                  <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>
                    {m.email || 'No email'}
                  </div>
                </div>

                {/* Badges */}
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                  <Badge variant={m.role === 'admin' ? 'info' : 'neutral'}>{m.role}</Badge>
                  <Badge variant={m.relation === 'owner' ? 'warning' : 'neutral'}>{m.relation}</Badge>
                </div>

                {/* Action buttons */}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <select
                    value={m.relation}
                    onChange={e => handleRoleChange(m.id, e.target.value)}
                    style={{
                      flex: 1, background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`,
                      borderRadius: tokens.radii.sm, padding: '4px 8px',
                      color: m.relation === 'owner' ? tokens.colors.accentLight : tokens.colors.textStrong,
                      fontSize: '11px', cursor: 'pointer', fontWeight: 600,
                    }}
                  >
                    <option value="member">Member</option>
                    <option value="owner">Owner</option>
                  </select>
                  <Button variant="danger" size="sm" onClick={() => handleRemove(m.id, m.name)}>Remove</Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Add member modal */}
      <Modal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        title="Add Member to Workspace"
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="secondary" onClick={() => setShowAddModal(false)}>Cancel</Button>
            {nonMembers.length > 0 && (
              <Button variant="primary" onClick={handleAdd} disabled={!selectedUserId}>Add</Button>
            )}
          </div>
        }
      >
        {nonMembers.length === 0 ? (
          <div style={{ color: tokens.colors.textMuted, fontSize: 13 }}>
            All active users are already members of this workspace.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Select
              label="User"
              value={selectedUserId}
              onChange={e => setSelectedUserId(e.target.value)}
              placeholder="Select user..."
              options={nonMembers.map(u => ({ value: u.id, label: `${u.name} (${u.email})` }))}
            />
            <Select
              label="Role"
              value={selectedRelation}
              onChange={e => setSelectedRelation(e.target.value)}
              options={[{ value: 'member', label: 'Member' }, { value: 'owner', label: 'Owner' }]}
            />
          </div>
        )}
      </Modal>
    </div>
  );
}
