import type { AgentTemplate } from './types';
import type { CliDescriptor } from './cli/catalog';
import type { HostModelsView } from './cli/hostModels';
import type {
  Resource,
  ClonePolicy,
  Action,
  ActionRun,
  WorkflowFunction,
  WorkflowFunctionRun,
  QaScenario,
  QaScenarioListItem,
  QaRun,
  QaRunBatch,
  Deployment,
  MigrationRun,
  QaSchedule,
  QaScheduleScope,
  AutomationSchedule,
  AutomationScheduleDispatch,
  SecurityProfile,
  SecurityProfileListItem,
  SecurityRun,
  SecurityRunBatch,
  SecuritySchedule,
  SecurityScheduleScope,
  SecurityScheduleKind,
  Credential,
  CliLoginInstanceOption,
  CliLoginSession,
  ChatMessage,
  ChatThread,
  DashboardAgent,
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
  AgentLiveSession,
  AgentManagerInstance,
  PrivilegedCommandRequest,
  PairingTokenMint,
  PairingTokenSafe,
  AgentManagerCommandKind,
  AgentManagerCommandOutcome,
  AgentManagerCommandResult,
  RuntimeParticipant,
  TicketAttachmentMeta,
  TicketPrerequisiteRow,
  UserNotificationChannel,
  HarnessConfig,
  QaPhasesConfig,
  Comment,
  Ticket,
  TicketStatus,
  TicketPriority,
  TicketListResponse,
  TicketTagCount,
  Project,
  ProjectInput,
  ProjectTestConnectionResult,
  RepoBranch,
  Account,
  RepoRefs,
  RepoCommitSummary,
  RepoCommitDetail,
  RepoTreeEntry,
  RepoFileContent,
  WorkflowHealthRollup,
  WorkflowHealthLongTermUsage,
  ClaudeBackendProfile,
  Skill,
  SkillDetail,
  SkillProposal,
  SkillSyncSummary,
  SkillTap,
  SkillVersion,
  HermesChildRun,
  OrchestrationTeam,
  OrchestrationMissionListItem,
  OrchestrationMissionDetail,
  OrchestrationTimelineEvent,
  OrchestrationRuntimeHost,
  OrchestrationSlotSpecInput,
  OntologyGraphStatusResponse,
  OntologyGraphRefreshResponse,
  OntologyGraphSnapshotResponse,
  OrchestrationPostActionCondition,
  OrchestrationRepoRef,
  OrchestrationConfirmDecision,
  OrchestrationConfirmPolicy,
  OrchestrationUserChatMode,
  OrchestrationStepStatus, OrchestrationStepSession, OrchestrationStepAttachment, OrchestrationEvidenceItem, AgentSessionHost, AgentSessionSummary, AgentSessionLiveSnapshot, AgentSessionDetail, AgentSessionCliSettings, TerminalHost, TerminalSummary, TerminalSnapshot, SessionProposal, VoiceConfigView, VoiceOperator, VoiceOptionView, VoiceTranscript, LibraryItem } from './types';
import type { ArtifactRefType } from './utils/artifactRef';
import { getApiBase } from './serverConfig';

// API 베이스는 PWA 서버 설정에 따라 바뀐다 — same-origin이면 '/api',
// 앱에서 다른 서버 주소를 입력했으면 '<base>/api'. 모듈 상수가 아니라
// 호출 시점에 읽는다(서버 전환 후 reload 없이도 다음 요청부터 반영).
function apiBase(): string {
  return getApiBase();
}

// The default ownership account is per-tab. Work URLs do not select it.
const SESSION_ACCOUNT_KEY = 'awb.activeAccountId';

export function bootstrapActiveAccountId(): string | null {
  if (typeof window === 'undefined') return null;
  // Restore this tab's settings selection before the new-tab default.
  try {
    const ss = sessionStorage.getItem(SESSION_ACCOUNT_KEY);
    if (ss) return ss;
  } catch { /* ignore */ }
  // Last-resort default for a new tab.
  try { return localStorage.getItem('currentAccountId'); } catch { return null; }
}

let _activeAccountId: string | null = bootstrapActiveAccountId();

export function setActiveAccountId(id: string | null): void {
  _activeAccountId = id;
  try {
    if (id) sessionStorage.setItem(SESSION_ACCOUNT_KEY, id);
    else sessionStorage.removeItem(SESSION_ACCOUNT_KEY);
  } catch { /* ignore */ }
}

export function getActiveAccountId(): string | null {
  return _activeAccountId;
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
  return `${apiBase()}/resources/${id}/raw${qs ? `?${qs}` : ''}`;
}

function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = localStorage.getItem('auth_token');
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (_activeAccountId) {
    headers['X-Account-Id'] = _activeAccountId;
  }
  return headers;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    headers: getAuthHeaders(),
    ...options,
  });
  if (!res.ok) {
    if (res.status === 401) {
      localStorage.removeItem('auth_token');
      window.dispatchEvent(new Event('auth-expired'));
    }
    const err = await res.json().catch(() => ({ error: res.statusText }));
    // Prefer the server's human-readable `message` (structured errors set it)
    // so toasts show a legible
    // reason instead of a machine slug; fall back to the `error` slug, then a
    // generic string. The machine-readable `code`/`error` slug + HTTP status are
    // preserved on the thrown error so callers can still branch on the *kind* of
    // failure instead of pattern-matching the message.
    const error = new Error(err.message || err.error || 'Request failed') as ApiError;
    if (err.code) error.code = err.code;
    else if (typeof err.error === 'string') error.code = err.error;
    error.status = res.status;
    // Structured 4xx bodies carry details beyond the slug (e.g. 409
    // `project_in_use` → per-kind reference counts); keep them reachable.
    error.body = err;
    throw error;
  }
  return res.json();
}

/**
 * Headers for a `/accounts/:wsId/...` call: the server requires the path and
 * X-Account-Id to name the same workspace, so the call carries its own.
 * Callers are `async` so a failure here rejects like request() does.
 */
function accountHeaders(wsId: string): Record<string, string> {
  return { ...getAuthHeaders(), 'X-Account-Id': wsId };
}

/** Error thrown by `request` — `code` is the server slug, `body` the parsed JSON error body. */
export type ApiError = Error & { code?: string; status?: number; body?: any };

/**
 * JSON 이 아닌 본문(오디오)을 주고받는 요청. 실패는 `request` 와 같은 모양(message · code · status)으로 던진다.
 * `contentType` 을 주면 그 형식의 바이트를 그대로 보낸다.
 */
async function fetchOk(path: string, init: RequestInit & { contentType?: string } = {}): Promise<Response> {
  const { contentType, ...rest } = init;
  const headers = getAuthHeaders();
  if (contentType) headers['Content-Type'] = contentType;
  const res = await fetch(`${apiBase()}${path}`, { ...rest, headers: { ...headers, ...(rest.headers as Record<string, string> | undefined) } });
  if (!res.ok) {
    if (res.status === 401) {
      localStorage.removeItem('auth_token');
      window.dispatchEvent(new Event('auth-expired'));
    }
    const err = await res.json().catch(() => null);
    // Proxies can return an HTML error page. Only expose a short API message, never the response body.
    const detail = err?.message || err?.error;
    const fallback = res.status === 504
      ? '서버 응답 시간이 초과되었습니다 (HTTP 504). 잠시 후 다시 시도해 주세요.'
      : `요청에 실패했습니다 (HTTP ${res.status}). 잠시 후 다시 시도해 주세요.`;
    const message = typeof detail === 'string' && !/<[!/?a-z][^>]*>/i.test(detail)
      ? detail.slice(0, 300) : fallback;
    const error = new Error(message) as Error & { code?: string; status?: number };
    if (typeof err?.code === 'string') error.code = err.code;
    else if (typeof err?.error === 'string') error.code = err.error;
    error.status = res.status;
    throw error;
  }
  return res;
}

export const api = {
  resolveArtifactRefs: (
    accountId: string,
    refs: Array<{ type: ArtifactRefType; id: string }>,
  ) => request<Array<{
    type: ArtifactRefType; id: string; available: boolean; label: string; deepLink: string | null;
    accountName?: string; reason?: string;
  }>>('/artifact-refs/resolve', {
    method: 'POST',
    body: JSON.stringify({ refs }),
  }),

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

  register: (name: string, email: string, password: string, requestedAccountId?: string) =>
    request<{ success: boolean; message: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name, email, password, requested_account_id: requestedAccountId }),
    }),

  getPublicAccounts: () =>
    request<{ id: string; name: string; slug: string }[]>('/auth/public-accounts'),

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

  assignUserAccount: (userId: string, accountId: string, relation: string = 'member') =>
    request<any>(`/admin/pending-users/${userId}/assign`, {
      method: 'POST',
      body: JSON.stringify({ account_id: accountId, relation }),
    }),

  getPermissionsMeta: () =>
    request<{ permissions: Record<string, { label: string; description: string; group: string }>; role_defaults: Record<string, string[]> }>('/auth/permissions'),

  // ─── Accounts ────────────────────────────────────────
  getAccounts: () => request<Account[]>('/accounts'),
  getAccount: (id: string) => request<Account>(`/accounts/${id}`),
  createAccount: (data: { name: string; description?: string }) =>
    request<any>('/accounts', { method: 'POST', body: JSON.stringify(data) }),
  updateAccount: (id: string, data: {
    name?: string;
    description?: string;
    harness_config?: HarnessConfig | null;
    clone_policy?: ClonePolicy | null;
    // Ticket dispatch settings (docs/tickets.md → Account settings).
    language?: string | null;
    max_concurrent_tickets_per_agent?: number;
    auto_archive_days?: number | null;
    /** ISO timestamp pauses all ticket dispatch in the workspace; null resumes. */
    dispatch_paused_at?: string | null;
  }) =>
    request<Account>(`/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteAccount: (id: string) =>
    request<any>(`/accounts/${id}`, { method: 'DELETE' }),
  getAccountMembers: (wsId: string) =>
    request<any[]>(`/accounts/${wsId}/members`),
  addAccountMember: (wsId: string, userId: string, relation: string = 'member') =>
    request<any>(`/accounts/${wsId}/members`, {
      method: 'POST', body: JSON.stringify({ user_id: userId, relation }),
    }),
  updateAccountMemberRole: (wsId: string, userId: string, relation: string) =>
    request<any>(`/accounts/${wsId}/members/${userId}`, {
      method: 'PATCH', body: JSON.stringify({ relation }),
    }),
  removeAccountMember: (wsId: string, userId: string) =>
    request<any>(`/accounts/${wsId}/members/${userId}`, { method: 'DELETE' }),
  // 프로필 핀 드롭다운용 전역 카탈로그(티켓 e616dbfc). 프로필은 인스턴스
  // 전역이라 워크스페이스 인자가 없다. getClaudeBackendProfiles 는 관리자
  // 전용 라우트라 비관리자에게는 빈 목록이 되므로 읽기는 이쪽을 쓴다.
  listClaudeBackendProfiles: () =>
    request<{ profiles: ClaudeBackendProfile[]; default_profile_id: string | null }>('/claude-backend-profiles'),
  getClaudeBackendProfiles: () =>
    request<{ profiles: ClaudeBackendProfile[]; default_profile_id: string | null }>('/admin/claude-backend-profiles'),
  createClaudeBackendProfile: (data: ClaudeBackendProfile) =>
    request<ClaudeBackendProfile>('/admin/claude-backend-profiles', { method: 'POST', body: JSON.stringify(data) }),
  updateClaudeBackendProfile: (id: string, data: Omit<Partial<ClaudeBackendProfile>, 'credential_ref'> & { credential_ref?: string | null }) =>
    request<ClaudeBackendProfile>(`/admin/claude-backend-profiles/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  getClaudeBackendProfileImpact: (id: string) =>
    request<any>(`/admin/claude-backend-profiles/${id}/impact`),
  deleteClaudeBackendProfile: (id: string, options?: { replacement_profile_id?: string; detach?: boolean }) =>
    request<any>(`/admin/claude-backend-profiles/${id}`, { method: 'DELETE', body: JSON.stringify(options || {}) }),
  setDefaultClaudeBackendProfile: (profile_id: string | null) =>
    request<any>('/admin/claude-backend-profiles/default', { method: 'PATCH', body: JSON.stringify({ profile_id }) }),

  // ─── Tickets (docs/tickets.md) ─────────────────────────
  // One workspace-wide pool. The list returns root tickets only (children are
  // nested two levels on each row) plus the tag counts of the matching set.
  listTickets: async (wsId: string, filters: TicketListQuery = {}) => {
    const qs = ticketListQueryString(filters);
    return request<TicketListResponse>(
      `/tickets${qs ? `?${qs}` : ''}`,
    );
  },
  /** Tag suggestions across the whole workspace pool (tag picker), most used first. */
  listTicketTags: async (wsId: string) =>
    request<{ tags: TicketTagCount[] }>('/ticket-tags'),
  createTicket: async (wsId: string, data: TicketCreateInput) =>
    request<Ticket>('/tickets', {
      method: 'POST',
      headers: accountHeaders(wsId),
      body: JSON.stringify(data),
    }),
  archiveTicket: async (ticketId: string) =>
    request<any>(`/tickets/${ticketId}/archive`, { method: 'POST' }),
  unarchiveTicket: async (ticketId: string) =>
    request<any>(`/tickets/${ticketId}/unarchive`, { method: 'POST' }),
  getTicket: async (ticketId: string) =>
    request<Ticket>(`/tickets/${ticketId}`),
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

  // data: any of `title, description, priority, tags, project_id, base_branch,
  // assignee, prompt_text, pending_*, next_ticket_id, on_done_action_ids`.
  updateTicket: (id: string, data: TicketPatch) =>
    request<Ticket>(`/tickets/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  decideTicketDuplicate: (id: string, data: { action: 'link' | 'keep_independent'; candidate_ticket_id?: string }) =>
    request<any>(`/tickets/${id}/duplicate-decision`, { method: 'POST', body: JSON.stringify(data) }),

  // Status change (replaces the column move). `position` is the index inside
  // the destination status lane (omit → end of lane).
  moveTicket: (id: string, status: TicketStatus, position?: number) =>
    request<Ticket>(`/tickets/${id}/move`, {
      method: 'PATCH',
      body: JSON.stringify(position === undefined ? { status } : { status, position }),
    }),

  // Re-parent a ticket. parent_id=string makes it a subtask; null promotes it
  // back to a root ticket. Returns the full ticket.
  reparentTicket: (id: string, parent_id: string | null) =>
    request<Ticket>(`/tickets/${id}/parent`, {
      method: 'PATCH',
      body: JSON.stringify({ parent_id }),
    }),

  // Manual "Run" — asks the dispatcher to (re)send this ticket to its assignee
  // now. `dispatched: false` carries the `reason` (unassigned, pending, paused,
  // at capacity, …) for the panel to show.
  triggerTicket: (id: string) =>
    request<{ ok: boolean; dispatched: boolean; reason?: string }>(`/tickets/${id}/trigger`, {
      method: 'POST',
      body: '{}',
    }),

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
  // Children have no assignee of their own — they are a checklist the parent's
  // assignee works through.
  createChildTicket: (parentId: string, data: { title: string; description?: string; tags?: string[] }) =>
    request<Ticket>(`/tickets/${parentId}/children`, { method: 'POST', body: JSON.stringify(data) }),

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
  getUsers: (accountId?: string) =>
    request<any[]>(accountId ? `/users?account_id=${encodeURIComponent(accountId)}` : '/users'),
  createUser: (data: { name: string; email?: string; role?: string; discord_user_id?: string; password?: string; permissions?: string[] }) =>
    request<any>('/users', { method: 'POST', body: JSON.stringify(data) }),
  updateUser: (id: string, data: Record<string, any>) =>
    request<any>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteUser: (id: string) =>
    request<any>(`/users/${id}`, { method: 'DELETE' }),

  // ─── Agents ────────────────────────────────────────────
  // accountId overrides the ambient X-Account-Id header for this one call —
  // see getChannels above for why callers reacting to a accountId prop change
  // need this instead of relying on the ambient header.
  // P4c-4: Agent listing/detail/activity endpoints removed server-side
  // (Agent 테이블 삭제). 실행 주체는 runtime-hosts 카탈로그에서 고른다
  // (listOrchestrationRuntimeHosts) — 아래 DeclareRuntimeSection 경로.
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
  listSubagents: (accountId: string): Promise<SubagentSummary[]> =>
    request<SubagentSummary[]>(`/subagent-monitor/accounts/${encodeURIComponent(accountId)}`),
  getSubagentTranscript: (subagentId: string, accountId: string): Promise<SubagentTranscript> => {
    const params = new URLSearchParams({ account_id: accountId });
    return request<SubagentTranscript>(`/subagent-monitor/${encodeURIComponent(subagentId)}?${params.toString()}`);
  },
  // The server reads X-Account-Id from the header set by getAuthHeaders(),
  // which now pulls from the per-tab active workspace. The caller can still
  // pass `accountId` explicitly to override (e.g., admin tools acting on a
  // workspace other than the one the tab is currently viewing).
  // P4c-3b: agent write endpoints removed server-side (POST/PATCH/DELETE /agents).

  // ─── Channels ──────────────────────────────────────────
  // accountId overrides the ambient X-Account-Id header for this one call
  // (same pattern as createAgent below) — callers that re-fetch the instant a
  // accountId prop changes can't rely on the ambient header having caught up
  // yet (it's synced from a sibling effect that may run after theirs).
  getChannels: (accountId?: string) => {
    const init: RequestInit = {};
    if (accountId) init.headers = { ...getAuthHeaders(), 'X-Account-Id': accountId };
    return request<any[]>('/channels', init);
  },
  createChannel: (data: {
    name: string; type?: string; bot_token?: string; guild_id?: string;
    channel_id?: string;
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
  // accountId overrides the ambient X-Account-Id header for this one call —
  // see getChannels above for why callers reacting to a accountId prop change
  // need this instead of relying on the ambient header.
  getApiKeys: (accountId?: string) => {
    const init: RequestInit = {};
    if (accountId) init.headers = { ...getAuthHeaders(), 'X-Account-Id': accountId };
    return request<any[]>('/keys', init);
  },
  getApiKey: (id: string) => request<any>(`/keys/${id}`),
  createApiKey: (data: { name: string; agent_id?: string | null; scope?: string; expires_in_days?: number }) =>
    request<any>('/keys', { method: 'POST', body: JSON.stringify(data) }),
  updateApiKey: (id: string, data: Record<string, any>) =>
    request<any>(`/keys/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  revokeApiKey: (id: string) =>
    request<any>(`/keys/${id}/revoke`, { method: 'POST' }),
  deleteApiKey: (id: string) =>
    request<any>(`/keys/${id}`, { method: 'DELETE' }),

  // ─── Resources ─────────────────────────────────────────
  listResources: (
    accountId: string,
    type?: string,
    sort?: { by?: string; order?: 'asc' | 'desc' },
    includeAllScopes = false,
  ) => {
    const params = new URLSearchParams({ account_id: accountId });
    if (type) params.set('type', type);
    if (sort?.by) params.set('sort_by', sort.by);
    if (sort?.order) params.set('sort_order', sort.order);
    if (includeAllScopes) params.set('include_all_scopes', 'true');
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
    opts: { account_id: string; type?: string },
  ): Promise<{ id: string; file_name: string; file_mimetype: string; size: number }> => {
    const params = new URLSearchParams({ account_id: opts.account_id });
    params.set('type', opts.type || 'comment_attachment');
    const token = (() => { try { return localStorage.getItem('auth_token'); } catch { return null; } })();
    const headers: Record<string, string> = {
      'Content-Type': file.type || 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name),
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (_activeAccountId) headers['X-Account-Id'] = _activeAccountId;
    const res = await fetch(`${apiBase()}/resources/upload?${params.toString()}`, {
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
    account_id?: string | null;
    scope?: 'global' | 'account';
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
  }) =>
    request<Resource>('/resources', { method: 'POST', body: JSON.stringify(data) }),
  updateResource: (
    id: string,
    data: {
      account_id?: string | null;
      scope?: 'global' | 'account';
      name?: string;
      description?: string;
      type?: string;
      url?: string;
      content?: string;
      file_data?: string;
      file_name?: string;
      file_mimetype?: string;
      tags?: string[];
      credential_id?: string | null;
    },
  ) =>
    request<Resource>(`/resources/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteResource: (id: string, accountId: string) => {
    const params = new URLSearchParams({ account_id: accountId });
    return request<{ success: true; id: string }>(`/resources/${id}?${params.toString()}`, { method: 'DELETE' });
  },
  // ─── Library (자료실) ────────────────────────────────────
  // 바이트는 uploadResourceFile(type 'library_file')로 먼저 올리고 여기서 묶는다.
  // 다운로드는 rawResourceUrl(resource_id, { download: true }) 그대로 — /raw가
  // APK를 attachment로 내린다. 404 latest는 body.code 'no_app_published'로 구분한다.
  listLibraryItems: (accountId: string) => {
    const params = new URLSearchParams({ account_id: accountId });
    return request<{ items: LibraryItem[] }>(`/library?${params.toString()}`);
  },
  createLibraryItem: (data: {
    account_id: string;
    resource_id: string;
    title: string;
    description?: string;
    version?: string;
    kind?: 'app' | 'file';
  }) => request<LibraryItem>('/library', { method: 'POST', body: JSON.stringify(data) }),
  deleteLibraryItem: (id: string, accountId: string) => {
    const params = new URLSearchParams({ account_id: accountId });
    return request<{ success: true; id: string }>(`/library/${encodeURIComponent(id)}?${params.toString()}`, { method: 'DELETE' });
  },
  getLatestApp: (accountId: string) => {
    const params = new URLSearchParams({ account_id: accountId });
    return request<LibraryItem>(`/library/apps/latest?${params.toString()}`);
  },
  // ─── Projects (docs/tickets.md → Project) ─────────────
  // One git repository + what every feature needs to work on it. Replaces
  // repository Resources (same ids after migration).
  listProjects: async (wsId: string) =>
    request<Project[]>('/projects'),
  getProject: (id: string) => request<Project>(`/projects/${encodeURIComponent(id)}`),
  createProject: async (wsId: string, data: ProjectInput & { name: string; repo_url: string }) =>
    request<Project>('/projects', {
      method: 'POST',
      headers: accountHeaders(wsId),
      body: JSON.stringify(data),
    }),
  updateProject: (id: string, data: ProjectInput) =>
    request<Project>(`/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(data) }),
  // 409 `project_in_use` (error.body.counts) unless `force` — see ProjectsPage.
  deleteProject: (id: string, opts?: { force?: boolean }) =>
    request<{ ok: boolean }>(`/projects/${encodeURIComponent(id)}${opts?.force ? '?force=1' : ''}`, {
      method: 'DELETE',
    }),
  /** Set the project's main clone folder on one Runtime Host (absolute host path). */
  setProjectHostFolder: (id: string, hostId: string, path: string) =>
    request<Project>(`/projects/${encodeURIComponent(id)}/host-folders/${encodeURIComponent(hostId)}`, {
      method: 'PUT',
      body: JSON.stringify({ path }),
    }),
  clearProjectHostFolder: (id: string, hostId: string) =>
    request<Project>(`/projects/${encodeURIComponent(id)}/host-folders/${encodeURIComponent(hostId)}`, {
      method: 'DELETE',
    }),
  listProjectBranches: (id: string) =>
    request<{ branches: RepoBranch[]; default_branch: string }>(`/projects/${encodeURIComponent(id)}/branches`),
  /** Probe a repo URL (+ credential) before saving — returns its branches on success. */
  testProjectConnection: (data: { repo_url: string; credential_id?: string | null; account_id: string }) =>
    request<ProjectTestConnectionResult>('/projects/test-connection', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // ─── project git reading (history / diff / file tree) ──────────────
  // Read from the server's per-project bare blobless cache clone. SSH-only URLs
  // come back as HTTP 422 (code 'ssh_unsupported') — `request` throws the error
  // message, which the panel renders as a degrade notice. `account_id` rides
  // along as before (same query params as the old resource repo browser).
  getProjectRefs: (id: string, accountId: string, refresh = false) => {
    const params = new URLSearchParams({ account_id: accountId });
    if (refresh) params.set('refresh', 'true');
    return request<RepoRefs>(`/projects/${encodeURIComponent(id)}/refs?${params.toString()}`);
  },
  // Cursor pagination: pass the last shown sha as `before` to load older commits.
  listProjectCommits: (
    id: string,
    accountId: string,
    opts?: { ref?: string; limit?: number; before?: string; refresh?: boolean },
  ) => {
    const params = new URLSearchParams({ account_id: accountId });
    if (opts?.ref) params.set('ref', opts.ref);
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.before) params.set('before', opts.before);
    if (opts?.refresh) params.set('refresh', 'true');
    return request<{ commits: RepoCommitSummary[] }>(`/projects/${encodeURIComponent(id)}/commits?${params.toString()}`);
  },
  getProjectCommit: (id: string, accountId: string, sha: string) => {
    const params = new URLSearchParams({ account_id: accountId });
    return request<RepoCommitDetail>(`/projects/${encodeURIComponent(id)}/commits/${encodeURIComponent(sha)}?${params.toString()}`);
  },
  getProjectTree: (id: string, accountId: string, opts?: { ref?: string; path?: string }) => {
    const params = new URLSearchParams({ account_id: accountId });
    if (opts?.ref) params.set('ref', opts.ref);
    if (opts?.path) params.set('path', opts.path);
    return request<{ ref: string; path: string; entries: RepoTreeEntry[] }>(
      `/projects/${encodeURIComponent(id)}/tree?${params.toString()}`,
    );
  },
  getProjectFile: (id: string, accountId: string, filePath: string, ref?: string) => {
    const params = new URLSearchParams({ account_id: accountId, path: filePath });
    if (ref) params.set('ref', ref);
    return request<RepoFileContent>(`/projects/${encodeURIComponent(id)}/file?${params.toString()}`);
  },

  // ─── Actions ──────────────────────────────────────────
  listActions: (_accountId: string) => request<Action[]>('/actions'),
  getAction: (id: string) => request<Action>(`/actions/${id}`),
  createAction: (data: {
    account_id: string;
    name: string;
    description?: string;
    prompt?: string;
    /** 레거시 단일 대상. 신규 코드는 `target_agent_ids` 를 쓴다 (티켓 fc3906c5). */
    target_agent_id?: string;
    /** 대상 에이전트 전체 — 트리거 1회가 각각에 대해 독립 run 을 만든다. */
    target_agent_ids?: string[];
    /** P4c-3b: spec-direct 대상 (서버가 id 배열과 합집합한다). */
    target_runtimes?: Array<Record<string, any>>;
    schedule_cron?: string;
    trigger?: string;
    trigger_label?: string;
    enabled?: boolean;
    max_runs?: number;
    workspace_folder?: string;
    repo_ref?: Action['repo_ref'];
    checkout_mode?: Action['checkout_mode'];
  }) =>
    request<Action>('/actions', { method: 'POST', body: JSON.stringify(data) }),
  updateAction: (
    id: string,
    data: {
      account_id: string;
      name?: string;
      description?: string;
      prompt?: string;
      target_agent_id?: string;
      /** 대상 전체 교체 — 배열이 오면 단일 필드보다 우선한다 (티켓 fc3906c5). */
      target_agent_ids?: string[];
      /** P4c-3b: spec-direct 대상 (서버가 id 배열과 합집합한다). */
      target_runtimes?: Array<Record<string, any>>;
      schedule_cron?: string;
      trigger?: string;
      trigger_label?: string;
      enabled?: boolean;
      max_runs?: number;
      workspace_folder?: string;
      repo_ref?: Action['repo_ref'];
      checkout_mode?: Action['checkout_mode'];
    },
  ) =>
    request<Action>(`/actions/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteAction: (id: string, accountId: string) => {
    const params = new URLSearchParams({ account_id: accountId });
    return request<{ success: true; id: string }>(`/actions/${id}?${params.toString()}`, { method: 'DELETE' });
  },
  // fan-out (티켓 fc3906c5): run_id/room_id/prompt 는 첫 run 을 가리키고,
  // runs[] 가 대상별 run 전체, failures[] 가 디스패치에 실패한 대상이다.
  runAction: (id: string) =>
    request<{
      run_id: string;
      room_id: string;
      prompt: string;
      batch_id: string;
      runs: Array<{ run_id: string; agent_id: string; room_id: string }>;
      failures: Array<{ agent_id: string; error: string }>;
    }>(`/actions/${id}/run`, { method: 'POST', body: '{}' }),
  listActionRuns: (id: string, accountId: string, limit = 20) => {
    const params = new URLSearchParams({ account_id: accountId, limit: String(limit) });
    return request<ActionRun[]>(`/actions/${id}/runs?${params.toString()}`);
  },
  getActionRun: (runId: string, accountId: string) => {
    const params = new URLSearchParams({ account_id: accountId });
    return request<ActionRun>(`/actions/runs/${runId}?${params.toString()}`);
  },

  // Functions: account_id omitted means global definitions only.
  listFunctions: (accountId?: string | null, includeShadowed = false) => {
    const params = new URLSearchParams();
    if (accountId) params.set('account_id', accountId);
    if (includeShadowed) params.set('include_shadowed', 'true');
    const query = params.toString();
    return request<WorkflowFunction[]>(`/functions${query ? `?${query}` : ''}`);
  },
  createFunction: (data: Partial<WorkflowFunction> & { key: string; name: string }) =>
    request<WorkflowFunction>('/functions', { method: 'POST', body: JSON.stringify(data) }),
  updateFunction: (id: string, data: Partial<WorkflowFunction>) =>
    request<WorkflowFunction>(`/functions/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteFunction: (id: string) =>
    request<{ success: true; id: string }>(`/functions/${id}`, { method: 'DELETE' }),
  runFunction: (
    id: string,
    data: { account_id: string; ticket_id?: string; inputs?: Record<string, any>; idempotency_key?: string },
  ) => request<WorkflowFunctionRun>(`/functions/${id}/run`, { method: 'POST', body: JSON.stringify(data) }),
  listFunctionRuns: (accountId: string, options?: { functionId?: string; ticketId?: string; limit?: number }) => {
    const params = new URLSearchParams({ account_id: accountId, limit: String(options?.limit || 50) });
    if (options?.functionId) params.set('function_id', options.functionId);
    if (options?.ticketId) params.set('ticket_id', options.ticketId);
    return request<WorkflowFunctionRun[]>(`/functions/runs?${params.toString()}`);
  },

  // ─── Scenario-based QA (ticket 3c655d20) ──────────────
  listQaScenarios: (_accountId: string) => request<QaScenarioListItem[]>('/qa/scenarios'),
  getQaScenario: (id: string) => request<QaScenario>(`/qa/scenarios/${id}`),
  createQaScenario: (data: {
    account_id: string;
    name: string;
    description?: string;
    steps?: QaScenario['steps'];
    target_agent_id?: string;
    /** P4c-3b: spec-direct target. */
    target_runtime?: Record<string, any>;
    qa_driver?: string;
    qa_driver_config?: Record<string, any> | null;
    enabled?: boolean;
    tags?: string[];
    on_failure_ticket?: QaScenario['on_failure_ticket'];
    max_runs?: number;
    workspace_folder?: string;
    repo_ref?: QaScenario['repo_ref'];
    checkout_mode?: QaScenario['checkout_mode'];
    build_mode?: QaScenario['build_mode'];
    // Deployment-awareness target environment (ticket 8ce72b18).
    target_environment?: string;
    // Per-scenario QA phases override (object to set, null to clear).
    qa_phases?: QaPhasesConfig | null;
  }) => request<QaScenario>('/qa/scenarios', { method: 'POST', body: JSON.stringify(data) }),
  updateQaScenario: (
    id: string,
    data: {
      account_id: string;
      name?: string;
      description?: string;
      steps?: QaScenario['steps'];
      target_agent_id?: string;
      /** P4c-3b: spec-direct target. */
      target_runtime?: Record<string, any>;
      qa_driver?: string;
      qa_driver_config?: Record<string, any> | null;
      enabled?: boolean;
      tags?: string[];
      on_failure_ticket?: QaScenario['on_failure_ticket'];
      max_runs?: number;
      workspace_folder?: string;
      repo_ref?: QaScenario['repo_ref'];
      checkout_mode?: QaScenario['checkout_mode'];
      build_mode?: QaScenario['build_mode'];
      // Deployment-awareness target environment (ticket 8ce72b18).
      target_environment?: string;
      // Per-scenario QA phases override (object to set, null to clear).
      qa_phases?: QaPhasesConfig | null;
    },
  ) => request<QaScenario>(`/qa/scenarios/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteQaScenario: (id: string, accountId: string) => {
    const params = new URLSearchParams({ account_id: accountId });
    return request<{ success: true; id: string }>(`/qa/scenarios/${id}?${params.toString()}`, { method: 'DELETE' });
  },
  runQaScenario: (id: string) =>
    request<{ run_id: string; room_id: string; prompt: string }>(`/qa/scenarios/${id}/run`, { method: 'POST', body: '{}' }),
  listQaRuns: (id: string, accountId: string, limit = 20) => {
    const params = new URLSearchParams({ account_id: accountId, limit: String(limit) });
    return request<QaRun[]>(`/qa/scenarios/${id}/runs?${params.toString()}`);
  },
  getQaRun: (runId: string, accountId: string) => {
    const params = new URLSearchParams({ account_id: accountId });
    return request<QaRun>(`/qa/runs/${runId}?${params.toString()}`);
  },
  // ─── Deployment awareness (ticket 8ce72b18) ──────────
  // The current live commit per environment visible to a workspace (its own
  // environments + all global ones). Powers the QA "live commit" badge.
  listDeployments: (accountId: string) => {
    const params = new URLSearchParams({ account_id: accountId });
    return request<Deployment[]>(`/deployments?${params.toString()}`);
  },
  // ─── Sequential QA batches (ticket daf06262) ──────────
  // scenario_ids[] OR all (→ enabled scenarios in scope). Only the first
  // scenario dispatches now; the rest run one-at-a-time as each finalizes.
  startQaBatch: (data: {
    account_id: string;
    scenario_ids?: string[];
    all?: boolean;
    stop_on_fail?: boolean;
  }) => request<QaRunBatch>('/qa/batches', { method: 'POST', body: JSON.stringify(data) }),
  getQaBatch: (batchId: string, accountId: string) => {
    const params = new URLSearchParams({ account_id: accountId });
    return request<QaRunBatch>(`/qa/batches/${batchId}?${params.toString()}`);
  },

  // ─── QA schedules (ticket b6bb7efd) ──────────────────
  // Automatic trigger layer: when due, the server kicks a sequential batch via
  // the same orchestrator as startQaBatch. Exactly one of cron / interval_ms.
  listQaSchedules: (_accountId: string) => request<QaSchedule[]>('/qa/schedules'),
  createQaSchedule: (data: {
    account_id: string;
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
      account_id: string;
      name?: string;
      scope?: QaScheduleScope;
      scenario_ids?: string[];
      cron?: string | null;
      interval_ms?: number | null;
      enabled?: boolean;
      stop_on_fail?: boolean;
    },
  ) => request<QaSchedule>(`/qa/schedules/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteQaSchedule: (id: string, accountId: string) => {
    const params = new URLSearchParams({ account_id: accountId });
    return request<{ success: true; id: string }>(`/qa/schedules/${id}?${params.toString()}`, { method: 'DELETE' });
  },
  runQaScheduleNow: (id: string, accountId: string) =>
    request<{ schedule: QaSchedule; batch: QaRunBatch }>(`/qa/schedules/${id}/run-now`, {
      method: 'POST',
      body: JSON.stringify({ account_id: accountId }),
    }),

  // ─── Account schedules (ticket 8845be79 foundation / 1927ed4a UI) ──────────
  // General-purpose agent-task scheduler: when due, the server opens a fresh chat
  // room and sends `task_prompt` to `target_agent_id`. Exactly one of cron /
  // interval_ms. Account-scoped only.
  listAutomationSchedules: (_accountId: string) => request<AutomationSchedule[]>('/automation-schedules'),
  createAutomationSchedule: (data: {
    account_id: string;
    name: string;
    target_agent_id?: string;
    /** P4c-3b: spec-direct target. */
    target_runtime?: Record<string, any>;
    task_prompt?: string;
    /** 등록된 Action 실행 (task_prompt 와 택일). */
    action_id?: string | null;
    cron?: string | null;
    interval_ms?: number | null;
    enabled?: boolean;
  }) => request<AutomationSchedule>('/automation-schedules', { method: 'POST', body: JSON.stringify(data) }),
  updateAutomationSchedule: (
    id: string,
    data: {
      account_id: string;
      name?: string;
      target_agent_id?: string;
      /** P4c-3b: spec-direct target. */
      target_runtime?: Record<string, any>;
      task_prompt?: string;
      /** 등록된 Action 실행 (task_prompt 와 택일). null 로 보내면 프롬프트 형태로 되돌린다. */
      action_id?: string | null;
      cron?: string | null;
      interval_ms?: number | null;
      enabled?: boolean;
    },
  ) => request<AutomationSchedule>(`/automation-schedules/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteAutomationSchedule: (id: string, accountId: string) => {
    const params = new URLSearchParams({ account_id: accountId });
    return request<{ success: true; id: string }>(`/automation-schedules/${id}?${params.toString()}`, { method: 'DELETE' });
  },
  runAutomationScheduleNow: (id: string, accountId: string) =>
    request<{ schedule: AutomationSchedule; dispatch: AutomationScheduleDispatch }>(`/automation-schedules/${id}/run-now`, {
      method: 'POST',
      body: JSON.stringify({ account_id: accountId }),
    }),

  // ─── Security inspection (보안 점검 — ticket cfd74638 foundation) ──────────
  // Sibling of scenario QA: profile CRUD + run dispatch + history + sequential
  // batches + schedules. Run-result recording (findings, complete) is agent-only
  // via MCP, so it is intentionally not exposed over REST.
  listSecurityProfiles: (_accountId: string) => request<SecurityProfileListItem[]>('/security/profiles'),
  getSecurityProfile: (id: string) => request<SecurityProfile>(`/security/profiles/${id}`),
  createSecurityProfile: (data: {
    account_id: string;
    name: string;
    description?: string;
    checklist?: SecurityProfile['checklist'];
    target_agent_id?: string;
    /** P4c-3b: spec-direct target. */
    target_runtime?: Record<string, any>;
    target_resource_id?: string | null;
    scan_driver?: string;
    scan_driver_config?: Record<string, any> | null;
    scope_mode?: SecurityProfile['scope_mode'];
    enabled?: boolean;
    tags?: string[];
    on_failure_ticket?: SecurityProfile['on_failure_ticket'];
    max_runs?: number;
    workspace_folder?: string;
    repo_ref?: SecurityProfile['repo_ref'];
    checkout_mode?: SecurityProfile['checkout_mode'];
    build_mode?: SecurityProfile['build_mode'];
  }) => request<SecurityProfile>('/security/profiles', { method: 'POST', body: JSON.stringify(data) }),
  updateSecurityProfile: (
    id: string,
    data: {
      account_id: string;
      name?: string;
      description?: string;
      checklist?: SecurityProfile['checklist'];
      target_agent_id?: string;
      /** P4c-3b: spec-direct target. */
      target_runtime?: Record<string, any>;
      target_resource_id?: string | null;
      scan_driver?: string;
      scan_driver_config?: Record<string, any> | null;
      scope_mode?: SecurityProfile['scope_mode'];
      enabled?: boolean;
      tags?: string[];
      on_failure_ticket?: SecurityProfile['on_failure_ticket'];
      max_runs?: number;
      workspace_folder?: string;
      repo_ref?: SecurityProfile['repo_ref'];
      checkout_mode?: SecurityProfile['checkout_mode'];
      build_mode?: SecurityProfile['build_mode'];
    },
  ) => request<SecurityProfile>(`/security/profiles/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteSecurityProfile: (id: string, accountId: string) => {
    const params = new URLSearchParams({ account_id: accountId });
    return request<{ success: true; id: string }>(`/security/profiles/${id}?${params.toString()}`, { method: 'DELETE' });
  },
  // Dispatch a "refresh the checklist with the latest security info" task — no
  // SecurityRun row, the agent WebSearches and writes the checklist back.
  refreshSecurityChecklist: (id: string) =>
    request<{ profile_id: string; room_id: string; prompt: string }>(`/security/profiles/${id}/refresh-checklist`, { method: 'POST', body: '{}' }),
  runSecurityProfile: (id: string) =>
    request<{ run_id: string; room_id: string; prompt: string }>(`/security/profiles/${id}/run`, { method: 'POST', body: '{}' }),
  listSecurityRuns: (id: string, accountId: string, limit = 20) => {
    const params = new URLSearchParams({ account_id: accountId, limit: String(limit) });
    return request<SecurityRun[]>(`/security/profiles/${id}/runs?${params.toString()}`);
  },
  getSecurityRun: (runId: string, accountId: string) => {
    const params = new URLSearchParams({ account_id: accountId });
    return request<SecurityRun>(`/security/runs/${runId}?${params.toString()}`);
  },
  // ─── Sequential security batches ──────────────────────
  startSecurityBatch: (data: {
    account_id: string;
    profile_ids?: string[];
    all?: boolean;
    stop_on_fail?: boolean;
  }) => request<SecurityRunBatch>('/security/batches', { method: 'POST', body: JSON.stringify(data) }),
  getSecurityBatch: (batchId: string, accountId: string) => {
    const params = new URLSearchParams({ account_id: accountId });
    return request<SecurityRunBatch>(`/security/batches/${batchId}?${params.toString()}`);
  },
  // ─── Security schedules ───────────────────────────────
  listSecuritySchedules: (_accountId: string) => request<SecuritySchedule[]>('/security/schedules'),
  createSecuritySchedule: (data: {
    account_id: string;
    name: string;
    kind?: SecurityScheduleKind;
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
      account_id: string;
      name?: string;
      kind?: SecurityScheduleKind;
      scope?: SecurityScheduleScope;
      profile_ids?: string[];
      cron?: string | null;
      interval_ms?: number | null;
      enabled?: boolean;
      stop_on_fail?: boolean;
    },
  ) => request<SecuritySchedule>(`/security/schedules/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteSecuritySchedule: (id: string, accountId: string) => {
    const params = new URLSearchParams({ account_id: accountId });
    return request<{ success: true; id: string }>(`/security/schedules/${id}?${params.toString()}`, { method: 'DELETE' });
  },
  // run-now is kind-discriminated: kind='scan' → `batch` set / `refreshes` null;
  // kind='checklist_refresh' → `batch` null / `refreshes` the per-profile dispatches.
  runSecurityScheduleNow: (id: string, accountId: string) =>
    request<{
      schedule: SecuritySchedule;
      kind: SecurityScheduleKind;
      batch: SecurityRunBatch | null;
      refreshes: { profile_id: string; room_id: string }[] | null;
    }>(`/security/schedules/${id}/run-now`, {
      method: 'POST',
      body: JSON.stringify({ account_id: accountId }),
    }),

  // ─── Credentials ──────────────────────────────────────
  // A workspace list also returns inherited global credentials (scope:'global').
  // Pass scope:'global' (no account_id) for the Admin global-credentials page.
  listCredentials: (accountId?: string, opts?: { provider?: string; scope?: 'global'; includeAllScopes?: boolean }) => {
    const params = new URLSearchParams();
    if (accountId) params.set('account_id', accountId);
    if (opts?.provider) params.set('provider', opts.provider);
    if (opts?.scope) params.set('scope', opts.scope);
    if (opts?.includeAllScopes) params.set('include_all_scopes', 'true');
    return request<Credential[]>(`/credentials?${params.toString()}`);
  },
  getCredentialProviders: () =>
    request<Record<string, { label: string; fields: string[] }>>('/credentials/providers'),
  revealCredential: (id: string, password: string) =>
    request<{ credential_fields: Record<string, string>; credential_status: 'ok' }>(
      `/credentials/${id}/reveal`,
      {
        method: 'POST',
        cache: 'no-store',
        body: JSON.stringify({ password }),
      },
    ),
  createCredential: (data: {
    // Omit account_id and pass scope:'global' to create an instance-level
    // credential (requires the MANAGE_GLOBAL_CREDENTIALS permission).
    account_id?: string;
    scope?: 'global' | 'account';
    name: string;
    description?: string;
    provider: string;
    credentials: Record<string, string>;
  }) =>
    request<Credential>('/credentials', { method: 'POST', body: JSON.stringify(data) }),
  updateCredential: (
    id: string,
    data: {
      account_id?: string | null;
      scope?: 'global' | 'account';
      name?: string;
      description?: string;
      provider?: string;
      credentials?: Record<string, string>;
    },
  ) =>
    request<Credential>(`/credentials/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteCredential: (id: string, accountId?: string) => {
    const params = new URLSearchParams();
    if (accountId) params.set('account_id', accountId);
    const qs = params.toString();
    return request<{ success: true; id: string }>(`/credentials/${id}${qs ? `?${qs}` : ''}`, { method: 'DELETE' });
  },

  // LLM CLI 카탈로그 — 클라이언트의 per-CLI 표(라벨/credential/로그인/capability)는
  // 전부 여기서 온다(`src/cli/catalog.ts` 가 static mirror 와 스토어를 가진다).
  getCliCatalog: () => request<{ clis: CliDescriptor[] }>('/cli-catalog'),

  // 티켓 b2e79108 — CLI 자동 로그인(device-auth). 터미널·파일 업로드 없이
  // Codex 로그인 세션을 시작하고 진행 상태를 폴링/SSE로 추적한다.
  listCliLoginInstances: (accountId?: string) => {
    const params = new URLSearchParams();
    if (accountId) params.set('account_id', accountId);
    const qs = params.toString();
    return request<CliLoginInstanceOption[]>(`/credentials/cli-login/instances${qs ? `?${qs}` : ''}`);
  },
  startCliLogin: (data: {
    account_id?: string;
    scope?: 'global' | 'account';
    cli: string;
    /** opencode 전용 — `opencode auth login -p <cli_provider> -m <cli_method>`. */
    cli_provider?: string;
    cli_method?: string;
    credential_name: string;
    instance_id: string;
  }) => request<CliLoginSession>('/credentials/cli-login/start', { method: 'POST', body: JSON.stringify(data) }),
  getCliLoginSession: (sessionId: string, accountId?: string) => {
    const params = new URLSearchParams();
    if (accountId) params.set('account_id', accountId);
    const qs = params.toString();
    return request<CliLoginSession>(`/credentials/cli-login/${sessionId}${qs ? `?${qs}` : ''}`);
  },
  cancelCliLogin: (sessionId: string, accountId?: string) =>
    request<CliLoginSession>(`/credentials/cli-login/${sessionId}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ account_id: accountId }),
    }),

  // ─── Chat (Phase 2) ────────────────────────────────────
  // Account context is read from the per-tab active workspace (see
  // getActiveAccountId) so multi-tab use never leaks across accounts.
  listChatThreads: () => {
    const account_id = getActiveAccountId() || '';
    const params = new URLSearchParams({ account_id });
    return request<ChatThread[]>(`/chat/threads?${params.toString()}`);
  },
  listChatMessages: (params: { agent_id: string; ticket_id?: string | null; limit?: number }) => {
    const account_id = getActiveAccountId() || '';
    const qs = new URLSearchParams({ account_id, agent_id: params.agent_id });
    if (params.ticket_id) qs.set('ticket_id', params.ticket_id);
    if (params.limit) qs.set('limit', String(params.limit));
    return request<ChatMessage[]>(`/chat/messages?${qs.toString()}`);
  },
  sendChatMessage: (params: { agent_id: string; content: string; ticket_id?: string | null }) => {
    const account_id = getActiveAccountId() || '';
    return request<ChatMessage>('/chat/messages', {
      method: 'POST',
      body: JSON.stringify({
        account_id,
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
  // Live Runtime Hosts heartbeating against the server.
  /** Runtime Host 별 CLI 모델 목록(하트비트 스냅샷). 모든 모델 화면의 단일 출처 — `src/cli/hostModels.ts` 참고. */
  getHostModels: (managerAgentId: string) =>
    request<HostModelsView>(`/agent-manager/hosts/${encodeURIComponent(managerAgentId)}/models`),
  /** 호스트에 재열거를 시키고 ack 까지 기다린 뒤 갱신된 목록을 받는다(서버가 기다린다 — 폴링 없음). */
  refreshHostModels: (managerAgentId: string) =>
    request<HostModelsView>(`/agent-manager/hosts/${encodeURIComponent(managerAgentId)}/models/refresh`, { method: 'POST' }),
  /** RuntimeSpec live 검증 — RuntimeSpecEditor의 저장 전 체크. 저장하지 않는다. */
  listTemplateHosts: () => request<Array<{ id: string; name: string }>>('/agent-templates/hosts'),
  listAgentTemplates: () => request<AgentTemplate[]>('/agent-templates'),
  createAgentTemplate: (value: Omit<AgentTemplate, 'id' | 'created_at' | 'updated_at'>) =>
    request<AgentTemplate>('/agent-templates', { method: 'POST', body: JSON.stringify(value) }),
  updateAgentTemplate: (id: string, value: Partial<Omit<AgentTemplate, 'id' | 'created_at' | 'updated_at'>>) =>
    request<AgentTemplate>(`/agent-templates/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(value) }),
  deleteAgentTemplate: (id: string) => request(`/agent-templates/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  validateRuntimeSpec: (account_id: string | null, spec: Record<string, any>) =>
    request<{ ok: boolean; spec?: Record<string, any>; error?: string }>('/runtime-specs/validate', {
      method: 'POST',
      body: JSON.stringify({ account_id, spec }),
    }),
  listAgentManagerInstances: (accountId?: string) => {
    const qs = new URLSearchParams();
    if (accountId) qs.set('account_id', accountId);
    const q = qs.toString();
    return request<AgentManagerInstance[]>(`/admin/agent-manager/instances${q ? '?' + q : ''}`);
  },
  renameRuntimeHost: (hostId: string, name: string) =>
    request<{ id: string; name: string }>(`/admin/agent-manager/hosts/${encodeURIComponent(hostId)}`, {
      method: 'PATCH', body: JSON.stringify({ name }),
    }),
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
  /**
   * 권한 상승이 필요한 작업 하나에 쓸 **일회용** sudo 티켓을 발급받는다.
   *
   * 비밀번호는 이 요청 바디에만 실린다 — 돌아오는 것은 티켓 id 뿐이고, 그 id 를
   * 커맨드 args 에 실어 보낸다. 매니저는 권한 상승이 실제로 필요한 순간에 그 id
   * 로 서버에서 비밀번호를 1회 당겨 간다. 그래서 SSE 페이로드·커맨드 원장·활동
   * 로그 어디에도 비밀번호가 남지 않는다.
   *
   * 티켓은 120초 뒤 만료되고 1회만 쓸 수 있다. 화면이 커맨드를 끝내 보내지
   * 않았다면 `revokeSudoTicket` 으로 즉시 태우는 것이 맞다.
   */
  mintSudoTicket: (
    instanceId: string,
    body: { password: string; scope: { kind: 'cli_update'; cli: string; bin: string } | { kind: 'privileged_command'; request_id: string } },
  ) =>
    request<{ ticket_id: string; expires_at: string }>(
      `/admin/agent-manager/instances/${encodeURIComponent(instanceId)}/sudo-ticket`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  /** 승인 대기 중인 권한 상승 명령 목록(관리자). */
  listPrivilegedCommands: () =>
    request<PrivilegedCommandRequest[]>('/admin/agent-manager/privileged-commands'),

  /**
   * 권한 상승 명령을 승인한다. 비밀번호는 이 요청 바디에만 실리고, 서버가 즉시
   * 일회용 티켓으로 바꿔 매니저에게 디스패치한다 — 저장되지 않는다.
   */
  approvePrivilegedCommand: (requestId: string, password: string) =>
    request<{ ok: boolean; command_id: string; request_id: string }>(
      `/admin/agent-manager/privileged-commands/${encodeURIComponent(requestId)}/approve`,
      { method: 'POST', body: JSON.stringify({ password }) },
    ),

  denyPrivilegedCommand: (requestId: string) =>
    request<{ ok: boolean; status: string }>(
      `/admin/agent-manager/privileged-commands/${encodeURIComponent(requestId)}/deny`,
      { method: 'POST' },
    ),

  revokeSudoTicket: (ticketId: string) =>
    request<{ ok: boolean }>(`/admin/agent-manager/sudo-ticket/${encodeURIComponent(ticketId)}`, {
      method: 'DELETE',
    }),

  sendAgentManagerCommand: (
    instanceId: string,
    body: { command: AgentManagerCommandKind; args?: Record<string, any> },
  ) =>
    request<AgentManagerCommandResult>(
      `/admin/agent-manager/instances/${encodeURIComponent(instanceId)}/command`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  // ticket 40110b64 — 위 디스패치가 돌려준 command_id 의 ack 결과 조회.
  // 202 는 수락 신호일 뿐이므로, 완료 판정은 반드시 이 조회의 state 로 한다.
  getAgentManagerCommandOutcome: (commandId: string) =>
    request<AgentManagerCommandOutcome>(
      `/admin/agent-manager/commands/${encodeURIComponent(commandId)}`,
    ),

  // Create an agent identity that the manager will spawn. Differs from the
  // generic POST /agents in two ways: (1) cli is validated against the
  // CLI_TYPES whitelist (common/types/cli-types.ts), (2) manager_agent_id is sanity-
  // checked (existence + type='manager'); the manager itself can live in a
  // different workspace from the new agent — managers are paired globally
  // by an admin and supervise children across accounts.
  //
  // Optional `accountId` lets callers (e.g. the workspace AI Agents page)
  // pin the request to the URL's wsId rather than relying on the per-tab
  // active workspace — same defensive override as createAgent.
  // P4c-3b: managed-agent creation removed server-side (spec-direct instead).

  // Cross-workspace manager picker source — the workspace AI Agents tab
  // uses this to populate the required Runtime Host dropdown so an Agent
  // in workspace B can be attached to a manager paired in workspace A.
  // MANAGE_AGENTS-gated; returns one row per Agent with type='manager'.
  listAgentManagers: () =>
    request<Array<{ id: string; name: string; description: string; account_id: string | null; is_active: number }>>(
      '/admin/agent-manager/managers',
    ),

  // P4c-4: managed-agent workspace move endpoint removed server-side.

  // ─── Admin Logs ────────────────────────────────────────
  // Governed, immutable skill catalog and bounded Hermes ChildRuns.
  /** Global + this workspace's skills. `includeShadowed` also returns global
   *  rows a workspace fork overrides, each flagged `shadowed: true`. */
  listSkills: (accountId: string, includeShadowed = false) =>
    request<Skill[]>(
      `/accounts/${encodeURIComponent(accountId)}/skills`
      + (includeShadowed ? '?include_shadowed=1' : ''),
    ),
  /** Copy a global skill into this workspace, where it shadows the global by
   *  slug while the global keeps receiving upstream updates. */
  forkSkill: (accountId: string, skillId: string, skillVersionId?: string) =>
    request<Skill>(
      `/accounts/${encodeURIComponent(accountId)}/skills/${encodeURIComponent(skillId)}/fork`,
      { method: 'POST', body: JSON.stringify({ skill_version_id: skillVersionId || '' }) },
    ),
  getSkill: (accountId: string, skillId: string) =>
    request<SkillDetail>(
      `/accounts/${encodeURIComponent(accountId)}/skills/${encodeURIComponent(skillId)}`,
    ),
  createSkill: (
    accountId: string,
    body: {
      slug: string;
      name: string;
      description?: string;
      body: string;
      support_files?: Array<{ path: string; content: string }>;
    },
  ) =>
    request<Skill & { version: SkillVersion }>(
      `/accounts/${encodeURIComponent(accountId)}/skills`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  publishSkillVersion: (
    accountId: string,
    skillId: string,
    body: { body: string; support_files?: Array<{ path: string; content: string }> },
  ) =>
    request<SkillVersion>(
      `/accounts/${encodeURIComponent(accountId)}/skills/${encodeURIComponent(skillId)}/versions`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  assignSkill: (
    accountId: string,
    skillId: string,
    body: {
      skill_version_id: string;
      runtime: Record<string, any>;
    },
  ) =>
    request<unknown>(
      `/accounts/${encodeURIComponent(accountId)}/skills/${encodeURIComponent(skillId)}/assignments`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  quarantineSkill: (accountId: string, skillId: string) =>
    request<Skill>(
      `/accounts/${encodeURIComponent(accountId)}/skills/${encodeURIComponent(skillId)}/quarantine`,
      { method: 'PATCH' },
    ),
  // ─── Skill registry (admin — global scope + git taps) ────
  listGlobalSkills: () => request<Skill[]>('/admin/skill-registry/skills'),
  getGlobalSkill: (skillId: string) =>
    request<SkillDetail>(`/admin/skill-registry/skills/${encodeURIComponent(skillId)}`),
  quarantineGlobalSkill: (skillId: string) =>
    request<Skill>(
      `/admin/skill-registry/skills/${encodeURIComponent(skillId)}/quarantine`,
      { method: 'PATCH' },
    ),
  /** Re-run the in-repo built-in pack seeding without a restart. Idempotent. */
  reseedBuiltinSkills: () =>
    request<SkillSyncSummary & { dir: string | null }>(
      '/admin/skill-registry/builtin/reseed',
      { method: 'POST' },
    ),
  listSkillTaps: () => request<SkillTap[]>('/admin/skill-registry/taps'),
  createSkillTap: (body: {
    name: string;
    repo_url: string;
    ref?: string;
    path?: string;
    enabled?: boolean;
    allowed_licenses?: string[];
  }) => request<SkillTap>('/admin/skill-registry/taps', { method: 'POST', body: JSON.stringify(body) }),
  updateSkillTap: (tapId: string, body: Record<string, unknown>) =>
    request<SkillTap>(`/admin/skill-registry/taps/${encodeURIComponent(tapId)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteSkillTap: (tapId: string) =>
    request<{ removed: true }>(`/admin/skill-registry/taps/${encodeURIComponent(tapId)}`, {
      method: 'DELETE',
    }),
  /** `dryRun` previews what would change without writing — run this before
   *  enabling a third-party tap, since every skill becomes agent prompt text. */
  syncSkillTap: (tapId: string, opts: { dryRun?: boolean; force?: boolean } = {}) =>
    request<{
      commit: string;
      summary: SkillSyncSummary;
      skipped: Array<{ path: string; reason: string }>;
      loaded: number;
      dry_run: boolean;
    }>(`/admin/skill-registry/taps/${encodeURIComponent(tapId)}/sync`, {
      method: 'POST',
      body: JSON.stringify({ dry_run: !!opts.dryRun, force: !!opts.force }),
    }),

  listSkillProposals: (
    accountId: string,
    status?: 'pending' | 'approved' | 'rejected',
  ) =>
    request<SkillProposal[]>(
      `/accounts/${encodeURIComponent(accountId)}/skills/proposals${status ? `?status=${status}` : ''}`,
    ),
  reviewSkillProposal: (
    accountId: string,
    proposalId: string,
    decision: 'approve' | 'reject',
    body: { note?: string; skill_id?: string },
  ) =>
    request<{ proposal: SkillProposal; version: SkillVersion | null }>(
      `/accounts/${encodeURIComponent(accountId)}/skills/proposals/${encodeURIComponent(proposalId)}/${decision}`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  listAgentChildRuns: (accountId: string, agentId: string) =>
    request<HermesChildRun[]>(
      `/accounts/${encodeURIComponent(accountId)}/agents/${encodeURIComponent(agentId)}/child-runs`,
    ),

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
  // Returns Runtime Host SSE diagnostics keyed by hosted Agent id.
  // Empty / missing entry means the assigned host is not connected.
  getActiveAgentSessions: () =>
    request<Record<string, AgentLiveSession[]>>('/events/active-agent-sessions'),

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
  // ─── Migration / Live Import (ticket 0f638509) ─────────
  listMigrationRuns: () => request<MigrationRun[]>('/admin/migration/runs'),
  getMigrationRun: (id: string) => request<MigrationRun>(`/admin/migration/runs/${id}`),
  startMigrationRun: (body: { source_url: string; source_token: string; skip_attachments?: boolean; allow_merge?: boolean }) =>
    request<MigrationRun>('/admin/migration/runs', { method: 'POST', body: JSON.stringify(body) }),
  pullMigrationAttachments: (id: string) =>
    request<MigrationRun>(`/admin/migration/runs/${id}/pull-attachments`, { method: 'POST' }),
  getInstanceQuiesce: () => request<{ quiesced: boolean; reason: string }>('/admin/migration/quiesce'),
  resumeFleetDispatch: () =>
    request<{ quiesced: boolean }>('/admin/migration/quiesce/resume', { method: 'POST' }),

  // ─── Admin Workflow Health ───────────
  // Usage rollups only (docs/tickets.md → Workflow health) — the storms /
  // respawns / suppressions views and the board filter are gone.
  getWorkflowHealth: () =>
    request<WorkflowHealthRollup>('/admin/workflow-health'),

  // All-time/장기 구간 누적 (ticket 090abc77) — workspace는 getAuthHeaders()의
  // ambient X-Account-Id 헤더로 해결되므로 여기서 별도로 넘기지 않는다.
  // 별도 엔드포인트로 둔 이유는 getWorkflowHealth의 15초 폴링에 all-time
  // 집계까지 얹지 않기 위함(컨트롤러 docstring 참고) — 호출부가 직접
  // 원하는 시점에만 불러야 한다.
  getLongTermUsage: (params?: { from?: string; to?: string }) => {
    const q = new URLSearchParams();
    if (params?.from) q.set('from', params.from);
    if (params?.to) q.set('to', params.to);
    const qs = q.toString();
    return request<WorkflowHealthLongTermUsage>(`/admin/workflow-health/long-term-usage${qs ? `?${qs}` : ''}`);
  },

  // ── Phase 7: Chat Rooms ─────────────────────────
  // accountId overrides the ambient X-Account-Id header for this one call —
  // see getChannels above for why callers reacting to a accountId prop change
  // need this instead of relying on the ambient header.
  // ─── Agent Sessions (CLI 직접 세션) ────────────────────────────────────
  // 서버: apps/server/src/modules/agent-sessions. 모든 경로가 (Runtime Host, CLI)
  // 아래에 있고, 목록/기록은 매니저 장비의 CLI 홈에서 reverse RPC 로 온다.
  listAgentSessionHosts: (accountId?: string) => {
    const init: RequestInit = {};
    if (accountId) init.headers = { ...getAuthHeaders(), 'X-Account-Id': accountId };
    return request<AgentSessionHost[]>('/agent-sessions/hosts', init);
  },
  getHostCliSettings: (managerId: string, cli: string) =>
    request<AgentSessionCliSettings>(`/agent-sessions/hosts/${encodeURIComponent(managerId)}/${encodeURIComponent(cli)}/settings`),
  /**
   * `defaultConfig` 는 부분 갱신 — 보낸 키만 바뀌고 null 은 그 키를 지운다(어댑터 기본값으로 되돌림).
   * `backendProfileId` 는 생략하면 그대로 두고, null 이면 핀을 지운다(CLI 기본 엔드포인트).
   */
  setHostCliSettings: (
    managerId: string,
    cli: string,
    credentialId: string | null,
    defaultConfig?: Record<string, string | boolean | null>,
    backendProfileId?: string | null,
  ) =>
    request<AgentSessionCliSettings>(`/agent-sessions/hosts/${encodeURIComponent(managerId)}/${encodeURIComponent(cli)}/settings`, {
      method: 'PUT',
      body: JSON.stringify({
        credential_id: credentialId,
        ...(defaultConfig ? { default_config: defaultConfig } : {}),
        ...(backendProfileId !== undefined ? { backend_profile_id: backendProfileId } : {}),
      }),
    }),
  listHostSessions: (managerId: string, cli: string) =>
    request<AgentSessionSummary[]>(`/agent-sessions/hosts/${encodeURIComponent(managerId)}/${encodeURIComponent(cli)}/sessions`),
  /** `force` 는 세션 잠금을 쥔 외부 프로세스까지 종료하고 연다 — 매니저가 그 프로세스의
   *  이름·PID 를 `resume_locked_external` 오류로 알려 준 뒤, 확인 대화상자를 거쳐서만 켠다. */
  openHostSession: (managerId: string, cli: string, input: { session_id?: string | null; cwd?: string; title?: string; force?: boolean }) =>
    request<AgentSessionLiveSnapshot>(`/agent-sessions/hosts/${encodeURIComponent(managerId)}/${encodeURIComponent(cli)}/sessions`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  getHostSession: (managerId: string, cli: string, sessionId: string) =>
    request<AgentSessionDetail>(`/agent-sessions/hosts/${encodeURIComponent(managerId)}/${encodeURIComponent(cli)}/sessions/${encodeURIComponent(sessionId)}`),
  /**
   * 세션이 내보낸 이미지 한 장의 **바이트**. `<img src>` 는 Authorization 헤더를 보낼 수
   * 없으므로, 토큰을 쿼리로 노출하는 별도 인증 경로를 만드는 대신(로그·referrer 로 새어
   * 나간다) 여기서 헤더로 받아 Blob URL 로 바꿔 쓴다 — 엔드포인트는 기존 가드
   * (`agent_sessions.use`) 를 그대로 통과한다.
   */
  getHostSessionImage: async (managerId: string, cli: string, sessionId: string, imageRef: string): Promise<Blob> => {
    const path = `/agent-sessions/hosts/${encodeURIComponent(managerId)}/${encodeURIComponent(cli)}`
      + `/sessions/${encodeURIComponent(sessionId)}/image/${encodeURIComponent(imageRef)}`;
    const resp = await fetchOk(path);
    return resp.blob();
  },
  /** 에이전트가 답에 **경로로** 적은 미리보기 파일(`![alt](E:/…png)`, `[보고서](./report.html)`) — 그 Runtime Host 의 매니저가 읽어 준다.
   *  `cwd` 는 상대 경로의 기준. 실패하면 서버가 준 사유(message)로 던진다. */
  getHostSessionLocalImage: async (managerId: string, cli: string, sessionId: string, path: string, cwd: string): Promise<Blob> => {
    const query = new URLSearchParams({ path, ...(cwd ? { cwd } : {}) });
    const url = `/agent-sessions/hosts/${encodeURIComponent(managerId)}/${encodeURIComponent(cli)}`
      + `/sessions/${encodeURIComponent(sessionId)}/local-image?${query.toString()}`;
    const resp = await fetchOk(url);
    return resp.blob();
  },
  /** 세션 프롬프트 — 텍스트 + 이미지 첨부. 이미지는 base64 그대로 실어 보내고 서버는 저장하지 않고
   *  매니저로 흘려보낸다(매니저가 ACP Image 블록으로 변환). 빈 텍스트 + 이미지 1장 이상도 된다. */
  promptHostSession: (managerId: string, cli: string, sessionId: string, text: string, images?: { base64: string; mime_type: string }[]) =>
    request<{ turn_id: string; live: AgentSessionLiveSnapshot }>(
      `/agent-sessions/hosts/${encodeURIComponent(managerId)}/${encodeURIComponent(cli)}/sessions/${encodeURIComponent(sessionId)}/prompt`,
      { method: 'POST', body: JSON.stringify({ text, ...(images?.length ? { images } : {}) }) },
    ),
  decideHostSessionPermission: (managerId: string, cli: string, sessionId: string, requestId: string, optionId: string | null) =>
    request<AgentSessionLiveSnapshot>(
      `/agent-sessions/hosts/${encodeURIComponent(managerId)}/${encodeURIComponent(cli)}/sessions/${encodeURIComponent(sessionId)}/permission`,
      { method: 'POST', body: JSON.stringify({ request_id: requestId, option_id: optionId }) },
    ),
  cancelHostSession: (managerId: string, cli: string, sessionId: string) =>
    request<AgentSessionLiveSnapshot>(
      `/agent-sessions/hosts/${encodeURIComponent(managerId)}/${encodeURIComponent(cli)}/sessions/${encodeURIComponent(sessionId)}/cancel`,
      { method: 'POST' },
    ),
  /**
   * 세션 프로세스를 죽이고 같은 세션 id 로 다시 띄운다.
   *
   * 살아 있는 프로세스는 **기동 시점의 CLI 상태**를 물고 있어서, 그 사이에 CLI 를
   * 올려도 모델 목록·기능이 갱신되지 않는다. 기록은 CLI 홈에 있으므로 재시작해도
   * 대화는 이어진다 — 죽는 것은 프로세스뿐이다.
   */
  restartHostSession: (managerId: string, cli: string, sessionId: string) =>
    request<AgentSessionLiveSnapshot>(
      `/agent-sessions/hosts/${encodeURIComponent(managerId)}/${encodeURIComponent(cli)}/sessions/${encodeURIComponent(sessionId)}/restart`,
      { method: 'POST' },
    ),
  repairHostSessionCredential: (managerId: string, cli: string, sessionId: string) =>
    request<AgentSessionLiveSnapshot>(
      `/agent-sessions/hosts/${encodeURIComponent(managerId)}/${encodeURIComponent(cli)}/sessions/${encodeURIComponent(sessionId)}/repair-credential`,
      { method: 'POST' },
    ),
  setHostSessionMode: (managerId: string, cli: string, sessionId: string, modeId: string) =>
    request<AgentSessionLiveSnapshot>(
      `/agent-sessions/hosts/${encodeURIComponent(managerId)}/${encodeURIComponent(cli)}/sessions/${encodeURIComponent(sessionId)}/mode`,
      { method: 'POST', body: JSON.stringify({ mode_id: modeId }) },
    ),
  setHostSessionConfigOption: (managerId: string, cli: string, sessionId: string, configId: string, value: string | boolean) =>
    request<AgentSessionLiveSnapshot>(
      `/agent-sessions/hosts/${encodeURIComponent(managerId)}/${encodeURIComponent(cli)}/sessions/${encodeURIComponent(sessionId)}/config-option`,
      { method: 'POST', body: JSON.stringify({ config_id: configId, value }) },
    ),
  answerHostSessionElicitation: (
    managerId: string,
    cli: string,
    sessionId: string,
    elicitationId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown> | null,
  ) =>
    request<AgentSessionLiveSnapshot>(
      `/agent-sessions/hosts/${encodeURIComponent(managerId)}/${encodeURIComponent(cli)}/sessions/${encodeURIComponent(sessionId)}/elicitation`,
      { method: 'POST', body: JSON.stringify({ elicitation_id: elicitationId, action, content: content ?? null }) },
    ),
  closeHostSession: (managerId: string, cli: string, sessionId: string) =>
    request<AgentSessionLiveSnapshot>(
      `/agent-sessions/hosts/${encodeURIComponent(managerId)}/${encodeURIComponent(cli)}/sessions/${encodeURIComponent(sessionId)}/close`,
      { method: 'POST' },
    ),

  // ─── Voice (docs/voice-operator.md) ──────────────────────────────────
  // 서버: apps/server/src/modules/voice. 엔진 키는 서버에만 있고, 화면은 녹음한 바이트를 보내
  // 글자를 받고, 글자를 보내 소리를 받는다.
  getVoiceConfig: () => request<VoiceConfigView>('/voice/config'),
  getVoiceSpeaker: () => request<import('./types').VoiceSpeakerProfile>('/voice/speaker'),
  enrollVoiceSpeaker: async (audio: Blob): Promise<import('./types').VoiceSpeakerProfile> =>
    (await fetchOk('/voice/speaker/enroll', { method: 'POST', body: audio, contentType: audio.type || 'application/octet-stream' })).json(),
  updateVoiceSpeaker: (input: { enabled?: boolean; threshold?: number }) =>
    request<import('./types').VoiceSpeakerProfile>('/voice/speaker', { method: 'PATCH', body: JSON.stringify(input) }),
  removeVoiceSpeaker: () => request<import('./types').VoiceSpeakerProfile>('/voice/speaker', { method: 'DELETE' }),
  voiceLocalModels: () => request<{ models: Array<{ id: string; name: string }>; speaker: { ready: boolean } }>('/voice/lab/models'),
  /**
   * 발화 하나를 글자로. 녹음 형식(webm/mp4/wav)을 그대로 보낸다. `purpose: 'wake'` 는 잠든 operator 를
   * 부르는 말인지 확인하는 상시 청취다 — 서버가 자체 호스팅 엔진일 때만 받는다.
   */
  transcribeVoice: async (audio: Blob, purpose: 'utterance' | 'wake' = 'utterance'): Promise<VoiceTranscript> =>
    (await fetchOk(`/voice/transcribe${purpose === 'wake' ? '?purpose=wake' : ''}`, { method: 'POST', body: audio, contentType: audio.type || 'application/octet-stream' })).json(),
  /**
   * 화면용 답 → 읽을 조각들(서버의 toSpeakable + splitSpeakable). 읽을 것이 없으면 빈 배열.
   * `summary` — operator 의 답: 첫 문단(귀로 들을 요약)만 읽는다(서버 toSpokenSummary).
   */
  voiceSpeakable: (text: string, summary = false) =>
    request<{ chunks: string[] }>('/voice/speakable', { method: 'POST', body: JSON.stringify(summary ? { text, summary: true } : { text }) }),
  /** 이미 읽을 문장으로 다듬은 조각 하나를 소리로. */
  synthesizeVoice: async (text: string): Promise<Blob> =>
    (await fetchOk('/voice/speech', { method: 'POST', body: JSON.stringify({ text }), contentType: 'application/json' })).blob(),
  /** Operators(이름 붙은 Agent Session) — 등록·수정·해제는 admin 만. */
  // operator 의 작업 제안(docs/voice-operator.md "작업 제안") — 내가 정할 것만 온다. 보내는 것은 그 세션에 프롬프트를 넣는 일이다.
  listSessionProposals: () => request<{ proposals: SessionProposal[] }>('/voice/proposals'),
  sendSessionProposal: (id: string) =>
    request<{ proposal: SessionProposal }>(`/voice/proposals/${encodeURIComponent(id)}/send`, { method: 'POST' }),
  dismissSessionProposal: (id: string) =>
    request<{ proposal: SessionProposal }>(`/voice/proposals/${encodeURIComponent(id)}/dismiss`, { method: 'POST' }),
  listVoiceOperators: () => request<{ operators: VoiceOperator[] }>('/voice/operators'),
  createVoiceOperator: (input: { name: string; aliases: string[]; manager_id: string; cli: string; session_id: string; cwd?: string; title?: string }) =>
    request<{ operator: VoiceOperator }>('/voice/operators', { method: 'POST', body: JSON.stringify(input) }),
  updateVoiceOperator: (id: string, input: { name?: string; aliases?: string[]; title?: string }) =>
    request<{ operator: VoiceOperator }>(`/voice/operators/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteVoiceOperator: (id: string) =>
    request<{ operators: VoiceOperator[] }>(`/voice/operators/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** 이 탭이 보고 있는 세션 — 서버는 보고 있는 세션의 완료를 operator 에게 보고하지 않는다. */
  reportVoicePresence: async (input: { tab_id: string; session: { manager_id: string; cli: string; session_id: string } | null; visible: boolean }): Promise<void> => {
    await fetchOk('/voice/presence', { method: 'PUT', body: JSON.stringify(input), contentType: 'application/json' });
  },
  /**
   * 이 단말의 음성 지원 스위치. 사용자의 단말이 모두 꺼져 있으면 서버가 세션 완료를 operator 에게 보고하지 않는다.
   * 답의 `operator_reports` — 알린 뒤에도 보고가 계속되는가(다른 단말이 켜져 있으면 true).
   */
  reportVoiceSupport: (input: { device_id: string; enabled: boolean }) =>
    request<{ operator_reports: boolean }>('/voice/support', { method: 'PUT', body: JSON.stringify(input) }),
  /** 음성 알림의 소리 — 받는 사람만, 서버가 처음 요청될 때 합성한다. */
  getVoiceAnnouncementAudio: async (id: string): Promise<Blob> =>
    (await fetchOk(`/voice/announcements/${encodeURIComponent(id)}/audio`)).blob(),
  /** Voice lab(admin) — 키가 있는 공급자를 골라 같은 발화/문장을 비교한다. */
  voiceLabTranscribe: async (provider: string, audio: Blob, model?: string): Promise<VoiceTranscript> => {
    const query = new URLSearchParams({ provider, ...(model ? { model } : {}) });
    return (await fetchOk(`/voice/lab/transcribe?${query.toString()}`, { method: 'POST', body: audio, contentType: audio.type || 'application/octet-stream' })).json();
  },
  voiceLabVoices: (provider: string) =>
    request<{ voices: VoiceOptionView[] }>(`/voice/lab/voices?provider=${encodeURIComponent(provider)}`),
  voiceLabSpeech: async (input: { provider: string; text: string; voice?: string; model?: string }): Promise<{ blob: Blob; latencyMs: number }> => {
    const startedAt = performance.now();
    const res = await fetchOk('/voice/lab/speech', { method: 'POST', body: JSON.stringify(input), contentType: 'application/json' });
    const blob = await res.blob();
    return { blob, latencyMs: Math.round(performance.now() - startedAt) };
  },

  // ─── Terminals (Runtime Host 셸) ──────────────────────────────────────
  // 서버: apps/server/src/modules/terminals. 살아 있는 터미널만 다룬다 — 기록이 없으므로
  // 목록에 죽은 것은 나오지 않고, 스크롤백은 attach 가 한 번 넘겨준다.
  listTerminalHosts: (accountId?: string) => {
    const init: RequestInit = {};
    if (accountId) init.headers = { ...getAuthHeaders(), 'X-Account-Id': accountId };
    return request<TerminalHost[]>('/terminals/hosts', init);
  },
  listHostTerminals: (managerId: string) =>
    request<TerminalSummary[]>(`/terminals/hosts/${encodeURIComponent(managerId)}/terminals`),
  openHostTerminal: (managerId: string, body: { shell?: string | null; cwd?: string; title?: string; cols?: number; rows?: number }) =>
    request<TerminalSummary>(`/terminals/hosts/${encodeURIComponent(managerId)}/terminals`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** 붙으면서 driver 가 된다 — 이 호출 이후의 출력이 내 SSE 로 온다. */
  attachHostTerminal: (managerId: string, terminalId: string, size?: { cols: number; rows: number }) =>
    request<TerminalSnapshot>(
      `/terminals/hosts/${encodeURIComponent(managerId)}/terminals/${encodeURIComponent(terminalId)}`
      + (size ? `?cols=${size.cols}&rows=${size.rows}` : ''),
    ),
  writeHostTerminal: (managerId: string, terminalId: string, data: string) =>
    request<{ ok: true }>(
      `/terminals/hosts/${encodeURIComponent(managerId)}/terminals/${encodeURIComponent(terminalId)}/input`,
      { method: 'POST', body: JSON.stringify({ data }) },
    ),
  resizeHostTerminal: (managerId: string, terminalId: string, cols: number, rows: number) =>
    request<TerminalSummary>(
      `/terminals/hosts/${encodeURIComponent(managerId)}/terminals/${encodeURIComponent(terminalId)}/resize`,
      { method: 'POST', body: JSON.stringify({ cols, rows }) },
    ),
  closeHostTerminal: (managerId: string, terminalId: string) =>
    request<TerminalSummary>(
      `/terminals/hosts/${encodeURIComponent(managerId)}/terminals/${encodeURIComponent(terminalId)}/close`,
      { method: 'POST' },
    ),

  listChatRooms: (scope?: 'account', accountId?: string) => {
    const init: RequestInit = {};
    if (accountId) init.headers = { ...getAuthHeaders(), 'X-Account-Id': accountId };
    return request<ChatRoomListItem[]>(scope === 'account' ? '/chat-rooms?scope=account' : '/chat-rooms', init);
  },

  // Server returns `{ room: ChatRoomDetail, existing: boolean }` — unwrap so
  // callers can dereference `room.id` directly. (Pre-dedup-removal the
  // `existing` flag mattered to MCP callers; for the REST/UI flow same-member
  // rooms are no longer deduped, so the envelope is just legacy noise.)
  createChatRoom: async (
    participants: { participant_type: string; participant_id: string; runtime?: Record<string, any> }[],
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

  getChatRoomSessionStatus: (roomId: string, observer = false) =>
    request<Array<{
      agent_id: string;
      agent_name: string;
      keep_alive_until_ms: number | null;
      background_task_count: number;
    }>>(`/chat-rooms/${roomId}/session-status${observer ? '?observer=true' : ''}`),

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
      xhr.open('POST', `${apiBase()}/chat-rooms/${roomId}/attachments`);
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
    request<ChatAttachment & { file_data: string; truncated?: boolean }>(
      `/chat-rooms/${roomId}/attachments/${attachmentId}`,
    ),

  markChatRoomRead: (roomId: string) =>
    request<void>(`/chat-rooms/${roomId}/read`, { method: 'PATCH' }),

  renameChatRoom: (roomId: string, name: string) =>
    request<void>(`/chat-rooms/${roomId}/name`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),

  // 자유 참여(open join) 토글 (ticket 995a9519). 방의 active participant 면 호출할 수
  // 있고, DM 과 시스템 소유 방(Action Run / orchestration / QA·security run)은 서버가
  // 400 으로 거부한다.
  setChatRoomOpenJoin: (roomId: string, openJoin: boolean) =>
    request<{ ok: boolean; room_id: string; open_join: boolean }>(`/chat-rooms/${roomId}/open-join`, {
      method: 'PATCH',
      body: JSON.stringify({ open_join: openJoin }),
    }),

  addChatRoomParticipants: (roomId: string, participants: { participant_type: string; participant_id: string; runtime?: Record<string, any> }[]) =>
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

  searchChatMessages: (_accountId: string, query: string): Promise<any[]> =>
    request<any[]>(`/chat-rooms/search?q=${encodeURIComponent(query)}`),

  // ─── @-Mentions ─────────────────────────────────────────
  getMentionCandidates: (
    accountId: string,
    ticketId?: string,
  ): Promise<MentionCandidatesResponse> => {
    const qs = ticketId ? `?ticket_id=${encodeURIComponent(ticketId)}` : '';
    return request<MentionCandidatesResponse>(
      `/accounts/${encodeURIComponent(accountId)}/mention-candidates${qs}`,
    );
  },

  getUnreadMentions: (_accountId?: string): Promise<UnreadMentionsResponse> =>
    request<UnreadMentionsResponse>('/mentions/unread'),

  markMentionRead: (mentionId: string): Promise<UserMentionItem> =>
    request<UserMentionItem>(`/mentions/${encodeURIComponent(mentionId)}/read`, { method: 'POST' }),

  // Viewport-based mention clearing. `unread-by-source` answers "which
  // mentions are still pending inside THIS ticket / room", projected to the
  // comment / chat-message they live in so the client can match them against
  // the rows on screen. `markMentionsRead` reports back the ones the reader
  // actually saw, batched.
  getUnreadMentionsBySource: (
    source: { ticketId?: string; roomId?: string },
  ): Promise<{ items: Array<{ id: string; source_id: string }> }> => {
    const qs = new URLSearchParams();
    if (source.ticketId) qs.set('ticket_id', source.ticketId);
    if (source.roomId) qs.set('room_id', source.roomId);
    return request<{ items: Array<{ id: string; source_id: string }> }>(
      `/mentions/unread-by-source?${qs.toString()}`,
    );
  },

  markMentionsRead: (ids: string[]): Promise<{ updated: number }> =>
    request<{ updated: number }>('/mentions/read-batch', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),

  markAllMentionsRead: (_accountId?: string): Promise<{ updated: number }> =>
    request<{ updated: number }>(
      '/mentions/read-all',
      { method: 'POST' },
    ),

  // ─── Badge count endpoints ───────────────────────────────
  // Lightweight counts across the caller's accessible accounts, used by
  // the sidebar NotificationContext. Each endpoint returns `{ count }` or
  // `{ total, perX }` so the client bookkeeping stays uniform.
  getChatUnreadCounts: (): Promise<{ total: number; perRoom: Record<string, number> }> =>
    request<{ total: number; perRoom: Record<string, number> }>('/chat-rooms/unread-counts'),
  // `{ total, perTicket }` — no per-board roll-up any more (docs/tickets.md).
  getTicketUnreadCounts: (): Promise<{ total: number; perTicket: Record<string, number> }> =>
    request<{ total: number; perTicket: Record<string, number> }>('/tickets/unread-counts'),
  // 티켓 코멘트 일괄 읽음 처리 — markAllMentionsRead와 같은 아이디어를,
  // UserMention 행 대신 TicketReadState에 upsert하는 방식으로 적용한다.
  // 접근 가능한 모든 account의 관여 티켓을 읽음 처리한다.
  markAllTicketsRead: (): Promise<{ updated: number }> =>
    request<{ updated: number }>('/tickets/read-all', {
      method: 'POST',
      body: '{}',
    }),
  getPendingUsersCount: (): Promise<{ count: number }> =>
    request<{ count: number }>('/admin/pending-users/count'),
  getAgentErrorsUnseenCount: (since?: string | null): Promise<{ count: number }> => {
    const qs = since ? `?since=${encodeURIComponent(since)}` : '';
    return request<{ count: number }>(`/admin/agent-logs/unseen-count${qs}`);
  },

  // ─── Orchestration mode ────────────────────────────────────────────────
  // Teams + Missions. Note the asymmetry with the agent-facing surface: there
  // is no client call that assigns or completes a STEP — the plan belongs to
  // the orchestrator agent and is only mutated through its MCP tools. Human
  // intervention is start / pause / resume / cancel / nudge.
  listOrchestrationTeams: (_accountId: string) =>
    request<OrchestrationTeam[]>('/orchestration/teams'),
  getOrchestrationTeam: (id: string, accountId: string) =>
    request<OrchestrationTeam>(`/orchestration/teams/${id}?account_id=${encodeURIComponent(accountId)}`),
  createOrchestrationTeam: (data: {
    account_id: string;
    name: string;
    description?: string;
    /** Orchestrator runtime spec — Runtime Host / CLI / model / working folder. */
    orchestrator: OrchestrationSlotSpecInput;
    orchestrator_prompt?: string;
    max_parallel_steps?: number;
    max_open_missions?: number;
    /** 글로벌(workspace 비종속) 팀으로 생성. 기본값 false. */
    is_global?: boolean;
    /** 글로벌 팀 전용: orchestrator가 미션을 만들 수 있는 workspace 목록. */
    allowed_account_ids?: string[];
  }) => request<OrchestrationTeam>('/orchestration/teams', { method: 'POST', body: JSON.stringify(data) }),
  updateOrchestrationTeam: (
    id: string,
    data: {
      account_id: string;
      name?: string;
      description?: string;
      /** Partial patch over the orchestrator's stored runtime spec. */
      orchestrator?: Partial<OrchestrationSlotSpecInput>;
      orchestrator_prompt?: string;
      max_parallel_steps?: number;
      max_open_missions?: number;
      enabled?: boolean;
      /** 글로벌 팀 전용: workspace 허용목록을 통째로 교체한다. */
      allowed_account_ids?: string[];
    },
  ) => request<OrchestrationTeam>(`/orchestration/teams/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteOrchestrationTeam: (id: string, accountId: string) =>
    request<{ success: true; id: string }>(
      `/orchestration/teams/${id}?account_id=${encodeURIComponent(accountId)}`,
      { method: 'DELETE' },
    ),
  addOrchestrationTeamMember: (
    teamId: string,
    data: {
      account_id: string;
      /** Runtime spec for the new slot. There is no agent to pick — it is provisioned from this. */
      runtime?: OrchestrationSlotSpecInput;
      /** Put the orchestrator itself on the roster as an executing member (ignores `runtime`). */
      as_orchestrator?: boolean;
      role_label?: string;
      capabilities?: string;
      max_concurrent?: number;
    },
  ) => request<OrchestrationTeam>(`/orchestration/teams/${teamId}/members`, { method: 'POST', body: JSON.stringify(data) }),
  updateOrchestrationTeamMember: (
    teamId: string,
    memberId: string,
    data: {
      account_id: string;
      /** Partial patch over the slot's stored runtime spec. Omit to leave it unchanged. */
      runtime?: Partial<OrchestrationSlotSpecInput>;
      role_label?: string;
      capabilities?: string;
      max_concurrent?: number;
      position?: number;
    },
  ) =>
    request<OrchestrationTeam>(`/orchestration/teams/${teamId}/members/${memberId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  removeOrchestrationTeamMember: (teamId: string, memberId: string, accountId: string) =>
    request<OrchestrationTeam>(
      `/orchestration/teams/${teamId}/members/${memberId}?account_id=${encodeURIComponent(accountId)}`,
      { method: 'DELETE' },
    ),
  /** Runtime Hosts + their CLI / model / working-folder candidates for the team editor. */
  listOrchestrationRuntimeHosts: (accountId: string) =>
    request<OrchestrationRuntimeHost[]>(
      `/orchestration/runtime-hosts?account_id=${encodeURIComponent(accountId)}`,
    ),
  /**
   * Make a Runtime Host re-list its per-CLI models and return its refreshed row.
   * The server issues the command and awaits the host's ack before replying, so
   * this resolves with a list that is already current.
   */
  refreshOrchestrationRuntimeHostModels: (managerAgentId: string, accountId: string) =>
    request<OrchestrationRuntimeHost>(
      `/orchestration/runtime-hosts/${encodeURIComponent(managerAgentId)}/refresh-models`,
      { method: 'POST', body: JSON.stringify({ account_id: accountId }) },
    ),

  listOrchestrationMissions: (_accountId: string, opts?: { teamId?: string; status?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (opts?.teamId) params.set('team_id', opts.teamId);
    if (opts?.status) params.set('status', opts.status);
    if (opts?.limit) params.set('limit', String(opts.limit));
    return request<OrchestrationMissionListItem[]>(`/orchestration/missions?${params.toString()}`);
  },
  /**
   * 한 step 의 작업 세션 기록(최신순 + `before_id` 커서). 미션 화면에서 그 step 을
   * 선택했을 때만 부른다 — 카드에 실리는 최신 한 줄은 미션 상세 응답의 `step.activity`
   * 에 이미 있다.
   */
  getOrchestrationStepSession: (
    stepId: string,
    accountId: string,
    opts?: { limit?: number; beforeId?: string },
  ) => {
    const params = new URLSearchParams({ account_id: accountId });
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.beforeId) params.set('before_id', opts.beforeId);
    return request<OrchestrationStepSession>(`/orchestration/steps/${stepId}/session?${params.toString()}`);
  },
  /** step 방 첨부 하나(바이트 포함). 썸네일·플레이어·다운로드가 Blob 으로 바꿔 쓴다. */
  getOrchestrationStepAttachment: (stepId: string, accountId: string, attachmentId: string) =>
    request<OrchestrationStepAttachment & { file_data: string; truncated?: boolean }>(
      `/orchestration/steps/${stepId}/attachments/${attachmentId}?account_id=${encodeURIComponent(accountId)}`,
    ),
  /** 미션의 검증 증거 갤러리 — 모든 step 방과 미션 방의 이미지·동영상, 최신순. */
  listOrchestrationMissionEvidence: (missionId: string, accountId: string, limit = 200) =>
    request<{ mission_id: string; items: OrchestrationEvidenceItem[] }>(
      `/orchestration/missions/${missionId}/evidence?account_id=${encodeURIComponent(accountId)}&limit=${limit}`,
    ),
  getOrchestrationMission: (id: string, accountId: string) =>
    request<OrchestrationMissionDetail>(
      `/orchestration/missions/${id}?account_id=${encodeURIComponent(accountId)}`,
    ),
  /**
   * 미션 타임라인 커서 페이지네이션(티켓 4d065f82). `getOrchestrationMission` 은 최신
   * N건만 싣는 bounded window 라, 이전 이력은 이 경로로만 가져올 수 있다. 커서는
   * `(at, seq, id)` 3단 복합 keyset 이다 — 같은 타임스탬프에 몰린 fan-out 이벤트가 페이지
   * 경계에서 통째로 누락되지 않게 하려면 seq 가 반드시 함께 가야 하고, **seq 마저 동률인**
   * 경우(fail-open 의 `write_seq: 0` 이 한 미션에서 두 번, 또는 백필 전 레거시 구간)까지
   * 막으려면 안정 키인 id 도 함께 가야 한다(티켓 7b679009). 셋 중 하나라도 빼면 그
   * 군집에서 이벤트가 조용히 사라진다.
   */
  listOrchestrationMissionEvents: (
    id: string,
    accountId: string,
    opts?: { limit?: number; before_at?: string; before_seq?: number; before_id?: string },
  ) => {
    const parts = [`account_id=${encodeURIComponent(accountId)}`];
    if (opts?.limit) parts.push(`limit=${opts.limit}`);
    if (opts?.before_at) parts.push(`before_at=${encodeURIComponent(opts.before_at)}`);
    if (opts?.before_seq !== undefined) parts.push(`before_seq=${opts.before_seq}`);
    if (opts?.before_id) parts.push(`before_id=${encodeURIComponent(opts.before_id)}`);
    return request<{
      events: OrchestrationTimelineEvent[];
      has_more: boolean;
      next_cursor: { at: string; seq: number; id: string } | null;
    }>(`/orchestration/missions/${id}/events?${parts.join('&')}`);
  },

  createOrchestrationMission: (data: {
    account_id: string;
    team_id: string;
    title: string;
    objective: string;
    context?: string;
    acceptance_criteria?: string;
    method?: string;
    completion_criteria?: Array<{ key: string; description: string }>;
    post_actions?: Array<{ action_id: string; order?: number; condition?: OrchestrationPostActionCondition }>;
    workspace_folder?: string;
    repo_ref?: OrchestrationRepoRef | null;
    checkout_mode?: 'reuse' | 'fresh';
    max_parallel_steps?: number;
    max_steps?: number;
    step_timeout_minutes?: number;
    /** 실행 그래프(조건 분기/join/bounded loop) 사용 여부 — confirm 노드의 전제 조건이다. */
    graph_enabled?: boolean;
    /** 사용자 확인 강도(티켓 5dbe4aa2). graph_enabled 가 켜져야 실제로 동작한다. */
    confirm_policy?: OrchestrationConfirmPolicy;
    /** 미션 대화에서 사람이 발화할 수 있는가(티켓 9cfd8161). 기본 'open'. */
    user_chat_mode?: OrchestrationUserChatMode;
    /** Brief the orchestrator immediately instead of leaving the mission a draft. */
    start?: boolean;
  }) => request<OrchestrationMissionDetail>('/orchestration/missions', { method: 'POST', body: JSON.stringify(data) }),
  updateOrchestrationMission: (
    id: string,
    data: {
      account_id: string;
      title?: string;
      objective?: string;
      context?: string;
      acceptance_criteria?: string;
      method?: string;
      completion_criteria?: Array<{ key: string; description: string }>;
      post_actions?: Array<{ action_id: string; order?: number; condition?: OrchestrationPostActionCondition }>;
      workspace_folder?: string;
      repo_ref?: OrchestrationRepoRef | null;
      checkout_mode?: 'reuse' | 'fresh';
      max_parallel_steps?: number;
      max_steps?: number;
      step_timeout_minutes?: number;
      graph_enabled?: boolean;
      confirm_policy?: OrchestrationConfirmPolicy;
      /**
       * 미션 대화의 사용자 chat 옵션(티켓 9cfd8161).
       *
       * 다른 브리핑 필드와 달리 **running 미션에서도 단독 PATCH 가 허용된다** — 서버의
       * draft 잠금(touchesBrief)에서 빠져 있다. 다만 브리핑 필드를 함께 실어 보내면
       * running 미션에서는 그쪽이 409 를 내므로, 실행 중 변경은 이 필드만 보낼 것.
       */
      user_chat_mode?: OrchestrationUserChatMode;
    },
  ) =>
    request<OrchestrationMissionDetail>(`/orchestration/missions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deleteOrchestrationMission: (id: string, accountId: string) =>
    request<{ success: true; id: string }>(
      `/orchestration/missions/${id}?account_id=${encodeURIComponent(accountId)}`,
      { method: 'DELETE' },
    ),
  startOrchestrationMission: (id: string, accountId: string) =>
    request<OrchestrationMissionDetail>(`/orchestration/missions/${id}/start`, {
      method: 'POST',
      body: JSON.stringify({ account_id: accountId }),
    }),
  pauseOrchestrationMission: (id: string, accountId: string) =>
    request<OrchestrationMissionDetail>(`/orchestration/missions/${id}/pause`, {
      method: 'POST',
      body: JSON.stringify({ account_id: accountId }),
    }),
  resumeOrchestrationMission: (id: string, accountId: string) =>
    request<OrchestrationMissionDetail>(`/orchestration/missions/${id}/resume`, {
      method: 'POST',
      body: JSON.stringify({ account_id: accountId }),
    }),
  cancelOrchestrationMission: (id: string, accountId: string, reason?: string) =>
    request<OrchestrationMissionDetail>(`/orchestration/missions/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ account_id: accountId, reason: reason || '' }),
    }),
  /**
   * confirm 노드에 Pass/Fail 판정을 제출한다(티켓 5dbe4aa2).
   *
   * `visit` 은 화면이 본 pass 번호다 — 반드시 함께 보낸다. loop 가 재진입해 화면이
   * stale 해진 상태에서 제출하면 서버가 409 로 거부하는데, 이 값을 빼면 그 방어가
   * 통째로 무력해진다(생략을 허용하면 stale 한 화면이 값을 빼는 것만으로 우회한다).
   */
  submitOrchestrationStepConfirm: (
    stepId: string,
    data: { account_id: string; verdict: 'pass' | 'fail'; visit: number; feedback?: string },
  ) =>
    request<{
      already_decided: boolean;
      step_id: string;
      step_key: string;
      status: OrchestrationStepStatus;
      confirm_decision: OrchestrationConfirmDecision | null;
      dispatched: string[];
      loop_reentered: string[];
      orchestrator_woken: boolean;
    }>(`/orchestration/steps/${stepId}/confirm`, { method: 'POST', body: JSON.stringify(data) }),
  /**
   * 종료된 미션을 다시 연다(운영자 입구). orchestrator 는 같은 전이를
   * `reopen_orchestration_mission` MCP 툴로 스스로 부르므로, 대화만으로도 이어서 진행된다.
   */
  reopenOrchestrationMission: (id: string, accountId: string, reason?: string) =>
    request<OrchestrationMissionDetail>(`/orchestration/missions/${id}/reopen`, {
      method: 'POST',
      body: JSON.stringify({ account_id: accountId, reason }),
    }),
  nudgeOrchestrationMission: (id: string, accountId: string, note?: string) =>
    request<OrchestrationMissionDetail>(`/orchestration/missions/${id}/nudge`, {
      method: 'POST',
      body: JSON.stringify({ account_id: accountId, note: note || '' }),
    }),
  /**
   * 미션 대화방에 참여한다(티켓 f6a0de0e). 멱등하므로 이미 참여 중인지 몰라도 부를 수
   * 있고, `joined` 로 이번 호출이 실제로 넣었는지 구분한다.
   */
  joinOrchestrationMissionConversation: (id: string, accountId: string) =>
    request<{ room_id: string; joined: boolean }>(`/orchestration/missions/${id}/join-conversation`, {
      method: 'POST',
      body: JSON.stringify({ account_id: accountId }),
    }),

  // ─── Ontology Graph (ticket d22b83b4) ─────────────────────
  getOntologyGraphStatus: (
    accountId: string,
    ref: { graphId?: string; resourceId?: string; folderPath?: string },
  ): Promise<OntologyGraphStatusResponse> => {
    const params = new URLSearchParams({ account_id: accountId });
    if (ref.graphId) params.set('graph_id', ref.graphId);
    if (ref.resourceId) params.set('resource_id', ref.resourceId);
    if (ref.folderPath !== undefined) params.set('folder_path', ref.folderPath);
    return request<OntologyGraphStatusResponse>(`/ontology/status?${params.toString()}`);
  },
  logOntologyGraphViewOpened: (
    accountId: string,
    ref: { resourceId?: string; folderPath?: string },
  ): Promise<{ ok: true }> =>
    request<{ ok: true }>('/ontology/view-opened', {
      method: 'POST',
      body: JSON.stringify({ account_id: accountId, resource_id: ref.resourceId, folder_path: ref.folderPath }),
    }),
  refreshOntologyGraph: (accountId: string, graphId: string): Promise<OntologyGraphRefreshResponse> =>
    request<OntologyGraphRefreshResponse>('/ontology/refresh', {
      method: 'POST',
      body: JSON.stringify({ account_id: accountId, graph_id: graphId }),
    }),
  getOntologyGraph: (accountId: string, graphId: string): Promise<OntologyGraphSnapshotResponse> =>
    request<OntologyGraphSnapshotResponse>(
      `/ontology/graph?account_id=${encodeURIComponent(accountId)}&graph_id=${encodeURIComponent(graphId)}`,
    ),
};

// ─── Ticket list / write shapes (docs/tickets.md) ─────────
export interface TicketListQuery {
  status?: TicketStatus[];
  /** AND semantics — a ticket must carry every tag. */
  tags?: string[];
  project_id?: string;
  assignee_key?: string;
  q?: string;
  include_archived?: boolean;
  archived_only?: boolean;
}

/** Query string for GET /accounts/:wsId/tickets (pure — unit tested). */
export function ticketListQueryString(filters: TicketListQuery): string {
  const qs = new URLSearchParams();
  if (filters.status && filters.status.length) qs.set('status', filters.status.join(','));
  if (filters.tags && filters.tags.length) qs.set('tags', filters.tags.join(','));
  if (filters.project_id) qs.set('project_id', filters.project_id);
  if (filters.assignee_key) qs.set('assignee_key', filters.assignee_key);
  if (filters.q && filters.q.trim()) qs.set('q', filters.q.trim());
  if (filters.include_archived) qs.set('include_archived', '1');
  if (filters.archived_only) qs.set('archived_only', '1');
  return qs.toString();
}

export interface TicketCreateInput {
  title: string;
  description?: string;
  status?: TicketStatus;
  priority?: TicketPriority;
  tags?: string[];
  project_id?: string | null;
  base_branch?: string;
  assignee?: Record<string, any> | null;
  prompt_text?: string;
  position?: number;
}

export interface TicketPatch {
  title?: string;
  description?: string;
  priority?: TicketPriority;
  tags?: string[];
  project_id?: string | null;
  base_branch?: string;
  assignee?: Record<string, any> | null;
  prompt_text?: string;
  pending_user_action?: boolean;
  pending_reason?: string;
  next_ticket_id?: string | null;
  on_done_action_ids?: string[];
  channel_ids?: string[];
}

// ─── Mention types ───────────────────────────────────────
export interface MentionCandidatesResponse {
  users: Array<{ id: string; name: string; avatar_url: string }>;
  // With `ticket_id`: the ticket's assignee (id = runtime identity key "rt-…").
  // Rows carry manager_name (the Runtime Host) so the autocompleter renders
  // them as <Host>/<label>.
  agents: Array<{
    id: string;
    name: string;
    avatar_url: string;
    manager_agent_id?: string | null;
    manager_name?: string | null;
  }>;
}

export interface UserMentionItem {
  id: string;
  user_id: string;
  account_id: string;
  source_type: 'comment' | 'chat_message';
  source_id: string;
  // Comment mentions deep-link via ticket_id (Tickets page `?ticket=`), chat
  // mentions via room_id.
  ticket_id: string | null;
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
