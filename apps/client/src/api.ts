import type {
  PromptTemplate,
  Resource,
  Action,
  ActionRun,
  Credential,
  ChatMessage,
  ChatThread,
  DashboardAgent,
  AgentDetail,
  ActivityRow,
  ChatRoomListItem,
  ChatRoomDetail,
  ChatRoomMessageItem,
  ChatRoomParticipantInfo,
  AgentErrorLog,
  AgentErrorLogAgentSummary,
  FsListResult,
  FsStatResult,
  FsReadResult,
  FsRootsResult,
  FsDrivesResult,
  SubagentSummary,
  SubagentTranscript,
  AgentProxySession,
  AgentManagerInstance,
  PairingTokenMint,
  PairingTokenSafe,
  AgentManagerCommandKind,
  AgentManagerCommandResult,
  ManagedAgentCreateBody,
  Agent,
  TicketAttachmentMeta,
  UserNotificationChannel,
} from './types';

const BASE = '/api';

// ─── Active workspace (per-tab) ────────────────────────────────
// `localStorage.currentWorkspaceId` is shared across browser tabs, which
// caused cross-workspace data leaks: switching workspace in Tab A would
// silently change the X-Workspace-Id header that Tab B sent on its next
// request, so Tab B (still showing workspace A on screen) would receive
// agents/tickets/etc. from workspace B. Symptom: "agent role list shows
// agents from another workspace, content of other workspaces leaks in".
//
// Fix: hold the active workspace in a per-tab module variable, persisted
// to sessionStorage (per-tab) and bootstrapped from the URL when present.
// localStorage is still written by AppLayout for new-tab default, but it
// is NEVER consulted at request time — each tab is self-contained.
const SESSION_WS_KEY = 'awb.activeWorkspaceId';

function bootstrapActiveWorkspaceId(): string | null {
  if (typeof window === 'undefined') return null;
  // 1) URL — most accurate, per-tab, survives initial render before AppLayout mounts.
  const m = window.location.pathname.match(/^\/ws\/([^/]+)/);
  if (m && m[1]) return m[1];
  // 2) sessionStorage — per-tab, survives reload of the same tab.
  try {
    const ss = sessionStorage.getItem(SESSION_WS_KEY);
    if (ss) return ss;
  } catch { /* ignore */ }
  // 3) localStorage — last-resort default for a new tab with no URL hint.
  try { return localStorage.getItem('currentWorkspaceId'); } catch { return null; }
}

let _activeWorkspaceId: string | null = bootstrapActiveWorkspaceId();

export function setActiveWorkspaceId(id: string | null): void {
  _activeWorkspaceId = id;
  try {
    if (id) sessionStorage.setItem(SESSION_WS_KEY, id);
    else sessionStorage.removeItem(SESSION_WS_KEY);
  } catch { /* ignore */ }
}

export function getActiveWorkspaceId(): string | null {
  return _activeWorkspaceId;
}

function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = localStorage.getItem('auth_token');
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (_activeWorkspaceId) {
    headers['X-Workspace-Id'] = _activeWorkspaceId;
  }
  return headers;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: getAuthHeaders(),
    ...options,
  });
  if (!res.ok) {
    if (res.status === 401) {
      localStorage.removeItem('auth_token');
      window.dispatchEvent(new Event('auth-expired'));
    }
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

export const api = {
  // ─── Auth ──────────────────────────────────────────────
  login: (email: string, password: string) =>
    request<any>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),

  logout: () =>
    request<any>('/auth/logout', { method: 'POST' }),

  getMe: () =>
    request<any>('/auth/me'),

  getSetupStatus: () =>
    request<{ needs_setup: boolean }>('/auth/setup-status'),

  setup: (data: { name: string; email: string; password: string }) =>
    request<any>('/auth/setup', { method: 'POST', body: JSON.stringify(data) }),

  register: (name: string, email: string, password: string, requestedWorkspaceId?: string) =>
    request<{ success: boolean; message: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name, email, password, requested_workspace_id: requestedWorkspaceId }),
    }),

  getPublicWorkspaces: () =>
    request<{ id: string; name: string; slug: string }[]>('/auth/public-workspaces'),

  // ─── Admin Pending Users ────────────────────────────────
  getPendingUsers: () =>
    request<any>('/admin/pending-users'),

  approveUser: (userId: string) =>
    request<any>(`/admin/pending-users/${userId}/approve`, { method: 'POST' }),

  rejectUser: (userId: string, reason?: string) =>
    request<any>(`/admin/pending-users/${userId}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  assignUserWorkspace: (userId: string, workspaceId: string, relation: string = 'member') =>
    request<any>(`/admin/pending-users/${userId}/assign`, {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId, relation }),
    }),

  getPermissionsMeta: () =>
    request<{ permissions: Record<string, { label: string; description: string; group: string }>; role_defaults: Record<string, string[]> }>('/auth/permissions'),

  // ─── Workspaces ────────────────────────────────────────
  getWorkspaces: () => request<any[]>('/workspaces'),
  getWorkspace: (id: string) => request<any>(`/workspaces/${id}`),
  createWorkspace: (data: { name: string; description?: string; board_name?: string }) =>
    request<any>('/workspaces', { method: 'POST', body: JSON.stringify(data) }),
  updateWorkspace: (id: string, data: { name?: string; description?: string }) =>
    request<any>(`/workspaces/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteWorkspace: (id: string) =>
    request<any>(`/workspaces/${id}`, { method: 'DELETE' }),
  getWorkspaceMembers: (wsId: string) =>
    request<any[]>(`/workspaces/${wsId}/members`),
  addWorkspaceMember: (wsId: string, userId: string, relation: string = 'member') =>
    request<any>(`/workspaces/${wsId}/members`, {
      method: 'POST', body: JSON.stringify({ user_id: userId, relation }),
    }),
  updateWorkspaceMemberRole: (wsId: string, userId: string, relation: string) =>
    request<any>(`/workspaces/${wsId}/members/${userId}`, {
      method: 'PATCH', body: JSON.stringify({ relation }),
    }),
  removeWorkspaceMember: (wsId: string, userId: string) =>
    request<any>(`/workspaces/${wsId}/members/${userId}`, { method: 'DELETE' }),

  // ─── Workspace Roles (v0.34) ───────────────────────────
  // Workspace-scoped workflow role catalog. The three legacy slugs
  // (`assignee`/`reporter`/`reviewer`) are seeded with `is_builtin: true` per
  // workspace; admins can rename / re-prompt them or add custom slugs. A
  // role can't be deleted while any ticket assignment still references it.
  listWorkspaceRoles: (wsId: string) =>
    request<any[]>(`/workspaces/${wsId}/roles`),
  createWorkspaceRole: (wsId: string, data: { slug: string; name: string; role_prompt?: string; description?: string; position?: number }) =>
    request<any>(`/workspaces/${wsId}/roles`, { method: 'POST', body: JSON.stringify(data) }),
  updateWorkspaceRole: (
    wsId: string,
    roleId: string,
    data: { slug?: string; name?: string; role_prompt?: string; description?: string; position?: number },
  ) =>
    request<any>(`/workspaces/${wsId}/roles/${roleId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteWorkspaceRole: (wsId: string, roleId: string) =>
    request<any>(`/workspaces/${wsId}/roles/${roleId}`, { method: 'DELETE' }),
  // Bulk reorder — server rewrites position to 0..N-1 in the given order.
  // Order propagates to TicketPanel / ColumnManager / TriggerMenu via the
  // same `position` field they already sort on.
  reorderWorkspaceRoles: (wsId: string, orderedRoleIds: string[]) =>
    request<any[]>(`/workspaces/${wsId}/roles/reorder`, {
      method: 'PATCH',
      body: JSON.stringify({ ordered_role_ids: orderedRoleIds }),
    }),

  // ─── Ticket Role Assignments (v0.34) ───────────────────
  // Per-ticket holder for each WorkspaceRole. The legacy
  // assignee/reporter/reviewer triple is mirrored from the builtin slugs;
  // custom slugs are *only* visible through this endpoint.
  listTicketRoleAssignments: (ticketId: string) =>
    request<TicketRoleAssignmentRow[]>(`/tickets/${ticketId}/role-assignments`),
  setTicketRoleAssignment: (
    ticketId: string,
    roleId: string,
    holder: { agent_id?: string | null; user_id?: string | null },
  ) =>
    request<{ assignments: TicketRoleAssignmentRow[] }>(
      `/tickets/${ticketId}/role-assignments/${roleId}`,
      { method: 'PUT', body: JSON.stringify(holder) },
    ),

  // ─── Boards ────────────────────────────────────────────
  getBoard: (id: string) => request<any>(`/boards/${id}`),
  getBoards: (workspaceId?: string) =>
    request<any[]>(workspaceId ? `/boards?workspace_id=${workspaceId}` : '/boards'),
  createBoard: (data: { name: string; description?: string; workspace_id: string }) =>
    request<any>('/boards', { method: 'POST', body: JSON.stringify(data) }),
  updateBoard: (
    id: string,
    data: {
      name?: string;
      description?: string;
      routing_config?: Record<string, string[]>;
      column_prompts?: Record<string, string> | null;
      max_concurrent_tickets_per_agent?: number;
    },
  ) =>
    request<any>(`/boards/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteBoard: (id: string) =>
    request<any>(`/boards/${id}`, { method: 'DELETE' }),
  getArchivedBoards: (workspaceId: string) =>
    request<any[]>(`/boards?workspace_id=${workspaceId}&include_archived=true`),
  archiveBoard: async (boardId: string) =>
    request<any>(`/boards/${boardId}/archive`, { method: 'POST' }),
  restoreBoard: async (boardId: string) =>
    request<any>(`/boards/${boardId}/restore`, { method: 'POST' }),
  // Board pause: server flips Board.paused_at and drops every agent_trigger
  // for tickets on this board until resumed. Idempotent — re-calling pause
  // refreshes the timestamp.
  pauseBoard: async (boardId: string) =>
    request<any>(`/boards/${boardId}/pause`, { method: 'POST' }),
  resumeBoard: async (boardId: string) =>
    request<any>(`/boards/${boardId}/resume`, { method: 'POST' }),

  // ─── Columns ──────────────────────────────────────────
  createColumn: (boardId: string, data: { name: string; color?: string; description?: string }) =>
    request<any>(`/boards/${boardId}/columns`, { method: 'POST', body: JSON.stringify(data) }),
  updateColumn: (id: string, data: { name?: string; color?: string; position?: number; description?: string; is_terminal?: boolean }) =>
    request<any>(`/columns/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteColumn: (id: string) =>
    request<any>(`/columns/${id}`, { method: 'DELETE' }),

  // ─── Tickets ───────────────────────────────────────────
  createTicket: (columnId: string, data: {
    title: string; description?: string; priority?: string;
    assignee?: string; reporter?: string; assignee_id?: string; reporter_id?: string;
  }) =>
    request<any>(`/columns/${columnId}/tickets`, { method: 'POST', body: JSON.stringify(data) }),

  updateTicket: (id: string, data: Record<string, any>) =>
    request<any>(`/tickets/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  moveTicket: (id: string, targetColumnId: string, targetPosition: number) =>
    request<any>(`/tickets/${id}/move`, { method: 'PATCH', body: JSON.stringify({ targetColumnId, targetPosition }) }),

  // Re-parent a ticket. parent_id=null promotes back to root (must include
  // column_id); parent_id=string makes it a subtask. targetPosition is
  // optional — server clamps and defaults to end-of-list.
  reparentTicket: (id: string, parent_id: string | null, opts?: { column_id?: string; targetPosition?: number }) =>
    request<any>(`/tickets/${id}/parent`, {
      method: 'PATCH',
      body: JSON.stringify({
        parent_id,
        ...(opts?.column_id ? { column_id: opts.column_id } : {}),
        ...(typeof opts?.targetPosition === 'number' ? { targetPosition: opts.targetPosition } : {}),
      }),
    }),

  // Move a root ticket to a different board (same workspace). Subtasks travel
  // with the parent automatically. target_column_id/target_position are
  // optional — omitting both lands in the destination board's first column at
  // end-of-list.
  moveTicketToBoard: (id: string, target_board_id: string, opts?: { target_column_id?: string; target_position?: number }) =>
    request<any>(`/tickets/${id}/move-to-board`, {
      method: 'PATCH',
      body: JSON.stringify({
        target_board_id,
        ...(opts?.target_column_id ? { target_column_id: opts.target_column_id } : {}),
        ...(typeof opts?.target_position === 'number' ? { target_position: opts.target_position } : {}),
      }),
    }),

  triggerAgent: (id: string, role: 'assignee' | 'reporter' | 'reviewer', agent_id?: string) =>
    request<{ trigger_id: string; ticket_id: string; agent_id: string; role: string; trigger_source: 'manual'; pushed_at: string }>(
      `/tickets/${id}/trigger`,
      { method: 'POST', body: JSON.stringify(agent_id ? { role, agent_id } : { role }) },
    ),

  deleteTicket: (id: string) =>
    request<any>(`/tickets/${id}`, { method: 'DELETE' }),

  // ─── Child Tickets (Subtasks) ──────────────────────────
  createChildTicket: (parentId: string, data: {
    title: string; description?: string; priority?: string; status?: string;
    assignee?: string; reporter?: string; assignee_id?: string; reporter_id?: string;
    labels?: string[]; channel_ids?: string[];
  }) =>
    request<any>(`/tickets/${parentId}/children`, { method: 'POST', body: JSON.stringify(data) }),

  // ─── Comments ──────────────────────────────────────────
  // attachments are uploaded in the SAME request as the comment so the user
  // doesn't have to wait for two round-trips; server wraps both the Resource
  // insert and the Comment insert in a single transaction.
  addComment: (
    ticketId: string,
    content: string,
    attachments: { file_name: string; file_mimetype: string; file_data: string }[] = [],
    options?: {
      type?: string;
      parent_id?: string | null;
      metadata?: Record<string, unknown>;
      attachment_resource_ids?: string[];
    },
  ) =>
    request<any>(`/tickets/${ticketId}/comments`, {
      method: 'POST',
      body: JSON.stringify({
        content,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(options?.attachment_resource_ids ? { attachment_resource_ids: options.attachment_resource_ids } : {}),
        ...(options?.type ? { type: options.type } : {}),
        ...(options?.parent_id !== undefined ? { parent_id: options.parent_id } : {}),
        ...(options?.metadata ? { metadata: options.metadata } : {}),
      }),
    }),
  setCommentStatus: (ticketId: string, commentId: string, status: 'open' | 'resolved') =>
    request<any>(`/tickets/${ticketId}/comments/${commentId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
  setCommentTyping: (ticketId: string, isTyping: boolean, commentType?: string) =>
    request<any>(`/tickets/${ticketId}/comment-typing`, {
      method: 'POST',
      body: JSON.stringify({ is_typing: isTyping, ...(commentType ? { comment_type: commentType } : {}) }),
    }),
  // Tier-1 E ticket presence — heartbeat (default) or explicit leave.
  // Returns the current viewer list so the caller can paint without a
  // SSE round-trip on first ping.
  pingTicketPresence: (ticketId: string) =>
    request<any>(`/tickets/${ticketId}/presence`, {
      method: 'POST',
      body: JSON.stringify({ is_active: true }),
    }),
  leaveTicketPresence: (ticketId: string) =>
    request<any>(`/tickets/${ticketId}/presence`, {
      method: 'POST',
      body: JSON.stringify({ is_active: false }),
    }),
  // Tier-1 F: per-ticket read marker.
  getTicketReadState: (ticketId: string) =>
    request<{ ticket_id: string; last_read_at: string | null }>(`/tickets/${ticketId}/read-state`),
  markTicketRead: (ticketId: string, upTo?: string) =>
    request<{ ticket_id: string; last_read_at: string }>(`/tickets/${ticketId}/read`, {
      method: 'POST',
      body: JSON.stringify(upTo ? { up_to: upTo } : {}),
    }),

  // ─── Ticket Attachments ────────────────────────────────
  // Files attached directly to a ticket (NOT through Resources). Distinct
  // from comment attachments — these cascade-delete with the ticket and
  // store the binary on the dedicated `ticket_attachments` table.
  listTicketAttachments: (ticketId: string) =>
    request<TicketAttachmentMeta[]>(`/tickets/${ticketId}/attachments`),
  getTicketAttachment: (ticketId: string, attachmentId: string) =>
    request<TicketAttachmentMeta>(`/tickets/${ticketId}/attachments/${attachmentId}`),
  addTicketAttachments: (
    ticketId: string,
    attachments: { file_name: string; file_mimetype: string; file_data: string }[],
  ) =>
    request<TicketAttachmentMeta[]>(`/tickets/${ticketId}/attachments`, {
      method: 'POST',
      body: JSON.stringify({ attachments }),
    }),
  deleteTicketAttachment: (ticketId: string, attachmentId: string) =>
    request<{ success: boolean; id: string }>(`/tickets/${ticketId}/attachments/${attachmentId}`, {
      method: 'DELETE',
    }),

  // ─── Users ─────────────────────────────────────────────
  getUsers: (workspaceId?: string) =>
    request<any[]>(workspaceId ? `/users?workspace_id=${encodeURIComponent(workspaceId)}` : '/users'),
  createUser: (data: { name: string; email?: string; role?: string; discord_user_id?: string; password?: string; permissions?: string[] }) =>
    request<any>('/users', { method: 'POST', body: JSON.stringify(data) }),
  updateUser: (id: string, data: Record<string, any>) =>
    request<any>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteUser: (id: string) =>
    request<any>(`/users/${id}`, { method: 'DELETE' }),

  // ─── Agents ────────────────────────────────────────────
  getAgents: () => request<any[]>('/agents'),
  getAgentsAll: () => request<any[]>('/agents?scope=all'),
  // Phase 3 Plan 03-02: dashboard snapshot with current_task + bool-coerced is_online
  getAgentDashboard: (workspaceId: string): Promise<DashboardAgent[]> =>
    request<DashboardAgent[]>(`/agents/dashboard?workspace_id=${encodeURIComponent(workspaceId)}`),
  // Phase 3 Plan 03-02: extended :id endpoint (role_prompt + redacted flag per D-44)
  getAgent: (id: string): Promise<AgentDetail> =>
    request<AgentDetail>(`/agents/${encodeURIComponent(id)}`),
  // Phase 3 Plan 03-02: actor-scoped activity for the detail modal
  getAgentActivity: (agentId: string, opts?: { limit?: number }): Promise<ActivityRow[]> => {
    const limit = opts?.limit ?? 50;
    return request<ActivityRow[]>(
      `/agents/${encodeURIComponent(agentId)}/activity?limit=${limit}`,
    );
  },
  // ─── Agent file browser (v0.31.0) ─────────────────────────
  // Each call forwards through to the agent's plugin over SSE and awaits the
  // reverse-HTTP response. Agent offline → 503. Path outside scope → 403.
  getAgentFsRoots: (agentId: string): Promise<FsRootsResult> =>
    request<FsRootsResult>(`/agents/${encodeURIComponent(agentId)}/fs/roots`),
  getAgentFsDrives: (agentId: string): Promise<FsDrivesResult> =>
    request<FsDrivesResult>(`/agents/${encodeURIComponent(agentId)}/fs/drives`),
  listAgentFs: (agentId: string, path: string): Promise<FsListResult> => {
    const params = new URLSearchParams({ path });
    return request<FsListResult>(`/agents/${encodeURIComponent(agentId)}/fs/list?${params.toString()}`);
  },
  statAgentFs: (agentId: string, path: string): Promise<FsStatResult> => {
    const params = new URLSearchParams({ path });
    return request<FsStatResult>(`/agents/${encodeURIComponent(agentId)}/fs/stat?${params.toString()}`);
  },
  readAgentFs: (agentId: string, path: string, opts?: { offset?: number; limit?: number }): Promise<FsReadResult> => {
    const params = new URLSearchParams({ path });
    if (opts?.offset !== undefined) params.set('offset', String(opts.offset));
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
    return request<FsReadResult>(`/agents/${encodeURIComponent(agentId)}/fs/read?${params.toString()}`);
  },
  // ─── Subagent monitor (v0.32) ─────────────────────────────
  listSubagents: (workspaceId: string): Promise<SubagentSummary[]> =>
    request<SubagentSummary[]>(`/subagent-monitor/workspaces/${encodeURIComponent(workspaceId)}`),
  getSubagentTranscript: (subagentId: string, workspaceId: string): Promise<SubagentTranscript> => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    return request<SubagentTranscript>(`/subagent-monitor/${encodeURIComponent(subagentId)}?${params.toString()}`);
  },
  // The server reads X-Workspace-Id from the header set by getAuthHeaders(),
  // which now pulls from the per-tab active workspace. The caller can still
  // pass `workspaceId` explicitly to override (e.g., admin tools acting on a
  // workspace other than the one the tab is currently viewing).
  createAgent: (data: { name: string; description?: string; type?: string; workspaceId?: string }) => {
    const { workspaceId, ...body } = data;
    const init: RequestInit = { method: 'POST', body: JSON.stringify(body) };
    if (workspaceId) {
      init.headers = { ...getAuthHeaders(), 'X-Workspace-Id': workspaceId };
    }
    return request<any>('/agents', init);
  },
  updateAgent: (id: string, data: Record<string, any>) =>
    request<any>(`/agents/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteAgent: (id: string) =>
    request<any>(`/agents/${id}`, { method: 'DELETE' }),

  // ─── Channels ──────────────────────────────────────────
  getChannels: () => request<any[]>('/channels'),
  createChannel: (data: {
    name: string; type?: string; bot_token?: string; guild_id?: string;
    channel_id?: string; board_id?: string;
  }) =>
    request<any>('/channels', { method: 'POST', body: JSON.stringify(data) }),
  updateChannel: (id: string, data: Record<string, any>) =>
    request<any>(`/channels/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteChannel: (id: string) =>
    request<any>(`/channels/${id}`, { method: 'DELETE' }),
  testChannel: (id: string) =>
    request<any>(`/channels/${id}/test`, { method: 'POST' }),

  // ─── My notification channels (per-user) ──────────────────
  getMyChannelProviders: () =>
    request<{ id: string; required_credentials: string[] }[]>('/me/channels/providers'),
  getMyChannels: () => request<UserNotificationChannel[]>('/me/channels'),
  createMyChannel: (data: {
    provider: string;
    target: string;
    label?: string;
    credentials?: Record<string, string>;
    is_active?: number;
    notify_mention?: number;
    notify_chat?: number;
    notify_ticket?: number;
  }) =>
    request<UserNotificationChannel>('/me/channels', { method: 'POST', body: JSON.stringify(data) }),
  updateMyChannel: (id: string, data: Record<string, any>) =>
    request<UserNotificationChannel>(`/me/channels/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteMyChannel: (id: string) =>
    request<{ success: true }>(`/me/channels/${id}`, { method: 'DELETE' }),
  testMyChannel: (id: string) =>
    request<{ success: boolean; error?: string }>(`/me/channels/${id}/test`, { method: 'POST' }),

  // ─── API Keys ──────────────────────────────────────────
  getApiKeys: () => request<any[]>('/keys'),
  getApiKey: (id: string) => request<any>(`/keys/${id}`),
  createApiKey: (data: { name: string; agent_id?: string | null; scope?: string; expires_in_days?: number }) =>
    request<any>('/keys', { method: 'POST', body: JSON.stringify(data) }),
  updateApiKey: (id: string, data: Record<string, any>) =>
    request<any>(`/keys/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  revokeApiKey: (id: string) =>
    request<any>(`/keys/${id}/revoke`, { method: 'POST' }),
  deleteApiKey: (id: string) =>
    request<any>(`/keys/${id}`, { method: 'DELETE' }),

  // ─── Prompt Templates (Phase 1 ROLE-05) ────────────────
  listPromptTemplates: (workspace_id: string, options?: { category?: string; id?: string }) => {
    const params = new URLSearchParams({ workspace_id });
    if (options?.category) params.set('category', options.category);
    if (options?.id) params.set('id', options.id);
    return request<PromptTemplate[]>(`/prompt-templates?${params.toString()}`);
  },
  getPromptTemplate: (id: string, workspace_id: string) => {
    const params = new URLSearchParams({ workspace_id });
    return request<PromptTemplate>(`/prompt-templates/${id}?${params.toString()}`);
  },
  createPromptTemplate: (data: {
    workspace_id: string;
    name: string;
    description?: string;
    content: string;
    category?: string;
  }) =>
    request<PromptTemplate>('/prompt-templates', { method: 'POST', body: JSON.stringify(data) }),
  updatePromptTemplate: (
    id: string,
    data: {
      workspace_id: string;
      name?: string;
      description?: string;
      content?: string;
      category?: string;
    },
  ) =>
    request<PromptTemplate>(`/prompt-templates/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deletePromptTemplate: (id: string, workspace_id: string) => {
    const params = new URLSearchParams({ workspace_id });
    return request<{ success: true; id: string }>(`/prompt-templates/${id}?${params.toString()}`, { method: 'DELETE' });
  },

  // ─── Resources ─────────────────────────────────────────
  listResources: (workspaceId: string, boardId?: string | null, type?: string) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    if (boardId !== undefined) params.set('board_id', boardId || '');
    if (type) params.set('type', type);
    return request<Resource[]>(`/resources?${params.toString()}`);
  },
  getResource: (id: string) =>
    request<Resource>(`/resources/${id}`),
  createResource: (data: {
    workspace_id: string;
    board_id?: string | null;
    credential_id?: string | null;
    name: string;
    description?: string;
    type?: string;
    url?: string;
    content?: string;
    file_data?: string;
    file_name?: string;
    file_mimetype?: string;
    tags?: string[];
    default_branch?: string;
  }) =>
    request<Resource>('/resources', { method: 'POST', body: JSON.stringify(data) }),
  updateResource: (
    id: string,
    data: {
      workspace_id: string;
      name?: string;
      description?: string;
      type?: string;
      url?: string;
      content?: string;
      file_data?: string;
      file_name?: string;
      file_mimetype?: string;
      tags?: string[];
      board_id?: string | null;
      credential_id?: string | null;
      default_branch?: string;
    },
  ) =>
    request<Resource>(`/resources/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteResource: (id: string, workspaceId: string) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    return request<{ success: true; id: string }>(`/resources/${id}?${params.toString()}`, { method: 'DELETE' });
  },
  listRepoBranches: (id: string, workspaceId: string) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    return request<{ branches: { name: string; sha: string }[]; default_branch: string }>(
      `/resources/${id}/branches?${params.toString()}`,
    );
  },
  testRepoBranches: (data: {
    workspace_id: string;
    url: string;
    credential_id?: string | null;
    default_branch?: string;
  }) =>
    request<{ branches: { name: string; sha: string }[]; default_branch: string }>(
      '/resources/branches/test',
      { method: 'POST', body: JSON.stringify(data) },
    ),

  // ─── Actions ──────────────────────────────────────────
  listActions: (workspaceId: string, boardId?: string | null) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    if (boardId !== undefined) params.set('board_id', boardId || '');
    return request<Action[]>(`/actions?${params.toString()}`);
  },
  getAction: (id: string) => request<Action>(`/actions/${id}`),
  createAction: (data: {
    workspace_id: string;
    board_id?: string | null;
    name: string;
    description?: string;
    prompt?: string;
    target_agent_id: string;
    schedule_cron?: string;
    enabled?: boolean;
    max_runs?: number;
  }) =>
    request<Action>('/actions', { method: 'POST', body: JSON.stringify(data) }),
  updateAction: (
    id: string,
    data: {
      workspace_id: string;
      name?: string;
      description?: string;
      prompt?: string;
      target_agent_id?: string;
      board_id?: string | null;
      schedule_cron?: string;
      enabled?: boolean;
      max_runs?: number;
    },
  ) =>
    request<Action>(`/actions/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteAction: (id: string, workspaceId: string) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    return request<{ success: true; id: string }>(`/actions/${id}?${params.toString()}`, { method: 'DELETE' });
  },
  runAction: (id: string) =>
    request<{ run_id: string; room_id: string; prompt: string }>(`/actions/${id}/run`, { method: 'POST', body: '{}' }),
  listActionRuns: (id: string, workspaceId: string, limit = 20) => {
    const params = new URLSearchParams({ workspace_id: workspaceId, limit: String(limit) });
    return request<ActionRun[]>(`/actions/${id}/runs?${params.toString()}`);
  },
  getActionRun: (runId: string, workspaceId: string) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    return request<ActionRun>(`/actions/runs/${runId}?${params.toString()}`);
  },

  // ─── Credentials ──────────────────────────────────────
  listCredentials: (workspaceId: string, provider?: string) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    if (provider) params.set('provider', provider);
    return request<Credential[]>(`/credentials?${params.toString()}`);
  },
  getCredentialProviders: () =>
    request<Record<string, { label: string; fields: string[] }>>('/credentials/providers'),
  createCredential: (data: {
    workspace_id: string;
    name: string;
    description?: string;
    provider: string;
    credentials: Record<string, string>;
  }) =>
    request<Credential>('/credentials', { method: 'POST', body: JSON.stringify(data) }),
  updateCredential: (
    id: string,
    data: {
      workspace_id: string;
      name?: string;
      description?: string;
      provider?: string;
      credentials?: Record<string, string>;
    },
  ) =>
    request<Credential>(`/credentials/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteCredential: (id: string, workspaceId: string) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    return request<{ success: true; id: string }>(`/credentials/${id}?${params.toString()}`, { method: 'DELETE' });
  },

  // ─── Chat (Phase 2) ────────────────────────────────────
  // Workspace context is read from the per-tab active workspace (see
  // getActiveWorkspaceId) so multi-tab use never leaks across workspaces.
  listChatThreads: () => {
    const workspace_id = getActiveWorkspaceId() || '';
    const params = new URLSearchParams({ workspace_id });
    return request<ChatThread[]>(`/chat/threads?${params.toString()}`);
  },
  listChatMessages: (params: { agent_id: string; ticket_id?: string | null; limit?: number }) => {
    const workspace_id = getActiveWorkspaceId() || '';
    const qs = new URLSearchParams({ workspace_id, agent_id: params.agent_id });
    if (params.ticket_id) qs.set('ticket_id', params.ticket_id);
    if (params.limit) qs.set('limit', String(params.limit));
    return request<ChatMessage[]>(`/chat/messages?${qs.toString()}`);
  },
  sendChatMessage: (params: { agent_id: string; content: string; ticket_id?: string | null }) => {
    const workspace_id = getActiveWorkspaceId() || '';
    return request<ChatMessage>('/chat/messages', {
      method: 'POST',
      body: JSON.stringify({
        workspace_id,
        agent_id: params.agent_id,
        content: params.content,
        ticket_id: params.ticket_id || undefined,
      }),
    });
  },

  // ─── Activity ──────────────────────────────────────────
  getTicketActivity: (ticketId: string) => request<any[]>(`/tickets/${ticketId}/activity`),
  getActivity: () => request<any[]>('/activity'),
  // Phase 3 Plan 03-02: workspace-wide recent activity feed (capped server-side to 1..200)
  getRecentActivity: (opts?: { limit?: number }): Promise<ActivityRow[]> => {
    const limit = opts?.limit ?? 50;
    return request<ActivityRow[]>(`/activity?limit=${limit}`);
  },

  // ─── QA (Quality Assurance) ────────────────────────────
  getQaStatus: () => request<{ available: boolean; description: string; usage: string }>('/admin/qa/status'),
  runQa: () => request<any>('/admin/qa/run', { method: 'POST' }),
  // Flow tests — spawns `node --test test/qa-flows/*.test.mjs` on the server.
  // Takes ~30-60s; intended for admins to trigger the full end-to-end suite
  // (ticket lifecycle, MCP round-trips, multi-agent scoping, large data,
  // etc.) from the admin UI without dropping to a shell.
  runQaFlows: () => request<any>('/admin/qa/run-flows', { method: 'POST' }),

  // ─── Admin Agent Manager (Phase 3) ─────────────────────
  // Live registry of daemon/proxy plugin instances heartbeating against the
  // server. One Agent row may have multiple instances (a developer running
  // proxy.mjs on one host and daemon.mjs on another shares one agent id);
  // this surface preserves the per-process detail.
  listAgentManagerInstances: (workspaceId?: string) => {
    const qs = new URLSearchParams();
    if (workspaceId) qs.set('workspace_id', workspaceId);
    const q = qs.toString();
    return request<AgentManagerInstance[]>(`/admin/agent-manager/instances${q ? '?' + q : ''}`);
  },
  getAgentManagerInstanceSubagents: (instanceId: string) =>
    request<SubagentSummary[]>(`/admin/agent-manager/instances/${encodeURIComponent(instanceId)}/subagents`),
  getAgentManagerInstanceLogs: (instanceId: string, limit = 200) =>
    request<any[]>(`/admin/agent-manager/instances/${encodeURIComponent(instanceId)}/logs?limit=${limit}`),
  restartAgentManagerInstance: (instanceId: string) =>
    request<any>(`/admin/agent-manager/instances/${encodeURIComponent(instanceId)}/restart`, { method: 'POST' }),

  // ─── ST-4/5 Agent-manager pairing & control ───────────
  // Pairing token lifecycle. mintAgentManagerPairing returns the raw token
  // ONCE — the UI must show it, copy it, and discard it. listAgentManagerPairings
  // returns the masked rows (no token, just the display code) for the table.
  mintAgentManagerPairing: (body: { agent_name?: string }) =>
    request<PairingTokenMint>('/admin/agent-manager/pair', { method: 'POST', body: JSON.stringify(body || {}) }),
  listAgentManagerPairings: () =>
    request<PairingTokenSafe[]>('/admin/agent-manager/pair'),
  revokeAgentManagerPairing: (id: string) =>
    request<{ ok: true }>(`/admin/agent-manager/pair/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // Control command — admin → manager instance over SSE. The 202 response
  // is the dispatch ack only; the manager later calls /command/ack with the
  // execution outcome (currently consumed only by server logs, surfacing it
  // in the UI is a future enhancement).
  sendAgentManagerCommand: (
    instanceId: string,
    body: { command: AgentManagerCommandKind; args?: Record<string, any> },
  ) =>
    request<AgentManagerCommandResult>(
      `/admin/agent-manager/instances/${encodeURIComponent(instanceId)}/command`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  // Create an agent identity that the manager will spawn. Differs from the
  // generic POST /agents in two ways: (1) cli is validated against the
  // claude/codex/gemini/custom whitelist, (2) manager_agent_id is sanity-
  // checked (existence + type='manager'); the manager itself can live in a
  // different workspace from the new agent — managers are paired globally
  // by an admin and supervise children across workspaces.
  //
  // Optional `workspaceId` lets callers (e.g. the workspace AI Agents page)
  // pin the request to the URL's wsId rather than relying on the per-tab
  // active workspace — same defensive override as createAgent.
  createManagedAgent: (body: ManagedAgentCreateBody, workspaceId?: string) => {
    const init: RequestInit = { method: 'POST', body: JSON.stringify(body) };
    if (workspaceId) {
      init.headers = { ...getAuthHeaders(), 'X-Workspace-Id': workspaceId };
    }
    return request<Agent>('/admin/agent-manager/agents', init);
  },

  // Cross-workspace manager picker source — the workspace AI Agents tab
  // uses this to populate the optional Agent Manager dropdown so an agent
  // in workspace B can be attached to a manager paired in workspace A.
  // MANAGE_AGENTS-gated; returns one row per Agent with type='manager'.
  listAgentManagers: () =>
    request<Array<{ id: string; name: string; description: string; workspace_id: string; is_active: number }>>(
      '/admin/agent-manager/managers',
    ),

  // Re-home an existing managed agent into a different workspace. Used by
  // the AgentManager admin page's per-row workspace picker so pre-existing
  // agents created against a global manager can be relocated to the
  // workspace they actually belong to without recreating them.
  setManagedAgentWorkspace: (agentId: string, workspaceId: string) =>
    request<Agent>(`/admin/agent-manager/agents/${encodeURIComponent(agentId)}/workspace`, {
      method: 'PATCH',
      body: JSON.stringify({ workspace_id: workspaceId }),
    }),

  // ─── Admin Logs ────────────────────────────────────────
  getLogs: (params?: { level?: string; category?: string; since?: string; until?: string; limit?: number; search?: string }) => {
    const qs = new URLSearchParams();
    if (params?.level) qs.set('level', params.level);
    if (params?.category) qs.set('category', params.category);
    if (params?.since) qs.set('since', params.since);
    if (params?.until) qs.set('until', params.until);
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.search) qs.set('search', params.search);
    const q = qs.toString();
    return request<any[]>(`/admin/logs${q ? '?' + q : ''}`);
  },
  getLogStats: () => request<any>('/admin/logs/stats'),
  getLogCategories: () => request<string[]>('/admin/logs/categories'),

  // ─── Live SSE connection detail per agent_id ───────────
  // Returns the array of live proxy SSE sessions per agent, each entry
  // carrying connect timestamp + peer IP + user-agent + boardId scope.
  // The Agent Details modal renders the list so the user can spot
  // multi-proxy situations directly — e.g., distinguish "two terminals
  // on this host" from "one Claude CLI internally opening two streams"
  // by looking at the IPs and connect times. Empty / missing entry = 0
  // proxies for that agent (modal treats it as offline).
  getActiveAgentSessions: () =>
    request<Record<string, AgentProxySession[]>>('/events/active-agent-sessions'),

  // Pin a specific SSE session as the routing target for an agent. Used by
  // the Agent Details panel when the user has 2+ proxies connected and wants
  // to direct ticket triggers + chat events to a specific terminal.
  setAgentMainSession: (agentId: string, sessionId: string) =>
    request<{ ok: boolean; agent_id?: string; session_id?: string; error?: string }>(
      `/events/active-agent-sessions/${encodeURIComponent(agentId)}/main`,
      { method: 'POST', body: JSON.stringify({ session_id: sessionId }) },
    ),
  // Clear the user-pinned main; routing falls back to oldest-connected.
  clearAgentMainSession: (agentId: string) =>
    request<{ ok: boolean; agent_id?: string }>(
      `/events/active-agent-sessions/${encodeURIComponent(agentId)}/main`,
      { method: 'DELETE' },
    ),

  // ─── Admin Agent Logs (Phase C) ────────────────────────
  listAgentLogs: (params: { agent_id?: string; level?: string; category?: string; since?: string; until?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.agent_id) q.set('agent_id', params.agent_id);
    if (params.level) q.set('level', params.level);
    if (params.category) q.set('category', params.category);
    if (params.since) q.set('since', params.since);
    if (params.until) q.set('until', params.until);
    if (params.limit) q.set('limit', String(params.limit));
    const qs = q.toString();
    return request<AgentErrorLog[]>(`/admin/agent-logs${qs ? '?' + qs : ''}`);
  },
  listAgentLogAgents: () =>
    request<AgentErrorLogAgentSummary[]>('/admin/agent-logs/agents'),

  // ─── Admin Settings ────────────────────────────────────
  getSettings: () =>
    request<{ key: string; value: string; description: string; is_secret: boolean; updated_at: string | null }[]>('/admin/settings'),
  updateSettings: (settings: Record<string, string>) =>
    request<any>('/admin/settings', { method: 'PATCH', body: JSON.stringify({ settings }) }),

  // ── Phase 7: Chat Rooms ─────────────────────────
  listChatRooms: (scope?: 'workspace') =>
    request<ChatRoomListItem[]>(scope === 'workspace' ? '/chat-rooms?scope=workspace' : '/chat-rooms'),

  createChatRoom: (participants: { participant_type: string; participant_id: string }[], name?: string) =>
    request<ChatRoomDetail>('/chat-rooms', {
      method: 'POST',
      body: JSON.stringify({ participants, name }),
    }),

  getChatRoom: (roomId: string, observer = false) =>
    request<ChatRoomDetail>(`/chat-rooms/${roomId}${observer ? '?observer=true' : ''}`),

  getChatRoomMessages: (roomId: string, limit = 50, before?: string, observer = false) => {
    const parts = [`limit=${limit}`];
    if (before) parts.push(`before=${before}`);
    if (observer) parts.push('observer=true');
    return request<ChatRoomMessageItem[]>(
      `/chat-rooms/${roomId}/messages?${parts.join('&')}`,
    );
  },

  sendChatRoomMessage: (roomId: string, content: string, images?: Array<{ data: string; filename: string; mimetype: string }>) =>
    request<ChatRoomMessageItem>(`/chat-rooms/${roomId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content, images: images || [] }),
    }),

  markChatRoomRead: (roomId: string) =>
    request<void>(`/chat-rooms/${roomId}/read`, { method: 'PATCH' }),

  renameChatRoom: (roomId: string, name: string) =>
    request<void>(`/chat-rooms/${roomId}/name`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),

  addChatRoomParticipants: (roomId: string, participants: { participant_type: string; participant_id: string }[]) =>
    request<void>(`/chat-rooms/${roomId}/participants`, {
      method: 'POST',
      body: JSON.stringify({ participants }),
    }),

  leaveChatRoom: (roomId: string) =>
    request<void>(`/chat-rooms/${roomId}/participants/me`, { method: 'DELETE' }),

  searchChatMessages: (workspaceId: string, query: string): Promise<any[]> =>
    request<any[]>(`/chat-rooms/search?q=${encodeURIComponent(query)}&workspace_id=${encodeURIComponent(workspaceId)}`),

  // ─── @-Mentions ─────────────────────────────────────────
  getMentionCandidates: (
    workspaceId: string,
    ticketId?: string,
  ): Promise<MentionCandidatesResponse> => {
    const qs = ticketId ? `?ticket_id=${encodeURIComponent(ticketId)}` : '';
    return request<MentionCandidatesResponse>(
      `/workspaces/${encodeURIComponent(workspaceId)}/mention-candidates${qs}`,
    );
  },

  getUnreadMentions: (workspaceId: string): Promise<UnreadMentionsResponse> =>
    request<UnreadMentionsResponse>(`/workspaces/${encodeURIComponent(workspaceId)}/mentions/unread`),

  markMentionRead: (mentionId: string): Promise<UserMentionItem> =>
    request<UserMentionItem>(`/mentions/${encodeURIComponent(mentionId)}/read`, { method: 'POST' }),

  markAllMentionsRead: (workspaceId: string): Promise<{ updated: number }> =>
    request<{ updated: number }>(
      `/workspaces/${encodeURIComponent(workspaceId)}/mentions/read-all`,
      { method: 'POST' },
    ),

  // ─── Badge count endpoints ───────────────────────────────
  // Lightweight counts used by the sidebar NotificationContext. Workspace
  // scope is resolved server-side from the X-Workspace-Id header, which
  // getAuthHeaders() pulls from localStorage — no explicit workspaceId
  // parameter is needed here. Each endpoint returns `{ count }` or
  // `{ total, perX }` so the client bookkeeping stays uniform.
  getChatUnreadCounts: (): Promise<{ total: number; perRoom: Record<string, number> }> =>
    request<{ total: number; perRoom: Record<string, number> }>('/chat-rooms/unread-counts'),
  getTicketUnreadCounts: (): Promise<{ total: number; perTicket: Record<string, number>; perBoard: Record<string, number> }> =>
    request<{ total: number; perTicket: Record<string, number>; perBoard: Record<string, number> }>('/tickets/unread-counts'),
  getPendingUsersCount: (): Promise<{ count: number }> =>
    request<{ count: number }>('/admin/pending-users/count'),
  getAgentErrorsUnseenCount: (since?: string | null): Promise<{ count: number }> => {
    const qs = since ? `?since=${encodeURIComponent(since)}` : '';
    return request<{ count: number }>(`/admin/agent-logs/unseen-count${qs}`);
  },
};

// ─── Ticket role assignment types ─────────────────────────
export interface TicketRoleAssignmentRow {
  role: { id: string; slug: string; name: string; position: number; is_builtin: boolean };
  holder: { type: 'agent' | 'user'; id: string; name: string } | null;
}

// ─── Mention types ───────────────────────────────────────
export interface MentionCandidatesResponse {
  users: Array<{ id: string; name: string; avatar_url: string }>;
  // ST-7: agent rows carry manager_name when supervised by an
  // agent-manager so the mention autocompleter can render them as
  // <ManagerName>/<AgentName>.
  agents: Array<{
    id: string;
    name: string;
    avatar_url: string;
    manager_agent_id?: string | null;
    manager_name?: string | null;
  }>;
  // v0.34: workspace roles can resolve to agents *or* users now.
  role_shortcuts: Array<{ key: string; label: string; resolved_type: 'agent' | 'user'; resolved_id: string }>;
}

export interface UserMentionItem {
  id: string;
  user_id: string;
  workspace_id: string;
  source_type: 'comment' | 'chat_message';
  source_id: string;
  ticket_id: string | null;
  // Resolved board for comment mentions (server-side join through
  // Ticket → BoardColumn). Null for chat mentions — those deep-link via
  // room_id instead. Used by MentionInboxBadge to build a navigable URL.
  board_id: string | null;
  room_id: string | null;
  actor_id: string;
  actor_type: 'user' | 'agent';
  actor_name: string;
  preview: string;
  created_at: string;
  read_at: string | null;
}

export interface UnreadMentionsResponse {
  count: number;
  items: UserMentionItem[];
}
