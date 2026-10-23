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
  // CLI Memory — Runtime Host 장비의 LLM CLI 메모리 파일(CLAUDE.md · AGENTS.md · auto memory …)을
  // 읽고 고친다. 그 파일은 모든 에이전트 세션의 지침이 되고 비밀이 섞여 있을 수 있으므로 기본은
  // admin 전용이다. docs/cli-memory.md
  USE_CLI_MEMORY: 'cli_memory.use',
  // 음성(STT/TTS) — 외부 엔진을 부르는 유료 경로라 기본은 admin 전용이고, 필요한 사용자에게만 부여한다.
  // docs/voice-operator.md
  USE_VOICE: 'voice.use',
  // Marketing — 캠페인 · 채널 · 게시물 승인 · 메일 연락처를 다룬다. 승인하면 회사 이름으로 외부에
  // 글과 메일이 나가므로 기본은 admin 전용이다. docs/marketing.md
  MANAGE_MARKETING: 'marketing.manage',
  MANAGE_BUSINESS: 'business.manage',
  // 마케팅 예산 편성 · 지출 승인 · 결제 기록 — 실제 돈이 움직인다. 기본은 admin 전용이고,
  // manage 와 따로 부여한다(캠페인을 운영하는 사람과 돈을 승인하는 사람을 나눌 수 있게).
  APPROVE_MARKETING_SPEND: 'marketing.approve_spend',
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
  [PERMISSIONS.MANAGE_PROMPT_TEMPLATES]: { label: 'Manage Prompt Templates', description: 'Create, edit, delete account prompt templates', group: 'Admin' },
  [PERMISSIONS.MANAGE_RESOURCES]: { label: 'Manage Resources', description: 'Create, edit, delete account resources', group: 'Admin' },
  [PERMISSIONS.MANAGE_ACTIONS]: { label: 'Manage Actions', description: 'Create, edit, delete and run account actions', group: 'Admin' },
  [PERMISSIONS.MANAGE_FUNCTIONS]: { label: 'Manage Functions', description: 'Create, edit, delete and execute global or account Functions', group: 'Admin' },
  [PERMISSIONS.MANAGE_CREDENTIALS]: { label: 'Manage Credentials', description: 'Create, edit, delete account credentials', group: 'Admin' },
  [PERMISSIONS.MANAGE_GLOBAL_CREDENTIALS]: { label: 'Manage Global Credentials', description: 'Create, edit, delete instance-level credentials shared across all accounts', group: 'Admin' },
  [PERMISSIONS.MANAGE_BOARDS]: { label: 'Manage Boards', description: 'Create, edit, delete boards and columns', group: 'Boards' },
  [PERMISSIONS.CREATE_TICKETS]: { label: 'Create Tickets', description: 'Create new tickets and subtasks', group: 'Tickets' },
  [PERMISSIONS.EDIT_TICKETS]: { label: 'Edit Tickets', description: 'Edit tickets, subtasks, and comments', group: 'Tickets' },
  [PERMISSIONS.DELETE_TICKETS]: { label: 'Delete Tickets', description: 'Delete tickets and subtasks', group: 'Tickets' },
  [PERMISSIONS.VIEW_ACTIVITY]: { label: 'View Activity', description: 'View activity logs', group: 'General' },
  [PERMISSIONS.CHAT_SEND]: { label: 'Send Chat Messages', description: 'Send chat messages to agents', group: 'Chat' },
  [PERMISSIONS.CHAT_VIEW]: { label: 'View Chat Messages', description: 'View chat threads and history', group: 'Chat' },
  [PERMISSIONS.BROWSE_AGENT_FS]: { label: 'Browse Agent Filesystem', description: 'Browse files on an agent machine within scoped roots configured on the plugin side', group: 'Admin' },
  [PERMISSIONS.USE_CLI_MEMORY]: { label: 'Use CLI Memory', description: 'Read, analyze and edit the memory files of LLM CLIs (CLAUDE.md, AGENTS.md, auto memory …) on Runtime Host machines — these steer every agent session there', group: 'Sessions' },
  [PERMISSIONS.USE_TERMINALS]: { label: 'Use Terminals', description: 'Open shell terminals on Runtime Host machines and run arbitrary commands there — effectively operator access to that machine', group: 'Sessions' },
  [PERMISSIONS.USE_AGENT_SESSIONS]: { label: 'Use Agent Sessions', description: 'Browse and drive CLI sessions (Claude Code / Codex / Hermes) on Runtime Host machines, including sessions already on those machines', group: 'Sessions' },
  [PERMISSIONS.MANAGE_MARKETING]: { label: 'Manage Marketing', description: 'Run marketing campaigns: approve channels, posts and emails that go out under your name, and manage email contacts', group: 'Marketing' },
  [PERMISSIONS.MANAGE_BUSINESS]: { label: 'Manage Business', description: 'Manage company workflows and connectors, submit reviewed formation requests, and read business operations data', group: 'Business' },
  [PERMISSIONS.APPROVE_MARKETING_SPEND]: { label: 'Approve Marketing Spend', description: 'Approve budget allocations and payments requested by marketing agents, and record payment results — real money moves', group: 'Marketing' },
  [PERMISSIONS.USE_VOICE]: { label: 'Use Voice', description: 'Speak prompts and hear replies — audio goes to the configured speech-to-text / text-to-speech provider, which is billed per use', group: 'Sessions' },
};
