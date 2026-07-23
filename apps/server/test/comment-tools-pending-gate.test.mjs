// pending_user_action gate for the Q&A-family MCP tools (ticket 8fc94adf,
// follow-up to a940d75b/50b92d71). Only `add_comment` enforced the pend-state
// short-circuit (via applyAgentCommentPingPongGuard's ticket.pending_user_action
// check in agent-comment-pingpong.ts) — ask_question / answer_question /
// record_decision / handoff_to_agent had the hard-budget ceiling but not this
// gate, so an agent could keep asking/answering/deciding/handing off while a
// human was supposed to unpend the ticket first. This pins the ported guard
// (isPendingUserActionBlocked) on all 4 tools: an agent-authored call is
// suppressed and nothing is saved while pending, a user-authored call still
// goes through (clearing pending_user_action is itself a human action), and
// the agent path succeeds again once pending clears.
//
// Runs against compiled dist/ (requires `npm run build`, satisfied by the
// test script) with a REAL sql.js DataSource — same recipe as
// misc-tools-batch-comment-budget.test.mjs — using an isolated SQLJS_DB_PATH
// temp file so it never touches the shared dev database/data.db.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-comment-tools-pending-gate-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'comment-tools-pending-gate-test.db');
process.env.NODE_ENV = 'test';

const { buildDataSourceOptions } = await import('file://' + path.join(DIST, 'db.js'));
const { DataSource } = await import('typeorm');
const { Ticket } = await import('file://' + path.join(DIST, 'entities', 'Ticket.js'));
const { Comment } = await import('file://' + path.join(DIST, 'entities', 'Comment.js'));
const { Agent } = await import('file://' + path.join(DIST, 'entities', 'Agent.js'));
const { ActivityLog } = await import('file://' + path.join(DIST, 'entities', 'ActivityLog.js'));
const { ActivityService } = await import('file://' + path.join(DIST, 'services', 'activity.service.js'));
const { registerCommentTools } = await import('file://' + path.join(DIST, 'modules', 'mcp', 'tools', 'comment-tools.js'));

const ds = new DataSource(buildDataSourceOptions());
await ds.initialize();

const logStub = { warn() {}, info() {}, error() {}, debug() {} };
const activityService = new ActivityService(ds.getRepository(ActivityLog), ds.getRepository(Agent), logStub);
const mentionServiceStub = { parseMentions: () => [] };

const ticketRepo = ds.getRepository(Ticket);
const commentRepo = ds.getRepository(Comment);
const agentRepo = ds.getRepository(Agent);

function registerTools() {
  const handlers = new Map();
  const server = { tool(name, _description, _schema, handler) { handlers.set(name, handler); } };
  const ctx = {
    dataSource: ds, activityService, mentionService: mentionServiceStub,
    logger: logStub, ticketRoleAssignmentService: null, roomMessagingService: null,
  };
  registerCommentTools(server, ctx);
  return handlers;
}

async function makeTicket(overrides = {}) {
  return ticketRepo.save(ticketRepo.create({
    title: 'T', workspace_id: 'w1', pending_user_action: false, ...overrides,
  }));
}
async function makeAgent(overrides = {}) {
  return agentRepo.save(agentRepo.create({ name: 'Agent', ...overrides }));
}
function parse(res) {
  return JSON.parse(res.content[0].text);
}

after(async () => {
  await ds.destroy();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('ask_question: agent call suppressed while pending, no comment saved', async () => {
  const handlers = registerTools();
  const t = await makeTicket({ pending_user_action: true, pending_reason: 'r' });
  const before = await commentRepo.count({ where: { ticket_id: t.id } });

  const res = await handlers.get('ask_question')({
    ticket_id: t.id, content: '질문 있습니다', author_type: 'agent', author_id: 'a1', author: 'A',
  }, {});
  assert.deepEqual(parse(res), { suppressed: true, reason: 'pending_user_action' });

  const afterCount = await commentRepo.count({ where: { ticket_id: t.id } });
  assert.equal(afterCount, before, 'no comment row must be saved while pending');
});

test('ask_question: user-authored call still goes through while pending (only agents are gated)', async () => {
  const handlers = registerTools();
  const t = await makeTicket({ pending_user_action: true, pending_reason: 'r' });

  const res = await handlers.get('ask_question')({
    ticket_id: t.id, content: '사람 질문', author_type: 'user', author_id: 'u1', author: 'U',
  }, {});
  assert.equal(parse(res).type, 'question');
});

test('ask_question: agent call succeeds once pending clears', async () => {
  const handlers = registerTools();
  const t = await makeTicket({ pending_user_action: false });

  const res = await handlers.get('ask_question')({
    ticket_id: t.id, content: '질문', author_type: 'agent', author_id: 'a1', author: 'A',
  }, {});
  assert.equal(parse(res).type, 'question');
});

test('answer_question: agent call suppressed while pending — no answer saved, question stays open', async () => {
  const handlers = registerTools();
  const t = await makeTicket({ pending_user_action: false });
  const question = await commentRepo.save(commentRepo.create({
    ticket_id: t.id, author_type: 'user', author: 'U', content: 'Q?', type: 'question', status: 'open',
  }));
  await ticketRepo.update({ id: t.id }, { pending_user_action: true, pending_reason: 'r' });

  const before = await commentRepo.count({ where: { ticket_id: t.id } });
  const res = await handlers.get('answer_question')({
    question_comment_id: question.id, content: '답변', author_type: 'agent', author_id: 'a1', author: 'A',
  }, {});
  assert.deepEqual(parse(res), { suppressed: true, reason: 'pending_user_action' });

  const afterCount = await commentRepo.count({ where: { ticket_id: t.id } });
  assert.equal(afterCount, before, 'no answer row must be saved while pending');

  const reloadedQuestion = await commentRepo.findOne({ where: { id: question.id } });
  assert.equal(reloadedQuestion.status, 'open', 'a suppressed answer must not auto-resolve the question');
});

test('record_decision: agent call suppressed while pending, no comment saved', async () => {
  const handlers = registerTools();
  const t = await makeTicket({ pending_user_action: true, pending_reason: 'r' });
  const before = await commentRepo.count({ where: { ticket_id: t.id } });

  const res = await handlers.get('record_decision')({
    ticket_id: t.id, content: '결정 내용', author_type: 'agent', author_id: 'a1', author: 'A',
  }, {});
  assert.deepEqual(parse(res), { suppressed: true, reason: 'pending_user_action' });

  const afterCount = await commentRepo.count({ where: { ticket_id: t.id } });
  assert.equal(afterCount, before, 'no decision row must be saved while pending');
});

test('handoff_to_agent: agent call suppressed while pending — no comment AND no reassignment', async () => {
  const handlers = registerTools();
  const originalAssignee = await makeAgent({ name: 'Original' });
  const targetAgent = await makeAgent({ name: 'Target' });
  const t = await makeTicket({
    pending_user_action: true, pending_reason: 'r',
    assignee_id: originalAssignee.id, assignee: 'Original',
  });
  const before = await commentRepo.count({ where: { ticket_id: t.id } });

  const res = await handlers.get('handoff_to_agent')({
    ticket_id: t.id, target_agent_id: targetAgent.id, content: '인계합니다',
    author_type: 'agent', author_id: 'a1', author: 'A',
  }, {});
  assert.deepEqual(parse(res), { suppressed: true, reason: 'pending_user_action' });

  const afterCount = await commentRepo.count({ where: { ticket_id: t.id } });
  assert.equal(afterCount, before, 'no handoff comment must be saved while pending');

  const reloaded = await ticketRepo.findOne({ where: { id: t.id } });
  assert.equal(reloaded.assignee_id, originalAssignee.id, 'reassignment must be blocked too — pending gates the whole handoff, not just the comment');
});

test('handoff_to_agent: succeeds once pending clears', async () => {
  const handlers = registerTools();
  const targetAgent = await makeAgent({ name: 'Target2' });
  const t = await makeTicket({ pending_user_action: false });

  const res = await handlers.get('handoff_to_agent')({
    ticket_id: t.id, target_agent_id: targetAgent.id, content: '인계',
    author_type: 'agent', author_id: 'a1', author: 'A',
  }, {});
  assert.equal(parse(res).ticket.assignee_id, targetAgent.id);
});
