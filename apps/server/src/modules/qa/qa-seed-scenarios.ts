import type { QaScenarioStep, QaOnFailureTicketConfig } from '../../entities/QaScenario';
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
 * renders and the run prompt is built from. The catalogue ships two driver flavours:
 *
 *   - `awb-mcp` (scenarios 1–12) — the QA agent drives AWB's own MCP/REST surface
 *     (see docs/qa-driver-guide.md §6 "http-api driver") and records evidence with
 *     save_resource + record_qa_step. The step `mcp_tool` values are real AWB MCP
 *     tool names so the agent can execute them verbatim; `params` use `{{placeholder}}`
 *     tokens the agent fills from the run context. Evidence is tool-result JSON
 *     (type=document) — backend validation, no pixels.
 *
 *   - `browser` (scenarios 13+) — the QA agent drives the real AWB **client UI** with
 *     a headless-Chrome driver (CDP; see docs/qa-driver-guide.md §4 "Browser driver"
 *     and the reference helper apps/server/scripts/qa-visual-capture.mjs). Evidence is
 *     actual **screenshots (image/png) and a journey video (video/mp4)** so the QA
 *     detail Gallery/Lightbox/inline-video viewer has real pixels to show. The
 *     `mcp_tool` values are browser-driver verbs (browser_navigate / browser_screenshot
 *     / browser_start_video / browser_stop_video) — NOT AWB MCP tools.
 *
 * Mimetype matters: the /api/resources/:id/raw endpoint streams Content-Type from the
 * Resource's file_mimetype, and the viewer's MediaThumb renders <img> first then falls
 * back to <video> on load error — so a video with an empty/wrong mimetype won't decode.
 * The browser scenarios therefore record image/png for screenshots and video/mp4 for
 * the journey clip explicitly.
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

/** The visual driver: a headless-Chrome (CDP) browser driver over AWB's client UI. */
const BROWSER_DRIVER = 'browser';

/**
 * Browser-driver config. Captures real AWB client screens with headless Chrome.
 * `start_url` is env-specific (placeholder). `auth` documents how the driver gets a
 * session before navigating to authenticated routes — the reference helper logs in via
 * POST /api/auth/login and injects the returned token into localStorage (`auth_token`
 * + `currentWorkspaceId`) so the SPA boots authenticated. Routes use `{{placeholder}}`
 * tokens the agent fills from the run context. See apps/server/scripts/qa-visual-capture.mjs.
 */
function browserDriverConfig(extra: Record<string, any> = {}): Record<string, any> {
  return {
    transport: 'chrome-cdp-headless',
    start_url: '{{awb_base_url}}',
    viewport: { width: 1440, height: 900 },
    record_video: false,
    auth: {
      method: 'token-inject',
      login_endpoint: '/api/auth/login',
      local_storage_keys: ['auth_token', 'currentWorkspaceId'],
    },
    capture_helper: 'apps/server/scripts/qa-visual-capture.mjs',
    mimetypes: { screenshot: 'image/png', video: 'video/mp4' },
    note: 'Drive the AWB client UI with headless Chrome (browser driver contract, '
      + 'docs/qa-driver-guide.md §4). Save each screenshot as a Resource (type=image, '
      + 'file_mimetype=image/png) and the journey clip as (type=image, file_mimetype=video/mp4 — '
      + 'there is no `video` Resource enum; the viewer keys off mimetype, not type). Attach each '
      + 'artifact via record_qa_step (PER-STEP): the QA RunDetail viewer only renders per-step '
      + 'galleries, so a run-level attach_qa_artifact shows as a count but NOT as a thumbnail — '
      + 'the video must be a step artifact to render its inline-video tile.',
    ...extra,
  };
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
      // author_role is passed explicitly here. The awb-mcp QA driver runs as a
      // CHAT subagent (no X-AWB-Subagent-Role pin) and the probe ticket's author
      // (the driver agent) ends up holding 2 roles — assignee (set in step 0) and
      // reporter (create_ticket auto-fills reporter→caller). With 2+ roles and no
      // pin, add_comment.resolveAuthorRole intentionally OMITS author_role to avoid
      // misattributing the comment to a role the agent isn't acting as. That guard
      // is correct product behaviour; the scenario must therefore exercise the
      // explicit-override path (resolution order #1) to assert role attribution.
      step(1, 'Add a plain note comment as the assignee', 'Assignee (In Progress role holder) receives a comment trigger', 'add_comment', { ticket_id: '{{ticket_id}}', content: 'QA: plain note — should wake assignee', type: 'note', author_role: 'assignee' }),
      step(2, 'Add a comment with a structured reviewer mention, authored as the assignee', 'comment_mention notification is scoped to the reviewer only', 'add_comment', { ticket_id: '{{ticket_id}}', content: 'QA: @[role:reviewer|Reviewer] please look', type: 'note', author_role: 'assignee' }),
      step(3, 'Reload the ticket thread', "Both comments present with metadata.author_role == 'assignee' (explicit override recorded)", 'get_ticket', { ticket_id: '{{ticket_id}}' }),
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
      + 'dispatch. The probe is assigned to a freshly-created INERT sink agent (created in step 0, no '
      + 'manager attached) — NOT the QA driver agent itself. Two trigger-loop guards sit BEFORE the '
      + 'pause gate and would otherwise confound the differential: (1) the self-trigger guard skips a '
      + 'comment trigger when commenter == assignee, and the QA driver IS the scenario target agent, so '
      + 'a self-assigned probe never emits a comment trigger regardless of pause; (2) a routed-column '
      + 'self-assignee probe gets create-dispatched, claimed and pended, which independently suppresses '
      + 'later comment triggers. A fresh inert sink dodges both: the comment targets a non-self holder '
      + '(self-guard passes) and nothing consumes the emit (no claim/pend), and because the sink owns '
      + 'exactly one ticket the focus selector always picks the probe. Pause is engaged BEFORE the probe '
      + 'is created so create-dispatch is gated too. Asserted via ActivityLog: '
      + 'agent_trigger_dropped_board_paused while paused vs trigger_emitted (trigger_source=comment) '
      + 'after resume. Mirrors board-pause.test.mjs.',
    qa_driver: AWB_MCP_DRIVER,
    qa_driver_config: driverConfig(),
    tags: ['boards', 'pause', 'triggers'],
    steps: [
      step(0, 'Create a fresh INERT sink agent (no manager → its triggers emit as ActivityLog rows but are never consumed by a subagent) and capture its id as {{sink_agent_id}}', 'Agent created; its id is used as the probe assignee so the comment trigger targets a non-self holder (clears the self-trigger guard) and nothing claims/pends the probe', 'create_agent', { name: 'QA pause sink (inert)', type: 'custom', description: 'Throwaway inert assignee for the board pause/resume QA probe. No manager attached, so emitted triggers leave an ActivityLog row but spawn no subagent.' }),
      step(1, 'Pause the board', 'update_board sets paused_at; re-read with get_board and confirm paused_at != null', 'update_board', { board_id: '{{board_id}}', paused: true }),
      step(2, 'Create the probe ticket in In Progress assigned to the inert sink, and capture its id as {{ticket_id}}', 'Ticket exists in In Progress assigned to {{sink_agent_id}}; because the board is paused, create-dispatch is gated so NO trigger_emitted appears for this ticket', 'create_ticket', { workspace_id: '{{workspace_id}}', column_id: '{{in_progress_column_id}}', title: 'QA pause probe', assignee_id: '{{sink_agent_id}}' }),
      step(3, 'Post a comment while paused', 'Gate drops it: NO trigger_emitted for the probe; an agent_trigger_dropped_board_paused ActivityLog row is written instead (commenter != assignee, so only the pause gate suppresses the trigger)', 'add_comment', { ticket_id: '{{ticket_id}}', content: 'QA: comment while paused', type: 'note' }),
      step(4, 'Resume the board', 'update_board clears paused_at; re-read with get_board and confirm paused_at == null', 'update_board', { board_id: '{{board_id}}', paused: false }),
      step(5, 'Post another comment after resume', 'Assignee (the inert sink) now receives a comment trigger: a trigger_emitted ActivityLog row with trigger_source=comment is written for the probe', 'add_comment', { ticket_id: '{{ticket_id}}', content: 'QA: comment after resume', type: 'note' }),
      step(6, 'Inspect recent activity', 'Differential holds for the probe ticket: a comment-sourced trigger_emitted row exists AFTER resume but NONE while paused; the while-paused comment produced an agent_trigger_dropped_board_paused row', 'get_recent_activity', { limit: 200 }),
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
      + 'auto-advance-halt-unassigned.test.mjs.\n\n'
      + 'GOTCHA — the orphan case needs a TRUE zero-holder ticket. create_ticket auto-defaults the '
      + 'reporter to the calling agent (commit 29f7df8), so a freshly-created ticket is NOT an orphan: '
      + 'it carries a reporter holder and TriggerLoopService._ticketHasAnyHolder counts the reporter, '
      + 'so the ticket takes the staffed (reporter-only) cascade path instead of halting. Step 3 below '
      + 'strips that auto-filled reporter so step 4 actually exercises the halt-unassigned guard.',
    qa_driver: AWB_MCP_DRIVER,
    qa_driver_config: driverConfig(),
    tags: ['columns', 'column-policies', 'routing', 'auto-advance'],
    steps: [
      step(0, 'Create a board whose Plan column routes to "planner"', 'Board + columns created', 'create_board', { workspace_id: '{{workspace_id}}', name: 'QA policy probe' }),
      step(1, 'Set Plan column role_routing to a role no agent holds', 'update_column persists role_routing=["planner"]', 'update_column', { column_id: '{{plan_column_id}}', role_routing: ['planner'] }),
      step(2, 'Move a ticket WITH an assignee (but no planner) onto Plan', 'Ticket auto-advances past the unservable Plan column to In Progress; assignee woken', 'move_ticket', { ticket_id: '{{staffed_ticket_id}}', target_column_name: 'Plan', board_id: '{{policy_board_id}}' }),
      step(3, 'Strip the auto-filled reporter off the orphan ticket so it has ZERO role holders (create_ticket auto-defaults reporter→caller, so a fresh ticket is NOT a true orphan)', 'Reporter slot cleared via role_assignments — the ticket now holds no agent/user on any role (assignee/reporter/reviewer all empty)', 'update_ticket', { ticket_id: '{{orphan_ticket_id}}', role_assignments: [{ role_slug: 'reporter', agent_id: '' }] }),
      step(4, 'Move the now truly-unassigned ticket onto Plan', 'Ticket HALTS in place on Plan with an auto_advance_halted_unassigned activity marker (no auto-advance, no silent skip to Done)', 'move_ticket', { ticket_id: '{{orphan_ticket_id}}', target_column_name: 'Plan', board_id: '{{policy_board_id}}' }),
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

  // 13 ───────────────────────────────────────────────────────────────────────
  {
    key: 'visual-core-screens',
    name: 'Visual — core UI screens (login → board → ticket → chat → QA → resources)',
    description:
      'Drive the real AWB client UI with a headless-Chrome (browser) driver and capture a '
      + 'screenshot of each core screen as image/png evidence: the login page, the board view, '
      + 'a ticket detail panel with comments, a chat room, the board QA manager (table view), the '
      + 'Resources page, and the board sub-menu. Unlike the awb-mcp scenarios this leaves real '
      + 'pixels in the QA detail Gallery/Lightbox. Capture recipe: apps/server/scripts/qa-visual-capture.mjs.',
    qa_driver: BROWSER_DRIVER,
    qa_driver_config: browserDriverConfig(),
    tags: ['visual', 'ui', 'screenshots', 'gallery'],
    steps: [
      step(0, 'Navigate to the AWB login page and screenshot it', 'Login card ("Welcome Back" / email + password) renders; save as image/png', 'browser_screenshot', { route: '{{awb_base_url}}/', name: 'login.png', mimetype: 'image/png' }),
      step(1, 'Log in, then screenshot the board (kanban columns + ticket cards)', 'Board view shows columns (Backlog…Done) and ticket cards', 'browser_screenshot', { route: '{{awb_base_url}}/ws/{{workspace_id}}/boards/{{board_id}}', name: 'board.png', mimetype: 'image/png' }),
      step(2, 'Open a ticket detail panel (deep-link ?ticket=) and screenshot it', 'Ticket panel shows title, description, and comment thread', 'browser_screenshot', { route: '{{awb_base_url}}/ws/{{workspace_id}}/boards/{{board_id}}?ticket={{ticket_id}}', name: 'ticket-detail.png', mimetype: 'image/png' }),
      step(3, 'Open the chat room view and screenshot it', 'Chat room list + message thread render', 'browser_screenshot', { route: '{{awb_base_url}}/ws/{{workspace_id}}/chat', name: 'chat.png', mimetype: 'image/png' }),
      step(4, 'Open the board QA manager (scenario table) and screenshot it', 'QA scenario table shows scenarios with last-run / pass-rate columns', 'browser_screenshot', { route: '{{awb_base_url}}/ws/{{workspace_id}}/boards/{{board_id}}/qa', name: 'qa-manager.png', mimetype: 'image/png' }),
      step(5, 'Open the Resources page and screenshot it', 'Resources grid renders (media + documents)', 'browser_screenshot', { route: '{{awb_base_url}}/ws/{{workspace_id}}/resources', name: 'resources.png', mimetype: 'image/png' }),
      step(6, 'Open the board sub-menu (resources/actions/qa/settings/archive) and screenshot it', 'Board sub-menu navigation is visible', 'browser_screenshot', { route: '{{awb_base_url}}/ws/{{workspace_id}}/boards/{{board_id}}/settings', name: 'board-submenu.png', mimetype: 'image/png' }),
    ],
  },

  // 14 ───────────────────────────────────────────────────────────────────────
  {
    key: 'visual-ticket-journey-video',
    name: 'Visual — ticket journey screen recording (video evidence)',
    description:
      'Record one continuous journey through the AWB client UI as an mp4 (login → board → open a '
      + 'ticket → scroll its comments → QA manager) so the QA detail inline-video player and Lightbox '
      + 'have a real video/mp4 artifact to play. Validates the /api/resources/:id/raw Range-streaming '
      + 'path end-to-end. Capture recipe: apps/server/scripts/qa-visual-capture.mjs --record-video.',
    qa_driver: BROWSER_DRIVER,
    qa_driver_config: browserDriverConfig({ record_video: true }),
    tags: ['visual', 'ui', 'video', 'screencast'],
    steps: [
      step(0, 'Launch headless Chrome and start screencast recording', 'CDP screencast started; frames accumulating', 'browser_start_video', { fps: 8 }),
      step(1, 'Log in and land on the board view', 'Board renders within the recording', 'browser_navigate', { route: '{{awb_base_url}}/ws/{{workspace_id}}/boards/{{board_id}}' }),
      step(2, 'Open a ticket and scroll through its comments', 'Ticket panel + comment thread captured in the recording', 'browser_navigate', { route: '{{awb_base_url}}/ws/{{workspace_id}}/boards/{{board_id}}?ticket={{ticket_id}}' }),
      step(3, 'Visit the board QA manager', 'QA table captured in the recording', 'browser_navigate', { route: '{{awb_base_url}}/ws/{{workspace_id}}/boards/{{board_id}}/qa' }),
      step(4, 'Stop recording, encode mp4, and record it as THIS step\'s artifact', 'Journey saved as a Resource (file_mimetype=video/mp4) and recorded via record_qa_step on this step so the inline-video tile renders (per-step, not run-level)', 'browser_stop_video', { name: 'ticket-journey.mp4', mimetype: 'video/mp4', record_on_step: 4 }),
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
  /**
   * On-failure auto-ticket policy stamped onto every seeded scenario. Default
   * = the suite default (DEFAULT_SEED_ON_FAILURE_TICKET below): enabled, high
   * priority, per_open_ticket dedupe so a recurring failure appends a
   * recurrence comment rather than flooding a new ticket each run. Pass `null`
   * to seed with the side-effect OFF.
   */
  on_failure_ticket?: QaOnFailureTicketConfig | null;
}

/**
 * Default on-failure policy for seeded scenarios (ticket 52a93654). The seed
 * suite re-runs the same scenarios repeatedly, so `per_open_ticket` is the
 * right dedupe: the first failure files a fix ticket; subsequent failures of
 * the same scenario append a recurrence comment to that still-open ticket
 * instead of spawning a fresh one. board/column/assignee are left unset so they
 * fall back to run.board_id → scenario.board_id and the scenario's target agent.
 *
 * QA→fix→QA closed loop (ticket 467dbc7a): `rerun_on_fix` is ON so a seeded
 * scenario's fix ticket reaching Done deterministically re-runs the scenario,
 * capped at `max_rerun_attempts` reruns before it halts for human review.
 * `rerun_delay_seconds` is a deploy-lag buffer — ⚠️ the seed scenarios hit the
 * RUNNING server, which auto-deploys main→production.private only AFTER the fix
 * merges, so an immediate (0s) rerun can validate the pre-fix code. This is a
 * real, repeated failure mode: e.g. the board-pause scenario filed a fix ticket
 * whose rerun fired the instant the fix merged but seconds before the deploy
 * propagated, re-failing against the pre-fix build (a false negative). We default
 * to a non-zero buffer so the common case (deploy lands within a few minutes)
 * heals on its own; operators with a slower pipeline should raise it further to
 * their typical deploy lag (re-seed to apply). Note the timer is best-effort and
 * in-process (setTimeout), so a server restart cancels a pending rerun — keep
 * the buffer modest. See docs/qa-rerun-on-fix.md.
 */
export const DEFAULT_SEED_ON_FAILURE_TICKET: QaOnFailureTicketConfig = {
  enabled: true,
  priority: 'high',
  dedupe: 'per_open_ticket',
  labels: ['qa-failure', 'auto'],
  rerun_on_fix: true,
  max_rerun_attempts: 3,
  // 10-minute deploy-lag buffer (was 0). Covers the common main→prod auto-deploy
  // window so a fix-ticket→Done rerun validates the deployed build, not the
  // pre-fix one. See the deploy-lag note above.
  rerun_delay_seconds: 600,
};

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
  // `undefined` (key not passed) → suite default; explicit `null` → OFF.
  const onFailureTicket = opts.on_failure_ticket === undefined
    ? DEFAULT_SEED_ON_FAILURE_TICKET
    : opts.on_failure_ticket;
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
    on_failure_ticket: onFailureTicket,
    created_by: opts.created_by ?? '',
    max_runs: 20,
  }));
}
