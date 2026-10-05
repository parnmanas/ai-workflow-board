// QA: MCP initialize handshake + tools/list surface.
//
// Validates the contract that every proxy.mjs build depends on:
//   - initialize succeeds with awb/schemaVersion:2 capability
//   - session-id is propagated back to the client
//   - every tool in EXPECTED_TOOLS is registered (drift-detection canary)
//   - no tool in REMOVED_TOOLS is registered — the board-less model
//     (docs/tickets.md → MCP) dropped them and they must not come back

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  createAccount,
  createAgent,
  createApiKey,
} from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

process.env.PORT = process.env.QA_MCP_SURFACE_PORT || '0';

// P4c-4: list_agents / ping / move_agent_to_workspace 삭제 (Agent 표면 없음).
const EXPECTED_TOOLS = [
  // Board-less tickets (docs/tickets.md → MCP).
  'list_tickets',
  'get_ticket',
  'create_ticket',
  'update_ticket',
  'move_ticket',
  'claim_ticket',
  'release_ticket',
  'get_my_tickets',
  'list_archived_tickets',
  'subscribe_events',
  'add_comment',
  // Projects (repository + main clone folder per host).
  'list_projects',
  'get_project',
  'save_project',
  'list_repo_branches',
  'list_accounts',
  // Ticket 48d14fff — prerequisite ("blocked-by ticket") surface.
  'add_ticket_prerequisites',
  'remove_ticket_prerequisite',
  'list_ticket_prerequisites',
  // Ticket 9d892da9 — chat-message read surface.
  'get_chat_room_messages',
  'search_chat_messages',
  // Ticket 3c655d20 — scenario-based QA surface (QaScenario/QaRun).
  'list_qa_scenarios',
  'get_qa_scenario',
  'create_qa_scenario',
  'update_qa_scenario',
  'delete_qa_scenario',
  'start_qa_run',
  'record_qa_step',
  'qa_run_heartbeat',
  'attach_qa_artifact',
  'complete_qa_run',
  'list_qa_runs',
  'get_qa_run',
  // Ticket daf06262 — sequential multi-scenario batch runs.
  'start_qa_batch',
  'get_qa_batch',
  // Ticket b6bb7efd — QA scheduler (automatic batch trigger layer).
  'list_qa_schedules',
  'get_qa_schedule',
  'create_qa_schedule',
  'update_qa_schedule',
  'delete_qa_schedule',
  'run_qa_schedule_now',
  // Ticket cfd74638 — security-inspection surface (SecurityProfile/SecurityRun).
  'list_security_profiles',
  'get_security_profile',
  'create_security_profile',
  'update_security_profile',
  'delete_security_profile',
  'refresh_security_checklist',
  'start_security_run',
  'record_security_finding',
  'attach_security_artifact',
  'complete_security_run',
  'list_security_runs',
  'get_security_run',
  // Ticket 7c07c19d — security scheduler + manual full inspection (batch).
  'start_security_batch',
  'get_security_batch',
  'list_security_schedules',
  'get_security_schedule',
  'create_security_schedule',
  'update_security_schedule',
  'delete_security_schedule',
  'run_security_schedule_now',
  // Ticket 769eb260 — workspace scheduler (general-purpose agent-task trigger).
  'list_automation_schedules',
  'get_automation_schedule',
  'create_automation_schedule',
  'update_automation_schedule',
  'delete_automation_schedule',
  'run_automation_schedule_now',
  // Ticket 80d52250 — Build & Artifact Registry (commit↔산출물 서버 권위 추적).
  'get_latest_artifact',
  'register_build_artifact',
  'report_build_failure',
  // AWB Functions: structured, auditable operations callable by agents.
  'list_functions',
  'get_function',
  'save_function',
  'delete_function',
  'execute_function',
  'list_function_runs',
  // Ticket 20fa0197 — outreach LLM 분류 결과 보고(AgentDispatchClassifier 완료 콜백).
  'record_outreach_classification',
];

// Removed with boards (docs/tickets.md → MCP "Removed"): board / column /
// lesson / prompt-template / consensus / handoff / benchmark / feature /
// merge-lease / review-drift / self-improvement / completion-verification /
// comment-summary tools, plus move_ticket_to_board, get_allocated_tickets,
// batch_operations and get_board_summary.
const REMOVED_TOOLS = [
  'list_boards', 'get_board', 'create_board', 'update_board', 'delete_board',
  'get_board_summary', 'move_board_to_workspace', 'move_ticket_to_board',
  'create_column', 'update_column', 'delete_column',
  'add_board_lesson', 'list_board_lessons', 'update_board_lesson',
  'list_prompt_templates', 'save_prompt_template', 'delete_prompt_template',
  'record_agreement', 'propose_move',
  'handoff_to_agent', 'reject_handoff', 'get_handoff_pipeline',
  'submit_benchmark_score', 'get_benchmark_leaderboard', 'create_benchmark_run',
  'submit_feature_request', 'propose_feature_chain', 'approve_feature',
  'reject_feature', 'list_features', 'get_feature',
  'await_merge_lease', 'release_merge_lease',
  'check_review_drift',
  'create_remote_improvement_ticket',
  'register_completion_verification', 'record_completion_verification',
  'complete_comment_summary',
  'batch_operations',
  'get_allocated_tickets',
];

test('MCP initialize + tools/list returns expected AWB tool surface', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  const ws = await createAccount(app, getDataSourceToken, 'mcp-surface');
  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'inspector' });
  const key = await createApiKey(app, getDataSourceToken, agent.id, {
    accountId: ws.id,
    label: 'inspector',
  });

  step('MCP initialize with awb/schemaVersion:2');
  const mcp = new McpClient({ baseUrl: `http://localhost:${port}`, apiKey: key.raw_key });
  const initResult = await mcp.initialize();
  assert.ok(initResult, 'initialize must return a result');
  assert.ok(mcp.sessionId, 'mcp-session-id must be populated');

  step(`Fetch tools/list and verify ${EXPECTED_TOOLS.length} expected tool names present`);
  const tools = await mcp.listTools();
  const names = new Set(tools.map((t) => t.name));
  for (const expected of EXPECTED_TOOLS) {
    assert.ok(names.has(expected), `Expected MCP tool '${expected}' (saw ${tools.length} tools)`);
  }
  step(`Verify ${REMOVED_TOOLS.length} removed board-era tool names are absent`);
  const revived = REMOVED_TOOLS.filter((name) => names.has(name));
  assert.deepEqual(revived, [], `Removed MCP tool(s) registered again: ${revived.join(', ')}`);
  await mcp.close();
  exitAfterTests(0);
});
