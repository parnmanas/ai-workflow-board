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
 *   - `awb-mcp` — the QA agent drives AWB's own MCP/REST surface
 *     (see docs/qa-driver-guide.md §6 "http-api driver") and records evidence with
 *     save_resource + record_qa_step. The step `mcp_tool` values are real AWB MCP
 *     tool names so the agent can execute them verbatim; `params` use `{{placeholder}}`
 *     tokens the agent fills from the run context. Evidence is tool-result JSON
 *     (type=document) — backend validation, no pixels.
 *
 *   - `browser` — the QA agent drives the real AWB **client UI** with
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
 *
 * Scenarios whose premise went away with boards (board pause, board move,
 * column role routing / auto-advance, backlog promotion, role mentions,
 * benchmarks, the board-scoped dispatch-liveness probe) were dropped from the
 * catalogue; already-seeded rows of them stay in their workspace until an
 * operator deletes them (re-seeding never deletes).
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
 * + `currentAccountId`) so the SPA boots authenticated. Routes use `{{placeholder}}`
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
      local_storage_keys: ['auth_token', 'currentAccountId'],
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
  // 1 ─────────────────────────────────────────────────────────────────────────
  {
    key: 'ticket-lifecycle',
    name: 'Ticket lifecycle — create → status lanes → done',
    description:
      'Walk a root ticket through the fixed status lanes (To Do → In Progress → Review → Done) and '
      + 'assert the terminal stamp: terminal_entered_at is set on entering `done` and cleared when the '
      + 'ticket leaves it. The probe has NO assignee so the dispatcher never sends it to an agent '
      + '(docs/tickets.md → Status). Mirrors test/qa-flows/ticket-lifecycle.test.mjs.',
    qa_driver: AWB_MCP_DRIVER,
    qa_driver_config: driverConfig(),
    tags: ['lifecycle', 'tickets', 'status'],
    steps: [
      step(0, 'Create an unassigned root ticket in To Do', 'Ticket created with status=todo, assignee=null, terminal_entered_at=null', 'create_ticket', { account_id: '{{account_id}}', status: 'todo', title: 'QA lifecycle probe' }),
      step(1, 'Read the ticket back', 'status == todo; tags/project_id echo what was sent', 'get_ticket', { ticket_id: '{{ticket_id}}' }),
      step(2, 'Move the ticket to In Progress', 'Move succeeds; status == in_progress (no agent_trigger — there is no assignee)', 'move_ticket', { ticket_id: '{{ticket_id}}', status: 'in_progress' }),
      step(3, 'Move the ticket to Review', 'status == review', 'move_ticket', { ticket_id: '{{ticket_id}}', status: 'review' }),
      step(4, 'Move the ticket to Done', 'status == done and terminal_entered_at stamped', 'move_ticket', { ticket_id: '{{ticket_id}}', status: 'done' }),
      step(5, 'Reopen it (back to To Do)', 'status == todo and terminal_entered_at cleared', 'move_ticket', { ticket_id: '{{ticket_id}}', status: 'todo' }),
      step(6, 'Archive the probe', 'archived_at stamped — the probe leaves the live pool', 'archive_ticket', { ticket_id: '{{ticket_id}}' }),
    ],
  },

  // 2 ─────────────────────────────────────────────────────────────────────────
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
      step(0, 'Create a group chat room', 'Room created with the caller as participant', 'create_chat_room', { account_id: '{{account_id}}', type: 'group', name: 'QA chat probe' }),
      step(1, 'Add a second participant', 'Participant added; non-members must NOT receive room SSE', 'add_chat_participants', { room_id: '{{room_id}}', participants: [{ participant_type: 'agent', participant_id: '{{assignee_agent_id}}' }] }),
      step(2, 'Send a handful of messages so history is pageable', 'Each send returns a message id; last_message_at advances', 'send_chat_room_message', { room_id: '{{room_id}}', content: 'QA message {{n}}' }),
      step(3, 'Upload an evidence Resource then attach it to a message', 'Attachment owner transitions to chat_message; appears in history projection', 'add_chat_message_attachment', { room_id: '{{room_id}}', resource_id: '{{attachment_resource_id}}' }),
      step(4, 'Page the newest N messages then fetch older with a before-cursor', 'Pagination returns disjoint pages in order (dynamic loading)', 'get_chat_room_messages', { room_id: '{{room_id}}', limit: 3, before: '{{cursor}}' }),
      step(5, 'Search the room for a keyword', 'Search returns only matching messages within the room scope', 'search_chat_messages', { account_id: '{{account_id}}', query: 'QA message' }),
    ],
  },

  // 3 ─────────────────────────────────────────────────────────────────────────
  {
    key: 'mcp-agent-roundtrip',
    name: 'MCP agent roundtrip (SSE in → tool call out)',
    description:
      'The closed-loop promise: a ticket queued in To Do for a live assignee is started by the '
      + 'dispatcher (todo → in_progress + agent_trigger), and the agent reacts by calling MCP tools to '
      + 'advance it. Assert the agent\'s add_comment + move_ticket landed. Mirrors '
      + 'mcp-agent-roundtrip.test.mjs.',
    qa_driver: AWB_MCP_DRIVER,
    qa_driver_config: driverConfig({ requires_live_agent: true }),
    tags: ['mcp', 'sse', 'agent', 'roundtrip'],
    steps: [
      step(0, 'Subscribe to events so the trigger and the agent reaction are observable', 'SSE stream open', 'subscribe_events', { account_id: '{{account_id}}' }),
      step(1, 'Create a ticket in To Do assigned to a live agent runtime', 'Ticket exists with assignee set; the assignee is online', 'create_ticket', { account_id: '{{account_id}}', status: 'todo', title: 'QA roundtrip probe', prompt_text: 'Leave a short note, then move me to review.', assignee: '{{assignee_runtime}}' }),
      step(2, 'Confirm the dispatcher started it', 'Within a few seconds status == in_progress and an agent_trigger was delivered to the assignee', 'get_ticket', { ticket_id: '{{ticket_id}}' }),
      step(3, 'Wait for the agent to react via MCP', 'A new comment from the agent appears AND status == review (SSE→MCP loop closed)', 'get_ticket', { ticket_id: '{{ticket_id}}' }),
    ],
  },

  // 4 ─────────────────────────────────────────────────────────────────────────
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
      step(0, 'Create an Action targeting the QA agent', 'Action persisted, enabled', 'save_action', { account_id: '{{account_id}}', name: 'QA probe action', target_agent_id: '{{assignee_agent_id}}', prompt: 'QA: respond with OK.' }),
      step(1, 'Read it back', 'get_action returns the saved definition', 'get_action', { action_id: '{{action_id}}' }),
      step(2, 'Run the action', 'run_action returns a run_id + room_id; first message posted to the room', 'run_action', { action_id: '{{action_id}}' }),
      step(3, 'List run history', 'The new run is present, newest first, capped at max_runs', 'list_action_runs', { action_id: '{{action_id}}', account_id: '{{account_id}}' }),
    ],
  },

  // 5 ─────────────────────────────────────────────────────────────────────────
  {
    key: 'archive-unarchive',
    name: 'Archive / unarchive ticket',
    description:
      'Archiving a ticket removes it from the workspace ticket list; unarchiving restores it. '
      + 'Mirrors archive-edge-paths.test.mjs.',
    qa_driver: AWB_MCP_DRIVER,
    qa_driver_config: driverConfig(),
    tags: ['archive', 'tickets'],
    steps: [
      step(0, 'Create a ticket to archive', 'Ticket exists', 'create_ticket', { account_id: '{{account_id}}', status: 'todo', title: 'QA archive probe' }),
      step(1, 'Archive it', 'archived_at stamped', 'archive_ticket', { ticket_id: '{{ticket_id}}' }),
      step(2, 'List archived tickets', 'Ticket appears in the archived list', 'list_archived_tickets', { account_id: '{{account_id}}' }),
      step(3, 'Confirm it is excluded from the live ticket list', 'list_tickets (archived excluded by default) no longer returns it', 'list_tickets', { account_id: '{{account_id}}', query: 'QA archive probe' }),
      step(4, 'Unarchive it', 'archived_at cleared; ticket back in the pool', 'unarchive_ticket', { ticket_id: '{{ticket_id}}' }),
      step(5, 'Confirm restoration', 'get_ticket shows the ticket live again', 'get_ticket', { ticket_id: '{{ticket_id}}' }),
    ],
  },

  // 6 ─────────────────────────────────────────────────────────────────────────
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
      step(0, 'Save a comment_attachment Resource in the workspace', 'Resource created with type=comment_attachment', 'save_resource', { account_id: '{{account_id}}', type: 'comment_attachment', name: 'qa-evidence.txt' }),
      step(1, 'Read the resource back', 'get_resource returns metadata (id, mimetype, size)', 'get_resource', { resource_id: '{{resource_id}}' }),
      step(2, 'Attach it to a comment', 'add_comment with attachment_resource_ids succeeds', 'add_comment', { ticket_id: '{{ticket_id}}', content: 'QA: evidence attached', attachment_resource_ids: ['{{resource_id}}'] }),
      step(3, 'Reload the ticket', 'get_ticket shows the comment with its attachment hydrated', 'get_ticket', { ticket_id: '{{ticket_id}}' }),
    ],
  },

  // 7 ─────────────────────────────────────────────────────────────────────────
  {
    key: 'visual-core-screens',
    name: 'Visual — core UI screens (login → tickets → ticket → chat → QA → resources → projects)',
    description:
      'Drive the real AWB client UI with a headless-Chrome (browser) driver and capture a '
      + 'screenshot of each core screen as image/png evidence: the login page, the ticket pool, '
      + 'a ticket detail panel with comments, a chat room, the QA manager (table view), the '
      + 'Account resource menus and the projects page. Unlike the awb-mcp scenarios this leaves real '
      + 'pixels in the QA detail Gallery/Lightbox. Capture recipe: apps/server/scripts/qa-visual-capture.mjs.',
    qa_driver: BROWSER_DRIVER,
    qa_driver_config: browserDriverConfig(),
    tags: ['visual', 'ui', 'screenshots', 'gallery'],
    steps: [
      step(0, 'Navigate to the AWB login page and screenshot it', 'Login card ("Welcome Back" / email + password) renders; save as image/png', 'browser_screenshot', { route: '{{awb_base_url}}/', name: 'login.png', mimetype: 'image/png' }),
      step(1, 'Log in, then screenshot the ticket pool (status lanes + ticket cards)', 'Tickets page shows the status lanes (Backlog…Done) and ticket cards', 'browser_screenshot', { route: '{{awb_base_url}}/tickets', name: 'tickets.png', mimetype: 'image/png' }),
      step(2, 'Open a ticket detail panel (deep-link ?ticket=) and screenshot it', 'Ticket panel shows title, description, and comment thread', 'browser_screenshot', { route: '{{awb_base_url}}/tickets?ticket={{ticket_id}}', name: 'ticket-detail.png', mimetype: 'image/png' }),
      step(3, 'Open the chat room view and screenshot it', 'Chat room list + message thread render', 'browser_screenshot', { route: '{{awb_base_url}}/chat', name: 'chat.png', mimetype: 'image/png' }),
      step(4, 'Open the Account QA page and screenshot it', 'QA scenario table shows Account and Global scenarios with last-run / pass-rate columns', 'browser_screenshot', { route: '{{awb_base_url}}/qa', name: 'qa-manager.png', mimetype: 'image/png' }),
      step(5, 'Open the Account Resources page and screenshot it', 'Resources grid renders Global and Account entries together', 'browser_screenshot', { route: '{{awb_base_url}}/resources', name: 'resources.png', mimetype: 'image/png' }),
      step(6, 'Open the Projects page and screenshot it', 'Project list renders with each project\'s repository and per-host folders', 'browser_screenshot', { route: '{{awb_base_url}}/projects', name: 'projects.png', mimetype: 'image/png' }),
    ],
  },

  // 8 ─────────────────────────────────────────────────────────────────────────
  {
    key: 'visual-ticket-journey-video',
    name: 'Visual — ticket journey screen recording (video evidence)',
    description:
      'Record one continuous journey through the AWB client UI as an mp4 (login → tickets → open a '
      + 'ticket → scroll its comments → QA manager) so the QA detail inline-video player and Lightbox '
      + 'have a real video/mp4 artifact to play. Validates the /api/resources/:id/raw Range-streaming '
      + 'path end-to-end. Capture recipe: apps/server/scripts/qa-visual-capture.mjs --record-video.',
    qa_driver: BROWSER_DRIVER,
    qa_driver_config: browserDriverConfig({ record_video: true }),
    tags: ['visual', 'ui', 'video', 'screencast'],
    steps: [
      step(0, 'Launch headless Chrome and start screencast recording', 'CDP screencast started; frames accumulating', 'browser_start_video', { fps: 8 }),
      step(1, 'Log in and land on the tickets page', 'Ticket pool renders within the recording', 'browser_navigate', { route: '{{awb_base_url}}/tickets' }),
      step(2, 'Open a ticket and scroll through its comments', 'Ticket panel + comment thread captured in the recording', 'browser_navigate', { route: '{{awb_base_url}}/tickets?ticket={{ticket_id}}' }),
      step(3, 'Visit the Account QA page', 'QA table captured in the recording', 'browser_navigate', { route: '{{awb_base_url}}/qa' }),
      step(4, 'Stop recording, encode mp4, and record it as THIS step\'s artifact', 'Journey saved as a Resource (file_mimetype=video/mp4) and recorded via record_qa_step on this step so the inline-video tile renders (per-step, not run-level)', 'browser_stop_video', { name: 'ticket-journey.mp4', mimetype: 'video/mp4', record_on_step: 4 }),
    ],
  },

  // 9 ─────────────────────────────────────────────────────────────────────────
  {
    key: 'hermes-live-chat-delivery',
    name: 'Hermes live chat delivery — real deployed-host smoke test',
    description:
      'Send ONE chat message to the live, deployed Hermes-type Agent and observe how the reply actually '
      + 'lands, instead of trusting a verbal "it works" after deploy. Source: ticket a837879c hardened the '
      + 'Hermes reply path (Manager-owned reply POST, hermes_empty_reply / hermes_reply_post_failed '
      + 'fail-closed, an error-code allowlist so failure notices never leak raw exception text, and '
      + 'error-log-uploader classify() tagging failures level=error/category=hermes) — this scenario is the '
      + 'reproducible, re-runnable proof that behavior holds against the REAL host, not just the '
      + 'fake-ACP-fixture unit tests (apps/agent-manager/test/hermes-chat-dispatch-success.test.mjs / '
      + '-failure.test.mjs).\n\n'
      + 'This is a live external system, not a mock: the QA agent cannot force which branch happens (a '
      + 'genuine reply vs. a fail-closed notice) — it can only observe and grade whichever branch the real '
      + 'Hermes run produced. Steps 3-5 branch accordingly: exactly one of "genuine reply" or "failure '
      + 'notice" must be observed (passed either way — both are contractually valid outcomes), while total '
      + 'silence past the timeout is a real failure. The allowlist / Agent-Logs assertions (steps 4-5) only '
      + 'apply — and are recorded `skipped` otherwise — when the observed branch is a failure notice, since '
      + 'there is nothing to check on a clean reply.\n\n'
      + 'PRECONDITION the scenario cannot control: the target Hermes Agent (type=hermes) and its owning '
      + 'Runtime Host manager instance must both be online (list_agents / GET '
      + '/api/admin/agent-manager/instances). If none is online, fail step 0 immediately with that reason '
      + 'rather than waiting out the timeout — an offline host is an operational precondition gap, not a '
      + 'dispatch-path regression.',
    qa_driver: AWB_MCP_DRIVER,
    qa_driver_config: driverConfig({ requires_live_agent: true }),
    tags: ['hermes', 'e2e', 'chat', 'live-host', 'self-improvement'],
    steps: [
      step(0, 'Resolve the target Hermes Agent: list_agents, filter type==\'hermes\', and require is_online==1 (its manager_agent_id\'s Runtime Host row must also show is_online==1). Capture its id as {{hermes_agent_id}} AND separately capture its owning Runtime Host (manager) agent id — the row referenced by manager_agent_id — as {{hermes_host_agent_id}}. These are two DIFFERENT agents: error-log-uploader.ts uploads under the Runtime Host\'s own identity, not the managed Hermes Agent\'s (see step 5). If none is online, record THIS step failed with that reason and stop the run — do not wait out the timeout for an offline host.', 'Exactly one online hermes-type Agent resolved with its owning Runtime Host id also captured (or a clear, immediate failure naming the offline precondition)', 'list_agents', {}),
      step(1, 'Create (or reuse) a DM room with the resolved Hermes Agent and capture {{room_id}}; generate a short random nonce now and reuse it as {{probe_nonce}} in later steps', 'create_chat_room returns a 2-participant (caller + Hermes) room', 'create_chat_room', { participants: [{ type: 'agent', id: '{{hermes_agent_id}}' }] }),
      step(2, 'Send exactly ONE message into the room asking for a short acknowledgement, embedding {{probe_nonce}} so the reply is unambiguous', 'send_chat_room_message returns a message id', 'send_chat_room_message', { room_id: '{{room_id}}', content: 'QA Hermes live-delivery probe ({{probe_nonce}}) — please reply with any short acknowledgement.' }),
      step(3, 'Poll get_chat_room_messages (e.g. every ~15s up to ~5 minutes) until a NEW message from sender_type==\'agent\' AND sender_id=={{hermes_agent_id}} appears', 'Exactly one of two contractually-valid outcomes is observed within the timeout: (A) a genuine reply — non-empty, does NOT start with the "⚠️ **Hermes 런타임 실행 실패**" prefix; or (B) a fail-closed notice — starts with that exact prefix. Total silence past the timeout is a real failure (not a valid third outcome)', 'get_chat_room_messages', { room_id: '{{room_id}}' }),
      step(4, 'IF branch (B) was observed: extract the backtick-quoted code from the notice and confirm it is one of the allowlisted codes (runtime_supervisor_unavailable, runtime_not_configured, runtime_unknown, runtime_unavailable, runtime_config_invalid, runtime_not_supported, runtime_collaboration_denied, hermes_session_not_found, hermes_session_owner_mismatch, hermes_session_lease_mismatch, hermes_session_cwd_mismatch, acp_timeout, acp_aborted, acp_closed, acp_process_exited, acp_malformed_message, acp_message_too_large, acp_remote_error, acp_write_failed, max_tokens, max_turn_requests, refusal, cancelled, hermes_empty_reply, hermes_reply_post_failed) or the fallback literal runtime_dispatch_error, AND confirm the notice text contains no other raw exception/stack detail. IF branch (A) was observed instead, record this step `skipped` (nothing to check on a clean reply)', 'The exposed code is allowlisted (or the safe fallback) with zero raw internal detail leaked — matches apps/agent-manager/src/lib/event-dispatcher.ts #HERMES_CHAT_ERROR_CODES', 'get_chat_room_messages', { room_id: '{{room_id}}' }),
      step(5, 'IF branch (B) was observed: query GET /api/admin/agent-logs?level=error&category=hermes&agent_id={{hermes_host_agent_id}} (admin session; or GET /api/agent/error-logs with an agent key) and confirm a fresh row landed for this run — note error-log-uploader.ts uploads under the owning Runtime Host\'s OWN identity, not the managed Hermes Agent\'s ({{hermes_agent_id}} would filter to zero rows and false-fail this step even when the log landed correctly — see apps/agent-manager/src/lib/error-log-uploader.ts and apps/server/test/agent-error-logs-hermes.test.mjs), and that it uploads on its own periodic cycle, so allow a few minutes and retry rather than a single immediate check. IF branch (A) was observed instead, record this step `skipped`', 'A matching level=error/category=hermes row appears within a reasonable upload-cycle window, queried by {{hermes_host_agent_id}} (or the step is correctly skipped for a clean-reply run)', undefined, { level: 'error', category: 'hermes', agent_id: '{{hermes_host_agent_id}}' }),
    ],
  },
];

export interface BuildScenarioOptions {
  account_id: string;
  target_runtime: Record<string, any>;
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
 * instead of spawning a fresh one. project/assignee are left unset, so the fix
 * ticket lands in the run's workspace pool assigned to the scenario's
 * target_runtime.
 *
 * QA→fix→QA closed loop (ticket 467dbc7a): `rerun_on_fix` is ON so a seeded
 * scenario's fix ticket reaching Done deterministically re-runs the scenario,
 * capped at `max_rerun_attempts` reruns before it halts for human review.
 * `rerun_delay_seconds` 는 배포 지연 완충값이다 — ⚠️ 시드 시나리오는 **돌고 있는**
 * 서버를 치고, 그 서버는 배포 호스트가 `origin/main` 을 detached 로 다시 체크아웃해
 * 의존성 재설치·재빌드·재기동한 결과다. 수정을 main 에 머지해도 그 과정이 끝나기
 * 전에는 옛 코드가 서빙되므로, 즉시(0초) 재실행은 수정 전 코드를 검증할 수 있다.
 * This is a real, repeated failure mode: e.g. a seeded scenario filed a fix ticket
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
  tags: ['qa-failure', 'auto'],
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
 * Stamp the env-specific scope (workspace/agent) onto each template and
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
    account_id: opts.account_id,
    name: s.name,
    description: s.description,
    steps: s.steps,
    target_runtime: opts.target_runtime,
    qa_driver: s.qa_driver,
    qa_driver_config: s.qa_driver_config,
    enabled: true,
    tags: [keyTag(s.key), ...s.tags],
    on_failure_ticket: onFailureTicket,
    created_by: opts.created_by ?? '',
    max_runs: 20,
  }));
}
