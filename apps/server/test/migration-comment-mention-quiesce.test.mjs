// Regression / feature proof: instance-wide fleet quiesce — comment_mention
// family (ticket 0f638509, review round 1 P2 — the reviewer's own comment
// named "일부 comment_mention 경로" as one of the bypasses a follow-up ticket
// could not substitute for). Three of the four emit sites live in
// comment-tools.ts (add_comment, ask_question, handoff_to_agent) and are
// covered here against a REAL sql.js DataSource + REAL registerCommentTools
// registration — the same recipe as comment-tools-dedupe.test.mjs. The
// fourth (tickets.controller.ts's REST comment endpoint) applies the
// identical `if (quiescedForMentions) continue;` guard read from the same
// InstanceQuiesceService and is not independently re-tested here — the
// concern under test (does the quiesce check gate the emit) is shared code
// shape, not a distinct mechanism, and this file's job is to prove the
// PATTERN actually stops a real activityEvents emission end-to-end, which
// tickets.controller.ts's own existing REST test coverage does not exercise.
//
// Runs against compiled dist/ (requires `npm run build`). Isolated
// SQLJS_DB_PATH temp file — never touches the shared dev database/data.db.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');
const modPath = (...p) => 'file://' + path.join(DIST, ...p);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-comment-mention-quiesce-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'comment-mention-quiesce-test.db');
process.env.NODE_ENV = 'test';

const { buildDataSourceOptions } = await import(modPath('db.js'));
const { DataSource } = await import('typeorm');
const { Ticket } = await import(modPath('entities', 'Ticket.js'));
const { Comment } = await import(modPath('entities', 'Comment.js'));
const { Agent } = await import(modPath('entities', 'Agent.js'));
const { ActivityLog } = await import(modPath('entities', 'ActivityLog.js'));
const { ActivityService, activityEvents } = await import(modPath('services', 'activity.service.js'));
const { registerCommentTools } = await import(modPath('modules', 'mcp', 'tools', 'comment-tools.js'));

const ds = new DataSource(buildDataSourceOptions());
await ds.initialize();

const logStub = { warn() {}, info() {}, error() {}, debug() {} };
const activityService = new ActivityService(ds.getRepository(ActivityLog), ds.getRepository(Agent), logStub);
const ticketRepo = ds.getRepository(Ticket);
const agentRepo = ds.getRepository(Agent);

after(async () => {
  await ds.destroy();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function makeTicket(overrides = {}) {
  return ticketRepo.save(ticketRepo.create({ title: 'T', workspace_id: 'w1', pending_user_action: false, ...overrides }));
}
async function makeAgent(overrides = {}) {
  return agentRepo.save(agentRepo.create({ name: 'Mentioned Agent', workspace_id: 'w1', type: 'subagent', ...overrides }));
}
function parse(res) {
  return JSON.parse(res.content[0].text);
}
/** Captures every comment_mention emitted during `fn()`. */
async function captureCommentMentions(fn) {
  const captured = [];
  const listener = (payload) => captured.push(payload);
  activityEvents.on('comment_mention', listener);
  try {
    await fn();
  } finally {
    activityEvents.removeListener('comment_mention', listener);
  }
  return captured;
}

function registerTools(quiesced) {
  const handlers = new Map();
  const server = { tool(name, _description, _schema, handler) { handlers.set(name, handler); } };
  const mentionServiceStub = {
    parseMentions: (content) => (content.includes('@[agent:') ? [{}] : []),
    resolveMentions: async (_refs, _ticket, _opts) => [{ type: 'agent', id: registerTools._mentionedAgentId, roleShortcut: undefined }],
  };
  const ctx = {
    dataSource: ds, activityService, mentionService: mentionServiceStub,
    logger: logStub, ticketRoleAssignmentService: null, roomMessagingService: null,
    instanceQuiesceService: { isQuiesced: async () => quiesced },
  };
  registerCommentTools(server, ctx);
  return handlers;
}

test('add_comment: an @-mention does NOT emit comment_mention while the instance is quiesced, but the comment itself still saves', async () => {
  const mentioned = await makeAgent();
  registerTools._mentionedAgentId = mentioned.id;
  const t = await makeTicket();
  const handlers = registerTools(true);
  const addComment = handlers.get('add_comment');

  const captured = await captureCommentMentions(async () => {
    const res = parse(await addComment({
      ticket_id: t.id, content: '@[agent:' + mentioned.id + '|Mentioned] please look',
      author_type: 'user', author_id: 'u1', author: 'User',
    }, {}));
    assert.ok(res.id, 'the comment itself must still save even while quiesced');
  });
  assert.deepEqual(captured, [], 'no comment_mention may fire while the instance is quiesced');
});

test('add_comment: the SAME @-mention DOES emit comment_mention once the instance is not quiesced (sanity — proves the harness actually detects a real emission)', async () => {
  const mentioned = await makeAgent();
  registerTools._mentionedAgentId = mentioned.id;
  const t = await makeTicket();
  const handlers = registerTools(false);
  const addComment = handlers.get('add_comment');

  const captured = await captureCommentMentions(async () => {
    await addComment({
      ticket_id: t.id, content: '@[agent:' + mentioned.id + '|Mentioned] please look',
      author_type: 'user', author_id: 'u1', author: 'User',
    }, {});
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].agent_id, mentioned.id);
});

test('ask_question: an @-mention does NOT emit comment_mention while quiesced', async () => {
  const mentioned = await makeAgent();
  registerTools._mentionedAgentId = mentioned.id;
  const t = await makeTicket();
  const handlers = registerTools(true);
  const askQuestion = handlers.get('ask_question');

  const captured = await captureCommentMentions(async () => {
    const res = parse(await askQuestion({
      ticket_id: t.id, content: '@[agent:' + mentioned.id + '|Mentioned] what should I do?',
      author_type: 'user', author_id: 'u1', author: 'User',
    }, {}));
    assert.ok(res.id, 'the question comment itself must still save even while quiesced');
  });
  assert.deepEqual(captured, []);
});

test('handoff_to_agent: reassignment + comment still land while quiesced, but the immediate comment_mention wake-up is skipped', async () => {
  const targetAgent = await makeAgent({ name: 'Handoff Target' });
  registerTools._mentionedAgentId = targetAgent.id; // unused by this tool, but harmless
  const t = await makeTicket();
  const handlers = registerTools(true);
  const handoff = handlers.get('handoff_to_agent');

  const captured = await captureCommentMentions(async () => {
    const res = parse(await handoff({
      ticket_id: t.id, target_agent_id: targetAgent.id, content: 'picking this up, see context',
      author_type: 'user', author_id: 'u1', author: 'User',
    }, {}));
    assert.equal(res.ticket?.assignee_id, targetAgent.id, 'reassignment must still happen even while quiesced');
  });
  assert.deepEqual(captured, [], 'no immediate comment_mention wake-up while quiesced — the normal (also quiesce-gated) assignee-trigger cycle takes over once resumed');
});
