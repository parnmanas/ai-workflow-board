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
 * classified EXHAUSTIVELY across four buckets so a newly-added tool is a deliberate
 * decision, never a silent gap. tool-surface-parity.test.mjs asserts the server's
 * registered tools equal EMIT ∪ BATCH ∪ REJECT ∪ EXCLUDE, failing CI on any
 * unclassified (or stale) tool:
 *
 *   EMIT (this map) — create / move (incl. cross-board) / update (incl. child),
 *     comment plus the typed-comment mutations (ask_question / answer_question /
 *     record_decision), claim / release, pend / unpend, archive / unarchive,
 *     prerequisite add / remove, handoff, and the consensus micro-protocol
 *     (propose_move + record_agreement).
 *   BATCH (BATCH_TICKET_TOOL) — batch_operations: ONE result fans out to MANY refs.
 *   REJECT (REJECT_HANDOFF_TOOL) — reject_handoff: ONE result → the newly-filed 반려
 *     defect ticket + the re-blocked follow-up (bespoke shape → resolveRejectHandoffRefs).
 *   EXCLUDE (TICKET_TOOL_EXCLUSIONS) — reads, ticket deletes (404 deep-link),
 *     ticket-attachment I/O, the assistant's own send_chat_room_message, the
 *     current-task focus seat, remote improvement tickets (off-instance → 404), and
 *     every non-ticket domain. Enumerated there with a per-tool reason.
 */
export const TICKET_ACTION_TOOLS: Record<string, string> = {
  create_ticket: 'create',
  create_child_ticket: 'create',
  move_ticket: 'move',
  move_ticket_to_board: 'move',
  update_ticket: 'update',
  update_child_ticket: 'update',
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
  handoff_to_agent: 'handoff',
  propose_move: 'propose',
  record_agreement: 'consensus',
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

/** The one MCP ticket tool whose single tool_result fans out to MANY refs:
 *  batch_operations runs N ops in a transaction, so its result carries a
 *  `results[]` array parallel to the input `operations[]`. Handled by
 *  resolveBatchTicketRefs (multi-ref), NOT the 1-result→1-ref path above. */
export const BATCH_TICKET_TOOL = 'batch_operations';
/** The cross-board reverse-rejection tool. Like batch_operations its single
 *  tool_result fans out to MANY refs, and its shape fits NEITHER the create
 *  (result.id) NOR the existing-ticket (input ticket_id) path — it returns
 *  {defect_ticket_id, source_ticket_id, followup_pending_on_tickets, followup{…}}.
 *  Handled by resolveRejectHandoffRefs (multi-ref), NOT resolveTicketRef. */
export const REJECT_HANDOFF_TOOL = 'reject_handoff';
/** batch_operations sub-action → card action. An op whose action isn't here (or
 *  that failed) emits no ref. Legacy aliases (add-subtask / update-subtask) fold
 *  onto the same action as their current name. */
export const BATCH_OP_ACTION: Record<string, string> = {
  'create-ticket': 'create',
  'move-ticket': 'move',
  'add-child': 'create',
  'add-subtask': 'create',
  'update-child': 'update',
  'update-subtask': 'update',
  'add-comment': 'comment',
};
/** Korean action label for the fallback content line — rendered on surfaces that
 *  don't understand metadata (history replay, notifications, legacy clients). */
export const TICKET_ACTION_LABEL_KO: Record<string, string> = {
  create: '생성', move: '이동', update: '수정', comment: '코멘트',
  question: '질문', answer: '답변', decision: '결정',
  claim: '클레임', release: '클레임 해제', pend: '보류', unpend: '보류 해제',
  archive: '아카이브', unarchive: '아카이브 해제', prereq: '선행조건',
  handoff: '핸드오프', propose: '이동 제안', consensus: '합의', reject: '반려',
};

export interface TicketToolContext {
  action: string;
  fromResult: boolean;
  inputTicketId?: string;
  inputTitle?: string;
  /** Set ONLY for batch_operations: the raw input `operations[]`, zipped against
   *  the result `results[]` by resolveBatchTicketRefs. Presence of this field is
   *  what routes a capture down the multi-ref path instead of resolveTicketRef. */
  batchOps?: any[];
  /** Set ONLY for reject_handoff: routes to resolveRejectHandoffRefs (bespoke
   *  multi-ref shape). Presence of this flag is what selects that path. */
  rejectHandoff?: boolean;
}
export interface TicketRef {
  action: string;
  ticket_id: string;
  title?: string;
  // F2-4 ⓑ: propose_move 의 대상 컬럼 이름 등 제안/합의 부가 맥락(있으면).
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
  // batch_operations is a special case: one call, many ticket mutations. Capture
  // the raw operations[] here; resolveBatchTicketRefs zips it with results[] later.
  if (bare === BATCH_TICKET_TOOL) {
    return {
      action: 'batch',
      fromResult: true,
      batchOps: Array.isArray(inp.operations) ? inp.operations : [],
    };
  }
  // reject_handoff is the other multi-ref special: it keys on `followup_ticket_id`
  // (not `ticket_id`) and files a NEW defect ticket, so its refs come from the
  // bespoke resolveRejectHandoffRefs, not the standard action map below.
  if (bare === REJECT_HANDOFF_TOOL) {
    return {
      action: 'reject',
      fromResult: true,
      rejectHandoff: true,
      inputTicketId: typeof inp.followup_ticket_id === 'string' ? inp.followup_ticket_id : undefined,
    };
  }
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
 *  an array of tickets, or a ticket with a `children` array) — bounded, no deep
 *  descent. Pure: returns the pairs; the caller decides how to cache them. */
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
  // F2-4 ⓑ: propose_move 결과의 target_column.name 을 승인 카드 배지용 detail 로 싣는다.
  // ("→ <컬럼> 이동 제안"). record_agreement 등 여타 action 은 detail 없이 배지만 렌더.
  if (ctx.action === 'propose' && obj && obj.target_column && typeof obj.target_column === 'object') {
    const colName = (obj.target_column as any).name;
    if (typeof colName === 'string' && colName) ref.detail = colName;
  }
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

/** Resolve a batch_operations call into MANY ticket refs — the multi-ref path the
 *  1-result→1-ref resolveTicketRef can't cover. Zips the captured input
 *  `operations[]` with the result `results[]` (parallel arrays, same index):
 *  every op that SUCCEEDED and maps to a tracked BATCH_OP_ACTION yields one ref.
 *  The ticket id comes from the result row's `ticketId` (a create's NEW id, a
 *  move/update-child's target), except add-comment whose result carries only a
 *  `commentId` — there the ticket is the INPUT op's `ticketId`. Failed ops
 *  (`error`, or no `success`) and untracked ops emit nothing. */
export function resolveBatchTicketRefs(
  ctx: TicketToolContext,
  result: any,
  isError: boolean,
  titleLookup?: (id: string) => string | undefined,
): TicketRef[] {
  if (isError || !Array.isArray(ctx.batchOps)) return [];
  const obj = result && typeof result === 'object' && !Array.isArray(result) ? result : null;
  const rows = obj && Array.isArray(obj.results) ? obj.results : null;
  if (!rows) return [];
  const ops = ctx.batchOps;
  const out: TicketRef[] = [];
  const n = Math.min(ops.length, rows.length);
  for (let i = 0; i < n; i++) {
    const op = ops[i];
    const row = rows[i];
    if (!op || typeof op !== 'object' || !row || typeof row !== 'object') continue;
    if (row.success !== true || row.error != null) continue; // failed op → no card
    const action = BATCH_OP_ACTION[String(op.action)];
    if (!action) continue; // untracked op (e.g. read/unknown) → no card
    const rowTicketId = typeof row.ticketId === 'string' ? row.ticketId : undefined;
    const opTicketId = typeof op.ticketId === 'string' ? op.ticketId : undefined;
    // add-comment's result is {success, commentId} — the ticket is the input's;
    // every other op's result row carries the (new or target) ticketId.
    const ticketId = action === 'comment' ? opTicketId : rowTicketId || opTicketId;
    if (!ticketId) continue;
    let title: string | undefined = typeof op.title === 'string' && op.title ? op.title : undefined;
    if (!title) title = titleLookup && titleLookup(ticketId);
    const ref: TicketRef = { action, ticket_id: ticketId };
    if (title) ref.title = title;
    out.push(ref);
  }
  return out;
}

/** Resolve a reject_handoff call into its ticket refs. The tool files a NEW defect
 *  ticket back on the source board AND re-blocks the follow-up on it, so ONE result
 *  legitimately yields TWO refs — neither fits resolveTicketRef's create (result.id)
 *  or existing-ticket (input ticket_id) shapes. Result shape:
 *  {defect_ticket_id, defect_board_id, source_ticket_id, followup_pending_on_tickets,
 *   followup:{id,title,…}}.
 *    • defect_ticket_id → action 'reject' (the newly-filed 반려 defect ticket, primary).
 *    • the follow-up (input followup_ticket_id, else result.followup.id) → 'prereq'
 *      (it was re-blocked on the defect as a prerequisite).
 *  Errors / missing ids emit nothing (fail-closed). The defect lives on the SOURCE
 *  board — a DIFFERENT board maybe, but the SAME AWB instance, so its deep-link
 *  resolves (unlike create_remote_improvement_ticket, which is off-instance). */
export function resolveRejectHandoffRefs(
  ctx: TicketToolContext,
  result: any,
  isError: boolean,
  titleLookup?: (id: string) => string | undefined,
): TicketRef[] {
  if (isError) return [];
  const obj = result && typeof result === 'object' && !Array.isArray(result) ? result : null;
  if (!obj) return [];
  // 1. The newly-filed defect ticket — the primary artifact of a rejection. Its
  //    presence is the SUCCESS signal: with no defect_ticket_id the rejection did
  //    not happen (error / unexpected shape), so emit NOTHING — never a stray prereq
  //    off the input ticket id (fail-closed, mirrors the batch per-op success gate).
  const defectId = typeof obj.defect_ticket_id === 'string' ? obj.defect_ticket_id : undefined;
  if (!defectId) return [];
  const out: TicketRef[] = [];
  const defectRef: TicketRef = { action: 'reject', ticket_id: defectId };
  const defectTitle = titleLookup && titleLookup(defectId);
  if (defectTitle) defectRef.title = defectTitle;
  out.push(defectRef);
  // 2. The follow-up ticket, re-blocked on the defect as a prerequisite. Its title
  //    rides along in the result under `followup`, else falls back to the cache.
  const followup = obj.followup && typeof obj.followup === 'object' && !Array.isArray(obj.followup)
    ? obj.followup : null;
  const followupId =
    ctx.inputTicketId || (followup && typeof followup.id === 'string' ? followup.id : undefined);
  if (followupId) {
    const ref: TicketRef = { action: 'prereq', ticket_id: followupId };
    const title =
      (followup && typeof followup.title === 'string' && followup.title ? followup.title : undefined) ||
      (titleLookup && titleLookup(followupId)) || undefined;
    if (title) ref.title = title;
    out.push(ref);
  }
  return out;
}

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
 * TICKET_ACTION_TOOLS + BATCH_TICKET_TOOL + REJECT_HANDOFF_TOOL this is an EXHAUSTIVE
 * classification of the MCP tool surface — tool-surface-parity.test.mjs asserts the
 * server's registered tools == this union, so a newly-added tool fails CI until it is
 * classified here (or promoted to an emit above). Reasons:
 *   read        — get_/list_/search_ + whoami/ping/subscribe/fetch: feed title cache only.
 *   delete      — delete_ticket / delete_child_ticket: a card would deep-link a 404.
 *   attachment  — ticket-attachment sub-resource I/O, not a lifecycle action.
 *   assistant   — send_chat_room_message: the assistant's own reply, not an action.
 *   agent-state — set/clear_current_task: the focus seat, not a ticket-row mutation.
 *   remote      — create_remote_improvement_ticket: files on ANOTHER AWB instance,
 *                 so a local deep-link would 404.
 *   non-ticket  — board / workspace / agent / channel / resource / qa / security /
 *                 feature / action / user / api-key / benchmark / prompt-template /
 *                 chat / lesson: not a ticket-row mutation. (build / deploy 결과물성
 *                 tool 은 F2-4 ⓒ 로 ARTIFACT_ACTION_TOOLS 로 이관 — EXCLUDE 아님.)
 */
export const TICKET_TOOL_EXCLUSIONS: Record<string, string> = {
  // read (60)
  fetch_github_info: 'read', get_action: 'read', get_agent: 'read',
  get_allocated_tickets: 'read', get_api_key: 'read', get_benchmark_leaderboard: 'read',
  get_board: 'read', get_board_summary: 'read', get_chat_room_messages: 'read',
  get_feature: 'read', get_handoff_pipeline: 'read', get_latest_artifact: 'read',
  get_my_tickets: 'read', get_qa_batch: 'read', get_qa_run: 'read', get_qa_scenario: 'read',
  get_qa_schedule: 'read', get_recent_activity: 'read', get_resource: 'read',
  get_security_batch: 'read', get_security_profile: 'read', get_security_run: 'read',
  get_security_schedule: 'read', get_ticket: 'read', get_ticket_activity: 'read',
  get_ticket_attachment: 'read', get_user: 'read', get_workspace: 'read',
  get_workspace_schedule: 'read', list_action_runs: 'read', list_actions: 'read',
  list_agents: 'read', list_api_keys: 'read', list_archived_tickets: 'read',
  list_board_lessons: 'read', list_boards: 'read', list_channels: 'read',
  list_chat_rooms: 'read', list_features: 'read', list_prompt_templates: 'read',
  list_qa_runs: 'read', list_qa_scenarios: 'read', list_qa_schedules: 'read',
  list_repo_branches: 'read', list_resources: 'read', list_security_profiles: 'read',
  list_security_runs: 'read', list_security_schedules: 'read', list_ticket_attachments: 'read',
  list_ticket_prerequisites: 'read', list_users: 'read', list_workspace_schedules: 'read',
  list_workspaces: 'read', ping: 'read', search_actions: 'read', search_chat_messages: 'read',
  search_github: 'read', search_resources: 'read', subscribe_events: 'read', whoami: 'read',
  // delete (2)
  delete_child_ticket: 'delete', delete_ticket: 'delete',
  // attachment (2)
  add_ticket_attachment: 'attachment', delete_ticket_attachment: 'attachment',
  // assistant (1)
  send_chat_room_message: 'assistant',
  // agent-state (2)
  clear_current_task: 'agent-state', set_current_task: 'agent-state',
  // remote (1)
  create_remote_improvement_ticket: 'remote',
  // non-ticket (79) — 빌드/배포(register_build_artifact·report_build_failure·
  // report_deployment)는 F2-4 ⓒ 로 ARTIFACT_ACTION_TOOLS 로 이관됨(EXCLUDE 아님).
  // non-ticket
  add_board_lesson: 'non-ticket', add_chat_message_attachment: 'non-ticket',
  add_chat_participants: 'non-ticket', approve_feature: 'non-ticket',
  attach_qa_artifact: 'non-ticket', attach_security_artifact: 'non-ticket',
  complete_action_run: 'non-ticket', complete_qa_run: 'non-ticket',
  complete_security_run: 'non-ticket', create_agent: 'non-ticket',
  create_api_key: 'non-ticket', create_benchmark_run: 'non-ticket', create_board: 'non-ticket',
  create_channel: 'non-ticket', create_chat_room: 'non-ticket', create_column: 'non-ticket',
  create_qa_scenario: 'non-ticket', create_qa_schedule: 'non-ticket',
  create_security_profile: 'non-ticket', create_security_schedule: 'non-ticket',
  create_user: 'non-ticket', create_workspace: 'non-ticket',
  create_workspace_schedule: 'non-ticket', delete_action: 'non-ticket',
  delete_agent: 'non-ticket', delete_api_key: 'non-ticket', delete_board: 'non-ticket',
  delete_channel: 'non-ticket', delete_chat_message_attachment: 'non-ticket',
  delete_column: 'non-ticket', delete_prompt_template: 'non-ticket',
  delete_qa_scenario: 'non-ticket', delete_qa_schedule: 'non-ticket',
  delete_resource: 'non-ticket', delete_security_profile: 'non-ticket',
  delete_security_schedule: 'non-ticket', delete_user: 'non-ticket',
  delete_workspace: 'non-ticket', delete_workspace_schedule: 'non-ticket',
  embed_resources: 'non-ticket', move_agent_to_workspace: 'non-ticket',
  move_board_to_workspace: 'non-ticket', propose_feature_chain: 'non-ticket',
  qa_run_heartbeat: 'non-ticket', record_qa_step: 'non-ticket',
  record_security_finding: 'non-ticket', refresh_security_checklist: 'non-ticket',
  reject_feature: 'non-ticket',
  revoke_api_key: 'non-ticket', run_action: 'non-ticket', run_qa_schedule_now: 'non-ticket',
  run_security_schedule_now: 'non-ticket', run_workspace_schedule_now: 'non-ticket',
  save_action: 'non-ticket', save_prompt_template: 'non-ticket', save_resource: 'non-ticket',
  set_chat_room_name: 'non-ticket', set_qa_phase: 'non-ticket', set_typing: 'non-ticket',
  start_qa_batch: 'non-ticket', start_qa_run: 'non-ticket', start_security_batch: 'non-ticket',
  start_security_run: 'non-ticket', submit_benchmark_score: 'non-ticket',
  submit_feature_request: 'non-ticket', sync_github_resource: 'non-ticket',
  update_agent: 'non-ticket', update_api_key: 'non-ticket', update_board: 'non-ticket',
  update_board_lesson: 'non-ticket', update_channel: 'non-ticket', update_column: 'non-ticket',
  update_qa_scenario: 'non-ticket', update_qa_schedule: 'non-ticket',
  update_security_profile: 'non-ticket', update_security_schedule: 'non-ticket',
  update_user: 'non-ticket', update_workspace: 'non-ticket',
  update_workspace_schedule: 'non-ticket',
};

/** The full set of bare tool names this module classifies (emit ∪ batch ∪ reject ∪
 *  artifact ∪ exclude). The parity test compares this against the server's registered
 *  surface; exported as a function so callers always get a fresh Set (no shared mutable
 *  state). F2-4 ⓒ: ARTIFACT_ACTION_TOOLS 는 결과물 카드 버킷(EXCLUDE 아님)으로 합류. */
export function classifiedToolNames(): Set<string> {
  return new Set<string>([
    ...Object.keys(TICKET_ACTION_TOOLS),
    BATCH_TICKET_TOOL,
    REJECT_HANDOFF_TOOL,
    ...Object.keys(ARTIFACT_ACTION_TOOLS),
    ...Object.keys(TICKET_TOOL_EXCLUSIONS),
  ]);
}
