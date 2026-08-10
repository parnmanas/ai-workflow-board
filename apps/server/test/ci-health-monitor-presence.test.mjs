// Regression-grep — ticket cc1c494e (main CI red-streak watchdog).
//
// Cheap static check that CiHealthMonitorService is wired in the right
// places. The behavioural assertions live in
// test/qa-flows/ci-health-monitor.test.mjs and the pure-function threshold
// assertions live in test/ci-health-monitor.test.mjs; this file just guards
// against refactors that delete the wiring (which would make the sweep
// silently never run — the exact "nobody notices" failure mode this ticket
// exists to fix, this time for the fix itself).
//
// Comments are stripped before grepping so prose in module/entity headers —
// which legitimately names tokens for documentation — doesn't false-positive
// the call-site grep. Mirrors stuck-detector-presence.test.mjs's shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC_DIR = path.resolve(__dirname, '..', 'src');
const AGENTS_MODULE = path.join(SRC_DIR, 'modules', 'agents', 'agents.module.ts');
const MONITOR       = path.join(SRC_DIR, 'modules', 'agents', 'ci-health-monitor.service.ts');
const ENTITY        = path.join(SRC_DIR, 'entities', 'CiRedAlert.ts');
const ENTITIES_IDX  = path.join(SRC_DIR, 'entities', 'index.ts');
const GITHUB_CONN   = path.join(SRC_DIR, 'services', 'github-connector.service.ts');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

test('CiRedAlert entity exists with the expected shape', () => {
  assert.ok(fs.existsSync(ENTITY), `expected ${ENTITY} to exist`);
  const src = fs.readFileSync(ENTITY, 'utf8');
  assert.match(src, /@Entity\(['"]ci_red_alerts['"]\)/, "entity must map to 'ci_red_alerts' table");
  assert.match(src, /class\s+CiRedAlert/, 'entity must export CiRedAlert');
  assert.match(src, /@Index\([\s\S]*board_id[\s\S]*repo_full_name[\s\S]*branch[\s\S]*workflow_id[\s\S]*unique:\s*true/, 'must have a unique composite index on (board_id, repo_full_name, branch, workflow_id)');
  assert.match(src, /delivered_at/, 'must define delivered_at column (durable-delivery cooldown key)');
  assert.match(src, /delivery_attempts/, 'must define delivery_attempts column');
  assert.match(src, /created_ticket_id/, 'must define created_ticket_id column');
  assert.match(src, /streak/, 'must define streak column');
});

test('entities barrel index exports CiRedAlert', () => {
  const src = fs.readFileSync(ENTITIES_IDX, 'utf8');
  assert.match(
    src,
    /export\s+\{\s*CiRedAlert\s*\}\s+from\s+['"]\.\/CiRedAlert['"]/,
    'entities/index.ts must re-export CiRedAlert (entities array reads from this barrel)',
  );
});

test('GitHubConnectorService exposes the Actions API read methods', () => {
  assert.ok(fs.existsSync(GITHUB_CONN), `expected ${GITHUB_CONN} to exist`);
  const code = stripComments(fs.readFileSync(GITHUB_CONN, 'utf8'));
  assert.match(code, /async\s+listWorkflows\s*\(/, 'must expose listWorkflows()');
  assert.match(code, /async\s+listWorkflowRuns\s*\(/, 'must expose listWorkflowRuns()');
  assert.match(code, /async\s+listRunFailedJobs\s*\(/, 'must expose listRunFailedJobs()');
});

test('CiHealthMonitorService source defines the sweep loop, env config, and threshold fn', () => {
  assert.ok(fs.existsSync(MONITOR), `expected ${MONITOR} to exist`);
  const code = stripComments(fs.readFileSync(MONITOR, 'utf8'));
  assert.match(code, /class\s+CiHealthMonitorService/, 'must export CiHealthMonitorService class');
  assert.match(code, /OnModuleInit/, 'must implement OnModuleInit so the sweep loop boots');
  assert.match(code, /OnModuleDestroy/, 'must implement OnModuleDestroy so the timer is torn down');
  assert.match(code, /setInterval\(/, 'sweep loop must use setInterval');
  assert.match(code, /export\s+function\s+evaluateRedStreak\s*\(/, 'threshold decision must be a standalone exported pure function');
  assert.match(code, /CI_MONITOR_ENABLED/, 'must read CI_MONITOR_ENABLED env var');
  assert.match(code, /CI_MONITOR_SWEEP_MS/, 'must read CI_MONITOR_SWEEP_MS env var');
  assert.match(code, /CI_MONITOR_MIN_RUNS/, 'must read CI_MONITOR_MIN_RUNS env var');
  assert.match(code, /CI_MONITOR_MIN_AGE_MS/, 'must read CI_MONITOR_MIN_AGE_MS env var');
  assert.match(code, /CI_MONITOR_REALERT_MS/, 'must read CI_MONITOR_REALERT_MS env var');
  assert.match(code, /CI_MONITOR_CREATE_TICKET/, 'must read CI_MONITOR_CREATE_TICKET env var');
  // Must route through RoomMessagingService.sendSystemMessage — the same
  // in-process invariant StuckTicketDetectorService follows (never the MCP
  // send_chat_room_message tool).
  assert.match(code, /sendSystemMessage\(/, 'monitor must call RoomMessagingService.sendSystemMessage (in-process path, no MCP)');
  // Ticket auto-creation must key off operational_dedupe_key, INSERT-first —
  // never a pre-SELECT existence check (board lesson: idempotency must claim
  // atomically via DB UNIQUE before the side effect, not before-and-after).
  assert.match(code, /operational_dedupe_key/, 'ticket creation must set operational_dedupe_key for idempotency');
  assert.match(code, /isUniqueConstraintError/, 'must catch the unique-violation and resolve the collision, not pre-SELECT');
});

test('agents.module.ts wires CiHealthMonitorService and CiRedAlert', () => {
  const code = stripComments(fs.readFileSync(AGENTS_MODULE, 'utf8'));
  assert.match(
    code,
    /import\s+\{\s*CiHealthMonitorService\s*\}\s+from\s+['"]\.\/ci-health-monitor\.service['"]/,
    'AgentsModule must import CiHealthMonitorService from sibling file',
  );
  assert.match(code, /CiRedAlert/, "TypeOrmModule.forFeature must include CiRedAlert so the monitor's repo injection resolves");
  assert.match(code, /providers\s*:\s*\[[\s\S]*CiHealthMonitorService/, 'must register CiHealthMonitorService in providers');
  assert.match(code, /exports\s*:\s*\[[\s\S]*CiHealthMonitorService/, 'must export CiHealthMonitorService');
  // Already required by StuckTicketDetectorService, but load-bearing for
  // this service too (RoomMessagingService / TicketRoleAssignmentService).
  assert.match(code, /ChatRoomsModule/, 'AgentsModule must import ChatRoomsModule so CiHealthMonitorService can inject RoomMessagingService');
  assert.match(code, /WorkspaceRolesModule/, 'AgentsModule must import WorkspaceRolesModule so CiHealthMonitorService can inject TicketRoleAssignmentService');
});
