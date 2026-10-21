import React from 'react';
import { useAuth } from '../contexts/AuthContext';
import PageHeader from './PageHeader';
import UserManager from './admin/UserManager';
import { PermissionNotice } from './common';

export default function UsersPage() {
  const { hasPermission } = useAuth();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <PageHeader title="Users" />
      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
        {hasPermission('admin.users') ? <UserManager /> : (
          <PermissionNotice title="User management permission required" message="Ask an administrator to manage users." />
        )}
      </div>
    </div>
  );
}
