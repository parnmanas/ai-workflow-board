// Regression-grep — ticket 8e934802 (Stale-WAIT detector).
//
// Cheap static check that the detector is wired in the right places.
// The behavioural assertions live in
// test/qa-flows/stuck-ticket-detector.test.mjs; this file just guards
// against refactors that delete the wiring (which would make the
// detector silently never run).
//
// Comments are stripped before grepping so the prose in module / entity
// headers — which legitimately names tokens for documentation — doesn't
// false-positive the call-site grep.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC_DIR = path.resolve(__dirname, '..', 'src');
const AGENTS_MODULE = path.join(SRC_DIR, 'modules', 'agents', 'agents.module.ts');
const DETECTOR      = path.join(SRC_DIR, 'modules', 'agents', 'stuck-ticket-detector.service.ts');
const ENTITY        = path.join(SRC_DIR, 'entities', 'StuckTicketAlert.ts');
const ENTITIES_IDX  = path.join(SRC_DIR, 'entities', 'index.ts');
const ROOM_MSG      = path.join(SRC_DIR, 'modules', 'chat-rooms', 'room-messaging.service.ts');
const STUCK_CTRL    = path.join(SRC_DIR, 'modules', 'admin', 'stuck-tickets.controller.ts');
const ADMIN_MODULE  = path.join(SRC_DIR, 'modules', 'admin', 'admin.module.ts');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

test('StuckTicketAlert entity exists with ticket_id PK', () => {
  assert.ok(fs.existsSync(ENTITY), `expected ${ENTITY} to exist`);
  const src = fs.readFileSync(ENTITY, 'utf8');
  assert.match(src, /@Entity\(['"]stuck_alerts['"]\)/, "entity must map to 'stuck_alerts' table");
  assert.match(src, /class\s+StuckTicketAlert/, 'entity must export StuckTicketAlert');
  assert.match(src, /@PrimaryColumn[\s\S]*ticket_id/, 'ticket_id must be the primary column');
  assert.match(src, /last_alerted_at/, 'must define last_alerted_at column');
  assert.match(src, /last_cycle_count/, 'must define last_cycle_count column');
  assert.match(src, /last_comment_id/, 'must define last_comment_id column');
});

test('entities barrel index exports StuckTicketAlert', () => {
  const src = fs.readFileSync(ENTITIES_IDX, 'utf8');
  assert.match(
    src,
    /export\s+\{\s*StuckTicketAlert\s*\}\s+from\s+['"]\.\/StuckTicketAlert['"]/,
    'entities/index.ts must re-export StuckTicketAlert (entities array reads from this barrel)',
  );
});

test('StuckTicketDetectorService source defines the sweep loop and env config', () => {
  assert.ok(fs.existsSync(DETECTOR), `expected ${DETECTOR} to exist`);
  const code = stripComments(fs.readFileSync(DETECTOR, 'utf8'));
  assert.match(code, /class\s+StuckTicketDetectorService/, 'must export StuckTicketDetectorService class');
  assert.match(code, /OnModuleInit/, 'must implement OnModuleInit so the sweep loop boots');
  assert.match(code, /OnModuleDestroy/, 'must implement OnModuleDestroy so the timer is torn down');
  assert.match(code, /setInterval\(/, 'sweep loop must use setInterval');
  assert.match(code, /STUCK_DETECTOR_ENABLED/, 'must read STUCK_DETECTOR_ENABLED env var');
  assert.match(code, /STUCK_DETECTOR_SWEEP_MS/, 'must read STUCK_DETECTOR_SWEEP_MS env var');
  assert.match(code, /STUCK_DETECTOR_WINDOW/, 'must read STUCK_DETECTOR_WINDOW env var');
  assert.match(code, /STUCK_DETECTOR_MIN_SPAN_MS/, 'must read STUCK_DETECTOR_MIN_SPAN_MS env var');
  assert.match(code, /STUCK_DETECTOR_MIN_AGE_MS/, 'must read STUCK_DETECTOR_MIN_AGE_MS env var');
  assert.match(code, /STUCK_DETECTOR_REALERT_MS/, 'must read STUCK_DETECTOR_REALERT_MS env var');
  // The detector must route through RoomMessagingService.sendSystemMessage
  // — never the MCP send_chat_room_message tool (in-process invariant
  // from the ticket's constraint section).
  assert.match(
    code,
    /sendSystemMessage\(/,
    'detector must call RoomMessagingService.sendSystemMessage (in-process path, no MCP)',
  );
});

test('RoomMessagingService exposes sendSystemMessage helper', () => {
  const code = stripComments(fs.readFileSync(ROOM_MSG, 'utf8'));
  assert.match(
    code,
    /async\s+sendSystemMessage\s*\(\s*roomId/,
    "RoomMessagingService.sendSystemMessage(roomId, workspaceId, content) must exist " +
    "(detector uses it instead of impersonating a user via sendMessage)",
  );
});

test('agents.module.ts imports StuckTicketDetectorService into providers AND exports', () => {
  const code = stripComments(fs.readFileSync(AGENTS_MODULE, 'utf8'));
  assert.match(
    code,
    /import\s+\{\s*StuckTicketDetectorService\s*\}\s+from\s+['"]\.\/stuck-ticket-detector\.service['"]/,
    'AgentsModule must import StuckTicketDetectorService from sibling file',
  );
  // forFeature must include StuckTicketAlert so the repo is injectable.
  assert.match(
    code,
    /StuckTicketAlert/,
    "TypeOrmModule.forFeature must include StuckTicketAlert so the detector's repo injection resolves",
  );
  // Must import ChatRoomsModule so RoomMessagingService is in scope.
  assert.match(
    code,
    /ChatRoomsModule/,
    'AgentsModule must import ChatRoomsModule so StuckTicketDetectorService can inject RoomMessagingService',
  );
  // Provider + export wiring — the admin endpoint module pulls the
  // service from AgentsModule's exports, so the export entry is load-
  // bearing, not optional.
  assert.match(code, /providers\s*:\s*\[[\s\S]*StuckTicketDetectorService/, 'must register StuckTicketDetectorService in providers');
  assert.match(code, /exports\s*:\s*\[[\s\S]*StuckTicketDetectorService/, 'must export StuckTicketDetectorService so AdminModule can inject it');
});

test('admin /api/admin/stuck-tickets controller is registered and guarded', () => {
  assert.ok(fs.existsSync(STUCK_CTRL), `expected ${STUCK_CTRL} to exist`);
  const ctrlCode = stripComments(fs.readFileSync(STUCK_CTRL, 'utf8'));
  assert.match(ctrlCode, /@Controller\(['"]api\/admin\/stuck-tickets['"]\)/, 'controller path must be /api/admin/stuck-tickets');
  assert.match(ctrlCode, /@UseGuards\(\s*AdminGuard\s*\)/, 'controller must be guarded by AdminGuard');
  assert.match(ctrlCode, /listActiveAlerts\(/, 'GET handler must call detector.listActiveAlerts()');
  assert.match(ctrlCode, /forceRealert\(/, 'POST /:id/realert must call detector.forceRealert()');
  assert.match(ctrlCode, /dismissAlert\(/, 'DELETE /:id must call detector.dismissAlert()');

  const modCode = stripComments(fs.readFileSync(ADMIN_MODULE, 'utf8'));
  assert.match(modCode, /StuckTicketsController/, 'AdminModule must register StuckTicketsController');
  assert.match(modCode, /AgentsModule/, 'AdminModule must import AgentsModule so detector service can be injected into the controller');
});
