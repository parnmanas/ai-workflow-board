/**
 * Central MCP tool authorization gate.
 *
 * Ticket 838f43c4 (follow-up to d6b56237) — d6b56237 fixed four specific
 * tool files (user/api-key/agent/workspace) after they shipped destructive,
 * privilege-changing operations with zero caller-identity checks. That was a
 * per-file fix; the structural hole stayed open: `registerAllTools`
 * (tools/index.ts) auto-discovers and registers every `*-tools.ts` file by
 * filename convention alone, so a FIFTH admin-grade tool file added tomorrow
 * would be exposed to every MCP session with no opt-in gate — exactly what
 * happened to the four files d6b56237 had to patch after the fact.
 *
 * This module wraps `McpServer.tool()` itself, at the one place both the
 * NestJS-integrated controller (mcp.controller.ts) and the standalone entry
 * point (mcp-server.ts) funnel through — `registerAllTools()`. Every tool
 * registration, from every tool file, passes through here before its own
 * handler ever runs:
 *
 *   - Tools explicitly listed in TOOL_AUTHZ_TABLE are checked against their
 *     assigned tier BEFORE the tool's own handler runs — redundant, on
 *     purpose. If a future edit ever drops the per-file check (the exact
 *     failure mode d6b56237 fixed), this still catches it.
 *   - Tools NOT in the table but named like a destructive operation
 *     (`delete_*` / `revoke_*`) fall back to a safe default tier — this
 *     remains 'caller' deliberately, see DEFAULT_DESTRUCTIVE_TIER below.
 *   - Every OTHER tool name is checked against KNOWN_EXISTING_TOOLS, a
 *     snapshot of every tool that existed when this gate was written. A name
 *     in the snapshot passes through untouched (today's ~163 non-tabled,
 *     non-destructive-looking tools keep their exact current behavior — this
 *     gate does not re-audit them, that stays out of this ticket's scope).
 *     A name NOT in the snapshot — i.e. a tool that did not exist yet — is
 *     UNCLASSIFIED_TIER ('deny'): rejected unconditionally, before the
 *     handler runs, independent of caller identity or scope.
 *
 *     This last branch is what review round 1 found missing entirely (the
 *     original version of this file only caught a future admin tool if its
 *     name happened to start with `delete_` / `revoke_` — anything else,
 *     e.g. `rotate_credential` / `grant_admin_role` / `set_user_role` /
 *     `purge_workspace_secrets`, fell through to `null` and ran completely
 *     ungated) and what review round 2 found still under-strict: the branch
 *     existed but resolved to the 'caller' tier, an identity floor rather
 *     than a deny — any session with a resolvable caller reached the
 *     handler regardless of scope ('read' was enough for an unclassified
 *     admin-grade tool). An allowlist gate has to default-deny an
 *     unclassified name outright, not merely require *some* caller. The
 *     snapshot inverts the default for anything outside today's known
 *     surface: an unrecognized name is now guilty (denied) until a
 *     maintainer consciously adds it to KNOWN_EXISTING_TOOLS (if it's safe)
 *     or TOOL_AUTHZ_TABLE (if it needs a specific tier), rather than
 *     innocent (ungated, or merely identity-gated) until someone happens to
 *     notice. The completeness guard in `test/mcp-tool-authz.test.mjs` fails
 *     the build the moment a real tool name drifts out of sync with this
 *     snapshot, so that decision can't be silently skipped — but the
 *     runtime default here is the actual security boundary; the test is a
 *     hygiene aid on top of it, not a substitute for it.
 *
 * Tier semantics reuse shared/authz.ts exactly so behavior never diverges
 * from what the per-file gates already enforce:
 *   - 'full'   → requireFullScopeCaller: DB-backed, full-scope, agent-bound.
 *                Only used where the tool's OWN logic already requires this
 *                unconditionally (verified directly against source, not
 *                inferred from tests — see the table comments below).
 *   - 'caller' → any resolvable MCP caller identity (getCallerAgent(extra)
 *                is non-null). The same minimal floor create_user /
 *                update_user already use — safe as a universal default
 *                because every legitimately authenticated session already
 *                has one by the time a tool handler runs; it only rejects
 *                sessionless / stale / malformed calls. DEFAULT_DESTRUCTIVE_TIER
 *                uses 'caller' rather than 'full' for the same reason the
 *                original delete_* / revoke_* fallback did: today's ~16
 *                uncovered delete_* tools run with zero caller check today,
 *                and defaulting them straight to full-scope-required would
 *                be a production-breaking behavior change out of this
 *                ticket's scope (see "범위가 아닌 것"). This does NOT apply to
 *                UNCLASSIFIED_TIER — a name that isn't even delete_ / revoke_
 *                shaped has no such existing-behavior constraint to preserve,
 *                so it denies outright instead of picking a floor.
 *   - 'deny'   → (UNCLASSIFIED_TIER) rejected unconditionally; caller/scope
 *                is never consulted. See the branch discussion above.
 *
 * Deliberately NOT tiered here (left to their existing per-file logic):
 * update_workspace (a workspace-bound non-full-scope caller is intentionally
 * allowed — see workspace-tools.ts's callerCanAccessWorkspace usage) and
 * move_agent_to_workspace (only gated when dry_run=false; a static per-name
 * tier can't express that without misgating the dry-run preview). Both are
 * existing, known tool names, so both resolve via the KNOWN_EXISTING_TOOLS
 * branch (null — unchanged) exactly like before this fix.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DataSource } from 'typeorm';
import { err } from './helpers';
import { getCallerAgent, type McpAgentContext } from './session-auth';
import { requireFullScopeCaller } from './authz';

export type AuthzTier = 'full' | 'caller';

/**
 * Tool name → required tier. Every entry has been verified against its own
 * handler source (not inferred from tests) to confirm the tier never
 * rejects a call the tool's existing logic would otherwise allow.
 */
export const TOOL_AUTHZ_TABLE: Record<string, AuthzTier> = {
  // Role/permission + credential-minting + cross-workspace-cascade tools —
  // d6b56237's originally-reported set. Every one of these unconditionally
  // calls requireFullScopeCaller (directly, or via
  // requireWorkspaceScopedFullAccess whose first step is
  // requireFullScopeCaller), so 'full' here never conflicts with existing
  // behavior.
  delete_user: 'full',
  create_agent: 'full',
  update_agent: 'full',
  delete_agent: 'full',
  delete_workspace: 'full',

  // Same file family, but their own logic deliberately allows a
  // non-full-scope caller through (e.g. a 'write'-scoped key minting a
  // 'read'-scoped key for itself) — the central gate only asserts SOME
  // resolvable caller, never anonymous/sessionless, and leaves the
  // scope-ceiling / workspace-match nuance to the handler that already
  // implements it.
  create_user: 'caller',
  update_user: 'caller',
  create_api_key: 'caller',
  update_api_key: 'caller',
  revoke_api_key: 'caller',
  delete_api_key: 'caller',

  // Orchestration discovery (ticket b7127aae). Unlike the nine pre-existing
  // orchestration tools (KNOWN_EXISTING_TOOLS below), these did not exist when
  // this gate's snapshot was taken, so they need a conscious tier — not
  // KNOWN_EXISTING_TOOLS, which is a frozen historical snapshot, never a home
  // for new registrations (see its docstring). 'caller' mirrors what each
  // handler already enforces on its own: list_orchestration_teams /
  // list_orchestration_missions filter strictly by the caller's own agent id
  // (orchestrator-of or member-of), so the tier only needs to reject an
  // unresolvable/sessionless caller — the real authorization is the identity
  // filter inside the handler, exactly like the nine tools below.
  list_orchestration_teams: 'caller',
  list_orchestration_missions: 'caller',
  create_orchestration_mission: 'caller',

  // ticket 6ff827cb: new tool, not in KNOWN_EXISTING_TOOLS. 'caller' mirrors
  // what the handler already enforces on its own: it resolves the caller's
  // own Agent row, requires it be an ACTIVE PARTICIPANT of the target room_id
  // (ChatRoomParticipant lookup — real ownership check, same posture as
  // add_chat_participants/send_chat_room_message below in KNOWN_EXISTING_TOOLS),
  // and routes the grant only to that same agent's own live manager instance —
  // there is no cross-agent/cross-resource surface here for a stricter tier
  // to protect, only a resolvable caller requirement.
  keep_chat_session_alive: 'caller',
};

/**
 * Tool names matching this pattern, when NOT already a key in
 * TOOL_AUTHZ_TABLE, fall back to DEFAULT_DESTRUCTIVE_TIER instead of
 * running completely ungated.
 */
const DESTRUCTIVE_NAME_PATTERN = /^(delete_|revoke_)/;

/**
 * Safe universal floor for a delete_* / revoke_* tool nobody has explicitly
 * classified yet. Deliberately 'caller', not 'full': today's ~16 delete_*
 * tools outside d6b56237's set (delete_board, delete_ticket, delete_action,
 * delete_qa_scenario, ...) run with ZERO caller check today — defaulting
 * them straight to full-scope-required would be a production-breaking
 * behavior change this ticket explicitly scopes out (see the ticket's
 * "범위가 아닌 것" section). 'caller' is non-breaking (every legitimately
 * authenticated session already has one) while still closing the
 * fully-anonymous / malformed-session gap for every destructive tool that
 * exists today, and forces a conscious tier choice for anything genuinely
 * new.
 */
const DEFAULT_DESTRUCTIVE_TIER: AuthzTier = 'caller';

/**
 * Every tool name registered anywhere under modules/mcp/tools/*-tools.ts as
 * of ticket 838f43c4 review round 2 (extracted mechanically via
 * `grep -rhA1 "server\.tool($" apps/server/src/modules/mcp/tools/*-tools.ts`,
 * 190 names). Includes the 11 TOOL_AUTHZ_TABLE names and the 21
 * delete_* / revoke_* names too — resolveAuthzTier checks those branches
 * first, so the overlap is harmless; keeping the snapshot as "every tool
 * that exists" (rather than "only the untabled, non-destructive-looking
 * remainder") is simpler to regenerate and impossible to under-count by
 * mis-subtracting the other branches by hand.
 *
 * A name in this set is pre-existing and out of this ticket's audit scope —
 * resolveAuthzTier returns null (untouched), exactly like before review
 * round 2. A name NOT in this set is either a typo or a tool that did not
 * exist when this snapshot was taken; either way it gets UNCLASSIFIED_TIER
 * ('deny', unconditional — not a caller/scope floor, see review round 3)
 * instead of a free pass. See the file-level comment above for why this
 * exists and `test/mcp-tool-authz.test.mjs`'s completeness guard for how
 * drift against the real tool surface is caught.
 */
export const KNOWN_EXISTING_TOOLS: ReadonlySet<string> = new Set([
  'add_board_lesson', 'add_chat_message_attachment', 'add_chat_participants',
  'add_comment', 'add_ticket_attachment', 'add_ticket_prerequisites',
  'answer_question', 'approve_feature', 'archive_ticket', 'ask_question',
  'assign_workspace_backend_profile', 'attach_qa_artifact', 'attach_security_artifact',
  'batch_operations', 'check_review_drift', 'claim_ticket', 'clear_current_task',
  'complete_action_run', 'complete_comment_summary', 'complete_qa_run', 'complete_security_run',
  'correct_confirmed_ticket_duplicate', 'create_agent', 'create_api_key', 'create_benchmark_run',
  'create_board', 'create_channel', 'create_chat_room', 'create_child_ticket', 'create_column',
  'create_qa_scenario', 'create_qa_schedule', 'create_remote_improvement_ticket',
  'create_security_profile', 'create_security_schedule', 'create_ticket', 'create_user',
  'create_workspace', 'create_workspace_schedule', 'decide_ticket_duplicate', 'delete_action',
  'delete_agent', 'delete_api_key', 'delete_board', 'delete_channel',
  'delete_chat_message_attachment', 'delete_child_ticket', 'delete_column', 'delete_function',
  'delete_prompt_template', 'delete_qa_scenario', 'delete_qa_schedule', 'delete_resource',
  'delete_security_profile', 'delete_security_schedule', 'delete_ticket',
  'delete_ticket_attachment', 'delete_user', 'delete_workspace', 'delete_workspace_schedule',
  'embed_resources', 'execute_function', 'fetch_github_info', 'get_action', 'get_agent',
  'get_allocated_tickets', 'get_api_key', 'get_benchmark_leaderboard', 'get_board',
  'get_board_summary', 'get_chat_room_messages', 'get_feature', 'get_function',
  'get_handoff_pipeline', 'get_latest_artifact', 'get_my_tickets', 'get_qa_batch', 'get_qa_run',
  'get_qa_scenario', 'get_qa_schedule', 'get_recent_activity', 'get_resource',
  'get_security_batch', 'get_security_profile', 'get_security_run', 'get_security_schedule',
  'get_ticket', 'get_ticket_activity', 'get_ticket_attachment', 'get_user', 'get_workspace',
  'get_workspace_schedule', 'handoff_to_agent', 'list_action_runs', 'list_actions',
  'list_agents', 'list_api_keys', 'list_archived_tickets', 'list_board_lessons', 'list_boards',
  'list_channels', 'list_chat_rooms', 'list_claude_backend_profiles', 'list_features',
  'list_function_runs', 'list_functions', 'list_prompt_templates', 'list_qa_runs',
  'list_qa_scenarios', 'list_qa_schedules', 'list_repo_branches', 'list_resources',
  'list_security_profiles', 'list_security_runs', 'list_security_schedules',
  'list_ticket_attachments', 'list_ticket_prerequisites', 'list_users', 'list_workspaces',
  'list_workspace_schedules', 'move_agent_to_workspace', 'move_board_to_workspace',
  'move_ticket', 'move_ticket_to_board', 'pend_ticket', 'ping', 'propose_feature_chain',
  'propose_move', 'propose_skill_change', 'qa_run_heartbeat', 'record_agreement',
  'record_decision', 'record_outreach_classification', 'record_qa_step',
  'record_security_finding', 'refresh_security_checklist', 'register_build_artifact',
  'reject_feature', 'reject_handoff', 'release_ticket', 'remove_ticket_prerequisite',
  'report_build_failure', 'report_deployment', 'request_ticket_unpend_approval',
  'revoke_api_key', 'run_action', 'run_qa_schedule_now', 'run_security_schedule_now',
  'run_workspace_schedule_now', 'save_action', 'save_function', 'save_prompt_template',
  'save_resource', 'search_actions', 'search_chat_messages', 'search_github',
  'search_resources', 'send_chat_room_message', 'set_chat_room_name', 'set_current_task',
  'set_qa_phase', 'set_typing', 'start_qa_batch', 'start_qa_run', 'start_security_batch',
  'start_security_run', 'submit_benchmark_score', 'submit_feature_request', 'subscribe_events',
  'sync_github_resource', 'unarchive_ticket', 'unpend_ticket', 'update_agent',
  'update_api_key', 'update_board', 'update_board_lesson', 'update_channel',
  'update_child_ticket', 'update_claude_backend_profile', 'update_column',
  'update_qa_scenario', 'update_qa_schedule', 'update_security_profile',
  'update_security_schedule', 'update_ticket', 'update_user', 'update_workspace',
  'update_workspace_schedule', 'upsert_claude_backend_profile', 'whoami',
  // Orchestration mode (팀 기반 자율 업무 오케스트레이션). These are listed here
  // rather than in TOOL_AUTHZ_TABLE because none of them is gated on API-key
  // scope: every mutating one checks the CALLING AGENT against the mission's
  // orchestrator / the step's assignee inside the runner service, which is a
  // strictly stronger check than any tier here could express (a full-scope key
  // still cannot report on another agent's step). The read-only ones apply the
  // same membership check before returning anything.
  //
  // Ticket b7127aae added three MORE orchestration tools afterward
  // (list_orchestration_teams, list_orchestration_missions,
  // create_orchestration_mission) — those do NOT belong here. This set is a
  // frozen snapshot of what existed when this gate was written (see the
  // file-level comment above), never a home for new registrations, however
  // similar their authorization story is. They are registered in
  // TOOL_AUTHZ_TABLE with an explicit 'caller' tier instead — the same floor
  // as this block for the same reason (the real check is the handler/service
  // layer's own identity/ownership logic, not anything in this gate file;
  // 'caller' only rejects a sessionless caller before the handler runs).
  'add_orchestration_note', 'complete_orchestration_mission', 'get_orchestration_mission',
  'get_orchestration_step', 'list_my_orchestration_steps', 'report_orchestration_progress',
  'report_orchestration_step', 'submit_orchestration_plan', 'update_orchestration_step',
]);

/**
 * A tool name that is neither tabled, nor destructive-looking, nor present
 * in KNOWN_EXISTING_TOOLS did not exist when this gate was last synced with
 * the real tool surface — i.e. it is a genuinely new registration nobody has
 * consciously classified yet. Review round 2 found this branch defaulting to
 * a 'caller' tier, which is an identity floor, not a deny: any session with
 * a resolvable caller — regardless of scope ('read' is enough) — reached the
 * handler. That is not the fail-closed behavior an allowlist requires. This
 * branch now resolves to 'deny' unconditionally, independent of caller/scope,
 * so a brand-new tool is unreachable until a maintainer consciously adds it
 * to KNOWN_EXISTING_TOOLS (if it's safe to leave ungated) or
 * TOOL_AUTHZ_TABLE (if it needs a specific tier).
 */
export const UNCLASSIFIED_TIER = 'deny';

/**
 * Resolves the tier a tool name must satisfy: an AuthzTier to check against
 * the caller, 'deny' to reject unconditionally before the handler ever runs
 * (regardless of caller identity or scope), or null if this gate does not
 * apply to the name at all (KNOWN_EXISTING_TOOLS / untabled non-destructive
 * names — unchanged, existing behavior).
 */
export function resolveAuthzTier(toolName: string): AuthzTier | typeof UNCLASSIFIED_TIER | null {
  const mapped = TOOL_AUTHZ_TABLE[toolName];
  if (mapped) return mapped;
  if (DESTRUCTIVE_NAME_PATTERN.test(toolName)) return DEFAULT_DESTRUCTIVE_TIER;
  return KNOWN_EXISTING_TOOLS.has(toolName) ? null : UNCLASSIFIED_TIER;
}

async function checkAuthzTier(
  tier: AuthzTier | typeof UNCLASSIFIED_TIER,
  dataSource: DataSource,
  caller: McpAgentContext | undefined,
): Promise<string | null> {
  if (tier === UNCLASSIFIED_TIER) {
    return 'Unauthorized: this tool is not classified in the MCP authorization gate — '
      + 'add it to TOOL_AUTHZ_TABLE or KNOWN_EXISTING_TOOLS in shared/tool-authz-gate.ts before it can be called.';
  }
  if (tier === 'full') {
    return requireFullScopeCaller(dataSource, caller);
  }
  return caller ? null : 'Unauthorized: this operation requires a resolvable MCP caller identity.';
}

type ToolMethod = McpServer['tool'];

/**
 * Wraps `server.tool()` in place so every registration made through this
 * `server` instance from this call forward is checked against the authz
 * table before its handler runs. Overload-agnostic: `.tool()` supports
 * several positional-argument shapes (name, [description], [schema],
 * [annotations], callback) but the callback is always the last argument and
 * every other argument is forwarded untouched, so this never needs to
 * interpret the SDK's overload resolution itself.
 *
 * Mutates `server` (`.tool` becomes an own-property shadowing the prototype
 * method) — safe because `registerAllTools` builds a brand-new McpServer
 * per MCP session (see internal/create-mcp-server.ts), so there is never a
 * shared instance to double-wrap or leak state across sessions.
 */
export function installToolAuthzGate(server: McpServer, dataSource: DataSource): void {
  const originalTool = server.tool.bind(server) as (...args: unknown[]) => unknown;

  (server as unknown as { tool: ToolMethod }).tool = ((...args: unknown[]) => {
    const name = args[0];
    const lastIndex = args.length - 1;
    const handler = args[lastIndex];
    const tier = typeof name === 'string' ? resolveAuthzTier(name) : null;

    if (!tier || typeof handler !== 'function') {
      return originalTool(...args);
    }

    const gatedHandler = async (...handlerArgs: unknown[]) => {
      const extra = (handlerArgs[handlerArgs.length - 1] || {}) as { sessionId?: string };
      const caller = getCallerAgent(extra);
      const gateError = await checkAuthzTier(tier, dataSource, caller);
      if (gateError) return err(gateError);
      return (handler as (...a: unknown[]) => unknown)(...handlerArgs);
    };

    const nextArgs = args.slice(0, lastIndex).concat([gatedHandler]);
    return originalTool(...nextArgs);
  }) as ToolMethod;
}
