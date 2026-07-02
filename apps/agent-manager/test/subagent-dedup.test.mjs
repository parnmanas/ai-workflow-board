// One-shot SubagentManager dedup — the fallback path that runs when the
// persistent ticket-session path declines (cap_busy / spawn_failed / error).
//
// Covers ticket a5ab95ea scope ①, fallback half: `findDuplicateSpawn` must
// catch a second concurrent spawn for the same (ticket, role) even when the
// trigger carried an empty triggerId (field_changed-empty agent_trigger), so
// the one-shot fallback can't twin-spawn either. The pure helper is exercised
// directly so no CLI child is forked.
//
// Ticket 66bddd2e (VEG-R2-5 race) widened the (ticket, role) rule into a true
// single-flight guard: it now collapses a second spawn onto a live strand
// REGARDLESS of triggerId — two DISTINCT non-empty trigger ids for the same
// (ticket, role) seconds apart no longer twin-spawn.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findDuplicateSpawn, mentionTriggerId } from '../dist/lib/subagent-manager.js';

test('subagent dedup: unique trigger spawn is not a duplicate', () => {
  const records = [];
  const res = findDuplicateSpawn(records, {
    kind: 'trigger',
    triggerId: 't1',
    ticketId: 'ticket-a',
    role: 'assignee',
  });
  assert.equal(res, false);
});

test('subagent dedup: same non-empty triggerId is duplicate_trigger', () => {
  const records = [{ trigger_id: 't1', ticket_id: 'ticket-a', role: 'assignee' }];
  const res = findDuplicateSpawn(records, {
    kind: 'trigger',
    triggerId: 't1',
    ticketId: 'ticket-a',
    role: 'assignee',
  });
  assert.equal(res, 'duplicate_trigger');
});

test('subagent dedup: catches an in-flight RESERVATION (identity-bearing) for same trigger', () => {
  // Reservation records now carry identity; the dedup scan must see them so a
  // concurrent spawn collapses during the spawn window, before the real
  // SubagentRecord lands.
  const records = [
    { trigger_id: 't9', chat_request_id: null, ticket_id: 'ticket-z', role: 'reviewer' },
  ];
  const res = findDuplicateSpawn(records, {
    kind: 'trigger',
    triggerId: 't9',
    ticketId: 'ticket-z',
    role: 'reviewer',
  });
  assert.equal(res, 'duplicate_trigger');
});

test('subagent dedup: DISTINCT non-empty triggerId collapses on a live (ticket, role) strand', () => {
  // Ticket 66bddd2e (VEG-R2-5 race): two DIFFERENT non-empty trigger ids for
  // the same (ticket, role) arriving seconds apart must NOT twin-spawn while a
  // strand is alive. The live one-shot record carries trigger_id 't-old'; a
  // fresh trigger 't-new' for the same (ticket, role) is a single-flight
  // duplicate even though the ids differ (rule 1 would miss it).
  const records = [{ trigger_id: 't-old', ticket_id: 'ticket-a', role: 'assignee' }];
  const res = findDuplicateSpawn(records, {
    kind: 'trigger',
    triggerId: 't-new',
    ticketId: 'ticket-a',
    role: 'assignee',
  });
  assert.equal(res, 'duplicate_trigger', 'single-flight collapses distinct trigger id on live (ticket, role)');
});

test('subagent dedup: DISTINCT triggerId, DIFFERENT role still spawns (no false single-flight)', () => {
  // Single-flight is per (ticket, role): a reviewer trigger must still spawn
  // even while an assignee strand for the same ticket is alive.
  const records = [{ trigger_id: 't-old', ticket_id: 'ticket-a', role: 'assignee' }];
  const res = findDuplicateSpawn(records, {
    kind: 'trigger',
    triggerId: 't-new',
    ticketId: 'ticket-a',
    role: 'reviewer',
  });
  assert.equal(res, false, 'distinct role is a separate strand');
});

test('subagent dedup: DISTINCT mention triggerId still spawns on a live (ticket, role) strand', () => {
  // Ticket 66bddd2e review fix: a comment-mention spawn (triggerId
  // `mention:<commentId>`) is NEW work, not a duplicate re-trigger. A reviewer
  // asking the assignee a question while an assignee one-shot strand is still
  // alive must NOT be coalesced away (the strand can't take a follow-up turn,
  // so the comment would be silently lost). The single-flight (ticket, role)
  // rule is scoped to column triggers and must skip `mention:`-prefixed ids.
  const records = [{ trigger_id: 'mention:c1', ticket_id: 'ticket-a', role: 'assignee' }];
  const res = findDuplicateSpawn(records, {
    kind: 'trigger',
    triggerId: 'mention:c2', // a DIFFERENT comment mention for the same (ticket, role)
    ticketId: 'ticket-a',
    role: 'assignee',
  });
  assert.equal(res, false, 'distinct comment-mention is new work, not a single-flight duplicate');
});

test('subagent dedup: EXACT same mention triggerId is still deduped by rule 1', () => {
  // Idempotency for an exact redelivery of the SAME comment mention is still
  // handled by rule 1 (exact triggerId match) — only genuinely-new mentions
  // get past the single-flight gate.
  const records = [{ trigger_id: 'mention:c1', ticket_id: 'ticket-a', role: 'assignee' }];
  const res = findDuplicateSpawn(records, {
    kind: 'trigger',
    triggerId: 'mention:c1',
    ticketId: 'ticket-a',
    role: 'assignee',
  });
  assert.equal(res, 'duplicate_trigger', 'exact same comment mention is an idempotent redelivery');
});

test('subagent dedup: a mention spawn does NOT collapse onto a live COLUMN-trigger strand', () => {
  // The Review-loop case: an assignee column-trigger strand is alive (record
  // carries a real field_changed id), and the reviewer @-mentions the assignee.
  // The mention must still spawn so the question is read.
  const records = [{ trigger_id: 'field-xyz', ticket_id: 'ticket-a', role: 'assignee' }];
  const res = findDuplicateSpawn(records, {
    kind: 'trigger',
    triggerId: 'mention:c9',
    ticketId: 'ticket-a',
    role: 'assignee',
  });
  assert.equal(res, false, 'mention is new work even against a live column-trigger strand');
});

test('subagent dedup: SAME comment mention fans out to DIFFERENT holder agents (T7 리뷰 #2)', () => {
  // role 멘션(@[role:assignee])은 per-agent SSE 로 공동 홀더 수만큼 **같은
  // commentId** 이벤트가 도착한다. triggerId 에 agent 차원이 없으면 rule 1(exact
  // trigger_id)이 두 번째 홀더 스폰을 duplicate_trigger 로 drop — 그 홀더는
  // record_agreement 를 못 해 합의가 데드락된다. mentionTriggerId 가 agent 차원을
  // 붙여 홀더별로 스폰되게 한다.
  const records = [{
    trigger_id: mentionTriggerId('c1', 'agent-A'),
    ticket_id: 'ticket-a', role: 'assignee', agent_id: 'agent-A',
  }];
  const res = findDuplicateSpawn(records, {
    kind: 'trigger',
    triggerId: mentionTriggerId('c1', 'agent-B'), // 같은 comment, 다른 공동 홀더
    ticketId: 'ticket-a', role: 'assignee', agentId: 'agent-B',
  });
  assert.equal(res, false, 'same comment fanned out to a second holder agent must spawn');
});

test('subagent dedup: SAME (comment, agent) mention redelivery is still deduped by rule 1', () => {
  const records = [{
    trigger_id: mentionTriggerId('c1', 'agent-A'),
    ticket_id: 'ticket-a', role: 'assignee', agent_id: 'agent-A',
  }];
  const res = findDuplicateSpawn(records, {
    kind: 'trigger',
    triggerId: mentionTriggerId('c1', 'agent-A'), // 정확히 같은 (comment, agent) 재전달
    ticketId: 'ticket-a', role: 'assignee', agentId: 'agent-A',
  });
  assert.equal(res, 'duplicate_trigger', 'exact (comment, agent) redelivery stays idempotent');
});

test('subagent dedup: agent-차원 mention id 도 rule 3 mention 예외를 그대로 탄다', () => {
  // startsWith('mention:') 는 3-세그먼트 형태(mention:<commentId>:<agentId>)에도
  // 참 — 같은 홀더의 라이브 컬럼-트리거 스트랜드가 있어도 새 멘션은 스폰된다.
  const records = [{ trigger_id: 'trig-live', ticket_id: 'ticket-a', role: 'assignee', agent_id: 'agent-A' }];
  const res = findDuplicateSpawn(records, {
    kind: 'trigger',
    triggerId: mentionTriggerId('c9', 'agent-A'),
    ticketId: 'ticket-a', role: 'assignee', agentId: 'agent-A',
  });
  assert.equal(res, false, 'mention must not collapse onto the same holder\'s live column-trigger strand');
});

test('subagent dedup: EMPTY triggerId collapses on matching (ticket, role)', () => {
  const records = [{ trigger_id: null, ticket_id: 'ticket-a', role: 'assignee' }];
  const res = findDuplicateSpawn(records, {
    kind: 'trigger',
    triggerId: '', // field_changed-empty agent_trigger
    ticketId: 'ticket-a',
    role: 'assignee',
  });
  assert.equal(res, 'duplicate_trigger', 'fallback (ticket, role) dedup fires');
});

test('subagent dedup: EMPTY triggerId, DIFFERENT role does NOT collapse', () => {
  const records = [{ trigger_id: null, ticket_id: 'ticket-a', role: 'reviewer' }];
  const res = findDuplicateSpawn(records, {
    kind: 'trigger',
    triggerId: '',
    ticketId: 'ticket-a',
    role: 'assignee', // different role → separate session, must spawn
  });
  assert.equal(res, false, 'role isolation preserved');
});

test('subagent dedup: EMPTY triggerId, DIFFERENT ticket does NOT collapse', () => {
  const records = [{ trigger_id: null, ticket_id: 'ticket-a', role: 'assignee' }];
  const res = findDuplicateSpawn(records, {
    kind: 'trigger',
    triggerId: '',
    ticketId: 'ticket-b',
    role: 'assignee',
  });
  assert.equal(res, false);
});

test('subagent dedup: (ticket, role) fallback does NOT apply to chat spawns', () => {
  // Chat spawns carry no role; an empty-key chat spawn must never merge onto a
  // ticket record sharing the same blank role.
  const records = [{ trigger_id: null, ticket_id: 'ticket-a', role: null }];
  const res = findDuplicateSpawn(records, {
    kind: 'chat',
    triggerId: '',
    ticketId: 'ticket-a',
    role: '',
  });
  assert.equal(res, false, 'chat kind is exempt from the ticket-role fallback');
});

test('subagent dedup: same chatRequestId is duplicate_chat', () => {
  const records = [{ chat_request_id: 'msg:u1:ts', ticket_id: null, role: null }];
  const res = findDuplicateSpawn(records, {
    kind: 'chat',
    chatRequestId: 'msg:u1:ts',
  });
  assert.equal(res, 'duplicate_chat');
});

test('subagent dedup: role compared as empty-vs-empty (null === "")', () => {
  // A record with role=null and a spec with role='' (both "no role") must be
  // treated as the same role for the empty-triggerId fallback.
  const records = [{ trigger_id: null, ticket_id: 'ticket-a', role: null }];
  const res = findDuplicateSpawn(records, {
    kind: 'trigger',
    triggerId: '',
    ticketId: 'ticket-a',
    role: '',
  });
  assert.equal(res, 'duplicate_trigger');
});

// ─── 다중담당자 팬아웃 (T2/T7): (ticket, role, agent) 단일-플라이트 ──────────

test('subagent dedup: same (ticket, role) but DIFFERENT holder agents both spawn', () => {
  // 다중담당자 팬아웃: agent-A 의 strand 가 살아있는 동안 도착한 agent-B(같은
  // ticket, 같은 role 의 공동 홀더) 트리거를 drop 하면 B 는 자기 identity 로
  // record_agreement 를 못 해 합의가 데드락된다 — 반드시 별개 스폰.
  const records = [{ trigger_id: 't-old', ticket_id: 'ticket-a', role: 'assignee', agent_id: 'agent-A' }];
  const res = findDuplicateSpawn(records, {
    kind: 'trigger',
    triggerId: 't-new',
    ticketId: 'ticket-a',
    role: 'assignee',
    agentId: 'agent-B',
  });
  assert.equal(res, false, 'distinct holder agent is a separate strand, not a duplicate');
});

test('subagent dedup: same (ticket, role) AND same agent still collapses (single-flight kept)', () => {
  const records = [{ trigger_id: 't-old', ticket_id: 'ticket-a', role: 'assignee', agent_id: 'agent-A' }];
  const res = findDuplicateSpawn(records, {
    kind: 'trigger',
    triggerId: 't-new',
    ticketId: 'ticket-a',
    role: 'assignee',
    agentId: 'agent-A',
  });
  assert.equal(res, 'duplicate_trigger', 'same holder re-trigger stays single-flight');
});

test('subagent dedup: agent unknown on the RECORD side falls back to (ticket, role) collapse', () => {
  // 레거시 무회귀: 어느 한쪽이라도 agent 신원이 없으면 종전 (ticket, role)
  // 단일-플라이트를 유지한다(식별 불가 상태에서 팬아웃 허용 시 twin-spawn 재발).
  const records = [{ trigger_id: 't-old', ticket_id: 'ticket-a', role: 'assignee' }];
  const res = findDuplicateSpawn(records, {
    kind: 'trigger',
    triggerId: 't-new',
    ticketId: 'ticket-a',
    role: 'assignee',
    agentId: 'agent-B',
  });
  assert.equal(res, 'duplicate_trigger', 'unknown record agent keeps legacy single-flight');
});

test('subagent dedup: agent unknown on the SPEC side falls back to (ticket, role) collapse', () => {
  const records = [{ trigger_id: 't-old', ticket_id: 'ticket-a', role: 'assignee', agent_id: 'agent-A' }];
  const res = findDuplicateSpawn(records, {
    kind: 'trigger',
    triggerId: 't-new',
    ticketId: 'ticket-a',
    role: 'assignee',
    agentId: '',
  });
  assert.equal(res, 'duplicate_trigger', 'unknown spec agent keeps legacy single-flight');
});
