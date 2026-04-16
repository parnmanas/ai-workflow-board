import React, { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import UserManager from './UserManager';
import AgentManager from './AgentManager';
import AgentSessionDashboard from './AgentSessionDashboard';
import ChannelManager from './ChannelManager';
import ApiKeyManager from './ApiKeyManager';
import QaRunner from './QaRunner';
import { tokens } from '../../tokens';

interface AdminPanelProps {
  onClose: () => void;
}

interface TabConfig {
  key: string;
  label: string;
  permission: string;
  icon: string;
}

const allTabs: TabConfig[] = [
  { key: 'users', label: 'Users', permission: 'admin.users', icon: 'U' },
  { key: 'agents', label: 'AI Agents', permission: 'admin.agents', icon: 'A' },
  { key: 'session', label: 'Sessions', permission: 'admin.agents', icon: 'S' },
  { key: 'channels', label: 'Channels', permission: 'admin.channels', icon: 'C' },
  { key: 'apikeys', label: 'API Keys', permission: 'admin.api_keys', icon: 'K' },
  { key: 'qa', label: 'QA Tests', permission: 'admin.access', icon: 'Q' },
];

export default function AdminPanel({ onClose }: AdminPanelProps) {
  const { hasPermission, user, logout } = useAuth();

  // 사용자가 접근 가능한 탭만 필터
  const availableTabs = allTabs.filter(t => hasPermission(t.permission));
  const [activeTab, setActiveTab] = useState(availableTabs[0]?.key || 'users');

  const renderContent = () => {
    switch (activeTab) {
      case 'users': return <UserManager />;
      case 'agents': return <AgentManager />;
      case 'session': return <AgentSessionDashboard />;
      case 'channels': return <ChannelManager />;
      case 'apikeys': return <ApiKeyManager />;
      case 'qa': return <QaRunner />;
      default: return <div style={{ color: tokens.colors.textMuted, fontSize: '13px' }}>Select a tab</div>;
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', justifyContent: 'center', alignItems: 'flex-start',
      paddingTop: '3vh', zIndex: 1000, overflowY: 'auto',
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: tokens.colors.surfaceCard, borderRadius: 12, width: '100%', maxWidth: 900,
        maxHeight: '92vh', overflowY: 'auto', border: `1px solid ${tokens.colors.border}`,
        boxShadow: tokens.shadows.overlay,
        display: 'flex', flexDirection: 'column',
      }}>
        {/* Header */}
        <div style={{
          padding: '16px 20px', borderBottom: `1px solid ${tokens.colors.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexShrink: 0,
        }}>
          <div>
            <h2 style={{ fontSize: '18px', fontWeight: 700, color: tokens.colors.textPrimary }}>Admin Settings</h2>
            {user && (
              <div style={{ fontSize: '11px', color: tokens.colors.textMuted, marginTop: 2 }}>
                Logged in as <span style={{ color: tokens.colors.accentLight }}>{user.name}</span>
                <span style={{
                  fontSize: '9px', fontWeight: 600, padding: '1px 6px', borderRadius: 3,
                  background: user.role === 'admin' ? `${tokens.colors.accent}20` : `${tokens.colors.border}40`,
                  color: user.role === 'admin' ? tokens.colors.accentLight : tokens.colors.textSecondary,
                  textTransform: 'uppercase', marginLeft: 6,
                }}>{user.role}</span>
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button onClick={async () => { await logout(); onClose(); }} style={{
              background: 'transparent', color: tokens.colors.textMuted, border: `1px solid ${tokens.colors.border}`,
              borderRadius: tokens.radii.md, padding: '4px 12px', fontSize: '11px', cursor: 'pointer',
            }}>Logout</button>
            <button onClick={onClose} style={{
              background: tokens.colors.border, color: tokens.colors.textStrong, border: 'none', borderRadius: tokens.radii.md,
              padding: '4px 12px', fontSize: '16px', cursor: 'pointer',
            }}>x</button>
          </div>
        </div>

        {/* Sidebar + Content Layout */}
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* Sidebar */}
          <div style={{
            width: 180, borderRight: `1px solid ${tokens.colors.border}`, padding: '12px 0',
            flexShrink: 0, overflowY: 'auto',
          }}>
            {availableTabs.map(tab => (
              <button key={tab.key} onClick={() => setActiveTab(tab.key)} style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                padding: '10px 16px', background: activeTab === tab.key ? tokens.colors.border : 'transparent',
                border: 'none', borderLeft: activeTab === tab.key ? `2px solid ${tokens.colors.accent}` : '2px solid transparent',
                color: activeTab === tab.key ? tokens.colors.textStrong : tokens.colors.textMuted,
                fontSize: '13px', fontWeight: activeTab === tab.key ? 600 : 400,
                cursor: 'pointer', transition: 'all 0.15s', textAlign: 'left',
              }}>
                <span style={{
                  width: 24, height: 24, borderRadius: tokens.radii.md,
                  background: activeTab === tab.key ? tokens.colors.accent : `${tokens.colors.border}60`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '11px', fontWeight: 700, color: activeTab === tab.key ? 'white' : tokens.colors.textMuted,
                  flexShrink: 0,
                }}>{tab.icon}</span>
                {tab.label}
              </button>
            ))}
          </div>

          {/* Content */}
          <div style={{ flex: 1, padding: 20, overflowY: 'auto', maxHeight: 'calc(92vh - 80px)' }}>
            {renderContent()}
          </div>
        </div>
      </div>
    </div>
  );
}
