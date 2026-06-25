import type {
  PromptTemplate,
  Resource,
  Action,
  ActionRun,
  QaScenario,
  QaScenarioListItem,
  QaRun,
  QaRunBatch,
  QaSchedule,
  QaScheduleScope,
  SecurityProfile,
  SecurityProfileListItem,
  SecurityRun,
  SecurityRunBatch,
  SecuritySchedule,
  SecurityScheduleScope,
  Credential,
  ChatMessage,
  ChatThread,
  DashboardAgent,
  AgentDetail,
  ActivityRow,
  ChatRoomListItem,
  ChatRoomDetail,
  ChatAttachment,
  ChatRoomMessageItem,
  ChatRoomParticipantInfo,
  AgentErrorLog,
  AgentErrorLogAgentSummary,
  FsListResult,
  FsStatResult,
  FsReadResult,
  FsRootsResult,
  FsDrivesResult,
  FsMkdirResult,
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
  TicketPrerequisiteRow,
  UserNotificationChannel,
  BoardWithCards,
  BoardMovePreview,
  AgentMovePreview,
  AgentApiKeyPolicy,
  AgentCrossRefPolicy,
  BenchmarkRunDetail,
  HarnessConfig,
  EffortPresetsConfig,
  Comment,
  RepoRefs,
  RepoCommitSummary,
  RepoCommitDetail,
  RepoTreeEntry,
  RepoFileContent,
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

// Build a URL for the binary streaming endpoint (GET /api/resources/:id/raw).
// Used directly as an <img>/<video> src — those tags can't send an
// Authorization header, so the session token rides in the query string
// (the /raw route accepts header OR ?token=). Pass { download: true } to get
// an attachment Content-Disposition for download links.
export function rawResourceUrl(id: string, opts?: { download?: boolean }): string {
  const token = (() => { try { return localStorage.getItem('auth_token') || ''; } catch { return ''; } })();
  const params = new URLSearchParams();
  if (token) params.set('token', token);
  if (opts?.download) params.set('download', '1');
  const qs = params.toString();
  return `${BASE}/resources/${id}/raw${qs ? `?${qs}` : ''}`;
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
  updateWorkspace: (id: string, data: { name?: string; description?: string; harness_config?: HarnessConfig | null }) =>
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
  // Returns the lightened board payload — each ticket's `comments` is the
  // narrow BoardCardComment projection, not the full thread (perf ticket
  // b3812637). The detail panel fetches the full Ticket via getTicket.
  getBoard: (id: string) => request<BoardWithCards>(`/boards/${id}`),
  getBoardFocusTickets: (boardId: string) =>
    request<{ focus_tickets: Array<{ agent_id: string; agent_name: string; role: string; ticket_id: string }> }>(
      `/boards/${boardId}/focus-tickets`,
    ),
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
      self_improvement_mode?: 'off' | 'same_board' | 'remote_awb' | 'both';
      benchmark_mode?: 'off' | 'on';
      auto_archive_days?: number | null;
      harness_config?: HarnessConfig | null;
      // Abstract effort presets (per-CLI option mapping). null clears the
      // board override; the server falls back to BUILTIN_EFFORT_PRESETS.
      effort_presets?: EffortPresetsConfig | null;
      // Per-board output language (i18n). Empty string / null clears the
      // override (agents fall back to their default, English).
      language?: string | null;
    },
  ) =>
    request<any>(`/boards/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  // Benchmark leaderboard reads (ticket 684c012b). Run-scoped aggregation
  // (per-candidate score table) when runTicketId is given; workspace-wide
  // agent leaderboard otherwise.
  getBenchmarkRunLeaderboard: (runTicketId: string) =>
    request<any>(`/benchmark/runs/${runTicketId}/leaderboard`),
  getBenchmarkLeaderboard: (workspaceId?: string) =>
    request<any>(workspaceId ? `/benchmark/leaderboard?workspace_id=${workspaceId}` : '/benchmark/leaderboard'),
  // Benchmark run lifecycle (ticket 5eb459c4). createBenchmarkRun makes a DRAFT
  // (candidates parked, not dispatched); startBenchmarkRun dispatches them. The
  // Option-A edit policy is enforced server-side — updateBenchmarkRun on a
  // started run rejects prompt/rubric/evaluator changes + candidate removal (422).
  getBenchmarkRun: (runId: string) =>
    request<BenchmarkRunDetail>(`/benchmark/runs/${runId}`),
  createBenchmarkRun: (data: {
    board_id: string;
    prompt: string;
    title?: string;
    rubric?: string;
    base_repo?: string;
    candidate_agent_ids?: string[];
    evaluator_agent_ids?: string[];
    candidate_column_name?: string;
  }) =>
    request<BenchmarkRunDetail>('/benchmark/runs', { method: 'POST', body: JSON.stringify(data) }),
  updateBenchmarkRun: (runId: string, data: {
    title?: string;
    prompt?: string;
    rubric?: string;
    base_repo?: string;
    candidate_agent_ids?: string[];
    evaluator_agent_ids?: string[];
    candidate_column_name?: string;
  }) =>
    request<BenchmarkRunDetail>(`/benchmark/runs/${runId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  startBenchmarkRun: (runId: string) =>
    request<BenchmarkRunDetail>(`/benchmark/runs/${runId}/start`, { method: 'POST' }),
  addBenchmarkCandidates: (runId: string, candidateAgentIds: string[]) =>
    request<BenchmarkRunDetail>(`/benchmark/runs/${runId}/candidates`, {
      method: 'POST',
      body: JSON.stringify({ candidate_agent_ids: candidateAgentIds }),
    }),
  deleteBoard: (id: string) =>
    request<any>(`/boards/${id}`, { method: 'DELETE' }),
  // Cross-workspace board move (ticket 8882056b). dry_run=true (default)
  // returns the BoardMovePreview report without writing; dry_run=false commits
  // atomically. Admin-only on the server. A blocked commit rejects with 409.
  moveBoard: (
    boardId: string,
    targetWorkspaceId: string,
    opts?: { dryRun?: boolean; carryAgents?: boolean; excludeAgentIds?: string[] },
  ) =>
    request<BoardMovePreview>(`/boards/${boardId}/move-to-workspace`, {
      method: 'POST',
      body: JSON.stringify({
        target_workspace_id: targetWorkspaceId,
        dry_run: opts?.dryRun !== false,
        carry_agents: !!opts?.carryAgents,
        // ticket 9efa643b — per-agent carry exclusion (drop_companion_agent remedy)
        exclude_agent_ids: opts?.excludeAgentIds ?? [],
      }),
    }),
  // ticket 9efa643b — execute a structured move-blocker remedy inline from the
  // board-move preview. Returns { ok, action, affected }; the UI re-previews
  // afterward so the resolved blocker disappears.
  moveBoardRemedy: (boardId: string, action: string, params: Record<string, any>) =>
    request<{ ok: boolean; action: string; affected: number }>(
      `/boards/${boardId}/move-to-workspace/remedy`,
      { method: 'POST', body: JSON.stringify({ action, params }) },
    ),
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
  // Archived-ticket surface — distinct from board archive (Board.archived_at)
  // and the active ticket list (which filters archived_at IS NOT NULL).
  listArchivedTickets: async (
    boardId: string,
    opts?: { cursor?: string; limit?: number; q?: string },
  ) => {
    const params = new URLSearchParams();
    if (opts?.cursor) params.set('cursor', opts.cursor);
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.q) params.set('q', opts.q);
    const qs = params.toString();
    return request<{ tickets: any[]; next_cursor: string | null }>(
      `/boards/${boardId}/archived-tickets${qs ? `?${qs}` : ''}`,
    );
  },
  archiveTicket: async (ticketId: string) =>
    request<any>(`/tickets/${ticketId}/archive`, { method: 'POST' }),
  unarchiveTicket: async (ticketId: string) =>
    request<any>(`/tickets/${ticketId}/unarchive`, { method: 'POST' }),
  getTicket: async (ticketId: string) =>
    request<any>(`/tickets/${ticketId}`),
  // 티켓(root/하위)의 커서 페이지네이션 코멘트. `before` 는 코멘트 id 이고, 서버는
  // (created_at, id) 커서를 따라가 그보다 오래된 코멘트를 최신순으로 최대 `limit`개
  // 반환한다. detail 패널이 getTicket 의 첫 페이지 너머 더 오래된 코멘트를
  // scroll-load 할 때 쓴다.
  getTicketComments: async (ticketId: string, opts?: { limit?: number; before?: string }) => {
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set('limit', String(opts.limit));
    if (opts?.before) qs.set('before', opts.before);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<Comment[]>(`/tickets/${ticketId}/comments${suffix}`);
  },

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
    // Abstract effort preset id (resolved per-CLI at dispatch). null/omit = none.
    effort_preset?: string | null;
  }) =>
    request<any>(`/columns/${columnId}/tickets`, { method: 'POST', body: JSON.stringify(data) }),

  // data accepts any ticket field, incl. `effort_preset?: string | null`
  // (abstract effort preset id; null/'' clears the override).
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

  // ─── Ticket prerequisites (ticket 48d14fff) ────────────
  // The "blocked-by another ticket" M:N surface. add/remove return the full
  // updated ticket (loadTicketFull shape, incl. the refreshed `prerequisites`
  // array + pending_on_tickets flag) so the panel can update without a
  // follow-up GET.
  listPrerequisites: (ticketId: string) =>
    request<{ ticket_id: string; prerequisites: TicketPrerequisiteRow[] }>(
      `/tickets/${ticketId}/prerequisites`,
    ),

  addPrerequisites: (ticketId: string, prerequisite_ticket_ids: string[], reason?: string) =>
    request<any>(`/tickets/${ticketId}/prerequisites`, {
      method: 'POST',
      body: JSON.stringify({ prerequisite_ticket_ids, ...(reason ? { reason } : {}) }),
    }),

  removePrerequisite: (ticketId: string, prereqId: string) =>
    request<any>(`/tickets/${ticketId}/prerequisites/${prereqId}`, { method: 'DELETE' }),

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
  // Cross-workspace agent move (ticket 868ead64). dry_run=true (default)
  // returns the AgentMovePreview report without writing; dry_run=false commits
  // atomically. Admin-only on the server. A blocked commit rejects with 409.
  moveAgent: (
    agentId: string,
    targetWorkspaceId: string,
    opts?: { dryRun?: boolean; apiKeyPolicy?: AgentApiKeyPolicy; crossRefPolicy?: AgentCrossRefPolicy },
  ) =>
    request<AgentMovePreview>(`/agents/${encodeURIComponent(agentId)}/move-to-workspace`, {
      method: 'POST',
      body: JSON.stringify({
        target_workspace_id: targetWorkspaceId,
        dry_run: opts?.dryRun !== false,
        api_key_policy: opts?.apiKeyPolicy ?? 'migrate',
        cross_ref_policy: opts?.crossRefPolicy ?? 'block',
      }),
    }),
  // ticket 9efa643b — execute a structured move-blocker remedy inline from the
  // agent-move preview. Same executor as moveBoardRemedy, scoped to the agent
  // route. The UI re-previews afterward so the resolved blocker disappears.
  moveAgentRemedy: (agentId: string, action: string, params: Record<string, any>) =>
    request<{ ok: boolean; action: string; affected: number }>(
      `/agents/${encodeURIComponent(agentId)}/move-to-workspace/remedy`,
      { method: 'POST', body: JSON.stringify({ action, params }) },
    ),
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
  // Create a directory on the agent machine. `path` is the existing parent;
  // `name` is a single segment for the new folder (server rejects separators).
  // Returns the new directory's stat snapshot on 200; 409 EEXIST when it
  // already exists; 403 SCOPE_DENIED when the parent is outside scope.
  mkdirAgentFs: (agentId: string, path: string, name: string): Promise<FsMkdirResult> =>
    request<FsMkdirResult>(`/agents/${encodeURIComponent(agentId)}/fs/mkdir`, {
      method: 'POST',
      body: JSON.stringify({ path, name }),
    }),
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
  listResources: (
    workspaceId: string,
    boardId?: string | null,
    type?: string,
    sort?: { by?: string; order?: 'asc' | 'desc' },
  ) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    if (boardId !== undefined) params.set('board_id', boardId || '');
    if (type) params.set('type', type);
    if (sort?.by) params.set('sort_by', sort.by);
    if (sort?.order) params.set('sort_order', sort.order);
    return request<Resource[]>(`/resources?${params.toString()}`);
  },
  getResource: (id: string) =>
    request<Resource>(`/resources/${id}`),
  // Upload a file as a Resource by streaming the raw bytes (NOT base64-in-JSON)
  // so large media bypasses the 10MB JSON body limit. Returns metadata only —
  // the bytes are then referenced from a comment via attachment_resource_ids
  // and rendered through the /raw streaming endpoint (ticket ff3e7337).
  uploadResourceFile: async (
    file: File,
    opts: { workspace_id: string; board_id?: string | null; type?: string },
  ): Promise<{ id: string; file_name: string; file_mimetype: string; size: number }> => {
    const params = new URLSearchParams({ workspace_id: opts.workspace_id });
    if (opts.board_id) params.set('board_id', opts.board_id);
    params.set('type', opts.type || 'comment_attachment');
    const token = (() => { try { return localStorage.getItem('auth_token'); } catch { return null; } })();
    const headers: Record<string, string> = {
      'Content-Type': file.type || 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name),
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (_activeWorkspaceId) headers['X-Workspace-Id'] = _activeWorkspaceId;
    const res = await fetch(`${BASE}/resources/upload?${params.toString()}`, {
      method: 'POST',
      headers,
      body: file,
    });
    if (!res.ok) {
      if (res.status === 401) {
        localStorage.removeItem('auth_token');
        window.dispatchEvent(new Event('auth-expired'));
      }
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Upload failed');
    }
    return res.json();
  },
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

  // ─── repository git reading (history / diff / file tree) ──────────────
  // All read from the server's per-Resource bare blobless cache clone. SSH-only
  // URLs come back as HTTP 422 (code 'ssh_unsupported') — `request` throws the
  // error message, which the panel renders as a degrade notice.
  getRepoRefs: (id: string, workspaceId: string, refresh = false) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    if (refresh) params.set('refresh', 'true');
    return request<RepoRefs>(`/resources/${id}/refs?${params.toString()}`);
  },
  // Cursor pagination: pass the last shown sha as `before` to load older commits.
  listRepoCommits: (
    id: string,
    workspaceId: string,
    opts?: { ref?: string; limit?: number; before?: string; refresh?: boolean },
  ) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    if (opts?.ref) params.set('ref', opts.ref);
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.before) params.set('before', opts.before);
    if (opts?.refresh) params.set('refresh', 'true');
    return request<{ commits: RepoCommitSummary[] }>(`/resources/${id}/commits?${params.toString()}`);
  },
  getRepoCommit: (id: string, workspaceId: string, sha: string) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    return request<RepoCommitDetail>(`/resources/${id}/commits/${encodeURIComponent(sha)}?${params.toString()}`);
  },
  getRepoTree: (id: string, workspaceId: string, opts?: { ref?: string; path?: string }) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    if (opts?.ref) params.set('ref', opts.ref);
    if (opts?.path) params.set('path', opts.path);
    return request<{ ref: string; path: string; entries: RepoTreeEntry[] }>(
      `/resources/${id}/tree?${params.toString()}`,
    );
  },
  getRepoFile: (id: string, workspaceId: string, filePath: string, ref?: string) => {
    const params = new URLSearchParams({ workspace_id: workspaceId, path: filePath });
    if (ref) params.set('ref', ref);
    return request<RepoFileContent>(`/resources/${id}/file?${params.toString()}`);
  },

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
    trigger?: string;
    trigger_label?: string;
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
      trigger?: string;
      trigger_label?: string;
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

  // ─── Scenario-based QA (ticket 3c655d20) ──────────────
  listQaScenarios: (workspaceId: string, boardId?: string | null) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    if (boardId !== undefined) params.set('board_id', boardId || '');
    return request<QaScenarioListItem[]>(`/qa/scenarios?${params.toString()}`);
  },
  getQaScenario: (id: string) => request<QaScenario>(`/qa/scenarios/${id}`),
  createQaScenario: (data: {
    workspace_id: string;
    board_id?: string | null;
    name: string;
    description?: string;
    steps?: QaScenario['steps'];
    target_agent_id: string;
    qa_driver?: string;
    qa_driver_config?: Record<string, any> | null;
    enabled?: boolean;
    tags?: string[];
    on_failure_ticket?: QaScenario['on_failure_ticket'];
    max_runs?: number;
  }) => request<QaScenario>('/qa/scenarios', { method: 'POST', body: JSON.stringify(data) }),
  updateQaScenario: (
    id: string,
    data: {
      workspace_id: string;
      name?: string;
      description?: string;
      steps?: QaScenario['steps'];
      target_agent_id?: string;
      board_id?: string | null;
      qa_driver?: string;
      qa_driver_config?: Record<string, any> | null;
      enabled?: boolean;
      tags?: string[];
      on_failure_ticket?: QaScenario['on_failure_ticket'];
      max_runs?: number;
    },
  ) => request<QaScenario>(`/qa/scenarios/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteQaScenario: (id: string, workspaceId: string) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    return request<{ success: true; id: string }>(`/qa/scenarios/${id}?${params.toString()}`, { method: 'DELETE' });
  },
  runQaScenario: (id: string) =>
    request<{ run_id: string; room_id: string; prompt: string }>(`/qa/scenarios/${id}/run`, { method: 'POST', body: '{}' }),
  listQaRuns: (id: string, workspaceId: string, limit = 20) => {
    const params = new URLSearchParams({ workspace_id: workspaceId, limit: String(limit) });
    return request<QaRun[]>(`/qa/scenarios/${id}/runs?${params.toString()}`);
  },
  getQaRun: (runId: string, workspaceId: string) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    return request<QaRun>(`/qa/runs/${runId}?${params.toString()}`);
  },
  // ─── Sequential QA batches (ticket daf06262) ──────────
  // scenario_ids[] OR all (→ enabled scenarios in scope). Only the first
  // scenario dispatches now; the rest run one-at-a-time as each finalizes.
  startQaBatch: (data: {
    workspace_id: string;
    board_id?: string | null;
    scenario_ids?: string[];
    all?: boolean;
    stop_on_fail?: boolean;
  }) => request<QaRunBatch>('/qa/batches', { method: 'POST', body: JSON.stringify(data) }),
  getQaBatch: (batchId: string, workspaceId: string) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    return request<QaRunBatch>(`/qa/batches/${batchId}?${params.toString()}`);
  },

  // ─── QA schedules (ticket b6bb7efd) ──────────────────
  // Automatic trigger layer: when due, the server kicks a sequential batch via
  // the same orchestrator as startQaBatch. Exactly one of cron / interval_ms.
  listQaSchedules: (workspaceId: string, boardId?: string | null) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    if (boardId !== undefined && boardId !== null) params.set('board_id', boardId);
    return request<QaSchedule[]>(`/qa/schedules?${params.toString()}`);
  },
  createQaSchedule: (data: {
    workspace_id: string;
    board_id?: string | null;
    name: string;
    scope?: QaScheduleScope;
    scenario_ids?: string[];
    cron?: string | null;
    interval_ms?: number | null;
    enabled?: boolean;
    stop_on_fail?: boolean;
  }) => request<QaSchedule>('/qa/schedules', { method: 'POST', body: JSON.stringify(data) }),
  updateQaSchedule: (
    id: string,
    data: {
      workspace_id: string;
      board_id?: string | null;
      name?: string;
      scope?: QaScheduleScope;
      scenario_ids?: string[];
      cron?: string | null;
      interval_ms?: number | null;
      enabled?: boolean;
      stop_on_fail?: boolean;
    },
  ) => request<QaSchedule>(`/qa/schedules/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteQaSchedule: (id: string, workspaceId: string) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    return request<{ success: true; id: string }>(`/qa/schedules/${id}?${params.toString()}`, { method: 'DELETE' });
  },
  runQaScheduleNow: (id: string, workspaceId: string) =>
    request<{ schedule: QaSchedule; batch: QaRunBatch }>(`/qa/schedules/${id}/run-now`, {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId }),
    }),

  // ─── Security inspection (보안 점검 — ticket cfd74638 foundation) ──────────
  // Sibling of scenario QA: profile CRUD + run dispatch + history + sequential
  // batches + schedules. Run-result recording (findings, complete) is agent-only
  // via MCP, so it is intentionally not exposed over REST.
  listSecurityProfiles: (workspaceId: string, boardId?: string | null) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    if (boardId !== undefined) params.set('board_id', boardId || '');
    return request<SecurityProfileListItem[]>(`/security/profiles?${params.toString()}`);
  },
  getSecurityProfile: (id: string) => request<SecurityProfile>(`/security/profiles/${id}`),
  createSecurityProfile: (data: {
    workspace_id: string;
    board_id?: string | null;
    name: string;
    description?: string;
    checklist?: SecurityProfile['checklist'];
    target_agent_id: string;
    target_resource_id?: string | null;
    scan_driver?: string;
    scan_driver_config?: Record<string, any> | null;
    scope_mode?: SecurityProfile['scope_mode'];
    enabled?: boolean;
    tags?: string[];
    on_failure_ticket?: SecurityProfile['on_failure_ticket'];
    max_runs?: number;
  }) => request<SecurityProfile>('/security/profiles', { method: 'POST', body: JSON.stringify(data) }),
  updateSecurityProfile: (
    id: string,
    data: {
      workspace_id: string;
      name?: string;
      description?: string;
      checklist?: SecurityProfile['checklist'];
      target_agent_id?: string;
      target_resource_id?: string | null;
      board_id?: string | null;
      scan_driver?: string;
      scan_driver_config?: Record<string, any> | null;
      scope_mode?: SecurityProfile['scope_mode'];
      enabled?: boolean;
      tags?: string[];
      on_failure_ticket?: SecurityProfile['on_failure_ticket'];
      max_runs?: number;
    },
  ) => request<SecurityProfile>(`/security/profiles/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteSecurityProfile: (id: string, workspaceId: string) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    return request<{ success: true; id: string }>(`/security/profiles/${id}?${params.toString()}`, { method: 'DELETE' });
  },
  // Dispatch a "refresh the checklist with the latest security info" task — no
  // SecurityRun row, the agent WebSearches and writes the checklist back.
  refreshSecurityChecklist: (id: string) =>
    request<{ profile_id: string; room_id: string; prompt: string }>(`/security/profiles/${id}/refresh-checklist`, { method: 'POST', body: '{}' }),
  runSecurityProfile: (id: string) =>
    request<{ run_id: string; room_id: string; prompt: string }>(`/security/profiles/${id}/run`, { method: 'POST', body: '{}' }),
  listSecurityRuns: (id: string, workspaceId: string, limit = 20) => {
    const params = new URLSearchParams({ workspace_id: workspaceId, limit: String(limit) });
    return request<SecurityRun[]>(`/security/profiles/${id}/runs?${params.toString()}`);
  },
  getSecurityRun: (runId: string, workspaceId: string) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    return request<SecurityRun>(`/security/runs/${runId}?${params.toString()}`);
  },
  // ─── Sequential security batches ──────────────────────
  startSecurityBatch: (data: {
    workspace_id: string;
    board_id?: string | null;
    profile_ids?: string[];
    all?: boolean;
    stop_on_fail?: boolean;
  }) => request<SecurityRunBatch>('/security/batches', { method: 'POST', body: JSON.stringify(data) }),
  getSecurityBatch: (batchId: string, workspaceId: string) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    return request<SecurityRunBatch>(`/security/batches/${batchId}?${params.toString()}`);
  },
  // ─── Security schedules ───────────────────────────────
  listSecuritySchedules: (workspaceId: string, boardId?: string | null) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    if (boardId !== undefined && boardId !== null) params.set('board_id', boardId);
    return request<SecuritySchedule[]>(`/security/schedules?${params.toString()}`);
  },
  createSecuritySchedule: (data: {
    workspace_id: string;
    board_id?: string | null;
    name: string;
    scope?: SecurityScheduleScope;
    profile_ids?: string[];
    cron?: string | null;
    interval_ms?: number | null;
    enabled?: boolean;
    stop_on_fail?: boolean;
  }) => request<SecuritySchedule>('/security/schedules', { method: 'POST', body: JSON.stringify(data) }),
  updateSecuritySchedule: (
    id: string,
    data: {
      workspace_id: string;
      board_id?: string | null;
      name?: string;
      scope?: SecurityScheduleScope;
      profile_ids?: string[];
      cron?: string | null;
      interval_ms?: number | null;
      enabled?: boolean;
      stop_on_fail?: boolean;
    },
  ) => request<SecuritySchedule>(`/security/schedules/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteSecuritySchedule: (id: string, workspaceId: string) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    return request<{ success: true; id: string }>(`/security/schedules/${id}?${params.toString()}`, { method: 'DELETE' });
  },
  runSecurityScheduleNow: (id: string, workspaceId: string) =>
    request<{ schedule: SecuritySchedule; batch: SecurityRunBatch }>(`/security/schedules/${id}/run-now`, {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId }),
    }),

  // ─── Credentials ──────────────────────────────────────
  // A workspace list also returns inherited global credentials (scope:'global').
  // Pass scope:'global' (no workspace_id) for the Admin global-credentials page.
  listCredentials: (workspaceId?: string, opts?: { provider?: string; scope?: 'global' }) => {
    const params = new URLSearchParams();
    if (workspaceId) params.set('workspace_id', workspaceId);
    if (opts?.provider) params.set('provider', opts.provider);
    if (opts?.scope) params.set('scope', opts.scope);
    return request<Credential[]>(`/credentials?${params.toString()}`);
  },
  getCredentialProviders: () =>
    request<Record<string, { label: string; fields: string[] }>>('/credentials/providers'),
  createCredential: (data: {
    // Omit workspace_id and pass scope:'global' to create an instance-level
    // credential (requires the MANAGE_GLOBAL_CREDENTIALS permission).
    workspace_id?: string;
    scope?: 'global';
    name: string;
    description?: string;
    provider: string;
    credentials: Record<string, string>;
  }) =>
    request<Credential>('/credentials', { method: 'POST', body: JSON.stringify(data) }),
  updateCredential: (
    id: string,
    data: {
      workspace_id?: string;
      name?: string;
      description?: string;
      provider?: string;
      credentials?: Record<string, string>;
    },
  ) =>
    request<Credential>(`/credentials/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteCredential: (id: string, workspaceId?: string) => {
    const params = new URLSearchParams();
    if (workspaceId) params.set('workspace_id', workspaceId);
    const qs = params.toString();
    return request<{ success: true; id: string }>(`/credentials/${id}${qs ? `?${qs}` : ''}`, { method: 'DELETE' });
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
  // Reap+respawn every agent the manager supervises, in place (no process
  // re-exec). Flows through the generic command endpoint — the verb takes no
  // args. Returns the 202 dispatch ack only; the per-agent restart count lands
  // in the async ack (server-logged), so the UI shows the target count instead.
  restartAllAgents: (instanceId: string) =>
    request<AgentManagerCommandResult>(
      `/admin/agent-manager/instances/${encodeURIComponent(instanceId)}/command`,
      { method: 'POST', body: JSON.stringify({ command: 'restart_all_agents' }) },
    ),

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
  // claude/codex/antigravity/custom whitelist, (2) manager_agent_id is sanity-
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
  // Probe the configured remote AWB target for self-improvement filing.
  // Pings the remote /api/health with the stored X-Agent-Key server-side so
  // the admin can verify URL + key before relying on the forwarder. Returns
  // the same shape the controller emits — never echoes the key back.
  testSelfImprovementRemote: () =>
    request<{ ok: boolean; status?: number; message: string }>(
      '/admin/settings/self-improvement/test',
      { method: 'POST', body: '{}' },
    ),
  // Cascade discovery — used by the SettingsManager workspace/board/column
  // dropdowns. `url` empty (or matching the current origin) routes to local
  // DB; otherwise the request body is forwarded over MCP to the remote
  // instance. `api_key` may be omitted/masked when targeting self or when
  // the admin hasn't edited the saved key (server falls back to the stored
  // encrypted value in that case).
  discoverSelfImprovementWorkspaces: (body: { url?: string; api_key?: string }) =>
    request<{ mode: 'local' | 'remote'; items: { id: string; name: string }[] }>(
      '/admin/settings/self-improvement/discover/workspaces',
      { method: 'POST', body: JSON.stringify(body) },
    ),
  discoverSelfImprovementBoards: (body: { url?: string; api_key?: string; workspace_id: string }) =>
    request<{ mode: 'local' | 'remote'; items: { id: string; name: string }[] }>(
      '/admin/settings/self-improvement/discover/boards',
      { method: 'POST', body: JSON.stringify(body) },
    ),
  discoverSelfImprovementColumns: (body: { url?: string; api_key?: string; board_id: string }) =>
    request<{ mode: 'local' | 'remote'; items: { id: string; name: string }[] }>(
      '/admin/settings/self-improvement/discover/columns',
      { method: 'POST', body: JSON.stringify(body) },
    ),

  // ─── Admin Column Policies (ticket f886ada7) ───────────
  listColumnPolicies: () =>
    request<{ boards: Array<{
      board_id: string;
      board_name: string;
      workspace_id: string;
      columns: Array<{
        id: string;
        name: string;
        position: number;
        kind: string;
        is_terminal: boolean;
        role_routing: string[];
        policies: Array<{
          id: string;
          board_id: string;
          column_id: string;
          role_slug: string;
          expected_action: 'move' | 'wait_until_label_removed' | 'terminal';
          target_column_id: string;
          gate_labels: string[];
          max_cycles_without_progress: number;
          on_violation: 'alert' | 'auto_move' | 'escalate_meta_ticket';
          enabled: boolean;
          created_at: string;
          updated_at: string;
        }>;
      }>;
    }> }>('/admin/column-policies'),

  updateColumnPolicy: (policyId: string, patch: {
    enabled?: boolean;
    max_cycles_without_progress?: number;
    on_violation?: 'alert' | 'auto_move' | 'escalate_meta_ticket';
    expected_action?: 'move' | 'wait_until_label_removed' | 'terminal';
    target_column_id?: string;
    gate_labels?: string[];
  }) =>
    request<{ success: boolean; policy: any }>(`/admin/column-policies/${policyId}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),

  // ── Phase 7: Chat Rooms ─────────────────────────
  listChatRooms: (scope?: 'workspace') =>
    request<ChatRoomListItem[]>(scope === 'workspace' ? '/chat-rooms?scope=workspace' : '/chat-rooms'),

  // Server returns `{ room: ChatRoomDetail, existing: boolean }` — unwrap so
  // callers can dereference `room.id` directly. (Pre-dedup-removal the
  // `existing` flag mattered to MCP callers; for the REST/UI flow same-member
  // rooms are no longer deduped, so the envelope is just legacy noise.)
  createChatRoom: async (
    participants: { participant_type: string; participant_id: string }[],
    name?: string,
  ): Promise<ChatRoomDetail> => {
    const result = await request<{ room: ChatRoomDetail; existing: boolean }>('/chat-rooms', {
      method: 'POST',
      body: JSON.stringify({ participants, name }),
    });
    return result.room;
  },

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

  sendChatRoomMessage: (
    roomId: string,
    content: string,
    images?: Array<{ data: string; filename: string; mimetype: string }>,
    attachmentIds?: string[],
  ) =>
    request<ChatRoomMessageItem>(`/chat-rooms/${roomId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content,
        images: images || [],
        attachment_ids: attachmentIds || [],
      }),
    }),

  // Pre-send upload — body carries one `{ file_name, file_mimetype, file_data }`
  // entry. Server stores it with owner_type='chat_room'; on send, the matching
  // attachment_id flips to owner_type='chat_message'. XHR is used so we can
  // surface a per-file upload progress bar in the chat input.
  uploadChatAttachment: (
    roomId: string,
    file: { file_name: string; file_mimetype: string; file_data: string },
    onProgress?: (pct: number) => void,
    signal?: AbortSignal,
  ): Promise<ChatAttachment> => {
    return new Promise<ChatAttachment>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${BASE}/chat-rooms/${roomId}/attachments`);
      const headers = getAuthHeaders();
      for (const [k, v] of Object.entries(headers)) {
        try { xhr.setRequestHeader(k, v); } catch { /* ignore */ }
      }
      if (xhr.upload && onProgress) {
        xhr.upload.onprogress = (e: ProgressEvent) => {
          if (e.lengthComputable) onProgress(Math.round((e.loaded * 100) / e.total));
        };
      }
      xhr.onload = () => {
        if (xhr.status === 401) {
          localStorage.removeItem('auth_token');
          window.dispatchEvent(new Event('auth-expired'));
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); }
          catch (e) { reject(new Error('Invalid upload response')); }
        } else {
          let msg = `Upload failed (${xhr.status})`;
          try {
            const body = JSON.parse(xhr.responseText);
            if (body?.error) msg = body.error;
          } catch { /* keep default */ }
          reject(new Error(msg));
        }
      };
      xhr.onerror = () => reject(new Error('Upload network error'));
      xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
      if (signal) {
        if (signal.aborted) { xhr.abort(); return; }
        signal.addEventListener('abort', () => xhr.abort(), { once: true });
      }
      xhr.send(JSON.stringify(file));
    });
  },

  deletePendingChatAttachment: (roomId: string, attachmentId: string) =>
    request<{ ok: boolean }>(`/chat-rooms/${roomId}/attachments/${attachmentId}`, {
      method: 'DELETE',
    }),

  // Fetch a single attachment with its base64 payload — used for image preview
  // rendering and file download (decoded into a Blob client-side).
  getChatAttachment: (roomId: string, attachmentId: string) =>
    request<ChatAttachment & { file_data: string }>(
      `/chat-rooms/${roomId}/attachments/${attachmentId}`,
    ),

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

  // Per-viewer "Clear conversation" (ticket 1ae77f55). Sets the caller's
  // cleared_at on the participant row — every subsequent listRooms /
  // getMessages call ignores older history for this user. Other participants
  // see the room unchanged.
  clearChatRoom: (roomId: string) =>
    request<{ ok: boolean; cleared_at: string }>(`/chat-rooms/${roomId}/messages`, {
      method: 'DELETE',
    }),

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
