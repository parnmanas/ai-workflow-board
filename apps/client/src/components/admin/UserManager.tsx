import { getLocaleTag } from '../../i18n/core';
import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React, { useState, useEffect } from 'react';
import { api } from '../../api';
import { User, PermissionMeta } from '../../types';
import { tokens } from '../../tokens';
import { Button, Input, Select, Badge, Modal, Card } from '../common';
import { useNotifications } from '../../contexts/NotificationContext';
import { useConfirm } from '../../contexts/ConfirmContext';

interface PermissionInfo {
  permissions: Record<string, PermissionMeta>;
  role_defaults: Record<string, string[]>;
}

interface PendingUser {
  id: string;
  name: string;
  email: string;
  status: 'pending';
  created_at: string;
}

export default function UserManager({ accountId }: { accountId?: string } = {}) {
  useLocale();
  const confirm = useConfirm();
  const [users, setUsers] = useState<User[]>([]);
  const [pendingUsers, setPendingUsers] = useState<PendingUser[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: '', email: '', role: 'user', discord_user_id: '',
    password: '', permissions: [] as string[],
  });
  const [permInfo, setPermInfo] = useState<PermissionInfo | null>(null);
  const [showPerms, setShowPerms] = useState(false);

  const load = async () => {
    const [usersData, permData, pendingData] = await Promise.all([
      api.getUsers(accountId),
      api.getPermissionsMeta(),
      accountId ? Promise.resolve([]) : api.getPendingUsers(),
    ]);
    setUsers(usersData);
    setPermInfo(permData);
    // PendingUsersController returns { users: [...] }, not a bare array.
    // Without this unwrap pendingUsers.length is undefined → falsy → the
    // "Pending Approval" section never renders even when accounts await
    // approval. api.getPendingUsers is typed as `any` so TS doesn't catch it.
    setPendingUsers(Array.isArray(pendingData) ? pendingData : (pendingData?.users ?? []));
  };

  // The pending-users badge is a live count of accounts still awaiting a
  // decision — not a "have you seen it?" marker. Zeroing it on page-open made
  // the badge vanish and then come back on the next 60 s poll while the queue
  // was still full. It now clears only when the queue actually empties, which
  // the approve/reject handlers force via refreshBadges().
  const { refresh: refreshBadges } = useNotifications();
  useEffect(() => { load(); }, [accountId]);

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
    const ok = await confirm({ title: translate('Delete user'), message: translate('Delete this user?') });
    if (!ok) return;
    await api.deleteUser(id);
    await load();
  };

  const handleApprove = async (id: string) => {
    await api.approveUser(id);
    setPendingUsers(prev => prev.filter(u => u.id !== id));
    await load();
    refreshBadges();
  };

  const handleReject = async (id: string) => {
    await api.rejectUser(id);
    setPendingUsers(prev => prev.filter(u => u.id !== id));
    await load();
    refreshBadges();
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
            {user.email || translate('No email')} {translate('·')} {new Date(user.created_at).toLocaleDateString(getLocaleTag())}
          </div>
        </div>
        <Badge variant="warning">{user.status}</Badge>
        <Button
          variant="primary"
          size="sm"
          onClick={() => handleApprove(user.id)}
        >{translate('Approve')}</Button>
        <Button variant="danger" size="sm" onClick={() => handleReject(user.id)}>{translate('Reject')}</Button>
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
            {user.email || translate('No email')}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        <Badge variant={user.role === 'admin' ? 'info' : 'neutral'}>{user.role}</Badge>
        <Badge variant={user.status === 'active' ? 'success' : user.status === 'pending' ? 'warning' : 'danger'}>{user.status}</Badge>
      </div>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <Button variant="secondary" size="sm" onClick={() => handleEdit(user)}>{translate('Edit')}</Button>
        <Button variant="danger" size="sm" onClick={() => handleDelete(user.id)}>{translate('Delete')}</Button>
      </div>
    </Card>
  );

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <span style={{ fontSize: 13, color: tokens.colors.textMuted }}>{users.length} {translate('users')}</span>
        <Button variant="primary" size="md" onClick={() => { resetForm(); setShowForm(true); }}>{translate('+ Add User')}</Button>
      </div>

      {/* Pending Users Section */}
      {pendingUsers.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <h4 style={{
            fontSize: '13px', fontWeight: 600, color: tokens.colors.warningLight, marginBottom: 8,
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <Badge variant="warning" dot />
            {translate('Pending Approval (')}{pendingUsers.length})
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
            <div style={{ fontSize: 18, fontWeight: 700, color: tokens.colors.textPrimary, marginBottom: 8 }}>{translate('No users yet')}</div>
            <div style={{ fontSize: 13, color: tokens.colors.textSecondary }}>{translate('Add your first user to get started.')}</div>
          </div>
        )}
      </div>

      {/* Create / Edit User Modal */}
      <Modal
        isOpen={showForm}
        onClose={resetForm}
        title={editingId ? translate('Edit User') : translate('Create User')}
        maxWidth={560}
        footer={
          <>
            <Button variant="secondary" onClick={resetForm}>{translate('Cancel')}</Button>
            <Button variant="primary" onClick={handleSave}>{editingId ? translate('Update') : translate('Create')}</Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing.sm }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input
              label={translate('Name *')}
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              placeholder={translate('User name')}
            />
            <Input
              label={translate('Email')}
              value={form.email}
              onChange={e => setForm({ ...form, email: e.target.value })}
              placeholder="email@example.com"
            />
            <Input
              label={translate('Password{0}', { 0: editingId ? translate(' (leave empty to keep)') : '' })}
              type="password"
              value={form.password}
              onChange={e => setForm({ ...form, password: e.target.value })}
              placeholder={editingId ? translate('Unchanged') : translate('Set password')}
            />
            <Select
              label={translate('Role')}
              value={form.role}
              onChange={e => setForm({ ...form, role: (e.target as HTMLSelectElement).value })}
              options={[{ value: 'user', label: translate('User') }, { value: 'admin', label: translate('Admin') }]}
            />
            <Input
              label={translate('Discord User ID')}
              value={form.discord_user_id}
              onChange={e => setForm({ ...form, discord_user_id: e.target.value })}
              placeholder="123456789"
            />
          </div>

          {/* Permissions Section */}
          <div>
            <Button variant="ghost" size="sm" onClick={() => setShowPerms(!showPerms)}>
              {showPerms ? translate('Hide') : translate('Show')} {translate('Custom Permissions')}{form.permissions.length > 0 && translate(' ({0} custom)', { 0: form.permissions.length })}
            </Button>

            {showPerms && permInfo && (
              <div style={{
                marginTop: 10, background: tokens.colors.surfaceCard, borderRadius: tokens.radii.md,
                border: `1px solid ${tokens.colors.border}`, padding: 12,
              }}>
                <div style={{ fontSize: '11px', color: tokens.colors.textMuted, marginBottom: 10 }}>
                  {translate('Role "')}{form.role}{translate('" includes')} {roleDefaults.length} {translate('default permissions. Add custom permissions below to extend access.')}</div>
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
                            {isRoleDefault && <span style={{ fontSize: '10px', color: tokens.colors.borderStrong, marginLeft: 4 }}>{translate('(role default)')}</span>}
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
