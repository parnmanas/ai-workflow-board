export const PERMISSIONS = {
  ADMIN_ACCESS: 'admin.access',
  MANAGE_USERS: 'admin.users',
  MANAGE_AGENTS: 'admin.agents',
  MANAGE_CHANNELS: 'admin.channels',
  MANAGE_API_KEYS: 'admin.api_keys',
  MANAGE_PROMPT_TEMPLATES: 'admin.prompt_templates',
  MANAGE_RESOURCES: 'admin.resources',
  MANAGE_ACTIONS: 'admin.actions',
  MANAGE_FUNCTIONS: 'admin.functions',
  MANAGE_CREDENTIALS: 'admin.credentials',
  MANAGE_GLOBAL_CREDENTIALS: 'admin.global_credentials',
  MANAGE_BOARDS: 'boards.manage',
  CREATE_TICKETS: 'tickets.create',
  EDIT_TICKETS: 'tickets.edit',
  DELETE_TICKETS: 'tickets.delete',
  VIEW_ACTIVITY: 'activity.view',
  CHAT_SEND: 'chat.send',
  CHAT_VIEW: 'chat.view',
  BROWSE_AGENT_FS: 'agents.fs_browse',
  // Agent Session(CLI 직접 세션) — Runtime Host 장비의 CLI 세션(운영자 홈의
  // Claude Code / Codex 기록 포함)을 열람·구동한다. 장비의 개인 기록이 노출되므로
  // 기본은 admin 전용이고, 필요한 사용자에게만 부여한다.
  USE_AGENT_SESSIONS: 'agent_sessions.use',
  // Terminal(Runtime Host 셸) — 그 장비에서 셸을 띄우고 임의의 명령을 친다. 사실상
  // 장비 운영자 권한이므로 기본은 admin 전용이고, 필요한 사용자에게만 부여한다.
  USE_TERMINALS: 'terminals.use',
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
  [PERMISSIONS.MANAGE_ACTIONS]: { label: 'Manage Actions', description: 'Create, edit, delete and run workspace actions', group: 'Admin' },
  [PERMISSIONS.MANAGE_FUNCTIONS]: { label: 'Manage Functions', description: 'Create, edit, delete and execute global or workspace Functions', group: 'Admin' },
  [PERMISSIONS.MANAGE_CREDENTIALS]: { label: 'Manage Credentials', description: 'Create, edit, delete workspace credentials', group: 'Admin' },
  [PERMISSIONS.MANAGE_GLOBAL_CREDENTIALS]: { label: 'Manage Global Credentials', description: 'Create, edit, delete instance-level credentials shared across all workspaces', group: 'Admin' },
  [PERMISSIONS.MANAGE_BOARDS]: { label: 'Manage Boards', description: 'Create, edit, delete boards and columns', group: 'Boards' },
  [PERMISSIONS.CREATE_TICKETS]: { label: 'Create Tickets', description: 'Create new tickets and subtasks', group: 'Tickets' },
  [PERMISSIONS.EDIT_TICKETS]: { label: 'Edit Tickets', description: 'Edit tickets, subtasks, and comments', group: 'Tickets' },
  [PERMISSIONS.DELETE_TICKETS]: { label: 'Delete Tickets', description: 'Delete tickets and subtasks', group: 'Tickets' },
  [PERMISSIONS.VIEW_ACTIVITY]: { label: 'View Activity', description: 'View activity logs', group: 'General' },
  [PERMISSIONS.CHAT_SEND]: { label: 'Send Chat Messages', description: 'Send chat messages to agents', group: 'Chat' },
  [PERMISSIONS.CHAT_VIEW]: { label: 'View Chat Messages', description: 'View chat threads and history', group: 'Chat' },
  [PERMISSIONS.BROWSE_AGENT_FS]: { label: 'Browse Agent Filesystem', description: 'Browse files on an agent machine within scoped roots configured on the plugin side', group: 'Admin' },
  [PERMISSIONS.USE_TERMINALS]: { label: 'Use Terminals', description: 'Open shell terminals on Runtime Host machines and run arbitrary commands there — effectively operator access to that machine', group: 'Sessions' },
  [PERMISSIONS.USE_AGENT_SESSIONS]: { label: 'Use Agent Sessions', description: 'Browse and drive CLI sessions (Claude Code / Codex / Hermes) on Runtime Host machines, including sessions already on those machines', group: 'Sessions' },
};
