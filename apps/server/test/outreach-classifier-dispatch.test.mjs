// Behavioral tests for AgentDispatchClassifier + ClassificationBridgeService
// (ticket 20fa0197 — real LLM-backed OutreachClassifier via async agent
// dispatch). No NestJS DI, no HTTP server — repos/messaging are stubbed
// (mirrors outreach-ingest.test.mjs's style); only ClassificationBridgeService
// itself is real, since the wait/resolve/timeout logic is what's under test.
//
//   • classifier_agent_id unset → classify() returns RuleBasedClassifier's
//     result immediately; no room/participant/message is ever created.
//   • classifier_agent_id set but the agent doesn't exist → same fallback,
//     no dispatch attempted (the lookup fails before any room is created).
//   • classifier_agent_id set, dispatch succeeds, the SAME agent reports back
//     via ClassificationBridgeService.report() with the run_id embedded in
//     the dispatched prompt → classify() resolves with the REPORTED
//     category/confidence, not the rule-based fallback.
//   • nobody reports back before the (test-shortened) timeout → classify()
//     falls back to RuleBasedClassifier rather than hanging forever.
//   • ClassificationBridgeService.report() rejects a wrong run_id, an
//     unknown run_id, and a run_id reported by an agent other than the one
//     it was dispatched to — and is single-shot (a second report on an
//     already-resolved run_id is a no-op).

import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentDispatchClassifier, MIN_TIMEOUT_MS } from '../dist/modules/outreach/classifier/agent-dispatch.classifier.js';
import { ClassificationBridgeService } from '../dist/modules/outreach/classifier/classification-bridge.service.js';
import { RuleBasedClassifier } from '../dist/modules/outreach/classifier/rule-based.classifier.js';

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function item(over = {}) {
  return {
    external_item_id: 'item-1',
    title: 'crash on save',
    body: 'the app crashes whenever I click save',
    author: 'alice',
    permalink: 'https://example.com/item-1',
    created_at: new Date('2026-06-25T10:00:00Z'),
    ...over,
  };
}

function context(over = {}) {
  return {
    workspaceId: 'ws-1',
    channelId: 'chan-1',
    channelKind: 'github',
    classifierAgentId: null,
    ...over,
  };
}

function makeAgentRepo(agents) {
  return { async findOne({ where: { id } }) { return agents.find((a) => a.id === id) || null; } };
}

function makeRoomRepo() {
  const rooms = [];
  return {
    rooms,
    create(v) { return { id: `room-${rooms.length + 1}`, ...v }; },
    async save(v) { rooms.push(v); return v; },
  };
}

function makeParticipantRepo() {
  const saved = [];
  return {
    saved,
    create(v) { return v; },
    async save(v) { saved.push(...(Array.isArray(v) ? v : [v])); return v; },
  };
}

// `onSend` fires synchronously inside sendMessage's body, i.e. strictly
// after roomRepo.save/participantRepo.save have already resolved (they're
// awaited earlier in the same sequential dispatch) — a test can await it
// instead of guessing a fixed number of microtask ticks (see board runbook
// lesson on bounded-condition waits, not settle-count waits).
function makeMessaging(onSend) {
  const calls = [];
  return {
    calls,
    async sendMessage(roomId, workspaceId, senderType, senderId, senderName, content) {
      calls.push({ roomId, workspaceId, senderType, senderId, senderName, content });
      onSend?.();
      return {};
    },
  };
}

function extractRunId(prompt) {
  const m = /run_id="([0-9a-f-]+)"/.exec(prompt);
  assert.ok(m, `prompt did not embed a run_id: ${prompt}`);
  return m[1];
}

function makeClassifier({ agents = [], timeoutMs, onSend } = {}) {
  if (timeoutMs !== undefined) process.env.OUTREACH_CLASSIFIER_TIMEOUT_MS = String(timeoutMs);
  else delete process.env.OUTREACH_CLASSIFIER_TIMEOUT_MS;
  const agentRepo = makeAgentRepo(agents);
  const roomRepo = makeRoomRepo();
  const participantRepo = makeParticipantRepo();
  const messaging = makeMessaging(onSend);
  const bridge = new ClassificationBridgeService();
  const classifier = new AgentDispatchClassifier(roomRepo, participantRepo, agentRepo, messaging, bridge, noopLog);
  delete process.env.OUTREACH_CLASSIFIER_TIMEOUT_MS;
  return { classifier, roomRepo, participantRepo, messaging, bridge };
}

test('classifier_agent_id unset falls back to rule-based, no dispatch', async () => {
  const { classifier, roomRepo, messaging } = makeClassifier();
  const rb = new RuleBasedClassifier();
  const expected = await rb.classify(item());

  const result = await classifier.classify(item(), context({ classifierAgentId: null }));

  assert.deepEqual(result, expected);
  assert.equal(roomRepo.rooms.length, 0);
  assert.equal(messaging.calls.length, 0);
});

test('classifier_agent_id set but agent not found falls back to rule-based, no dispatch', async () => {
  const { classifier, roomRepo, messaging } = makeClassifier({ agents: [] });
  const rb = new RuleBasedClassifier();
  const expected = await rb.classify(item());

  const result = await classifier.classify(item(), context({ classifierAgentId: 'agent-missing' }));

  assert.deepEqual(result, expected);
  assert.equal(roomRepo.rooms.length, 0);
  assert.equal(messaging.calls.length, 0);
});

test('dispatch + matching report resolves with the reported classification', async () => {
  const sent = deferred();
  const { classifier, roomRepo, participantRepo, messaging, bridge } = makeClassifier({
    agents: [{ id: 'agent-1', workspace_id: 'ws-1' }],
    onSend: sent.resolve,
  });

  const classifyPromise = classifier.classify(item(), context({ classifierAgentId: 'agent-1' }));

  // Wait for the actual observable event (the dispatch prompt being sent),
  // not a guessed number of microtask ticks — sendMessage is the last step
  // of _dispatch, so by the time it fires, room + participant saves (both
  // awaited earlier in the same sequential call) are already done.
  await sent.promise;
  assert.equal(roomRepo.rooms.length, 1);
  assert.equal(participantRepo.saved.length, 2);
  assert.ok(participantRepo.saved.some((p) => p.participant_type === 'agent' && p.participant_id === 'agent-1'));
  assert.equal(messaging.calls.length, 1);

  const runId = extractRunId(messaging.calls[0].content);
  const accepted = bridge.report(runId, 'agent-1', 'bug', 92);
  assert.equal(accepted, true);

  const result = await classifyPromise;
  assert.deepEqual(result, { category: 'bug', confidence: 92 });
});

test('report from the wrong agent, or with an unknown run_id, is rejected', async () => {
  const { bridge } = makeClassifier();
  const { runId } = bridge.register('agent-1', 5_000);

  assert.equal(bridge.report('not-a-real-run-id', 'agent-1', 'bug', 90), false);
  assert.equal(bridge.report(runId, 'agent-2', 'bug', 90), false);

  // The legitimate report still works afterward — a bad attempt doesn't
  // consume or corrupt the pending entry.
  assert.equal(bridge.report(runId, 'agent-1', 'bug', 90), true);
  // Single-shot: reporting again on the same (now-resolved) run_id no-ops.
  assert.equal(bridge.report(runId, 'agent-1', 'noise', 10), false);
});

test('no report before timeout falls back to rule-based', async () => {
  // MIN_TIMEOUT_MS is clampEnv's floor — anything lower is silently clamped
  // up to it, so drive the real floor rather than an arbitrary small number.
  const { classifier, bridge } = makeClassifier({
    agents: [{ id: 'agent-1', workspace_id: 'ws-1' }],
    timeoutMs: MIN_TIMEOUT_MS,
  });
  const rb = new RuleBasedClassifier();
  const expected = await rb.classify(item());

  const result = await classifier.classify(item(), context({ classifierAgentId: 'agent-1' }));

  assert.deepEqual(result, expected);
  assert.equal(bridge.pendingCount(), 0, 'timed-out entry must not linger in the pending map');
});
