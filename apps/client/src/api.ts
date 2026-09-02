import type {
  PromptTemplate,
  Resource,
  ClonePolicy,
  Action,
  ActionRun,
  WorkflowFunction,
  WorkflowFunctionRun,
  Feature,
  HandoffPipeline,
  QaScenario,
  QaScenarioListItem,
  QaRun,
  QaRunBatch,
  Deployment,
  MigrationRun,
  QaSchedule,
  QaScheduleScope,
  WorkspaceSchedule,
  WorkspaceScheduleDispatch,
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
  AgentLiveSession,
  AgentManagerInstance,
  PairingTokenMint,
  PairingTokenSafe,
  AgentManagerCommandKind,
  AgentManagerCommandResult,
  ManagedAgentCreateBody,
  Agent,
  RuntimeProfileConfig,
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
  EnvironmentConfig,
  QaPhasesConfig,
  BoardLesson,
  Comment,
  RepoRefs,
  RepoCommitSummary,
  RepoCommitDetail,
  RepoTreeEntry,
  RepoFileContent,
  WorkflowHealthRollup,
  WorkflowHealthLongTermUsage,
  ClaudeBackendProfile,
  WorkspaceClaudeBackendProfiles,
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
  OrchestrationAssignableAgent,
  OntologyGraphStatusResponse,
  OntologyGraphRefreshResponse,
  OntologyGraphSnapshotResponse,
  OrchestrationPostActionCondition,
  OrchestrationRepoRef,
} from './types';
import type { ArtifactRefType } from './utils/artifactRef';

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

// Exported so AppLayout's initial state and AuthContext.resolveWorkspaceState
// resolve the same per-tab candidate instead of each reading localStorage
// directly — that split let a tab's boot state disagree with the sessionStorage
// value this module already uses for X-Workspace-Id, and the disagreement then
// got "fixed" by overwriting sessionStorage with the wrong (shared) value
// (ticket dc5c0813).
export function bootstrapActiveWorkspaceId(): string | null {
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
    // Prefer the server's human-readable `message` (structured errors — the
    // consensus gate / review-approval guard — set it) so toasts show a legible
    // reason instead of a machine slug; fall back to the `error` slug, then a
    // generic string. The machine-readable `code`/`error` slug + HTTP status are
    // preserved on the thrown error so callers can still branch on the *kind* of
    // failure instead of pattern-matching the message.
    const error = new Error(err.message || err.error || 'Request failed') as Error & { code?: string; status?: number };
    if (err.code) error.code = err.code;
    else if (typeof err.error === 'string') error.code = err.error;
    error.status = res.status;
    throw error;
  }
  return res.json();
}

export const api = {
  resolveArtifactRefs: (
    workspaceId: string,
    refs: Array<{ type: ArtifactRefType; id: string }>,
  ) => request<Array<{
    type: ArtifactRefType; id: string; available: boolean; label: string; deepLink: string | null;
    workspaceName?: string; boardName?: string; reason?: string;
  }>>('/artifact-refs/resolve', {
    method: 'POST',
    body: JSON.stringify({ workspace_id: workspaceId, refs }),
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
  updateWorkspace: (id: string, data: { name?: string; description?: string; harness_config?: HarnessConfig | null; clone_policy?: ClonePolicy | null; assistant_agent_id?: string | null; cli_runtime_profiles?: RuntimeProfileConfig[]; default_cli_runtime_profile?: string | null }) =>
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
  getWorkspaceClaudeBackendProfiles: (wsId: string) =>
    request<WorkspaceClaudeBackendProfiles>(`/workspaces/${wsId}/claude-backend-profiles`),
  getWorkspaceClaudeBackendProfileCatalog: (wsId: string) =>
    request<{ profiles: ClaudeBackendProfile[] }>(`/workspaces/${wsId}/claude-backend-profiles/catalog`),
  updateWorkspaceClaudeBackendProfiles: (
    wsId: string,
    data: { allowed_profile_ids: string[]; default_profile_id: string | null },
  ) => request<WorkspaceClaudeBackendProfiles>(`/workspaces/${wsId}/claude-backend-profiles`, {
    method: 'PATCH', body: JSON.stringify(data),
  }),
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

  // ─── 다중담당자·합의 (T6) ───────────────────────────────
  // 합의 상태 READ + 이동 제안/투표/override. 서버는 이 REST 브릿지로 MCP 전용
  // 합의 로직을 브라우저에 노출한다. 투표가 합의를 성립시키면 서버가 auto-execute
  // 로 실제 이동하고 응답 `moved` 에 반영한다.
  getTicketConsensus: (ticketId: string) =>
    request<ConsensusView>(`/tickets/${ticketId}/consensus`),
  proposeTicketMove: (ticketId: string, targetColumnId: string, content?: string) =>
    request<{ proposal_id: string; target_column: { id: string; name: string }; consensus: ConsensusStateView }>(
      `/tickets/${ticketId}/consensus/propose`,
      { method: 'POST', body: JSON.stringify({ target_column_id: targetColumnId, content }) },
    ),
  recordTicketConsensusVote: (
    ticketId: string,
    payload: { status: 'agree' | 'object'; proposal_id?: string | null; override?: boolean; content?: string },
  ) =>
    request<{ consensus: ConsensusStateView; moved: { proposal_id: string; to_column_id: string; to_column_name: string | null } | null }>(
      `/tickets/${ticketId}/consensus/vote`,
      { method: 'POST', body: JSON.stringify(payload) },
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
      // Per-board worktree layout (worktree 규약 chain). 'per_ticket' (default)
      // → one worktree per ticket; 'shared' → one reused worktree.
      worktree_mode?: 'per_ticket' | 'shared';
      // Per-board PR usage (worktree 규약 chain). false (default) → direct ff
      // merge; true → the opt-in PR path. Server validates and 400s a non-boolean.
      use_pr?: boolean;
      auto_archive_days?: number | null;
      harness_config?: HarnessConfig | null;
      cli_runtime_profile?: string | null;
      // Abstract effort presets (per-CLI option mapping). null clears the
      // board override; the server falls back to BUILTIN_EFFORT_PRESETS.
      effort_presets?: EffortPresetsConfig | null;
      // Per-board output language (i18n). Empty string / null clears the
      // override (agents fall back to their default, English).
      language?: string | null;
      // Per-board environment setup (ticket 354d336b). null clears the board
      // override. The server validates it (strict zod) and 400s a typo.
      environment_config?: EnvironmentConfig | null;
      // Per-board QA phases model (ticket 90cc22f7). null clears the override
      // (legacy single-timeout); the server validates it (zod) and 400s a typo.
      qa_phases?: QaPhasesConfig | null;
      // Per-board DEFAULT role holders (ticket d94a1b87): { [roleSlug]: [{ agent_id }
      // | { user_id }], … }. null or {} clears. The server validates the shape
      // AND that each slug/holder exists (400s a typo). Filled into any role the
      // caller left unstaffed at ticket-create time.
      default_role_assignments?: Record<string, Array<{ agent_id?: string; user_id?: string }>> | null;
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
  // ─── Board Lessons / Runbook (ticket 9d0d6ac4) ───────────
  // Board-scoped knowledge base. Active lessons are auto-injected into the
  // board's dispatch prompts server-side; these back the Settings > Lessons UI.
  listBoardLessons: (boardId: string, includeInactive = false) =>
    request<BoardLesson[]>(
      `/boards/${boardId}/lessons${includeInactive ? '?include_inactive=true' : ''}`,
    ),
  createBoardLesson: (
    boardId: string,
    data: { title: string; body: string; tags?: string[]; source_ticket_id?: string },
  ) =>
    request<BoardLesson>(`/boards/${boardId}/lessons`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateBoardLesson: (
    boardId: string,
    lessonId: string,
    data: {
      title?: string;
      body?: string;
      tags?: string[];
      source_ticket_id?: string;
      active?: boolean;
    },
  ) =>
    request<BoardLesson>(`/boards/${boardId}/lessons/${lessonId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deleteBoardLesson: (boardId: string, lessonId: string) =>
    request<{ success: boolean }>(`/boards/${boardId}/lessons/${lessonId}`, {
      method: 'DELETE',
    }),
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
  // Cross-board handoff pipeline rollup (ticket ac21a745). Given any ticket in a
  // relay, returns every stage across boards (root walk-up + follow-up walk-down)
  // so the detail panel can render the relay without hopping boards. REST bridge
  // for the MCP get_handoff_pipeline (the client never speaks MCP directly).
  getHandoffPipeline: async (ticketId: string) =>
    request<HandoffPipeline>(`/tickets/${ticketId}/handoff-pipeline`),
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
  getCommentSummary: (ticketId: string) =>
    request<any>(`/tickets/${ticketId}/comment-summary`),
  startCommentSummary: (ticketId: string) =>
    request<any>(`/tickets/${ticketId}/comment-summary`, { method: 'POST' }),

  // ─── Columns ──────────────────────────────────────────
  createColumn: (boardId: string, data: { name: string; color?: string; description?: string }) =>
    request<any>(`/boards/${boardId}/columns`, { method: 'POST', body: JSON.stringify(data) }),
  updateColumn: (id: string, data: { name?: string; color?: string; position?: number; description?: string; is_terminal?: boolean; unassigned_policy?: 'halt' | 'skip' | 'skip_if_ticket_staffed'; process_subtasks?: boolean }) =>
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

  decideTicketDuplicate: (id: string, data: { action: 'link' | 'keep_independent'; candidate_ticket_id?: string }) =>
    request<any>(`/tickets/${id}/duplicate-decision`, { method: 'POST', body: JSON.stringify(data) }),

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
  // workspaceId overrides the ambient X-Workspace-Id header for this one call —
  // see getChannels above for why callers reacting to a workspaceId prop change
  // need this instead of relying on the ambient header.
  getAgents: (workspaceId?: string) => {
    const init: RequestInit = {};
    if (workspaceId) init.headers = { ...getAuthHeaders(), 'X-Workspace-Id': workspaceId };
    return request<any[]>('/agents', init);
  },
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
  // workspaceId overrides the ambient X-Workspace-Id header for this one call
  // (same pattern as createAgent below) — callers that re-fetch the instant a
  // workspaceId prop changes can't rely on the ambient header having caught up
  // yet (it's synced from a sibling effect that may run after theirs).
  getChannels: (workspaceId?: string) => {
    const init: RequestInit = {};
    if (workspaceId) init.headers = { ...getAuthHeaders(), 'X-Workspace-Id': workspaceId };
    return request<any[]>('/channels', init);
  },
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
  // workspaceId overrides the ambient X-Workspace-Id header for this one call —
  // see getChannels above for why callers reacting to a workspaceId prop change
  // need this instead of relying on the ambient header.
  getApiKeys: (workspaceId?: string) => {
    const init: RequestInit = {};
    if (workspaceId) init.headers = { ...getAuthHeaders(), 'X-Workspace-Id': workspaceId };
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

  // ─── Prompt Templates (Phase 1 ROLE-05) ────────────────
  listPromptTemplates: (workspace_id: string, options?: { category?: string; id?: string; includeAllScopes?: boolean }) => {
    const params = new URLSearchParams({ workspace_id });
    if (options?.category) params.set('category', options.category);
    if (options?.id) params.set('id', options.id);
    if (options?.includeAllScopes) params.set('include_all_scopes', 'true');
    return request<PromptTemplate[]>(`/prompt-templates?${params.toString()}`);
  },
  getPromptTemplate: (id: string, workspace_id: string) => {
    const params = new URLSearchParams({ workspace_id });
    return request<PromptTemplate>(`/prompt-templates/${id}?${params.toString()}`);
  },
  createPromptTemplate: (data: {
    workspace_id?: string | null;
    scope?: 'global' | 'workspace';
    name: string;
    description?: string;
    content: string;
    category?: string;
  }) =>
    request<PromptTemplate>('/prompt-templates', { method: 'POST', body: JSON.stringify(data) }),
  updatePromptTemplate: (
    id: string,
    data: {
      workspace_id?: string | null;
      scope?: 'global' | 'workspace';
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
  listDefaultPromptTemplates: (workspace_id: string) => {
    const params = new URLSearchParams({ workspace_id });
    return request<import('./types').BuiltinPromptDefault[]>(`/prompt-templates/defaults/catalog?${params.toString()}`);
  },
  resetDefaultPromptTemplates: (data: {
    workspace_id: string;
    names: string[];
    reset_board_mappings: boolean;
  }) => request<{ success: true; templates: PromptTemplate[] }>('/prompt-templates/defaults/reset', {
    method: 'POST',
    body: JSON.stringify(data),
  }),

  // ─── Resources ─────────────────────────────────────────
  listResources: (
    workspaceId: string,
    type?: string,
    sort?: { by?: string; order?: 'asc' | 'desc' },
    includeAllScopes = false,
  ) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
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
    opts: { workspace_id: string; type?: string },
  ): Promise<{ id: string; file_name: string; file_mimetype: string; size: number }> => {
    const params = new URLSearchParams({ workspace_id: opts.workspace_id });
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
    workspace_id?: string | null;
    scope?: 'global' | 'workspace';
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
    clone_policy?: ClonePolicy | null;
  }) =>
    request<Resource>('/resources', { method: 'POST', body: JSON.stringify(data) }),
  updateResource: (
    id: string,
    data: {
      workspace_id?: string | null;
      scope?: 'global' | 'workspace';
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
      default_branch?: string;
      clone_policy?: ClonePolicy | null;
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
    scope?: 'global' | 'workspace';
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
  listActions: (workspaceId: string) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    return request<Action[]>(`/actions?${params.toString()}`);
  },
  getAction: (id: string) => request<Action>(`/actions/${id}`),
  createAction: (data: {
    workspace_id: string;
    name: string;
    description?: string;
    prompt?: string;
    target_agent_id: string;
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
      workspace_id: string;
      name?: string;
      description?: string;
      prompt?: string;
      target_agent_id?: string;
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

  // Functions: workspace_id omitted means global definitions only.
  listFunctions: (workspaceId?: string | null, includeShadowed = false) => {
    const params = new URLSearchParams();
    if (workspaceId) params.set('workspace_id', workspaceId);
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
    data: { workspace_id: string; board_id?: string; ticket_id?: string; inputs?: Record<string, any>; idempotency_key?: string },
  ) => request<WorkflowFunctionRun>(`/functions/${id}/run`, { method: 'POST', body: JSON.stringify(data) }),
  listFunctionRuns: (workspaceId: string, options?: { functionId?: string; ticketId?: string; limit?: number }) => {
    const params = new URLSearchParams({ workspace_id: workspaceId, limit: String(options?.limit || 50) });
    if (options?.functionId) params.set('function_id', options.functionId);
    if (options?.ticketId) params.set('ticket_id', options.ticketId);
    return request<WorkflowFunctionRun[]>(`/functions/runs?${params.toString()}`);
  },

  // ─── Feature/Epic intake (ticket aae7644c) ────────────
  listFeatures: (workspaceId: string, boardId?: string | null) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    if (boardId !== undefined && boardId !== null) params.set('board_id', boardId);
    return request<Feature[]>(`/features?${params.toString()}`);
  },
  getFeature: (id: string) => request<Feature>(`/features/${id}`),
  createFeature: (data: {
    workspace_id: string;
    board_id?: string | null;
    title: string;
    requirement: string;
    planner_agent_id?: string;
    source_chat_room_id?: string;
    auto_plan?: boolean;
  }) => request<Feature>('/features', { method: 'POST', body: JSON.stringify(data) }),
  approveFeature: (id: string) =>
    request<Feature>(`/features/${id}/approve`, { method: 'POST', body: '{}' }),
  rejectFeature: (id: string, feedback: string, replan = true) =>
    request<Feature>(`/features/${id}/reject`, { method: 'POST', body: JSON.stringify({ feedback, replan }) }),
  replanFeature: (id: string) =>
    request<Feature>(`/features/${id}/replan`, { method: 'POST', body: '{}' }),

  // ─── Scenario-based QA (ticket 3c655d20) ──────────────
  listQaScenarios: (workspaceId: string) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    return request<QaScenarioListItem[]>(`/qa/scenarios?${params.toString()}`);
  },
  getQaScenario: (id: string) => request<QaScenario>(`/qa/scenarios/${id}`),
  createQaScenario: (data: {
    workspace_id: string;
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
    workspace_folder?: string;
    repo_ref?: QaScenario['repo_ref'];
    checkout_mode?: QaScenario['checkout_mode'];
    build_mode?: QaScenario['build_mode'];
    // Deployment-awareness target environment (ticket 8ce72b18).
    target_environment?: string;
    // Per-scenario QA phases override (object to set, null to clear/inherit board).
    qa_phases?: QaPhasesConfig | null;
  }) => request<QaScenario>('/qa/scenarios', { method: 'POST', body: JSON.stringify(data) }),
  updateQaScenario: (
    id: string,
    data: {
      workspace_id: string;
      name?: string;
      description?: string;
      steps?: QaScenario['steps'];
      target_agent_id?: string;
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
      // Per-scenario QA phases override (object to set, null to clear/inherit board).
      qa_phases?: QaPhasesConfig | null;
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
  // ─── Deployment awareness (ticket 8ce72b18) ──────────
  // The current live commit per environment visible to a workspace (its own
  // environments + all global ones). Powers the QA "live commit" badge.
  listDeployments: (workspaceId: string) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    return request<Deployment[]>(`/deployments?${params.toString()}`);
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
  listQaSchedules: (workspaceId: string) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    return request<QaSchedule[]>(`/qa/schedules?${params.toString()}`);
  },
  createQaSchedule: (data: {
    workspace_id: string;
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

  // ─── Workspace schedules (ticket 8845be79 foundation / 1927ed4a UI) ──────────
  // General-purpose agent-task scheduler: when due, the server opens a fresh chat
  // room and sends `task_prompt` to `target_agent_id`. Exactly one of cron /
  // interval_ms. Workspace-scoped only — board_id is a dead legacy column.
  listWorkspaceSchedules: (workspaceId: string) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    return request<WorkspaceSchedule[]>(`/workspace-schedules?${params.toString()}`);
  },
  createWorkspaceSchedule: (data: {
    workspace_id: string;
    name: string;
    target_agent_id: string;
    task_prompt: string;
    cron?: string | null;
    interval_ms?: number | null;
    enabled?: boolean;
  }) => request<WorkspaceSchedule>('/workspace-schedules', { method: 'POST', body: JSON.stringify(data) }),
  updateWorkspaceSchedule: (
    id: string,
    data: {
      workspace_id: string;
      name?: string;
      target_agent_id?: string;
      task_prompt?: string;
      cron?: string | null;
      interval_ms?: number | null;
      enabled?: boolean;
    },
  ) => request<WorkspaceSchedule>(`/workspace-schedules/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteWorkspaceSchedule: (id: string, workspaceId: string) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    return request<{ success: true; id: string }>(`/workspace-schedules/${id}?${params.toString()}`, { method: 'DELETE' });
  },
  runWorkspaceScheduleNow: (id: string, workspaceId: string) =>
    request<{ schedule: WorkspaceSchedule; dispatch: WorkspaceScheduleDispatch }>(`/workspace-schedules/${id}/run-now`, {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId }),
    }),

  // ─── Security inspection (보안 점검 — ticket cfd74638 foundation) ──────────
  // Sibling of scenario QA: profile CRUD + run dispatch + history + sequential
  // batches + schedules. Run-result recording (findings, complete) is agent-only
  // via MCP, so it is intentionally not exposed over REST.
  listSecurityProfiles: (workspaceId: string) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    return request<SecurityProfileListItem[]>(`/security/profiles?${params.toString()}`);
  },
  getSecurityProfile: (id: string) => request<SecurityProfile>(`/security/profiles/${id}`),
  createSecurityProfile: (data: {
    workspace_id: string;
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
    workspace_folder?: string;
    repo_ref?: SecurityProfile['repo_ref'];
    checkout_mode?: SecurityProfile['checkout_mode'];
    build_mode?: SecurityProfile['build_mode'];
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
  listSecuritySchedules: (workspaceId: string) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    return request<SecuritySchedule[]>(`/security/schedules?${params.toString()}`);
  },
  createSecuritySchedule: (data: {
    workspace_id: string;
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
      workspace_id: string;
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
  deleteSecuritySchedule: (id: string, workspaceId: string) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    return request<{ success: true; id: string }>(`/security/schedules/${id}?${params.toString()}`, { method: 'DELETE' });
  },
  // run-now is kind-discriminated: kind='scan' → `batch` set / `refreshes` null;
  // kind='checklist_refresh' → `batch` null / `refreshes` the per-profile dispatches.
  runSecurityScheduleNow: (id: string, workspaceId: string) =>
    request<{
      schedule: SecuritySchedule;
      kind: SecurityScheduleKind;
      batch: SecurityRunBatch | null;
      refreshes: { profile_id: string; room_id: string }[] | null;
    }>(`/security/schedules/${id}/run-now`, {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId }),
    }),

  // ─── Credentials ──────────────────────────────────────
  // A workspace list also returns inherited global credentials (scope:'global').
  // Pass scope:'global' (no workspace_id) for the Admin global-credentials page.
  listCredentials: (workspaceId?: string, opts?: { provider?: string; scope?: 'global'; includeAllScopes?: boolean }) => {
    const params = new URLSearchParams();
    if (workspaceId) params.set('workspace_id', workspaceId);
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
    // Omit workspace_id and pass scope:'global' to create an instance-level
    // credential (requires the MANAGE_GLOBAL_CREDENTIALS permission).
    workspace_id?: string;
    scope?: 'global' | 'workspace';
    name: string;
    description?: string;
    provider: string;
    credentials: Record<string, string>;
  }) =>
    request<Credential>('/credentials', { method: 'POST', body: JSON.stringify(data) }),
  updateCredential: (
    id: string,
    data: {
      workspace_id?: string | null;
      scope?: 'global' | 'workspace';
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

  // 티켓 b2e79108 — CLI 자동 로그인(device-auth). 터미널·파일 업로드 없이
  // Codex 로그인 세션을 시작하고 진행 상태를 폴링/SSE로 추적한다.
  listCliLoginInstances: (workspaceId?: string) => {
    const params = new URLSearchParams();
    if (workspaceId) params.set('workspace_id', workspaceId);
    const qs = params.toString();
    return request<CliLoginInstanceOption[]>(`/credentials/cli-login/instances${qs ? `?${qs}` : ''}`);
  },
  startCliLogin: (data: {
    workspace_id?: string;
    scope?: 'global' | 'workspace';
    cli: string;
    credential_name: string;
    instance_id: string;
  }) => request<CliLoginSession>('/credentials/cli-login/start', { method: 'POST', body: JSON.stringify(data) }),
  getCliLoginSession: (sessionId: string, workspaceId?: string) => {
    const params = new URLSearchParams();
    if (workspaceId) params.set('workspace_id', workspaceId);
    const qs = params.toString();
    return request<CliLoginSession>(`/credentials/cli-login/${sessionId}${qs ? `?${qs}` : ''}`);
  },
  cancelCliLogin: (sessionId: string, workspaceId?: string) =>
    request<CliLoginSession>(`/credentials/cli-login/${sessionId}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId }),
    }),

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
  // Live Runtime Hosts heartbeating against the server.
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
  // claude/codex/antigravity/pi/custom whitelist, (2) manager_agent_id is sanity-
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
  // uses this to populate the required Runtime Host dropdown so an Agent
  // in workspace B can be attached to a manager paired in workspace A.
  // MANAGE_AGENTS-gated; returns one row per Agent with type='manager'.
  listAgentManagers: () =>
    request<Array<{ id: string; name: string; description: string; workspace_id: string | null; is_active: number }>>(
      '/admin/agent-manager/managers',
    ),

  // Re-home an existing managed agent into a different workspace. Used by
  // the Agent Manager runtime section's per-row workspace picker so pre-existing
  // agents created against a global manager can be relocated to the
  // workspace they actually belong to without recreating them.
  setManagedAgentWorkspace: (agentId: string, workspaceId: string | null) =>
    request<Agent>(`/admin/agent-manager/agents/${encodeURIComponent(agentId)}/workspace`, {
      method: 'PATCH',
      body: JSON.stringify({ workspace_id: workspaceId }),
    }),

  // ─── Admin Logs ────────────────────────────────────────
  // Governed, immutable skill catalog and bounded Hermes ChildRuns.
  /** Global + this workspace's skills. `includeShadowed` also returns global
   *  rows a workspace fork overrides, each flagged `shadowed: true`. */
  listSkills: (workspaceId: string, includeShadowed = false) =>
    request<Skill[]>(
      `/workspaces/${encodeURIComponent(workspaceId)}/skills`
      + (includeShadowed ? '?include_shadowed=1' : ''),
    ),
  /** Copy a global skill into this workspace, where it shadows the global by
   *  slug while the global keeps receiving upstream updates. */
  forkSkill: (workspaceId: string, skillId: string, skillVersionId?: string) =>
    request<Skill>(
      `/workspaces/${encodeURIComponent(workspaceId)}/skills/${encodeURIComponent(skillId)}/fork`,
      { method: 'POST', body: JSON.stringify({ skill_version_id: skillVersionId || '' }) },
    ),
  getSkill: (workspaceId: string, skillId: string) =>
    request<SkillDetail>(
      `/workspaces/${encodeURIComponent(workspaceId)}/skills/${encodeURIComponent(skillId)}`,
    ),
  createSkill: (
    workspaceId: string,
    body: {
      slug: string;
      name: string;
      description?: string;
      body: string;
      support_files?: Array<{ path: string; content: string }>;
    },
  ) =>
    request<Skill & { version: SkillVersion }>(
      `/workspaces/${encodeURIComponent(workspaceId)}/skills`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  publishSkillVersion: (
    workspaceId: string,
    skillId: string,
    body: { body: string; support_files?: Array<{ path: string; content: string }> },
  ) =>
    request<SkillVersion>(
      `/workspaces/${encodeURIComponent(workspaceId)}/skills/${encodeURIComponent(skillId)}/versions`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  assignSkill: (
    workspaceId: string,
    skillId: string,
    body: {
      skill_version_id: string;
      agent_id: string;
      board_id?: string;
      role_slug?: string;
    },
  ) =>
    request<unknown>(
      `/workspaces/${encodeURIComponent(workspaceId)}/skills/${encodeURIComponent(skillId)}/assignments`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  quarantineSkill: (workspaceId: string, skillId: string) =>
    request<Skill>(
      `/workspaces/${encodeURIComponent(workspaceId)}/skills/${encodeURIComponent(skillId)}/quarantine`,
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
    workspaceId: string,
    status?: 'pending' | 'approved' | 'rejected',
  ) =>
    request<SkillProposal[]>(
      `/workspaces/${encodeURIComponent(workspaceId)}/skills/proposals${status ? `?status=${status}` : ''}`,
    ),
  reviewSkillProposal: (
    workspaceId: string,
    proposalId: string,
    decision: 'approve' | 'reject',
    body: { note?: string; skill_id?: string },
  ) =>
    request<{ proposal: SkillProposal; version: SkillVersion | null }>(
      `/workspaces/${encodeURIComponent(workspaceId)}/skills/proposals/${encodeURIComponent(proposalId)}/${decision}`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  listAgentChildRuns: (workspaceId: string, agentId: string) =>
    request<HermesChildRun[]>(
      `/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/child-runs`,
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

  // ─── Admin Workflow Health ───────────
  // The rollup embeds active_storms/top_respawns/suppression_stats, so the
  // controller's narrower /storms, /respawns, /suppressions endpoints are
  // intentionally left without a dedicated client wrapper here.
  getWorkflowHealth: (params?: { boardId?: string }) => {
    const q = params?.boardId ? `?board_id=${encodeURIComponent(params.boardId)}` : '';
    return request<WorkflowHealthRollup>(`/admin/workflow-health${q}`);
  },

  // All-time/장기 구간 누적 (ticket 090abc77) — workspace는 getAuthHeaders()의
  // ambient X-Workspace-Id 헤더로 해결되므로 여기서 별도로 넘기지 않는다.
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
  // workspaceId overrides the ambient X-Workspace-Id header for this one call —
  // see getChannels above for why callers reacting to a workspaceId prop change
  // need this instead of relying on the ambient header.
  listChatRooms: (scope?: 'workspace', workspaceId?: string) => {
    const init: RequestInit = {};
    if (workspaceId) init.headers = { ...getAuthHeaders(), 'X-Workspace-Id': workspaceId };
    return request<ChatRoomListItem[]>(scope === 'workspace' ? '/chat-rooms?scope=workspace' : '/chat-rooms', init);
  },

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
  // `ticketBoard` maps each unread ticket to the board its badge rolls up
  // into, so the client can decrement the right board when a single ticket
  // is marked read instead of waiting for the next full refresh.
  getTicketUnreadCounts: (): Promise<{
    total: number;
    perTicket: Record<string, number>;
    perBoard: Record<string, number>;
    ticketBoard: Record<string, string>;
  }> =>
    request<{
      total: number;
      perTicket: Record<string, number>;
      perBoard: Record<string, number>;
      ticketBoard: Record<string, string>;
    }>('/tickets/unread-counts'),
  // 티켓 코멘트 일괄 읽음 처리 — markAllMentionsRead와 같은 아이디어를,
  // UserMention 행 대신 TicketReadState에 upsert하는 방식으로 적용한다.
  // `boardId`는 그 보드의 관여 티켓만 좁히고, 생략하면 현재 워크스페이스
  // (X-Workspace-Id 헤더)의 관여 티켓 전체를 읽음 처리한다.
  markAllTicketsRead: (boardId?: string): Promise<{ updated: number }> =>
    request<{ updated: number }>('/tickets/read-all', {
      method: 'POST',
      body: JSON.stringify(boardId ? { board_id: boardId } : {}),
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
  listOrchestrationTeams: (workspaceId: string) =>
    request<OrchestrationTeam[]>(`/orchestration/teams?workspace_id=${encodeURIComponent(workspaceId)}`),
  getOrchestrationTeam: (id: string, workspaceId: string) =>
    request<OrchestrationTeam>(`/orchestration/teams/${id}?workspace_id=${encodeURIComponent(workspaceId)}`),
  createOrchestrationTeam: (data: {
    workspace_id: string;
    name: string;
    description?: string;
    orchestrator_agent_id: string;
    orchestrator_prompt?: string;
    max_parallel_steps?: number;
    max_open_missions?: number;
    /** 글로벌(workspace 비종속) 팀으로 생성. 기본값 false. */
    is_global?: boolean;
    /** 글로벌 팀 전용: orchestrator가 미션을 만들 수 있는 workspace 목록. */
    allowed_workspace_ids?: string[];
  }) => request<OrchestrationTeam>('/orchestration/teams', { method: 'POST', body: JSON.stringify(data) }),
  updateOrchestrationTeam: (
    id: string,
    data: {
      workspace_id: string;
      name?: string;
      description?: string;
      orchestrator_agent_id?: string;
      orchestrator_prompt?: string;
      max_parallel_steps?: number;
      max_open_missions?: number;
      enabled?: boolean;
      /** 글로벌 팀 전용: workspace 허용목록을 통째로 교체한다. */
      allowed_workspace_ids?: string[];
    },
  ) => request<OrchestrationTeam>(`/orchestration/teams/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteOrchestrationTeam: (id: string, workspaceId: string) =>
    request<{ success: true; id: string }>(
      `/orchestration/teams/${id}?workspace_id=${encodeURIComponent(workspaceId)}`,
      { method: 'DELETE' },
    ),
  addOrchestrationTeamMember: (
    teamId: string,
    data: { workspace_id: string; agent_id: string; role_label?: string; capabilities?: string; max_concurrent?: number },
  ) => request<OrchestrationTeam>(`/orchestration/teams/${teamId}/members`, { method: 'POST', body: JSON.stringify(data) }),
  updateOrchestrationTeamMember: (
    teamId: string,
    memberId: string,
    data: { workspace_id: string; role_label?: string; capabilities?: string; max_concurrent?: number; position?: number },
  ) =>
    request<OrchestrationTeam>(`/orchestration/teams/${teamId}/members/${memberId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  removeOrchestrationTeamMember: (teamId: string, memberId: string, workspaceId: string) =>
    request<OrchestrationTeam>(
      `/orchestration/teams/${teamId}/members/${memberId}?workspace_id=${encodeURIComponent(workspaceId)}`,
      { method: 'DELETE' },
    ),
  listOrchestrationAgents: (workspaceId: string, opts?: { globalOnly?: boolean }) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    if (opts?.globalOnly) params.set('global_only', 'true');
    return request<OrchestrationAssignableAgent[]>(`/orchestration/assignable-agents?${params.toString()}`);
  },

  listOrchestrationMissions: (workspaceId: string, opts?: { teamId?: string; status?: string; limit?: number }) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    if (opts?.teamId) params.set('team_id', opts.teamId);
    if (opts?.status) params.set('status', opts.status);
    if (opts?.limit) params.set('limit', String(opts.limit));
    return request<OrchestrationMissionListItem[]>(`/orchestration/missions?${params.toString()}`);
  },
  getOrchestrationMission: (id: string, workspaceId: string) =>
    request<OrchestrationMissionDetail>(
      `/orchestration/missions/${id}?workspace_id=${encodeURIComponent(workspaceId)}`,
    ),
  createOrchestrationMission: (data: {
    workspace_id: string;
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
    /** Brief the orchestrator immediately instead of leaving the mission a draft. */
    start?: boolean;
  }) => request<OrchestrationMissionDetail>('/orchestration/missions', { method: 'POST', body: JSON.stringify(data) }),
  updateOrchestrationMission: (
    id: string,
    data: {
      workspace_id: string;
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
    },
  ) =>
    request<OrchestrationMissionDetail>(`/orchestration/missions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deleteOrchestrationMission: (id: string, workspaceId: string) =>
    request<{ success: true; id: string }>(
      `/orchestration/missions/${id}?workspace_id=${encodeURIComponent(workspaceId)}`,
      { method: 'DELETE' },
    ),
  startOrchestrationMission: (id: string, workspaceId: string) =>
    request<OrchestrationMissionDetail>(`/orchestration/missions/${id}/start`, {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId }),
    }),
  pauseOrchestrationMission: (id: string, workspaceId: string) =>
    request<OrchestrationMissionDetail>(`/orchestration/missions/${id}/pause`, {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId }),
    }),
  resumeOrchestrationMission: (id: string, workspaceId: string) =>
    request<OrchestrationMissionDetail>(`/orchestration/missions/${id}/resume`, {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId }),
    }),
  cancelOrchestrationMission: (id: string, workspaceId: string, reason?: string) =>
    request<OrchestrationMissionDetail>(`/orchestration/missions/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId, reason: reason || '' }),
    }),
  nudgeOrchestrationMission: (id: string, workspaceId: string, note?: string) =>
    request<OrchestrationMissionDetail>(`/orchestration/missions/${id}/nudge`, {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId, note: note || '' }),
    }),

  // ─── Ontology Graph (ticket d22b83b4) ─────────────────────
  getOntologyGraphStatus: (
    workspaceId: string,
    ref: { graphId?: string; resourceId?: string; folderPath?: string },
  ): Promise<OntologyGraphStatusResponse> => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    if (ref.graphId) params.set('graph_id', ref.graphId);
    if (ref.resourceId) params.set('resource_id', ref.resourceId);
    if (ref.folderPath !== undefined) params.set('folder_path', ref.folderPath);
    return request<OntologyGraphStatusResponse>(`/ontology/status?${params.toString()}`);
  },
  logOntologyGraphViewOpened: (
    workspaceId: string,
    ref: { resourceId?: string; folderPath?: string },
  ): Promise<{ ok: true }> =>
    request<{ ok: true }>('/ontology/view-opened', {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId, resource_id: ref.resourceId, folder_path: ref.folderPath }),
    }),
  refreshOntologyGraph: (workspaceId: string, graphId: string): Promise<OntologyGraphRefreshResponse> =>
    request<OntologyGraphRefreshResponse>('/ontology/refresh', {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId, graph_id: graphId }),
    }),
  getOntologyGraph: (workspaceId: string, graphId: string): Promise<OntologyGraphSnapshotResponse> =>
    request<OntologyGraphSnapshotResponse>(
      `/ontology/graph?workspace_id=${encodeURIComponent(workspaceId)}&graph_id=${encodeURIComponent(graphId)}`,
    ),
};

// ─── Ticket role assignment types ─────────────────────────
export interface TicketRoleAssignmentRow {
  role: { id: string; slug: string; name: string; position: number; is_builtin: boolean };
  holder: { type: 'agent' | 'user'; id: string; name: string } | null;
}

// ─── 다중담당자·합의 뷰 타입 (T6) ─────────────────────────
// 서버 common/consensus-state 의 ConsensusState + consensus-actions 의
// ConsensusView 를 미러. party 는 {type,id} 뿐 — 이름은 `names` 맵으로 해석한다.
export interface ConsensusParty { type: 'agent' | 'user'; id: string; }
export interface ConsensusStateView {
  proposalId: string | null;
  required: ConsensusParty[];
  agreed: ConsensusParty[];
  objected: ConsensusParty[];
  pending: ConsensusParty[];
  satisfied: boolean;
  overriddenBy?: ConsensusParty;
  routingRoleSlugs: string[];
}
export interface ConsensusProposalView {
  proposal_id: string;
  target_column_id: string;
  target_column_name: string | null;
  by: ConsensusParty;
  at: number;
}
export interface ConsensusView {
  state: ConsensusStateView;
  proposal: ConsensusProposalView | null;
  /** `"type:id" → 표시 이름`. required/agreed/pending 홀더 이름 해석용. */
  names: Record<string, string>;
  gate: { blocked: boolean; holder_count: number };
}
// consensus_update SSE 프레임(서버 event-registry flatten). 카운트만 실린다 —
// 상세 홀더 목록은 UI 가 getTicketConsensus 로 재조회.
export interface ConsensusUpdateEvent {
  event_type: 'consensus_update';
  ticket_id: string;
  workspace_id: string;
  proposal_id: string | null;
  satisfied: boolean;
  required: number;
  agreed: number;
  objected: number;
  pending: number;
  status: 'agree' | 'object';
  override: boolean;
  actor_id: string;
  actor_name: string;
  timestamp: string;
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
