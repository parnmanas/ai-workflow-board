// Behavioural + static regression — ticket e9c8e1d6 ([하드닝] 라이브 persistent
// 세션의 current_task 15분 TTL 만료 → supervisor 재emit이 불필요 follow-up turn
// 주입).
//
// Root cause: agent-manager stamps set_current_task exactly ONCE at spawn and
// never refreshes it, so `active_tasks[ticket].claimed_at` ages out at
// CURRENT_TASK_STALE_MS (15 min). A live strand that spends >15 min producing
// tokens WITHOUT a ticket-write therefore looks dead to the in-flight-strand
// gate (hasLiveRoleStrand), the server stops dropping the supervisor's periodic
// non-force nudge, and the manager collapses each nudge into a redundant
// follow-up turn on the still-live session — token waste / work disruption
// (no twin; the manager's session-key dedup is intact).
//
// Fix (server-only): hasLiveRoleStrand now ALSO recognizes a fresh
// per-(agent,ticket,role) OUTPUT-liveness timestamp (refreshed on every
// model-output post, already ingested by AgentStatusService) within the same
// CURRENT_TASK_STALE_MS horizon. A genuinely idle/wedged strand emits no output,
// ages past the horizon on both paths, and still receives the nudge (recovery
// preserved). No SSE/plugin/agent-manager change — output-liveness is already
// posted and stored.
//
// No NestJS boot: the service is constructed directly with hand-rolled fakes,
// mirroring agent-status-supervisor-eviction.test.mjs / supervisor-output-
// liveness.test.mjs (fast + deterministic).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'src');
const DIST = path.join(__dirname, '..', 'dist');

async function loadDist(relParts) {
  const url = 'file://' + path.join(DIST, ...relParts);
  try {
    return await import(url);
  } catch (err) {
    throw new Error(
      'This test requires the server to be built first. Run `npm run --workspace=apps/server build`. Original error: ' +
        err.message,
    );
  }
}
function readSrc(relParts) {
  return fs.readFileSync(path.join(SRC, ...relParts), 'utf8');
}

const noopLog = { info() {}, warn() {}, error() {}, debug() {}, log() {} };
const STALE_MS = 15 * 60_000; // CURRENT_TASK_STALE_MS mirror
const AGO = (ms) => new Date(Date.now() - ms);

async function makeStatus() {
  const { AgentStatusService } = await loadDist(['modules', 'agents', 'agent-status.service.js']);
  const { MemoryMetricsRegistry } = await loadDist(['services', 'memory-metrics.registry.js']);
  const agentRepo = { async find() { return []; }, async update() {} };
  const dataSource = { getRepository: () => ({ async findOne() { return null; } }) };
  return new AgentStatusService(agentRepo, dataSource, noopLog, new MemoryMetricsRegistry());
}

// Seed a current_task (active_tasks entry) directly, exactly like the eviction
// test seeds `state` — avoids setCurrentTask's async DB/emit machinery.
function seedTask(service, agentId, ticketId, role, claimedAt) {
  service.state.set(agentId, {
    agent_id: agentId,
    is_online: true,
    last_seen_at: new Date(),
    active_tasks: new Map([[ticketId, { ticket_id: ticketId, ticket_title: 't', claimed_at: claimedAt, role }]]),
  });
}
// Backdate an output-liveness entry to a specific age (recordOutputLiveness
// always stamps `now`, so we reach into the role-keyed map for stale cases).
function setOutputAge(service, agentId, ticketId, role, ageMs) {
  service.outputLiveness.set(service._outputLivenessKey(agentId, ticketId, role), Date.now() - ageMs);
}

// ── Path 1 (current_task) — unchanged behaviour ─────────────────────────────

test('path1: fresh current_task with matching role → live (regression)', async () => {
  const s = await makeStatus();
  seedTask(s, 'A', 't1', 'assignee', new Date());
  assert.equal(s.hasLiveRoleStrand('A', 't1', 'assignee'), true);
});

test('path1: a live ASSIGNEE current_task does NOT block a REVIEWER trigger (role isolation)', async () => {
  const s = await makeStatus();
  seedTask(s, 'A', 't1', 'assignee', new Date());
  assert.equal(s.hasLiveRoleStrand('A', 't1', 'reviewer'), false);
});

test('path1: undefined role on the live task matches any role (pre-v0.34 conservatism)', async () => {
  const s = await makeStatus();
  seedTask(s, 'A', 't1', undefined, new Date());
  assert.equal(s.hasLiveRoleStrand('A', 't1', 'assignee'), true);
  assert.equal(s.hasLiveRoleStrand('A', 't1', 'reviewer'), true);
});

test('path1: stale current_task and NO output-liveness → not live (recovery nudge allowed)', async () => {
  const s = await makeStatus();
  seedTask(s, 'A', 't1', 'assignee', AGO(STALE_MS + 60_000)); // 16 min old
  assert.equal(s.hasLiveRoleStrand('A', 't1', 'assignee'), false);
});

// ── Path 2 (output-liveness) — the fix ──────────────────────────────────────

test('FIX: stale current_task + fresh output-liveness → live (the reported scenario)', async () => {
  const s = await makeStatus();
  // spawn stamped current_task 16 min ago; no ticket-write since → path 1 stale
  seedTask(s, 'A', 't1', 'assignee', AGO(STALE_MS + 60_000));
  // but the strand kept producing tokens → output-liveness is fresh
  s.recordOutputLiveness('A', 't1', 'assignee');
  assert.equal(
    s.hasLiveRoleStrand('A', 't1', 'assignee'),
    true,
    'a producing strand past the 15-min current_task TTL is still recognized → supervisor non-force nudge is dropped, no redundant follow-up turn injected',
  );
});

test('FIX: no current_task at all + fresh output-liveness → live', async () => {
  const s = await makeStatus();
  // never seeded active_tasks (state has no entry for A) — output-liveness alone
  s.recordOutputLiveness('A', 't1', 'assignee');
  assert.equal(s.hasLiveRoleStrand('A', 't1', 'assignee'), true);
});

test('recovery preserved: stale current_task + STALE output-liveness → not live (nudge fires)', async () => {
  const s = await makeStatus();
  seedTask(s, 'A', 't1', 'assignee', AGO(STALE_MS + 5 * 60_000)); // 20 min old
  setOutputAge(s, 'A', 't1', 'assignee', STALE_MS + 60_000);      // last token 16 min ago
  assert.equal(
    s.hasLiveRoleStrand('A', 't1', 'assignee'),
    false,
    'a strand silent on BOTH signals past the horizon is genuinely idle/wedged → the supervisor nudge (and later force_respawn) must reach it',
  );
});

test('output-liveness is role-keyed: fresh ASSIGNEE output does not mark a REVIEWER seat live', async () => {
  const s = await makeStatus();
  s.recordOutputLiveness('A', 't1', 'assignee');
  assert.equal(s.hasLiveRoleStrand('A', 't1', 'assignee'), true);
  assert.equal(s.hasLiveRoleStrand('A', 't1', 'reviewer'), false);
});

test('boundary: output-liveness just inside the horizon is live, just outside is not', async () => {
  const s = await makeStatus();
  setOutputAge(s, 'A', 't1', 'assignee', STALE_MS - 60_000); // 14 min — inside
  assert.equal(s.hasLiveRoleStrand('A', 't1', 'assignee'), true, '14 min < 15 min → live');
  setOutputAge(s, 'A', 't1', 'assignee', STALE_MS + 60_000); // 16 min — outside
  assert.equal(s.hasLiveRoleStrand('A', 't1', 'assignee'), false, '16 min > 15 min → not live');
});

test('defensive: empty agent_id / ticket_id short-circuits to false', async () => {
  const s = await makeStatus();
  s.recordOutputLiveness('A', 't1', 'assignee');
  assert.equal(s.hasLiveRoleStrand('', 't1', 'assignee'), false);
  assert.equal(s.hasLiveRoleStrand('A', '', 'assignee'), false);
});

// ── Static guard — a refactor must not silently drop the second signal ───────

test('static: hasLiveRoleStrand consults output-liveness as a second liveness signal', () => {
  const raw = readSrc(['modules', 'agents', 'agent-status.service.ts']);
  assert.match(
    raw,
    /hasLiveRoleStrand\([\s\S]*?getOutputLivenessAt\(agent_id, ticket_id, role\)[\s\S]*?return false;\n  \}/,
    'hasLiveRoleStrand must read getOutputLivenessAt(agent_id, ticket_id, role) before returning false',
  );
});
