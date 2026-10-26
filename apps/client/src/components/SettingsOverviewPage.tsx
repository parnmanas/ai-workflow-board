import { t as translate } from '../i18n/core';
import { useLocale } from '../i18n/react';
import LanguageSelect from './LanguageSelect';
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { tokens } from '../tokens';
import PageHeader from './PageHeader';
import ServerConfigField, { PwaInstallButton } from './ServerConfigField';
import AndroidVoiceCard from './AndroidVoiceCard';
import ApkDownloadButton from './ApkDownloadButton';

interface SettingsDestination {
  title: string;
  description: string;
  path: string;
  icon: string;
  adminOnly?: boolean;
}

interface SettingsGroup {
  title: string;
  description: string;
  items: SettingsDestination[];
}

export default function SettingsOverviewPage() {
  useLocale();
  const { currentAccountId } = useAuth();
  const accountId = currentAccountId || '';
  const { hasPermission } = useAuth();
  const navigate = useNavigate();
  const isAdmin = hasPermission('admin.access');

  const groups: SettingsGroup[] = [
    {
      title: 'Account',
      description: translate('Your work defaults and login-user administration.'),
      items: [
        {
          title: translate('Work defaults'),
          description: translate('Ticket dispatch, agent response language, harness and clone policy defaults.'),
          path: `/settings/defaults`,
          icon: 'W',
        },
        {
          title: translate('Login users'),
          description: translate('Approve or disable login users. Each user has a personal account.'),
          path: `/settings/users`,
          icon: 'M',
          adminOnly: true,
        },
      ],
    },
    {
      title: 'Connections & secrets',
      description: translate('Credentials and external connections used by agents and notifications.'),
      items: [
        {
          title: translate('Credentials'),
          description: translate('Global and account credentials used by resources and agents.'),
          path: `/settings/credentials`,
          icon: 'C',
        },
        {
          title: translate('Channels'),
          description: translate('Notification channels connected to this account.'),
          path: `/settings/channels`,
          icon: 'N',
        },
        {
          title: translate('API Keys'),
          description: translate('MCP API keys for agents and external clients.'),
          path: `/settings/api-keys`,
          icon: 'K',
        },
        {
          title: translate('Claude Profiles'),
          description: translate('Claude backend definitions and account settings.'),
          path: `/settings/claude-profiles`,
          icon: 'C',
        },
      ],
    },
    {
      title: 'Administration',
      description: translate('Instance-wide accounts and platform configuration.'),
      items: [
        {
          title: translate('User Administration'),
          description: translate('Approve and manage user accounts across the instance.'),
          path: '/admin/users',
          icon: 'U',
          adminOnly: true,
        },
        {
          title: translate('System Settings'),
          description: translate('Embedding, MCP session, and self-improvement configuration.'),
          path: '/admin/settings',
          icon: 'S',
          adminOnly: true,
        },
        {
          title: translate('Live Import'),
          description: translate('Pull this instance\'s data from a live source AWB server.'),
          path: '/admin/migration',
          icon: 'M',
          adminOnly: true,
        },
      ],
    },
  ];

  const visibleGroups = groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !item.adminOnly || isAdmin),
    }))
    .filter((group) => group.items.length > 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader
        title={translate('Settings')}
        description={translate('Account access, connections, agent defaults, and system administration')}
      />
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: 24 }}>
        <div style={{ maxWidth: 1040, display: 'flex', flexDirection: 'column', gap: 28 }}>
          {/* PWA 기기 설정 — 계정 소유와 무관한 이 단말만의 선택 */}
          <section aria-labelledby="settings-device">
            <h2
              id="settings-device"
              style={{ margin: 0, fontSize: 15, fontWeight: 700, color: tokens.colors.textPrimary }}
            >
              {translate('Device')}</h2>
            <p style={{ margin: '4px 0 12px', fontSize: 12, color: tokens.colors.textMuted }}>
              {translate('Language, server connection and app installation for this browser. Language changes also apply to other tabs on this site.')}</p>
            <div style={{
              background: tokens.colors.surfaceCard,
              border: `1px solid ${tokens.colors.border}`,
              borderRadius: tokens.radii.lg,
              padding: 16,
              display: 'flex', flexDirection: 'column', gap: 12,
              maxWidth: 560,
            }}>
              <LanguageSelect />
              <ServerConfigField />
              <div style={{
                borderTop: `1px solid ${tokens.colors.border}`,
                paddingTop: 12, display: 'flex', alignItems: 'center', gap: 12,
              }}>
                <PwaInstallButton />
                <span style={{ fontSize: 11, color: tokens.colors.textMuted, lineHeight: 1.5 }}>
                  {translate('알림은 사이드바 🔔에서, 음성 지원은 OPERATORS 👂에서 켭니다. 화면이 꺼지면 마이크도 멈추니 웨이크용 단말은 충전기에 꽂아 두세요.')}</span>
              </div>
              <div style={{
                borderTop: `1px solid ${tokens.colors.border}`,
                paddingTop: 12,
              }}>
                <ApkDownloadButton />
              </div>
            </div>
            <AndroidVoiceCard />
          </section>
          {visibleGroups.map((group) => (
            <section key={group.title} aria-labelledby={`settings-${group.title.replace(/\W+/g, '-').toLowerCase()}`}>
              <h2
                id={`settings-${group.title.replace(/\W+/g, '-').toLowerCase()}`}
                style={{ margin: 0, fontSize: 15, fontWeight: 700, color: tokens.colors.textPrimary }}
              >
                {translate(group.title)}
              </h2>
              <p style={{ margin: '4px 0 12px', fontSize: 12, color: tokens.colors.textMuted }}>
                {group.description}
              </p>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
                  gap: 12,
                }}
              >
                {group.items.map((item) => (
                  <button
                    key={item.path}
                    type="button"
                    onClick={() => navigate(item.path)}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 12,
                      minHeight: 96,
                      padding: 16,
                      textAlign: 'left',
                      background: tokens.colors.surfaceCard,
                      border: `1px solid ${tokens.colors.border}`,
                      borderRadius: tokens.radii.lg,
                      color: tokens.colors.textPrimary,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                    onMouseEnter={(event) => {
                      event.currentTarget.style.borderColor = tokens.colors.borderStrong;
                      event.currentTarget.style.background = tokens.colors.surfaceHover;
                    }}
                    onMouseLeave={(event) => {
                      event.currentTarget.style.borderColor = tokens.colors.border;
                      event.currentTarget.style.background = tokens.colors.surfaceCard;
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        width: 34,
                        height: 34,
                        borderRadius: tokens.radii.md,
                        background: `${tokens.colors.accent}20`,
                        color: tokens.colors.accentLight,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 13,
                        fontWeight: 700,
                        flexShrink: 0,
                      }}
                    >
                      {item.icon}
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 13, fontWeight: 700 }}>
                        {item.title}
                      </span>
                      <span
                        style={{
                          display: 'block',
                          marginTop: 4,
                          fontSize: 12,
                          lineHeight: 1.45,
                          color: tokens.colors.textMuted,
                        }}
                      >
                        {item.description}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
