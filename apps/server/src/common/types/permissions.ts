export const PERMISSIONS = {
  ADMIN_ACCESS: 'admin.access',
  MANAGE_USERS: 'admin.users',
  MANAGE_AGENTS: 'admin.agents',
  MANAGE_CHANNELS: 'admin.channels',
  MANAGE_API_KEYS: 'admin.api_keys',
  MANAGE_PROMPT_TEMPLATES: 'admin.prompt_templates',
  MANAGE_RESOURCES: 'admin.resources',
  MANAGE_CREDENTIALS: 'admin.credentials',
  MANAGE_BOARDS: 'boards.manage',
  CREATE_TICKETS: 'tickets.create',
  EDIT_TICKETS: 'tickets.edit',
  DELETE_TICKETS: 'tickets.delete',
  VIEW_ACTIVITY: 'activity.view',
  CHAT_SEND: 'chat.send',
  CHAT_VIEW: 'chat.view',
} as const;

export type Permission = typeof PERMISSIONS[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS = Object.values(PERMISSIONS);

export const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  admin: [...ALL_PERMISSIONS],
  user: [
    PERMISSIONS.CREATE_TICKETS,
    PERMISSIONS.EDIT_TICKETS,
    PERMISSIONS.VIEW_ACTIVITY,
    PERMISSIONS.CHAT_SEND,
    PERMISSIONS.CHAT_VIEW,
  ],
};

export function resolvePermissions(role: string, customPermissions: string[] = []): string[] {
  const rolePerms = ROLE_PERMISSIONS[role] || [];
  const merged = new Set([...rolePerms, ...customPermissions]);
  return Array.from(merged);
}

export function hasPermission(role: string, customPermissions: string[], permission: string): boolean {
  const resolved = resolvePermissions(role, customPermissions);
  return resolved.includes(permission);
}

export const PERMISSION_LABELS: Record<string, { label: string; description: string; group: string }> = {
  [PERMISSIONS.ADMIN_ACCESS]: { label: 'Admin Access', description: 'Access the admin panel', group: 'Admin' },
  [PERMISSIONS.MANAGE_USERS]: { label: 'Manage Users', description: 'Create, edit, delete users', group: 'Admin' },
  [PERMISSIONS.MANAGE_AGENTS]: { label: 'Manage Agents', description: 'Create, edit, delete AI agents', group: 'Admin' },
  [PERMISSIONS.MANAGE_CHANNELS]: { label: 'Manage Channels', description: 'Create, edit, delete notification channels', group: 'Admin' },
  [PERMISSIONS.MANAGE_API_KEYS]: { label: 'Manage API Keys', description: 'Create, revoke, delete MCP API keys', group: 'Admin' },
  [PERMISSIONS.MANAGE_PROMPT_TEMPLATES]: { label: 'Manage Prompt Templates', description: 'Create, edit, delete workspace prompt templates', group: 'Admin' },
  [PERMISSIONS.MANAGE_RESOURCES]: { label: 'Manage Resources', description: 'Create, edit, delete workspace resources', group: 'Admin' },
  [PERMISSIONS.MANAGE_CREDENTIALS]: { label: 'Manage Credentials', description: 'Create, edit, delete workspace credentials', group: 'Admin' },
  [PERMISSIONS.MANAGE_BOARDS]: { label: 'Manage Boards', description: 'Create, edit, delete boards and columns', group: 'Boards' },
  [PERMISSIONS.CREATE_TICKETS]: { label: 'Create Tickets', description: 'Create new tickets and subtasks', group: 'Tickets' },
  [PERMISSIONS.EDIT_TICKETS]: { label: 'Edit Tickets', description: 'Edit tickets, subtasks, and comments', group: 'Tickets' },
  [PERMISSIONS.DELETE_TICKETS]: { label: 'Delete Tickets', description: 'Delete tickets and subtasks', group: 'Tickets' },
  [PERMISSIONS.VIEW_ACTIVITY]: { label: 'View Activity', description: 'View activity logs', group: 'General' },
  [PERMISSIONS.CHAT_SEND]: { label: 'Send Chat Messages', description: 'Send chat messages to agents', group: 'Chat' },
  [PERMISSIONS.CHAT_VIEW]: { label: 'View Chat Messages', description: 'View chat threads and history', group: 'Chat' },
};
