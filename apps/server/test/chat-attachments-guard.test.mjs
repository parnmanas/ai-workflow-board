// Regression-grep — ticket 92082b55 subtask (a)
//   "Server: chat attachment storage + REST + MCP + SSE/history + cleanup"
//
// Chat-message attachments reuse the existing ticket_attachments table by
// extending it with an owner_type / owner_id / room_id triple instead of
// minting a separate storage backend. The reviewer gate (planner-fixed,
// 2026-05-25) calls out a fixed list of invariants that must be true on the
// server contract before this subtask can ship:
//
//   - migration + backfill on ticket_attachments
//   - owner-transition validation (workspace + room + sender match) before
//     a pending upload is bound to a message
//   - chat participant download auth (require_active_participant on REST)
//   - send_chat_room_message schema accepts attachment_ids[]
//   - SSE / history rows carry attachments[] (single shared projector)
//   - MCP add_chat_message_attachment + add_ticket_attachment owner stamp
//   - cleanup on room teardown (action_run path)
//
// Each invariant is fragile under unrelated refactors — a future change to
// the attachment helper or to RoomMessagingService could silently drop one
// of them and leave the surface compiling but broken. Static guards are the
// cheapest way to keep them honest without booting Nest.
//
// Pattern mirrors archive-exclusion-guard.test.mjs: strip comments first so
// doc prose that legitimately mentions the symbol doesn't false-positive
// on files that no longer implement the contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '..', 'src');

function read(rel) {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

// ── Entity + migration ────────────────────────────────────────────────

test('TicketAttachment entity carries the generic owner triple', () => {
  const code = stripComments(read('entities/TicketAttachment.ts'));
  assert.match(code, /owner_type:\s*string/, 'owner_type column missing from TicketAttachment entity');
  assert.match(code, /owner_id:\s*string/, 'owner_id column missing from TicketAttachment entity');
  assert.match(code, /room_id:\s*string/, 'room_id column missing from TicketAttachment entity (denormalized for room-scoped queries + cleanup)');
});

test('GeneralizeAttachmentsForChat migration backfills owner_type/owner_id from ticket_id', () => {
  const migrationsDir = path.join(SRC, 'database', 'migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => /GeneralizeAttachmentsForChat/.test(f));
  assert.equal(files.length, 1, 'Expected exactly one GeneralizeAttachmentsForChat migration');
  const code = fs.readFileSync(path.join(migrationsDir, files[0]), 'utf8');
  assert.match(code, /ADD COLUMN[\s\S]*owner_type/i, 'migration must add owner_type column on ticket_attachments');
  assert.match(code, /ADD COLUMN[\s\S]*owner_id/i, 'migration must add owner_id column on ticket_attachments');
  assert.match(code, /ADD COLUMN[\s\S]*room_id/i, 'migration must add room_id column on ticket_attachments');
  assert.match(code, /UPDATE ticket_attachments[\s\S]*owner_type\s*=\s*'ticket'/i, 'migration must backfill owner_type=ticket for existing rows');
  assert.match(code, /UPDATE ticket_attachments[\s\S]*owner_id\s*=\s*ticket_id/i, 'migration must backfill owner_id=ticket_id for existing rows');
});

// ── Send-time validation ─────────────────────────────────────────────

test('RoomMessagingService._validatePendingAttachments enforces room + workspace + sender match', () => {
  const code = stripComments(read('modules/chat-rooms/room-messaging.service.ts'));
  assert.match(code, /_validatePendingAttachments/, 'helper must exist so every send_message caller funnels through one guard');
  // Workspace scope check — required so a pending upload in workspace A
  // can't be smuggled into a message in workspace B.
  assert.match(code, /row\.workspace_id\s*!==\s*workspaceId/, 'pending attachment must reject ids that belong to a different workspace');
  // Uploader identity — required so a co-participant can't attach another
  // user / agent's pending file to their own message.
  assert.match(code, /row\.uploaded_by_type\s*!==\s*senderType[\s\S]{0,80}uploaded_by_id\s*!==\s*senderId/, 'pending attachment must reject ids uploaded by a different sender');
  // Pending state contract — pre-send rows carry owner_type='chat_room'
  // and owner_id=roomId. Anything else (already-sent chat_message, or a
  // row anchored to a different room) must fail loudly so a cross-room
  // smuggling attempt or a re-send of an already-bound id is blocked.
  assert.match(
    code,
    /owner_type\s*!==\s*'chat_room'\s*\|\|\s*row\.owner_id\s*!==\s*roomId/,
    "pending attachment must be owner_type='chat_room' AND owner_id===roomId; anything else is either already-bound or cross-room and must throw",
  );
});

test('RoomMessagingService.sendMessage transitions attachment ownership after the message row is saved', () => {
  const code = stripComments(read('modules/chat-rooms/room-messaging.service.ts'));
  // The transition target — pending attachment rows must be stamped with
  // owner_type='chat_message' and owner_id = the freshly-saved message id.
  // CAS update via query builder (preferred shape) sets these via .set({...}).
  assert.match(
    code,
    /\.set\(\{\s*owner_type:\s*'chat_message',\s*owner_id:\s*created\.id\s*\}\)/,
    'sendMessage must stamp owner_type+owner_id onto pending attachments after saving the message row, so a crash mid-flight never leaves bound-but-empty rows',
  );
});

test('RoomMessagingService.getMessages + sendMessage emit a shared attachments[] projection', () => {
  const code = stripComments(read('modules/chat-rooms/room-messaging.service.ts'));
  // History fetch must hydrate attachments per message via the shared loader.
  assert.match(code, /_loadAttachmentsForMessages/, 'history loader for chat attachments must exist');
  assert.match(code, /projectChatAttachment/, 'sendMessage / getMessages must reuse projectChatAttachment so SSE + history share one shape');
});

// ── REST surface ─────────────────────────────────────────────────────

test('ChatRoomsController exposes upload + download + discard-pending endpoints', () => {
  const code = stripComments(read('modules/chat-rooms/chat-rooms.controller.ts'));
  assert.match(code, /@Post\(':roomId\/attachments'\)/, 'POST /api/chat-rooms/:roomId/attachments must exist (base64 upload contract)');
  assert.match(code, /@Get\(':roomId\/attachments\/:attachmentId'\)/, 'GET /api/chat-rooms/:roomId/attachments/:id must exist (participant-only download)');
  assert.match(code, /@Delete\(':roomId\/attachments\/:attachmentId'\)/, 'DELETE /api/chat-rooms/:roomId/attachments/:id must exist (uploader-only discard of pending uploads)');
});

test('ChatRoomsController upload + download require an active participant', () => {
  const code = stripComments(read('modules/chat-rooms/chat-rooms.controller.ts'));
  // Both upload and download must call requireActiveParticipant — a stranger
  // with a guessed room_id must not be able to either upload binaries into
  // someone else's room or scrape a file they were never sent.
  const matches = code.match(/requireActiveParticipant\(roomId,\s*user\.id,\s*'user'\)/g) || [];
  assert.ok(matches.length >= 2, `requireActiveParticipant must gate at least upload+download on chat-rooms controller (saw ${matches.length})`);
});

test('ChatRoomsController.sendMessage forwards attachment_ids[] into messaging service', () => {
  const code = stripComments(read('modules/chat-rooms/chat-rooms.controller.ts'));
  assert.match(
    code,
    /this\.messaging\.sendMessage\([\s\S]{0,400}body\.attachment_ids/,
    'POST /api/chat-rooms/:roomId/messages must accept attachment_ids[] in body and forward to RoomMessagingService.sendMessage',
  );
});

// ── MCP surface ──────────────────────────────────────────────────────

test('MCP add_chat_message_attachment tool is registered and pins the chat_room owner type', () => {
  const code = stripComments(read('modules/mcp/tools/chat-tools.ts'));
  assert.match(code, /'add_chat_message_attachment'/, 'add_chat_message_attachment MCP tool must be registered');
  // Planner-fixed contract: pre-send rows are owner_type='chat_room',
  // owner_id=room_id; sendMessage flips them to 'chat_message'+message_id.
  // Stamping 'chat_message' at upload time would break the pending-state
  // check in _validatePendingAttachments and let a re-send recycle the row.
  assert.match(code, /owner_type:\s*'chat_room'/, "MCP upload must stamp owner_type='chat_room' (pending). The send-time transition flips it to 'chat_message'.");
  assert.match(code, /requireActiveParticipant\([^)]*'agent'/, 'MCP upload must gate the agent caller on room participation before persisting');
});

test('MCP send_chat_room_message schema accepts attachment_ids[]', () => {
  const code = stripComments(read('modules/mcp/tools/chat-tools.ts'));
  assert.match(
    code,
    /attachment_ids:\s*z\.array\(z\.string\(\)\)\.optional\(\)/,
    'send_chat_room_message zod schema must declare attachment_ids: string[]? — required for agent-authored chat attachments',
  );
});

test('add_ticket_attachment stamps owner_type=ticket so the generic loader can find ticket rows', () => {
  const code = stripComments(read('modules/mcp/tools/ticket-attachment-tools.ts'));
  assert.match(
    code,
    /owner_type:\s*'ticket'[\s\S]{0,80}owner_id:\s*ticket_id/,
    'MCP add_ticket_attachment must stamp owner_type=ticket + owner_id=ticket_id so the generic owner_type index keeps ticket-side rows discoverable',
  );
});

// ── Cleanup contract ─────────────────────────────────────────────────

test('ActionsService._deleteRunWithRoom sweeps ticket_attachments for the deleted room', () => {
  const code = stripComments(read('modules/actions/actions.service.ts'));
  assert.match(
    code,
    /attachmentRepo\.delete\(\{\s*room_id:\s*run\.room_id\s*\}\)/,
    'action-run teardown must delete attachments by room_id — ticket_attachments has no FK back to chat_room_messages, so we rely on the denormalized room_id to cascade-clean by hand',
  );
});

// ── Agent-key download peer ──────────────────────────────────────────

// Subtask (c) — agent-manager needs to fetch attachment bytes for vision /
// inline-text delivery to subagent prompts, but the user-session GET
// endpoint refuses an X-Agent-Key request. The peer at
// /api/agent/chat-rooms/:roomId/attachments/:id mirrors the same row +
// projection (with file_data) under AgentAuthGuard + agent participant
// check so the manager has an audited path that doesn't require a user
// session.
test('AgentApiController exposes an agent-key download peer for chat attachments', () => {
  const code = stripComments(read('modules/agent-api/agent-api.controller.ts'));
  assert.match(
    code,
    /@Get\('chat-rooms\/:roomId\/attachments\/:attachmentId'\)/,
    'agent-api controller must expose GET chat-rooms/:roomId/attachments/:attachmentId for agent-key download',
  );
  // Participant gate via the same shared helper as the user-session route
  // — strangers (or agents added then removed) must not be able to scrape
  // attachments by guessing ids.
  assert.match(
    code,
    /requireActiveParticipant\([^)]*'agent'\)/,
    'agent download endpoint must call requireActiveParticipant(roomId, agentId, agent) before serving bytes',
  );
  // Body must include file_data (base64) so the manager can hand the
  // bytes to the CLI subagent — projectChatAttachment(row, { includeData: true })
  // is the canonical projector.
  assert.match(
    code,
    /projectChatAttachment\([\s\S]{0,80}includeData:\s*true/,
    'agent download response must call projectChatAttachment with includeData=true so file_data is returned',
  );
});

// ── Stream contract ──────────────────────────────────────────────────

test('ChatRequestHistoryEntry stream type carries the attachments shape', () => {
  const code = stripComments(read('common/types/stream-events.ts'));
  assert.match(
    code,
    /ChatRequestHistoryEntry[\s\S]{0,400}attachments\?:[\s\S]{0,200}download_url/,
    'ChatRequestHistoryEntry must declare attachments[] so the agent-manager chat-history payload can carry them downstream',
  );
});

// ── Review-bounce regression: ticket 92082b55 reviewer feedback ──────

// P1 (review 2026-05-26): _validatePendingAttachments → save(msg) → update
// was lossy under concurrent sends. Two callers with the same attachment_ids
// could both pass validation, both save messages, then "last update wins" on
// the attachment row — the first sender's POST/SSE response pointed at
// attachments persisted under the OTHER message id. Fix wraps save+claim in
// a transaction with a CAS-style UPDATE that re-asserts the pending state
// (owner_type='chat_room' AND owner_id=:roomId) and verifies result.affected
// equals ids.length. The guard below pins both halves so a well-meaning
// refactor doesn't silently weaken the contract back to the race.
test('RoomMessagingService.sendMessage claims attachments inside a transactional CAS update', () => {
  const code = stripComments(read('modules/chat-rooms/room-messaging.service.ts'));
  // The save-message + bind-attachments sequence must be wrapped in a single
  // transaction so a CAS-update mismatch rolls back the message row too.
  assert.match(
    code,
    /messageRepo\.manager\.transaction\(/,
    'sendMessage must wrap message save + attachment claim in one transaction so a lost CAS race rolls back the message row',
  );
  // CAS WHERE clauses — without these two filters the update reverts to the
  // pre-fix "update by id only", which is the lossy path.
  assert.match(
    code,
    /\.andWhere\(\s*'owner_type\s*=\s*:pendingType'/,
    "attachment claim must filter on owner_type='chat_room' so a row already flipped to 'chat_message' by a concurrent send is not re-claimed",
  );
  assert.match(
    code,
    /\.andWhere\(\s*'owner_id\s*=\s*:roomId'/,
    'attachment claim must filter on owner_id=:roomId so a pending row anchored to another room is not re-claimed',
  );
  // Affected-row check — without this, the WHERE clause can match 0 rows and
  // the message still goes out claiming attachments that were never bound.
  assert.match(
    code,
    /result\.affected\s*\?\?\s*0\s*\)\s*!==\s*ids\.length/,
    'sendMessage must verify CAS update affected === ids.length and throw 409 otherwise',
  );
});
