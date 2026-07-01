// QA: MCP initialize handshake + tools/list surface.
//
// Validates the contract that every proxy.mjs build depends on:
//   - initialize succeeds with awb/schemaVersion:2 capability
//   - session-id is propagated back to the client
//   - every tool in EXPECTED_TOOLS is registered (drift-detection canary)

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  setupKanbanScene,
  createAgent,
  createApiKey,
} from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

process.env.PORT = process.env.QA_MCP_SURFACE_PORT || '7803';

const EXPECTED_TOOLS = [
  'get_ticket',
  'create_ticket',
  'update_ticket',
  'move_ticket',
  'claim_ticket',
  'release_ticket',
  'add_comment',
  // Ticket 44f7f0eb — 다중담당자·합의 T4 명시적 합의 시그널.
  'record_agreement',
  'get_allocated_tickets',
  'list_agents',
  'list_workspaces',
  'list_boards',
  'create_column',
  'ping',
  // Ticket 48d14fff — prerequisite ("blocked-by ticket") surface.
  'add_ticket_prerequisites',
  'remove_ticket_prerequisite',
  'list_ticket_prerequisites',
  // Ticket 9d892da9 — chat-message read surface.
  'get_chat_room_messages',
  'search_chat_messages',
  // Ticket 8882056b — cross-workspace board move.
  'move_board_to_workspace',
  // Ticket 868ead64 — cross-workspace agent move.
  'move_agent_to_workspace',
  // Ticket 684c012b — benchmark scoring + leaderboard surface.
  'submit_benchmark_score',
  'get_benchmark_leaderboard',
  'create_benchmark_run',
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
  'list_workspace_schedules',
  'get_workspace_schedule',
  'create_workspace_schedule',
  'update_workspace_schedule',
  'delete_workspace_schedule',
  'run_workspace_schedule_now',
];

test('MCP initialize + tools/list returns expected AWB tool surface', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  const { ws } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'mcp-surface' });
  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'inspector' });
  const key = await createApiKey(app, getDataSourceToken, agent.id, {
    workspaceId: ws.id,
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
  await mcp.close();
  exitAfterTests(0);
});
