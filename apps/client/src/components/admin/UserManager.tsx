import React, { useState, useEffect } from 'react';
import { api } from '../../api';
import { User, PermissionMeta } from '../../types';
import { tokens } from '../../tokens';
import { Button, Input, Select, Badge, Modal, Card } from '../common';

interface PermissionInfo {
  permissions: Record<string, PermissionMeta>;
  role_defaults: Record<string, string[]>;
}

interface PendingUser {
  id: string;
  name: string;
  email: string;
  status: 'pending';
  requested_workspace_name: string | null;
  created_at: string;
}

export default function UserManager({ workspaceId }: { workspaceId?: string } = {}) {
  const [users, setUsers] = useState<User[]>([]);
  const [pendingUsers, setPendingUsers] = useState<PendingUser[]>([]);
  const [workspaces, setWorkspaces] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: '', email: '', role: 'user', discord_user_id: '',
    password: '', permissions: [] as string[],
  });
  const [permInfo, setPermInfo] = useState<PermissionInfo | null>(null);
  const [showPerms, setShowPerms] = useState(false);
  // Track which approved users are showing workspace assignment UI
  const [assigningWorkspace, setAssigningWorkspace] = useState<Record<string, string>>({});

  const load = async () => {
    const [usersData, permData, pendingData, workspacesData] = await Promise.all([
      api.getUsers(workspaceId),
      api.getPermissionsMeta(),
      workspaceId ? Promise.resolve([]) : api.getPendingUsers(),
      api.getWorkspaces(),
    ]);
    setUsers(usersData);
    setPermInfo(permData);
    // PendingUsersController returns { users: [...] }, not a bare array.
    // Without this unwrap pendingUsers.length is undefined → falsy → the
    // "Pending Approval" section never renders even when accounts await
    // approval. api.getPendingUsers is typed as `any` so TS doesn't catch it.
    setPendingUsers(Array.isArray(pendingData) ? pendingData : (pendingData?.users ?? []));
    setWorkspaces(workspacesData);
  };

  useEffect(() => { load(); }, [workspaceId]);

  const resetForm = () => {
    setForm({ name: '', email: '', role: 'user', discord_user_id: '', password: '', permissions: [] });
    setEditingId(null);
    setShowForm(false);
    setShowPerms(false);
  };

  const handleSave = async () => {
    if (!form.name.trim()) return;
    const data: any = {
      name: form.name, email: form.email, role: form.role,
      discord_user_id: form.discord_user_id, permissions: form.permissions,
    };
    if (form.password) data.password = form.password;

    if (editingId) {
      await api.updateUser(editingId, data);
    } else {
      await api.createUser(data);
    }
    resetForm();
    await load();
  };

  const handleEdit = (user: User) => {
    let customPerms: string[] = [];
    try { customPerms = JSON.parse(user.permissions || '[]'); } catch { /* ignore */ }
    setForm({
      name: user.name, email: user.email, role: user.role,
      discord_user_id: user.discord_user_id, password: '', permissions: customPerms,
    });
    setEditingId(user.id);
    setShowForm(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this user?')) return;
    await api.deleteUser(id);
    await load();
  };

  const handleApprove = async (id: string) => {
    await api.approveUser(id);
    setPendingUsers(prev => prev.filter(u => u.id !== id));
    await load();
  };

  const handleReject = async (id: string) => {
    await api.rejectUser(id);
    setPendingUsers(prev => prev.filter(u => u.id !== id));
    await load();
  };

  const handleAssignWorkspace = async (userId: string, workspaceId: string) => {
    if (!workspaceId) return;
    await api.assignUserWorkspace(userId, workspaceId);
    setAssigningWorkspace(prev => {
      const next = { ...prev };
      delete next[userId];
      return next;
    });
    await load();
  };

  const togglePermission = (perm: string) => {
    setForm(f => ({
      ...f,
      permissions: f.permissions.includes(perm)
        ? f.permissions.filter(p => p !== perm)
        : [...f.permissions, perm],
    }));
  };

  // 현재 role의 기본 권한
  const roleDefaults = permInfo?.role_defaults[form.role] || [];

  // 권한을 그룹별로 분류
  const permGroups: Record<string, { key: string; meta: PermissionMeta }[]> = {};
  if (permInfo) {
    for (const [key, meta] of Object.entries(permInfo.permissions)) {
      if (!permGroups[meta.group]) permGroups[meta.group] = [];
      permGroups[meta.group].push({ key, meta });
    }
  }

  const activeUsers = users.filter(u => u.status !== 'pending');

  const renderPendingUserRow = (user: PendingUser) => (
    <Card key={user.id} padding="10px 12px">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{
          width: 32, height: 32, borderRadius: '50%',
          background: tokens.colors.warningBg,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '13px', fontWeight: 700, color: tokens.colors.textStrong,
        }}>{user.name.charAt(0).toUpperCase()}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '13px', fontWeight: 600, color: tokens.colors.textStrong }}>{user.name}</div>
          <div style={{ fontSize: '11px', color: tokens.colors.textMuted }}>
            {user.email || 'No email'} &middot; {new Date(user.created_at).toLocaleDateString()}
          </div>
          <div style={{ fontSize: '11px', color: tokens.colors.textSecondary, marginTop: 2 }}>
            Requested workspace: <span style={{ color: user.requested_workspace_name ? tokens.colors.textStrong : tokens.colors.borderStrong }}>
              {user.requested_workspace_name || 'None'}
            </span>
          </div>
        </div>
        <Badge variant="warning">{user.status}</Badge>
        {/* Workspace assignment dropdown for approve flow */}
        <Select
          value={assigningWorkspace[user.id] || ''}
          onChange={e => setAssigningWorkspace(prev => ({ ...prev, [user.id]: (e.target as HTMLSelectElement).value }))}
          placeholder="Assign workspace..."
          options={workspaces.map((ws: any) => ({ value: ws.id, label: ws.name }))}
          style={{ width: 160 }}
        />
        <Button
          variant="primary"
          size="sm"
          onClick={async () => {
            await handleApprove(user.id);
            if (assigningWorkspace[user.id]) {
              await handleAssignWorkspace(user.id, assigningWorkspace[user.id]);
            }
          }}
        >Approve</Button>
        <Button variant="danger" size="sm" onClick={() => handleReject(user.id)}>Reject</Button>
      </div>
    </Card>
  );

  const renderUserRow = (user: User) => (
    <Card key={user.id} padding="12px 14px">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <div style={{
          width: 36, height: 36, borderRadius: '50%',
          background: user.role === 'admin' ? tokens.colors.accent : tokens.colors.border,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 14, fontWeight: 700, color: tokens.colors.textStrong, flexShrink: 0,
        }}>{user.name.charAt(0).toUpperCase()}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: tokens.colors.textStrong }}>{user.name}</div>
          <div style={{ fontSize: 11, color: tokens.colors.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {user.email || 'No email'}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        <Badge variant={user.role === 'admin' ? 'info' : 'neutral'}>{user.role}</Badge>
        <Badge variant={user.status === 'active' ? 'success' : user.status === 'pending' ? 'warning' : 'danger'}>{user.status}</Badge>
      </div>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <Button variant="secondary" size="sm" onClick={() => handleEdit(user)}>Edit</Button>
        <Button variant="danger" size="sm" onClick={() => handleDelete(user.id)}>Delete</Button>
      </div>
    </Card>
  );

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <span style={{ fontSize: 13, color: tokens.colors.textMuted }}>{users.length} users</span>
        <Button variant="primary" size="md" onClick={() => { resetForm(); setShowForm(true); }}>+ Add User</Button>
      </div>

      {/* Pending Users Section — dedicated API call for requested_workspace_name */}
      {pendingUsers.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <h4 style={{
            fontSize: '13px', fontWeight: 600, color: tokens.colors.warningLight, marginBottom: 8,
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <Badge variant="warning" dot />
            Pending Approval ({pendingUsers.length})
          </h4>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
            gap: tokens.spacing.md,
          }}>
            {pendingUsers.map(user => renderPendingUserRow(user))}
          </div>
        </div>
      )}

      {/* Active Users Section */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
        gap: tokens.spacing.md,
      }}>
        {activeUsers.map(user => renderUserRow(user))}
        {users.length === 0 && pendingUsers.length === 0 && (
          <div style={{ textAlign: 'center', padding: '48px 24px', gridColumn: '1 / -1' }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: tokens.colors.textPrimary, marginBottom: 8 }}>No users yet</div>
            <div style={{ fontSize: 13, color: tokens.colors.textSecondary }}>Add your first user to get started.</div>
          </div>
        )}
      </div>

      {/* Create / Edit User Modal */}
      <Modal
        isOpen={showForm}
        onClose={resetForm}
        title={editingId ? 'Edit User' : 'Create User'}
        maxWidth={560}
        footer={
          <>
            <Button variant="secondary" onClick={resetForm}>Cancel</Button>
            <Button variant="primary" onClick={handleSave}>{editingId ? 'Update' : 'Create'}</Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing.sm }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input
              label="Name *"
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              placeholder="User name"
            />
            <Input
              label="Email"
              value={form.email}
              onChange={e => setForm({ ...form, email: e.target.value })}
              placeholder="email@example.com"
            />
            <Input
              label={`Password${editingId ? ' (leave empty to keep)' : ''}`}
              type="password"
              value={form.password}
              onChange={e => setForm({ ...form, password: e.target.value })}
              placeholder={editingId ? 'Unchanged' : 'Set password'}
            />
            <Select
              label="Role"
              value={form.role}
              onChange={e => setForm({ ...form, role: (e.target as HTMLSelectElement).value })}
              options={[{ value: 'user', label: 'User' }, { value: 'admin', label: 'Admin' }]}
            />
            <Input
              label="Discord User ID"
              value={form.discord_user_id}
              onChange={e => setForm({ ...form, discord_user_id: e.target.value })}
              placeholder="123456789"
            />
          </div>

          {/* Permissions Section */}
          <div>
            <Button variant="ghost" size="sm" onClick={() => setShowPerms(!showPerms)}>
              {showPerms ? 'Hide' : 'Show'} Custom Permissions
              {form.permissions.length > 0 && ` (${form.permissions.length} custom)`}
            </Button>

            {showPerms && permInfo && (
              <div style={{
                marginTop: 10, background: tokens.colors.surfaceCard, borderRadius: tokens.radii.md,
                border: `1px solid ${tokens.colors.border}`, padding: 12,
              }}>
                <div style={{ fontSize: '11px', color: tokens.colors.textMuted, marginBottom: 10 }}>
                  Role "{form.role}" includes {roleDefaults.length} default permissions.
                  Add custom permissions below to extend access.
                </div>
                {Object.entries(permGroups).map(([group, perms]) => (
                  <div key={group} style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: '10px', fontWeight: 700, color: tokens.colors.borderStrong, textTransform: 'uppercase', marginBottom: 4 }}>{group}</div>
                    {perms.map(({ key, meta }) => {
                      const isRoleDefault = roleDefaults.includes(key);
                      const isCustom = form.permissions.includes(key);
                      const isActive = isRoleDefault || isCustom;
                      return (
                        <label key={key} style={{
                          display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0',
                          cursor: isRoleDefault ? 'default' : 'pointer', opacity: isRoleDefault ? 0.6 : 1,
                        }}>
                          <input
                            type="checkbox"
                            checked={isActive}
                            disabled={isRoleDefault}
                            onChange={() => !isRoleDefault && togglePermission(key)}
                            style={{ accentColor: tokens.colors.accent }}
                          />
                          <span style={{ fontSize: '12px', color: isActive ? tokens.colors.textStrong : tokens.colors.textMuted }}>
                            {meta.label}
                            {isRoleDefault && <span style={{ fontSize: '10px', color: tokens.colors.borderStrong, marginLeft: 4 }}>(role default)</span>}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
}
