import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { tokens } from '../tokens';
import PageHeader from './PageHeader';

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
  const { wsId = '' } = useParams<{ wsId: string }>();
  const { hasPermission } = useAuth();
  const navigate = useNavigate();
  const isAdmin = hasPermission('admin.access');

  const groups: SettingsGroup[] = [
    {
      title: 'Workspace',
      description: 'Identity, agent defaults, and access rules for this workspace.',
      items: [
        {
          title: 'Workspace Settings',
          description: 'Assistant agent and default agent harness configuration.',
          path: `/ws/${wsId}/settings/workspace`,
          icon: 'W',
          adminOnly: true,
        },
        {
          title: 'Members',
          description: 'People who can access this workspace.',
          path: `/ws/${wsId}/settings/members`,
          icon: 'M',
        },
        {
          title: 'Roles',
          description: 'Workflow roles, prompts, and role ordering.',
          path: `/ws/${wsId}/settings/roles`,
          icon: 'R',
        },
      ],
    },
    {
      title: 'Connections & secrets',
      description: 'Credentials and external connections used by agents and notifications.',
      items: [
        {
          title: 'Credentials',
          description: 'Global and workspace credentials used by resources and agents.',
          path: `/ws/${wsId}/settings/credentials`,
          icon: 'C',
        },
        {
          title: 'Channels',
          description: 'Notification channels connected to this workspace.',
          path: `/ws/${wsId}/settings/channels`,
          icon: 'N',
        },
        {
          title: 'API Keys',
          description: 'MCP API keys for agents and external clients.',
          path: `/ws/${wsId}/settings/api-keys`,
          icon: 'K',
        },
        {
          title: 'Claude Profiles',
          description: 'Claude backend definitions and workspace assignment.',
          path: `/ws/${wsId}/settings/claude-profiles`,
          icon: 'C',
        },
      ],
    },
    {
      title: 'Administration',
      description: 'Instance-wide accounts and platform configuration.',
      items: [
        {
          title: 'User Administration',
          description: 'Approve and manage user accounts across the instance.',
          path: '/admin/users',
          icon: 'U',
          adminOnly: true,
        },
        {
          title: 'System Settings',
          description: 'Embedding, MCP session, and self-improvement configuration.',
          path: '/admin/settings',
          icon: 'S',
          adminOnly: true,
        },
        {
          title: 'Live Import',
          description: 'Pull this instance\'s data from a live source AWB server.',
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
        title="Settings"
        description="Workspace access, connections, agent defaults, and system administration"
      />
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: 24 }}>
        <div style={{ maxWidth: 1040, display: 'flex', flexDirection: 'column', gap: 28 }}>
          {visibleGroups.map((group) => (
            <section key={group.title} aria-labelledby={`settings-${group.title.replace(/\W+/g, '-').toLowerCase()}`}>
              <h2
                id={`settings-${group.title.replace(/\W+/g, '-').toLowerCase()}`}
                style={{ margin: 0, fontSize: 15, fontWeight: 700, color: tokens.colors.textPrimary }}
              >
                {group.title}
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
