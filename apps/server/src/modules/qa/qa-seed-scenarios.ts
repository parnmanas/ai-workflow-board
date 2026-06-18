import type { QaScenarioStep } from '../../entities/QaScenario';
import type { CreateScenarioInput } from './qa.service';

/**
 * Seed catalogue of scenario-QA definitions (ticket 026e3321).
 *
 * The scenario-QA feature (QaScenario/QaRun) shipped with an empty catalogue —
 * `list_qa_scenarios` returned []. This module is the single source of truth for
 * a starter set that exercises AWB's own feature surface, distilled from the
 * admin self-test harness (`test/qa-flows/*.test.mjs` + `qa.controller.ts`).
 *
 * Each entry is **driver-agnostic data**: it carries the `steps[]` the visualizer
 * renders and the run prompt is built from. Every scenario here uses the
 * `awb-mcp` driver — the QA agent drives AWB's own MCP/REST surface (see
 * docs/qa-driver-guide.md §6 "http-api driver") and records evidence with
 * save_resource + record_qa_step. The step `mcp_tool` values are real AWB MCP
 * tool names so the agent can execute them verbatim; `params` use `{{placeholder}}`
 * tokens the agent fills from the run context.
 *
 * Consumed by:
 *   - scripts/seed-qa-scenarios.mjs (idempotent upsert into a live workspace)
 *   - test/qa-flows/qa-run-lifecycle.test.mjs (regression: build → run → record)
 *
 * Keeping the catalogue as plain data (no workspace/agent ids baked in) is what
 * makes it reproducible across environments — buildScenarioCreatePayloads()
 * stamps the env-specific scope on at seed time.
 */

export interface SeedScenario {
  /** Stable key — used to match-and-update on re-seed (mapped to a tag `key:<key>`). */
  key: string;
  name: string;
  description: string;
  qa_driver: string;
  qa_driver_config: Record<string, any>;
  tags: string[];
  steps: QaScenarioStep[];
}

/** The driver every seeded scenario uses: AWB's own MCP/REST surface. */
const AWB_MCP_DRIVER = 'awb-mcp';

/**
 * Shared driver config. `base_url` is left as a placeholder because it is
 * environment-specific; the seed runner / QA agent substitutes the live host.
 */
function driverConfig(extra: Record<string, any> = {}): Record<string, any> {
  return {
    transport: 'mcp-streamable-http',
    base_url: '{{awb_base_url}}',
    mcp_path: '/mcp',
    note: 'Drive AWB MCP tools directly (http-api driver contract, docs/qa-driver-guide.md §6). '
      + 'Capture each tool result JSON as a text Resource via save_resource for evidence.',
    ...extra,
  };
}

function step(idx: number, action: string, expect: string, mcp_tool?: string, params?: Record<string, any>): QaScenarioStep {
  return { idx, action, expect, mcp_tool, params };
}

export const QA_SEED_SCENARIOS: SeedScenario[] = [
  // 1 ────────────────────────────────────────────────────────────────────────
  {
    key: 'ticket-lifecycle',
    name: 'Ticket lifecycle — create → move → done → auto-advance',
    description:
      'Walk a root ticket through the kanban (To Do → In Progress → Review → Done) and assert '
      + 'role-routed triggers fire at each routed column and the terminal entry stamps. Mirrors '
      + 'test/qa-flows/ticket-lifecycle.test.mjs + auto-advance-unassigned.test.mjs.',
    qa_driver: AWB_MCP_DRIVER,
    qa_driver_config: driverConfig(),
    tags: ['lifecycle', 'tickets', 'routing', 'auto-advance'],
    steps: [
      step(0, 'Create a root ticket in the To Do column with an assignee set', 'Ticket created in To Do, status=todo', 'create_ticket', { workspace_id: '{{workspace_id}}', column_id: '{{todo_column_id}}', title: 'QA lifecycle probe', assignee_id: '{{assignee_agent_id}}' }),
      step(1, 'Read the ticket back', 'column_id == To Do, assignee resolved', 'get_ticket', { ticket_id: '{{ticket_id}}' }),
      step(2, 'Move the ticket To Do → In Progress', 'Move succeeds; assignee receives an agent_trigger for In Progress', 'move_ticket', { ticket_id: '{{ticket_id}}', target_column_name: 'In Progress', board_id: '{{board_id}}' }),
      step(3, 'Move In Progress → Review', 'reviewer (not assignee) is the role woken on the Review column', 'move_ticket', { ticket_id: '{{ticket_id}}', target_column_name: 'Review', board_id: '{{board_id}}' }),
      step(4, 'Move Review → Done (terminal)', 'Ticket lands in Done, terminal_entered_at stamped, status=done', 'move_ticket', { ticket_id: '{{ticket_id}}', target_column_name: 'Done', board_id: '{{board_id}}' }),
      step(5, 'Confirm final state', 'get_ticket shows column=Done and status=done', 'get_ticket', { ticket_id: '{{ticket_id}}' }),
    ],
  },

  // 2 ────────────────────────────────────────────────────────────────────────
  {
    key: 'comment-mention-trigger',
    name: 'Comment & mention triggers',
    description:
      'Posting a note on a routed In-Progress ticket wakes the column role holder; a structured '
      + '@[role:reviewer|…] mention notifies the mentioned target specifically. Mirrors '
      + 'comment-trigger.test.mjs + comment-mention.test.mjs.',
    qa_driver: AWB_MCP_DRIVER,
    qa_driver_config: driverConfig(),
    tags: ['comments', 'mentions', 'triggers'],
    steps: [
      step(0, 'Create a ticket already in In Progress with an assignee', 'Ticket exists in In Progress', 'create_ticket', { workspace_id: '{{workspace_id}}', column_id: '{{in_progress_column_id}}', title: 'QA comment-trigger probe', assignee_id: '{{assignee_agent_id}}' }),
      step(1, 'Add a plain note comment', 'Assignee (In Progress role holder) receives a comment trigger', 'add_comment', { ticket_id: '{{ticket_id}}', content: 'QA: plain note — should wake assignee', type: 'note' }),
      step(2, 'Add a comment with a structured reviewer mention', 'comment_mention notification is scoped to the reviewer only', 'add_comment', { ticket_id: '{{ticket_id}}', content: 'QA: @[role:reviewer|Reviewer] please look', type: 'note' }),
      step(3, 'Reload the ticket thread', 'Both comments present with author_role recorded in metadata', 'get_ticket', { ticket_id: '{{ticket_id}}' }),
    ],
  },

  // 3 ────────────────────────────────────────────────────────────────────────
  {
    key: 'chat-room-messaging',
    name: 'Chat room — message + attachment + dynamic loading',
    description:
      'Create a group chat room, add participants, send messages, attach an uploaded Resource, then '
      + 'page history with a cursor and search it. Mirrors multi-user-chat / chat-message-read / '
      + 'chat-attachments.test.mjs.',
    qa_driver: AWB_MCP_DRIVER,
    qa_driver_config: driverConfig(),
    tags: ['chat-rooms', 'attachments', 'pagination', 'search'],
    steps: [
      step(0, 'Create a group chat room', 'Room created with the caller as participant', 'create_chat_room', { workspace_id: '{{workspace_id}}', type: 'group', name: 'QA chat probe' }),
      step(1, 'Add a second participant', 'Participant added; non-members must NOT receive room SSE', 'add_chat_participants', { room_id: '{{room_id}}', participants: [{ participant_type: 'agent', participant_id: '{{assignee_agent_id}}' }] }),
      step(2, 'Send a handful of messages so history is pageable', 'Each send returns a message id; last_message_at advances', 'send_chat_room_message', { room_id: '{{room_id}}', content: 'QA message {{n}}' }),
      step(3, 'Upload an evidence Resource then attach it to a message', 'Attachment owner transitions to chat_message; appears in history projection', 'add_chat_message_attachment', { room_id: '{{room_id}}', resource_id: '{{attachment_resource_id}}' }),
      step(4, 'Page the newest N messages then fetch older with a before-cursor', 'Pagination returns disjoint pages in order (dynamic loading)', 'get_chat_room_messages', { room_id: '{{room_id}}', limit: 3, before: '{{cursor}}' }),
      step(5, 'Search the room for a keyword', 'Search returns only matching messages within the room scope', 'search_chat_messages', { workspace_id: '{{workspace_id}}', query: 'QA message' }),
    ],
  },

  // 4 ────────────────────────────────────────────────────────────────────────
  {
    key: 'mcp-agent-roundtrip',
    name: 'MCP agent roundtrip (SSE in → tool call out)',
    description:
      'The closed-loop promise: an agent woken by an SSE trigger reacts by calling MCP tools to '
      + 'advance the ticket. Drive a move to fire the trigger, then assert the agent\'s add_comment '
      + '+ move_ticket landed. Mirrors mcp-agent-roundtrip.test.mjs.',
    qa_driver: AWB_MCP_DRIVER,
    qa_driver_config: driverConfig({ requires_live_agent: true }),
    tags: ['mcp', 'sse', 'agent', 'roundtrip'],
    steps: [
      step(0, 'Create a ticket in To Do assigned to a live QA agent', 'Ticket exists, assignee online', 'create_ticket', { workspace_id: '{{workspace_id}}', column_id: '{{todo_column_id}}', title: 'QA roundtrip probe', prompt_text: 'Advance me to Review and leave a note.', assignee_id: '{{assignee_agent_id}}' }),
      step(1, 'Subscribe to events so the trigger and the agent reaction are observable', 'SSE stream open', 'subscribe_events', { workspace_id: '{{workspace_id}}' }),
      step(2, 'Move the ticket To Do → In Progress to fire the assignee trigger', 'agent_trigger delivered to the assignee within a few seconds', 'move_ticket', { ticket_id: '{{ticket_id}}', target_column_name: 'In Progress', board_id: '{{board_id}}' }),
      step(3, 'Wait for the agent to react via MCP', 'A new comment from the agent appears AND the ticket moves forward (SSE→MCP loop closed)', 'get_ticket', { ticket_id: '{{ticket_id}}' }),
    ],
  },

  // 5 ────────────────────────────────────────────────────────────────────────
  {
    key: 'action-run',
    name: 'Action authoring & dispatch',
    description:
      'Author an Action, dispatch it, and confirm an ActionRun room was created and the FIFO '
      + 'run-history budget holds. Exercises the actions module + on-ticket-done hook surface '
      + '(on-ticket-done-hook.test.mjs).',
    qa_driver: AWB_MCP_DRIVER,
    qa_driver_config: driverConfig(),
    tags: ['actions', 'dispatch'],
    steps: [
      step(0, 'Create an Action targeting the QA agent', 'Action persisted, enabled', 'save_action', { workspace_id: '{{workspace_id}}', name: 'QA probe action', target_agent_id: '{{assignee_agent_id}}', prompt: 'QA: respond with OK.' }),
      step(1, 'Read it back', 'get_action returns the saved definition', 'get_action', { action_id: '{{action_id}}' }),
      step(2, 'Run the action', 'run_action returns a run_id + room_id; first message posted to the room', 'run_action', { action_id: '{{action_id}}' }),
      step(3, 'List run history', 'The new run is present, newest first, capped at max_runs', 'list_action_runs', { action_id: '{{action_id}}', workspace_id: '{{workspace_id}}' }),
    ],
  },

  // 6 ────────────────────────────────────────────────────────────────────────
  {
    key: 'benchmark-lifecycle',
    name: 'Benchmark lifecycle — run → score → leaderboard',
    description:
      'Create a benchmark run with candidates, submit per-dimension scores (upsert), and read the '
      + 'run-scoped and agent-aggregate leaderboards. Mirrors benchmark-scoring / benchmark-lifecycle.',
    qa_driver: AWB_MCP_DRIVER,
    qa_driver_config: driverConfig(),
    tags: ['benchmarks', 'scoring', 'leaderboard'],
    steps: [
      step(0, 'Create a benchmark run with two candidate agents', 'Run created; candidates dispatched (or parked if draft)', 'create_benchmark_run', { workspace_id: '{{workspace_id}}', board_id: '{{board_id}}', name: 'QA benchmark probe', candidate_agent_ids: ['{{candidate_a}}', '{{candidate_b}}'] }),
      step(1, 'Submit scores for candidate A (correctness, quality)', 'Scores stored per (candidate, dimension)', 'submit_benchmark_score', { run_id: '{{run_id}}', candidate_agent_id: '{{candidate_a}}', scores: { correctness: 9, quality: 8 } }),
      step(2, 'Re-submit one dimension for A', 'Upsert overwrites rather than duplicates', 'submit_benchmark_score', { run_id: '{{run_id}}', candidate_agent_id: '{{candidate_a}}', scores: { correctness: 10 } }),
      step(3, 'Read the leaderboard', 'Run-scoped + agent-aggregate leaderboards reflect the submitted scores', 'get_benchmark_leaderboard', { run_id: '{{run_id}}', workspace_id: '{{workspace_id}}' }),
    ],
  },

  // 7 ────────────────────────────────────────────────────────────────────────
  {
    key: 'board-pause-resume',
    name: 'Board pause / resume gate',
    description:
      'A paused board (paused_at set) silently drops every agent_trigger; clearing paused_at restores '
      + 'dispatch. Mirrors board-pause.test.mjs.',
    qa_driver: AWB_MCP_DRIVER,
    qa_driver_config: driverConfig(),
    tags: ['boards', 'pause', 'triggers'],
    steps: [
      step(0, 'Create an In-Progress ticket assigned to the QA agent', 'Ticket exists in In Progress', 'create_ticket', { workspace_id: '{{workspace_id}}', column_id: '{{in_progress_column_id}}', title: 'QA pause probe', assignee_id: '{{assignee_agent_id}}' }),
      step(1, 'Pause the board', 'update_board sets paused_at', 'update_board', { board_id: '{{board_id}}', paused: true }),
      step(2, 'Post a comment while paused', 'NO agent_trigger emitted (gate drops it) — verify via recent activity', 'add_comment', { ticket_id: '{{ticket_id}}', content: 'QA: comment while paused', type: 'note' }),
      step(3, 'Resume the board', 'update_board clears paused_at', 'update_board', { board_id: '{{board_id}}', paused: false }),
      step(4, 'Post another comment', 'Assignee now receives the trigger again', 'add_comment', { ticket_id: '{{ticket_id}}', content: 'QA: comment after resume', type: 'note' }),
      step(5, 'Inspect recent activity', 'Trigger present after resume, absent while paused', 'get_recent_activity', { workspace_id: '{{workspace_id}}' }),
    ],
  },

  // 8 ────────────────────────────────────────────────────────────────────────
  {
    key: 'archive-unarchive',
    name: 'Archive / unarchive ticket',
    description:
      'Archiving a ticket removes it from board/workspace ticket reads and the stuck detector; '
      + 'unarchiving restores it. Mirrors archive-edge-paths.test.mjs.',
    qa_driver: AWB_MCP_DRIVER,
    qa_driver_config: driverConfig(),
    tags: ['archive', 'tickets'],
    steps: [
      step(0, 'Create a ticket to archive', 'Ticket exists', 'create_ticket', { workspace_id: '{{workspace_id}}', column_id: '{{todo_column_id}}', title: 'QA archive probe' }),
      step(1, 'Archive it', 'archived_at stamped', 'archive_ticket', { ticket_id: '{{ticket_id}}' }),
      step(2, 'List archived tickets', 'Ticket appears in the archived list', 'list_archived_tickets', { workspace_id: '{{workspace_id}}' }),
      step(3, 'Confirm it is excluded from the live board', 'get_board_summary / board read no longer counts it', 'get_board_summary', { board_id: '{{board_id}}' }),
      step(4, 'Unarchive it', 'archived_at cleared; ticket back on the board', 'unarchive_ticket', { ticket_id: '{{ticket_id}}' }),
      step(5, 'Confirm restoration', 'get_ticket shows the ticket live again', 'get_ticket', { ticket_id: '{{ticket_id}}' }),
    ],
  },

  // 9 ────────────────────────────────────────────────────────────────────────
  {
    key: 'workspace-board-move',
    name: 'Cross-workspace board move (re-stamp)',
    description:
      'Moving a board to another workspace re-stamps the board + its columns + tickets and carries '
      + 'column-prompt templates / roles. Mirrors workspace-move-board.test.mjs.',
    qa_driver: AWB_MCP_DRIVER,
    qa_driver_config: driverConfig(),
    tags: ['workspaces', 'boards', 'move'],
    steps: [
      step(0, 'Create a throwaway source board with a ticket', 'Board + ticket created', 'create_board', { workspace_id: '{{workspace_id}}', name: 'QA move-src' }),
      step(1, 'Create a destination workspace', 'Destination workspace exists', 'create_workspace', { name: 'QA move-dst' }),
      step(2, 'Move the board to the destination workspace', 'Board.workspace_id re-stamped; columns + tickets follow', 'move_board_to_workspace', { board_id: '{{src_board_id}}', target_workspace_id: '{{dst_workspace_id}}' }),
      step(3, 'Verify re-stamp', 'get_board shows the new workspace_id; tickets carry it too', 'get_board', { board_id: '{{src_board_id}}' }),
    ],
  },

  // 10 ───────────────────────────────────────────────────────────────────────
  {
    key: 'column-role-policy-auto-advance',
    name: 'Column role routing & auto-advance',
    description:
      'A routed column with no matching role holder auto-advances a staffed ticket to the next '
      + 'servable column, but HALTs a completely-unassigned ticket. Mirrors auto-advance-unassigned / '
      + 'auto-advance-halt-unassigned.test.mjs.',
    qa_driver: AWB_MCP_DRIVER,
    qa_driver_config: driverConfig(),
    tags: ['columns', 'column-policies', 'routing', 'auto-advance'],
    steps: [
      step(0, 'Create a board whose Plan column routes to "planner"', 'Board + columns created', 'create_board', { workspace_id: '{{workspace_id}}', name: 'QA policy probe' }),
      step(1, 'Set Plan column role_routing to a role no agent holds', 'update_column persists role_routing=["planner"]', 'update_column', { column_id: '{{plan_column_id}}', role_routing: ['planner'] }),
      step(2, 'Move a ticket WITH an assignee (but no planner) onto Plan', 'Ticket auto-advances past the unservable Plan column to In Progress; assignee woken', 'move_ticket', { ticket_id: '{{staffed_ticket_id}}', target_column_name: 'Plan', board_id: '{{policy_board_id}}' }),
      step(3, 'Move a completely-unassigned ticket onto Plan', 'Ticket HALTS in place with auto_advance_halted_unassigned (no silent skip to Done)', 'move_ticket', { ticket_id: '{{orphan_ticket_id}}', target_column_name: 'Plan', board_id: '{{policy_board_id}}' }),
    ],
  },

  // 11 ───────────────────────────────────────────────────────────────────────
  {
    key: 'backlog-promotion',
    name: 'Backlog promotion (chain-aware, focus-gated)',
    description:
      'With the per-agent focus cap full, the backlog stays put; when focus frees up the chain '
      + 'successor is promoted ahead of an unrelated higher-priority outsider. Mirrors '
      + 'backlog-promotion-chain / workflow-state-cap.test.mjs.',
    qa_driver: AWB_MCP_DRIVER,
    qa_driver_config: driverConfig(),
    tags: ['backlog', 'promotion', 'focus', 'chain'],
    steps: [
      step(0, 'Create a board with max_concurrent_tickets_per_agent = 1', 'Board created with focus cap', 'create_board', { workspace_id: '{{workspace_id}}', name: 'QA backlog probe', max_concurrent_tickets_per_agent: 1 }),
      step(1, 'Put one ticket in In Progress (fills the focus slot)', 'Focus slot occupied', 'move_ticket', { ticket_id: '{{active_ticket_id}}', target_column_name: 'In Progress', board_id: '{{backlog_board_id}}' }),
      step(2, 'Add a chain successor (low priority) + an unrelated outsider (high priority) to Backlog', 'Two backlog candidates exist', 'create_ticket', { workspace_id: '{{workspace_id}}', column_id: '{{backlog_column_id}}', title: 'QA chain successor', priority: 'low' }),
      step(3, 'While focus is full, observe no promotion', 'get_board_summary shows backlog unchanged (focus-held gate)', 'get_board_summary', { board_id: '{{backlog_board_id}}' }),
      step(4, 'Finish the active ticket (move to Done) to free the focus slot', 'Exactly one backlog ticket promotes — the chain successor wins over the outsider', 'move_ticket', { ticket_id: '{{active_ticket_id}}', target_column_name: 'Done', board_id: '{{backlog_board_id}}' }),
      step(5, 'Confirm the promotion', 'get_board_summary shows the chain successor promoted into the active column', 'get_board_summary', { board_id: '{{backlog_board_id}}' }),
    ],
  },

  // 12 ───────────────────────────────────────────────────────────────────────
  {
    key: 'resource-media-attachment',
    name: 'Resource upload & comment media attachment',
    description:
      'Upload a (large) media Resource by id, attach it to a comment, and confirm the ticket '
      + 'hydrates the attachment metadata. Backs the evidence path every QA run uses and mirrors '
      + 'comment-media-e2e.test.mjs.',
    qa_driver: AWB_MCP_DRIVER,
    qa_driver_config: driverConfig(),
    tags: ['resources', 'attachments', 'media'],
    steps: [
      step(0, 'Save a comment_attachment Resource in the workspace', 'Resource created with type=comment_attachment', 'save_resource', { workspace_id: '{{workspace_id}}', type: 'comment_attachment', name: 'qa-evidence.txt' }),
      step(1, 'Read the resource back', 'get_resource returns metadata (id, mimetype, size)', 'get_resource', { resource_id: '{{resource_id}}' }),
      step(2, 'Attach it to a comment', 'add_comment with attachment_resource_ids succeeds', 'add_comment', { ticket_id: '{{ticket_id}}', content: 'QA: evidence attached', attachment_resource_ids: ['{{resource_id}}'] }),
      step(3, 'Reload the ticket', 'get_ticket shows the comment with its attachment hydrated', 'get_ticket', { ticket_id: '{{ticket_id}}' }),
    ],
  },
];

export interface BuildScenarioOptions {
  workspace_id: string;
  target_agent_id: string;
  /** null/'' → workspace-scoped; <uuid> → pinned to that board. */
  board_id?: string | null;
  created_by?: string;
  /** Only seed scenarios whose `key` is in this list (default: all). */
  only?: string[];
}

/** Tag a scenario carries so re-seeds can find their prior row by stable key. */
export function keyTag(key: string): string {
  return `key:${key}`;
}

/**
 * Stamp the env-specific scope (workspace/board/agent) onto each template and
 * return ready-to-create payloads. The stable `key` is preserved both as the
 * leading tag (`key:<key>`) and folded into the catalogue, so an idempotent
 * seeder can match-and-update instead of duplicating.
 */
export function buildScenarioCreatePayloads(opts: BuildScenarioOptions): Array<CreateScenarioInput & { _key: string }> {
  const wanted = opts.only && opts.only.length ? new Set(opts.only) : null;
  return QA_SEED_SCENARIOS.filter((s) => !wanted || wanted.has(s.key)).map((s) => ({
    _key: s.key,
    workspace_id: opts.workspace_id,
    board_id: opts.board_id ?? null,
    name: s.name,
    description: s.description,
    steps: s.steps,
    target_agent_id: opts.target_agent_id,
    qa_driver: s.qa_driver,
    qa_driver_config: s.qa_driver_config,
    enabled: true,
    tags: [keyTag(s.key), ...s.tags],
    created_by: opts.created_by ?? '',
    max_runs: 20,
  }));
}
