// Pure helpers for F-1 (ticket 24694916) — mechanical ticket-action card capture.
//
// The ChatSessionManager observes the CLI's stream-json: mcp__awb__* tool calls
// (tool_use) and their results (tool_result). These helpers turn that raw stream
// data into structured ticket refs WITHOUT any I/O or session state, so the
// capture correctness ("누락 없이") is unit-testable without booting a session.
// The manager keeps only the stateful glue (pending map, title cache, flush).

/**
 * MCP ticket-mutation surface → card action, keyed by the BARE tool name (suffix
 * after the last `__`) so it matches whatever MCP server prefix the CLI uses
 * (mcp__awb__… / mcp__ai-workflow-board__…).
 *
 * CONTRACT (ticket 24694916, acceptance #1 "누락 없이") — the MCP tool surface is
 * classified EXHAUSTIVELY across every bucket below so a newly-added tool is a
 * deliberate decision, never a silent gap. tool-surface-parity.test.mjs asserts the
 * server's registered tools equal EMIT ∪ ARTIFACT ∪ EXCLUDE, failing CI on any
 * unclassified (or stale) tool:
 *
 *   EMIT (this map) — create / move (status) / update (incl. child), comment plus
 *     the typed-comment mutations (ask_question / answer_question / record_decision),
 *     claim / release, pend / unpend, archive / unarchive, prerequisite add / remove,
 *     CI wait.
 *   ARTIFACT (ARTIFACT_ACTION_TOOLS, F2-4 ⓒ) — build/deploy result cards, independent
 *     of the ticket_refs channel (see the bucket's own doc comment below).
 *   EXCLUDE (TICKET_TOOL_EXCLUSIONS) — reads (incl. list_tickets, whose results feed
 *     the title cache), ticket deletes (404 deep-link), ticket-attachment I/O, the
 *     assistant's own send_chat_room_message, the current-task focus seat, and every
 *     non-ticket domain. Enumerated there with a per-tool reason.
 *
 * The board model's extra buckets (BATCH batch_operations, REJECT reject_handoff,
 * BOARD get_board_summary) went away with those tools (docs/tickets.md — board-less).
 */
export const TICKET_ACTION_TOOLS: Record<string, string> = {
  create_ticket: 'create',
  create_child_ticket: 'create',
  move_ticket: 'move',
  update_ticket: 'update',
  update_child_ticket: 'update',
  decide_ticket_duplicate: 'update',
  correct_confirmed_ticket_duplicate: 'update',
  add_comment: 'comment',
  // Typed-comment mutations — each creates a comment row (ask/decision) or flips a
  // question's status (answer). answer_question carries NO input ticket_id (keys on
  // question_comment_id); its ticket id is resolved from the result row's ticket_id.
  ask_question: 'question',
  answer_question: 'answer',
  record_decision: 'decision',
  claim_ticket: 'claim',
  release_ticket: 'release',
  pend_ticket: 'pend',
  unpend_ticket: 'unpend',
  archive_ticket: 'archive',
  unarchive_ticket: 'unarchive',
  add_ticket_prerequisites: 'prereq',
  remove_ticket_prerequisite: 'prereq',
  // ticket 778b6dc7: durable CI-run wait, same "blocking flag on the ticket
  // row" shape as prereq add/remove above — one category covers both
  // register/cancel directions, same precedent as 'prereq'.
  await_ci_run: 'ci_wait',
  cancel_ci_wait: 'ci_wait',
};
/**
 * F2-4 ⓒ (ticket d21b28fc) — 결과물(artifact) 카드 캡처면.
 * 빌드/배포 이벤트는 티켓 row 를 바꾸지 않아 EMIT(ticket_refs)에 들어갈 수 없다.
 * 하지만 채팅에 결과물 카드로 남겨야 하므로 별도 `artifact_refs` 로 캡처한다.
 * 이 세 tool 은 tool-surface-parity 상 EXCLUDE 가 아니라 이 ARTIFACT 버킷에 속하며,
 * classifiedToolNames() 가 이들을 포함한다(EXCLUDE 에서 제외 = 같은 분류 한 번만).
 *   register_build_artifact / report_build_failure → 'build'
 *   report_deployment                              → 'deploy'
 */
export const ARTIFACT_ACTION_TOOLS: Record<string, string> = {
  register_build_artifact: 'build',
  report_build_failure: 'build',
  report_deployment: 'deploy',
};
/** Tools whose NEW ticket id is only in the tool RESULT (not the input). For every
 *  other tracked tool the input `ticket_id` is authoritative — the result `id` may
 *  be a comment id (add_comment) etc., so it must NOT be used as the ticket id. */
export const TICKET_CREATE_TOOLS = new Set(['create_ticket', 'create_child_ticket']);
/** Korean action label for the fallback content line — rendered on surfaces that
 *  don't understand metadata (history replay, notifications, legacy clients). */
export const TICKET_ACTION_LABEL_KO: Record<string, string> = {
  create: '생성', move: '이동', update: '수정', comment: '코멘트',
  question: '질문', answer: '답변', decision: '결정',
  claim: '클레임', release: '클레임 해제', pend: '보류', unpend: '보류 해제',
  archive: '아카이브', unarchive: '아카이브 해제', prereq: '선행조건', ci_wait: 'CI 대기',
};

export interface TicketToolContext {
  action: string;
  fromResult: boolean;
  inputTicketId?: string;
  inputTitle?: string;
}
export interface TicketRef {
  action: string;
  ticket_id: string;
  title?: string;
  /** move 의 목적지 status 등 부가 맥락(있으면). */
  detail?: string;
}

/** F2-4 ⓒ 결과물 ref — 빌드/배포 카드용. 티켓 ref 와 별도 배열(artifact_refs)로 방출. */
export interface ArtifactRef {
  kind: string;    // 'build' | 'deploy'
  title: string;   // 빌드 target / 배포 environment
  status?: string; // 'ok' | 'building' | 'failed' | 'deployed'
  commit?: string; // 커밋 SHA
  url?: string;    // 배포 base_url 등
}

export interface ArtifactToolContext {
  kind: string;
  /** bare tool name — 결과 shape 이 tool 마다 달라 분기에 쓴다. */
  tool: string;
}

export function bareToolName(name: string): string {
  // mcp__awb__create_ticket → create_ticket; a plain name (Bash) is unchanged.
  const i = name.lastIndexOf('__');
  return i >= 0 ? name.slice(i + 2) : name;
}

/** Map a tool_use block's name+input → a pending capture context, or null when the
 *  tool is not a tracked ticket action. */
export function trackedTicketTool(name: unknown, input: any): TicketToolContext | null {
  if (typeof name !== 'string') return null;
  const bare = bareToolName(name);
  const inp = input && typeof input === 'object' ? input : {};
  const action = TICKET_ACTION_TOOLS[bare];
  if (!action) return null;
  return {
    action,
    fromResult: TICKET_CREATE_TOOLS.has(bare),
    inputTicketId: typeof inp.ticket_id === 'string' ? inp.ticket_id : undefined,
    inputTitle: typeof inp.title === 'string' ? inp.title : undefined,
  };
}

/** Parse a stream tool_result block's `content` (a plain string or an array of
 *  content blocks like [{type:'text', text}]) into the JSON value, or null. */
export function parseStreamToolResult(raw: any): any {
  let text: string | null = null;
  if (typeof raw === 'string') text = raw;
  else if (Array.isArray(raw)) {
    const t = raw.find((c) => c && c.type === 'text' && typeof c.text === 'string');
    text = t ? t.text : null;
  }
  if (typeof text !== 'string' || !text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Shallow-collect {id,title} ticket pairs from a parsed result (a ticket object,
 *  an array of tickets, a `{ tickets: [...] }` listing such as list_tickets, or a
 *  ticket with a `children` array) — bounded, no deep descent. Pure: returns the
 *  pairs; the caller decides how to cache them. */
export function harvestTicketTitles(result: any): Array<{ id: string; title: string }> {
  const out: Array<{ id: string; title: string }> = [];
  if (!result || typeof result !== 'object') return out;
  const consider = (o: any) => {
    if (o && typeof o === 'object' && typeof o.id === 'string' && typeof o.title === 'string') {
      out.push({ id: o.id, title: o.title });
    }
  };
  if (Array.isArray(result)) {
    for (const el of result.slice(0, 100)) consider(el);
    return out;
  }
  consider(result);
  if (Array.isArray(result.children)) for (const c of result.children.slice(0, 100)) consider(c);
  if (Array.isArray(result.tickets)) for (const t of result.tickets.slice(0, 100)) consider(t);
  return out;
}

/** Resolve a tracked tool call + its parsed result into a ticket ref, or null when
 *  the ticket can't be identified or the action errored. `titleLookup` supplies a
 *  cached title for existing-ticket actions whose result carries none. */
export function resolveTicketRef(
  ctx: TicketToolContext,
  result: any,
  isError: boolean,
  titleLookup?: (id: string) => string | undefined,
): TicketRef | null {
  if (isError) return null;
  const obj = result && typeof result === 'object' && !Array.isArray(result) ? result : null;
  let ticketId: string | undefined;
  if (ctx.fromResult) {
    // CREATE: the new ticket id is the result object's `id`.
    if (obj && typeof obj.id === 'string') ticketId = obj.id;
  } else {
    // EXISTING ticket: input ticket_id is authoritative (result.id may be a comment
    // id for add_comment). Fall back to result.ticket_id.
    ticketId = ctx.inputTicketId || (obj && typeof obj.ticket_id === 'string' ? obj.ticket_id : undefined);
  }
  if (!ticketId) return null;
  let title: string | undefined;
  if (obj && typeof obj.title === 'string' && obj.title) title = obj.title;
  if (!title) title = (titleLookup && titleLookup(ticketId)) || ctx.inputTitle;
  const ref: TicketRef = { action: ctx.action, ticket_id: ticketId };
  if (title) ref.title = title;
  return ref;
}

/** Map a tool_use block → artifact capture context, or null when not a tracked
 *  artifact tool. Pure — mirrors trackedTicketTool for the F2-4 ⓒ result surface. */
export function trackedArtifactTool(name: unknown, _input?: any): ArtifactToolContext | null {
  if (typeof name !== 'string') return null;
  const bare = bareToolName(name);
  const kind = ARTIFACT_ACTION_TOOLS[bare];
  if (!kind) return null;
  return { kind, tool: bare };
}

/** Resolve a tracked artifact tool call + its parsed result into an ArtifactRef,
 *  or null on error / unrecognizable shape (fail-closed — no phantom card).
 *  Shapes (verified against server tools, ticket d21b28fc):
 *   • register_build_artifact → flat {target, status, commit_sha, ...}
 *   • report_build_failure   → { artifact: {target, status:'failed', commit_sha, ...}, ... }
 *   • report_deployment      → flat {environment, base_url, deployed_commit_sha, ...} */
export function resolveArtifactRef(
  ctx: ArtifactToolContext,
  result: any,
  isError: boolean,
): ArtifactRef | null {
  if (isError) return null;
  const obj = result && typeof result === 'object' && !Array.isArray(result) ? result : null;
  if (!obj) return null;
  if (ctx.kind === 'build') {
    // report_build_failure nests the artifact row; register_build_artifact is flat.
    const a =
      ctx.tool === 'report_build_failure'
        ? (obj.artifact && typeof obj.artifact === 'object' ? obj.artifact : null)
        : obj;
    if (!a) return null;
    const target = typeof a.target === 'string' && a.target ? a.target : undefined;
    if (!target) return null; // 라벨 없는 빌드 카드는 무의미
    const ref: ArtifactRef = { kind: 'build', title: target };
    const status =
      typeof a.status === 'string' && a.status
        ? a.status
        : ctx.tool === 'report_build_failure'
          ? 'failed'
          : undefined;
    if (status) ref.status = status;
    if (typeof a.commit_sha === 'string' && a.commit_sha) ref.commit = a.commit_sha;
    return ref;
  }
  // deploy — report_deployment. environment 는 필수, 나머지는 있으면 보존.
  const env = typeof obj.environment === 'string' && obj.environment ? obj.environment : undefined;
  if (!env) return null;
  const ref: ArtifactRef = { kind: 'deploy', title: env, status: 'deployed' };
  if (typeof obj.deployed_commit_sha === 'string' && obj.deployed_commit_sha) ref.commit = obj.deployed_commit_sha;
  if (typeof obj.base_url === 'string' && obj.base_url) ref.url = obj.base_url;
  return ref;
}

/** Split artifact refs into ≤`size` chunks — one per emitted ChatRoomMessage,
 *  mirroring chunkTicketRefs (server bounds each message at MAX_ARTIFACT_REFS). */
export function chunkArtifactRefs(refs: ArtifactRef[], size: number): ArtifactRef[][] {
  if (!Array.isArray(refs) || refs.length === 0) return [];
  if (!Number.isFinite(size) || size <= 0) return [refs.slice()];
  const out: ArtifactRef[][] = [];
  for (let i = 0; i < refs.length; i += size) out.push(refs.slice(i, i + size));
  return out;
}

// ─── F-3 agent-status ref capture removed in P4c-4 with get_agent itself. ──

/** Compose the Korean fallback content line for a coalesced set of refs. */
export function formatTicketRefsContent(refs: TicketRef[]): string {
  return refs
    .map((r) => `📋 티켓 ${TICKET_ACTION_LABEL_KO[r.action] || r.action || '작업'}: ${r.title || r.ticket_id}`)
    .join('\n');
}

/** F2-4 ⓒ: 결과물 카드의 Korean fallback content line(메타 미이해 표면용). */
export const ARTIFACT_KIND_LABEL_KO: Record<string, string> = {
  build: '빌드', deploy: '배포',
};
export function formatArtifactRefsContent(refs: ArtifactRef[]): string {
  return refs
    .map((r) => {
      const label = ARTIFACT_KIND_LABEL_KO[r.kind] || r.kind || '결과물';
      const status = r.status ? ` (${r.status})` : '';
      return `📦 ${label}: ${r.title}${status}`;
    })
    .join('\n');
}

/** Split a coalesced ref set into ≤`size` chunks — one per emitted ChatRoomMessage.
 *  The server bounds EACH message's ticket_refs at MAX_TICKET_REFS (room-messaging.
 *  service.ts), so a turn with more successful ticket actions than `size` is rendered
 *  across MULTIPLE cards rather than truncated at the bound — the "누락 없이"
 *  contract (ticket 24694916, acceptance #1). Order-preserving; empty input → no
 *  chunks; a non-positive `size` collapses to one chunk (defensive — never called so). */
export function chunkTicketRefs(refs: TicketRef[], size: number): TicketRef[][] {
  if (!Array.isArray(refs) || refs.length === 0) return [];
  if (!Number.isFinite(size) || size <= 0) return [refs.slice()];
  const out: TicketRef[][] = [];
  for (let i = 0; i < refs.length; i += size) out.push(refs.slice(i, i + size));
  return out;
}

/**
 * The COMPLEMENT of the emit surface: every server-registered MCP tool that is
 * deliberately NOT a ticket-action card, each with a one-word reason. Together with
 * TICKET_ACTION_TOOLS + ARTIFACT_ACTION_TOOLS this is an EXHAUSTIVE classification of
 * the MCP tool surface — tool-surface-parity.test.mjs asserts the server's registered
 * tools == this union, so a newly-added tool fails CI until it is classified here (or
 * promoted to an emit above). Reasons:
 *   read        — get_/list_/search_ + whoami/subscribe/fetch: feed title cache only
 *                 (list_tickets / get_my_tickets results label later title-less cards).
 *   delete      — delete_ticket / delete_child_ticket: a card would deep-link a 404.
 *   attachment  — ticket-attachment sub-resource I/O, not a lifecycle action.
 *   assistant   — send_chat_room_message / request_ticket_unpend_approval: agent-authored
 *                 chat messages, not a ticket-row mutation. The latter explicitly never
 *                 clears pending_user_action and already writes its own fully-rendered
 *                 ticket_action card (TicketUnpendActionCard) — folding it into ticket_refs
 *                 too would double the signal, not close a gap.
 *   agent-state — set/clear_current_task: the focus seat, not a ticket-row mutation.
 *   non-ticket  — project / account / channel / resource / qa / security / action /
 *                 function / user / api-key / chat / claude-backend-profile / outreach /
 *                 ontology: not a ticket-row mutation.
 *                 (build / deploy 결과물성 tool 은 F2-4 ⓒ 로 ARTIFACT_ACTION_TOOLS 로
 *                 이관 — EXCLUDE 아님.)
 */
export const TICKET_TOOL_EXCLUSIONS: Record<string, string> = {
  // 권한 상승 승인 흐름 — 티켓을 만들지도 바꾸지도 않는다. 결과는 호출한 agent 가
  // 자기 턴에서 읽고 쓰는 것이고, 채팅에 카드로 띄울 티켓 참조가 없다.
  request_privileged_command: 'non-ticket',
  get_privileged_command_result: 'non-ticket',
  // read — get_agent/list_agents 는 P4c-4 로, board/feature/benchmark/handoff 조회는
  // board 개념 제거(docs/tickets.md)로 서버에서 삭제됨.
  fetch_github_info: 'read', get_action: 'read',
  get_api_key: 'read', get_chat_room_messages: 'read',
  get_function: 'read',
  get_latest_artifact: 'read',
  get_my_tickets: 'read', get_qa_batch: 'read', get_qa_run: 'read', get_qa_scenario: 'read',
  get_qa_schedule: 'read', get_recent_activity: 'read', get_resource: 'read',
  get_security_batch: 'read', get_security_profile: 'read', get_security_run: 'read',
  get_security_schedule: 'read', get_ticket: 'read', get_ticket_activity: 'read',
  get_ticket_attachment: 'read', get_user: 'read', get_account: 'read',
  get_automation_schedule: 'read', list_action_runs: 'read', list_actions: 'read',
  list_api_keys: 'read', list_archived_tickets: 'read',
  list_channels: 'read',
  list_chat_rooms: 'read', list_claude_backend_profiles: 'read',
  list_function_runs: 'read',
  list_functions: 'read',
  list_qa_runs: 'read', list_qa_scenarios: 'read', list_qa_schedules: 'read',
  list_repo_branches: 'read', list_resources: 'read', list_security_profiles: 'read',
  list_security_runs: 'read', list_security_schedules: 'read', list_ticket_attachments: 'read',
  list_ticket_prerequisites: 'read', list_users: 'read', list_automation_schedules: 'read',
  list_accounts: 'read', search_actions: 'read', search_chat_messages: 'read',
  search_github: 'read', search_resources: 'read', subscribe_events: 'read', whoami: 'read',
  // board-less (docs/tickets.md) — the account ticket pool listing, same posture as
  // get_my_tickets / list_archived_tickets: a read whose `{ tickets: [...] }` result
  // feeds the title cache (harvestTicketTitles) so later title-less cards stay labelled.
  list_tickets: 'read',
  // board-less Projects (git repo + its knowledge, replacing repository Resources).
  // Reads; save_project below is a non-ticket write.
  list_projects: 'read', get_project: 'read',
  // ticket d35b7b7d (Ontology Graph 6/7) — five pure-query graph_ tools, same
  // posture as search_resources above: read-only lookups over a domain
  // corpus (Ontology Graph nodes/edges), no ticket-row mutation.
  // graph_status is classified separately below ('non-ticket') since it can
  // auto-provision a new OntologyGraph row (side effect, but not a ticket
  // row either) — same split as embed_resources vs. the other resource-tools.
  graph_find_symbol: 'read', graph_module_summary: 'read', graph_neighbors: 'read',
  graph_blast_radius: 'read', graph_call_path: 'read',
  // delete (2)
  delete_child_ticket: 'delete', delete_ticket: 'delete',
  // attachment (2)
  add_ticket_attachment: 'attachment', delete_ticket_attachment: 'attachment',
  // assistant (2)
  request_ticket_unpend_approval: 'assistant', send_chat_room_message: 'assistant',
  // agent-state (2)
  clear_current_task: 'agent-state', set_current_task: 'agent-state',
  // orchestration (16) — 오케스트레이션 모드(팀 기반 자율 업무)의 Mission/Step 툴.
  // 전부 EXCLUDE 인 이유: 이 툴들은 티켓 row 를 하나도 건드리지 않고 Mission/Step
  // 상태만 바꾼다. 그리고 그 상태는 이미 전용 관찰면 — AWB 의 Mission 상세 화면
  // (Plan 그래프 + append-only 타임라인, `orchestration_update` SSE 로 라이브) —
  // 에서 훨씬 풍부하게 보인다. 여기서 채팅 카드로도 캡처하면 같은 사실이 두 곳에
  // 중복 렌더되고, 특히 report_orchestration_progress 는 하트비트라 장시간 step
  // 하나가 채팅을 카드로 도배하게 된다. ARTIFACT 버킷(빌드/배포)과 대비되는
  // 판단이다: 저기엔 결과를 보여줄 다른 화면이 없지만, 여기엔 있다.
  // (step 이 만들어낸 PR/티켓 등 산출물은 report_orchestration_step 의 `artifacts`
  //  로 Mission 화면에 남으므로 이 경로로 잃는 정보도 없다.)
  add_orchestration_note: 'orchestration',
  complete_orchestration_mission: 'orchestration',
  create_orchestration_mission: 'orchestration',
  get_orchestration_mission: 'orchestration',
  get_orchestration_step: 'orchestration',
  list_my_orchestration_steps: 'orchestration',
  reopen_orchestration_mission: 'orchestration',
  list_orchestration_graph_templates: 'orchestration',
  list_orchestration_missions: 'orchestration',
  list_orchestration_teams: 'orchestration',
  patch_orchestration_graph: 'orchestration',
  report_orchestration_progress: 'orchestration',
  report_orchestration_step: 'orchestration',
  submit_orchestration_plan: 'orchestration',
  update_orchestration_criteria: 'orchestration',
  update_orchestration_step: 'orchestration',
  // non-ticket — 빌드/배포(register_build_artifact·report_build_failure·
  // report_deployment)는 F2-4 ⓒ 로 ARTIFACT_ACTION_TOOLS 로 이관됨(EXCLUDE 아님).
  add_chat_message_attachment: 'non-ticket',
  add_chat_participants: 'non-ticket',
  attach_qa_artifact: 'non-ticket', attach_security_artifact: 'non-ticket',
  // (complete_comment_summary 는 comment-summary 기능과 함께 서버에서 삭제됨.)
  complete_action_run: 'non-ticket',
  complete_qa_run: 'non-ticket',
  complete_security_run: 'non-ticket',
  create_api_key: 'non-ticket',
  create_channel: 'non-ticket', create_chat_room: 'non-ticket',
  create_qa_scenario: 'non-ticket', create_qa_schedule: 'non-ticket',
  create_security_profile: 'non-ticket', create_security_schedule: 'non-ticket',
  create_user: 'non-ticket', create_account: 'non-ticket',
  create_automation_schedule: 'non-ticket', delete_action: 'non-ticket',
  delete_api_key: 'non-ticket',
  delete_channel: 'non-ticket', delete_chat_message_attachment: 'non-ticket',
  delete_function: 'non-ticket',
  delete_qa_scenario: 'non-ticket', delete_qa_schedule: 'non-ticket',
  delete_resource: 'non-ticket', delete_security_profile: 'non-ticket',
  delete_security_schedule: 'non-ticket', delete_user: 'non-ticket',
  delete_account: 'non-ticket', delete_automation_schedule: 'non-ticket',
  embed_resources: 'non-ticket', execute_function: 'non-ticket',
  // ticket d35b7b7d (Ontology Graph 6/7) — same posture as embed_resources
  // above: can write (auto-provision an OntologyGraph row + kick off a
  // background build) but never touches a ticket row.
  graph_status: 'non-ticket',
  graph_refresh: 'non-ticket',
  propose_skill_change: 'non-ticket',
  qa_run_heartbeat: 'non-ticket', record_outreach_classification: 'non-ticket',
  record_qa_step: 'non-ticket',
  record_security_finding: 'non-ticket', refresh_security_checklist: 'non-ticket',
  revoke_api_key: 'non-ticket', run_action: 'non-ticket', run_qa_schedule_now: 'non-ticket',
  run_security_schedule_now: 'non-ticket', run_automation_schedule_now: 'non-ticket',
  save_action: 'non-ticket', save_function: 'non-ticket',
  save_project: 'non-ticket', save_resource: 'non-ticket',
  keep_chat_session_alive: 'non-ticket',
  // 말로 답하기 — operator 세션이 사용자의 말로 받은 답을 다른 Agent Session 의 승인 대기·질문에 전한다
  // (서버 operator-tools.ts). 티켓을 만들지도 바꾸지도 않는다.
  list_pending_session_requests: 'non-ticket',
  answer_session_permission: 'non-ticket',
  answer_session_question: 'non-ticket',
  propose_session_prompt: 'non-ticket',
  send_session_prompt_proposal: 'non-ticket',
  withdraw_session_prompt_proposal: 'non-ticket',
  list_session_prompt_proposals: 'non-ticket',
  set_chat_room_name: 'non-ticket', set_qa_phase: 'non-ticket', set_typing: 'non-ticket',
  start_qa_batch: 'non-ticket', start_qa_run: 'non-ticket', start_security_batch: 'non-ticket',
  start_security_run: 'non-ticket',
  sync_github_resource: 'non-ticket',
  update_api_key: 'non-ticket',
  update_claude_backend_profile: 'non-ticket',
  update_channel: 'non-ticket',
  update_qa_scenario: 'non-ticket', update_qa_schedule: 'non-ticket',
  update_security_profile: 'non-ticket', update_security_schedule: 'non-ticket',
  update_user: 'non-ticket', update_account: 'non-ticket',
  update_automation_schedule: 'non-ticket', upsert_claude_backend_profile: 'non-ticket',
};

/** The full set of bare tool names this module classifies (emit ∪ artifact ∪ exclude).
 *  The parity test compares this against the server's registered surface; exported as
 *  a function so callers always get a fresh Set (no shared mutable state). F2-4 ⓒ:
 *  ARTIFACT_ACTION_TOOLS 는 결과물 카드 버킷(EXCLUDE 아님)으로 합류. */
export function classifiedToolNames(): Set<string> {
  return new Set<string>([
    ...Object.keys(TICKET_ACTION_TOOLS),
    ...Object.keys(ARTIFACT_ACTION_TOOLS),
    ...Object.keys(TICKET_TOOL_EXCLUSIONS),
  ]);
}
