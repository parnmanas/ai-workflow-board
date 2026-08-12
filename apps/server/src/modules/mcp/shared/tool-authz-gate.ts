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
 *     (`delete_*` / `revoke_*`) fall back to a safe default tier.
 *   - Every OTHER tool name is checked against KNOWN_EXISTING_TOOLS, a
 *     snapshot of every tool that existed when this gate was written. A name
 *     in the snapshot passes through untouched (today's ~163 non-tabled,
 *     non-destructive-looking tools keep their exact current behavior — this
 *     gate does not re-audit them, that stays out of this ticket's scope).
 *     A name NOT in the snapshot — i.e. a tool that did not exist yet — gets
 *     DEFAULT_UNCLASSIFIED_TIER instead of running completely ungated.
 *
 *     This last branch is what review round 1 found missing: the original
 *     version of this file only caught a future admin tool if its name
 *     happened to start with `delete_` / `revoke_`. A tool named
 *     `rotate_credential`, `grant_admin_role`, `set_user_role`, or
 *     `purge_workspace_secrets` matched neither TOOL_AUTHZ_TABLE nor
 *     DESTRUCTIVE_NAME_PATTERN and fell through to `null` — fully ungated,
 *     the exact failure mode this ticket exists to close. The snapshot
 *     inverts the default for anything outside today's known surface: an
 *     unrecognized name is now guilty (gated) until a maintainer
 *     consciously adds it to KNOWN_EXISTING_TOOLS (if it's safe) or
 *     TOOL_AUTHZ_TABLE (if it needs a specific tier), rather than innocent
 *     (ungated) until someone happens to notice. The completeness guard in
 *     `test/mcp-tool-authz.test.mjs` fails the build the moment a real tool
 *     name drifts out of sync with this snapshot, so that decision can't be
 *     silently skipped — but the runtime default here is the actual
 *     security boundary; the test is a hygiene aid on top of it, not a
 *     substitute for it.
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
 *                sessionless / stale / malformed calls. Both
 *                DEFAULT_DESTRUCTIVE_TIER and DEFAULT_UNCLASSIFIED_TIER use
 *                'caller' rather than 'full' for the same reason the
 *                original delete_* / revoke_* fallback did: we have no
 *                evidence a brand-new tool actually needs full scope, and
 *                defaulting to 'full' would risk breaking a legitimate new
 *                lower-privilege tool. 'caller' is the floor every
 *                genuinely authenticated session already clears.
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
 * exist when this snapshot was taken; either way it gets
 * DEFAULT_UNCLASSIFIED_TIER instead of a free pass. See the file-level
 * comment above for why this exists and `test/mcp-tool-authz.test.mjs`'s
 * completeness guard for how drift against the real tool surface is caught.
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
]);

/**
 * Safe universal floor for a tool name that is neither tabled, nor
 * destructive-looking, nor present in KNOWN_EXISTING_TOOLS — i.e. it did not
 * exist when this gate was last synced with the real tool surface. Same
 * 'caller' rationale as DEFAULT_DESTRUCTIVE_TIER (see file header): no
 * evidence the new tool needs full scope, so 'caller' is the safe floor
 * rather than a guess.
 */
export const DEFAULT_UNCLASSIFIED_TIER: AuthzTier = 'caller';

/** Resolves the tier a tool name must satisfy, or null if this gate does not apply to it. */
export function resolveAuthzTier(toolName: string): AuthzTier | null {
  const mapped = TOOL_AUTHZ_TABLE[toolName];
  if (mapped) return mapped;
  if (DESTRUCTIVE_NAME_PATTERN.test(toolName)) return DEFAULT_DESTRUCTIVE_TIER;
  return KNOWN_EXISTING_TOOLS.has(toolName) ? null : DEFAULT_UNCLASSIFIED_TIER;
}

async function checkAuthzTier(
  tier: AuthzTier,
  dataSource: DataSource,
  caller: McpAgentContext | undefined,
): Promise<string | null> {
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
