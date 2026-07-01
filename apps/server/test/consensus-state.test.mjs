// Unit test — 다중담당자·합의 T4 판정 모델 (`computeConsensusState` + metadata 브릿지).
//
// DoD: 전원 만장일치 / 부분 / 이의 / stale(제안 교체) / reporter override /
// 홀더 1명 즉시-합의 를 순수 함수로 고정한다. DB·Nest 없이 검증되도록
// `common/consensus-state.ts` 로 분리된 로직만 임포트한다.
//
// Imports the compiled module from dist/ (built by `npm run build`).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist', 'common', 'consensus-state.js');
const {
  computeConsensusState,
  buildConsensusMetadata,
  parseConsensusVote,
} = await import('file://' + DIST);

const agent = (id) => ({ type: 'agent', id });
const user = (id) => ({ type: 'user', id });
// vote helper — at defaults ascending by call so "latest" is predictable.
const vote = (by, status, proposalId = 'p1', at = 1000, override = false) => ({
  by, status, proposalId, at, ...(override ? { override: true } : {}),
});

const keys = (arr) => arr.map((p) => `${p.type}:${p.id}`).sort();

// ─── 전원 만장일치 ────────────────────────────────────────────────────
test('전원 agree → satisfied', () => {
  const s = computeConsensusState({
    requiredHolders: [agent('a'), agent('b')],
    votes: [vote(agent('a'), 'agree'), vote(agent('b'), 'agree')],
    proposalId: 'p1',
  });
  assert.equal(s.satisfied, true);
  assert.deepEqual(keys(s.agreed), ['agent:a', 'agent:b']);
  assert.deepEqual(s.pending, []);
  assert.deepEqual(s.objected, []);
  assert.equal(s.overriddenBy, undefined);
});

// ─── 부분 합의 ────────────────────────────────────────────────────────
test('일부만 agree, 나머지 미투표 → pending, not satisfied', () => {
  const s = computeConsensusState({
    requiredHolders: [agent('a'), agent('b')],
    votes: [vote(agent('a'), 'agree')],
    proposalId: 'p1',
  });
  assert.equal(s.satisfied, false);
  assert.deepEqual(keys(s.agreed), ['agent:a']);
  assert.deepEqual(keys(s.pending), ['agent:b']);
});

// ─── 이의 ─────────────────────────────────────────────────────────────
test('한 홀더가 object → satisfied=false, objected 에 표기', () => {
  const s = computeConsensusState({
    requiredHolders: [agent('a'), agent('b')],
    votes: [vote(agent('a'), 'agree'), vote(agent('b'), 'object')],
    proposalId: 'p1',
  });
  assert.equal(s.satisfied, false);
  assert.deepEqual(keys(s.objected), ['agent:b']);
  assert.deepEqual(keys(s.agreed), ['agent:a']);
});

test('최신 시그널만 유효 — object 후 agree 로 갱신하면 agreed', () => {
  const s = computeConsensusState({
    requiredHolders: [agent('a')],
    votes: [vote(agent('a'), 'object', 'p1', 1000), vote(agent('a'), 'agree', 'p1', 2000)],
    proposalId: 'p1',
  });
  assert.equal(s.satisfied, true);
  assert.deepEqual(keys(s.agreed), ['agent:a']);
});

// ─── stale (제안 교체) ────────────────────────────────────────────────
test('새 제안이 이전 승인을 무효화 → 전원 agree 였어도 pending', () => {
  const s = computeConsensusState({
    requiredHolders: [agent('a'), agent('b')],
    votes: [vote(agent('a'), 'agree', 'p1'), vote(agent('b'), 'agree', 'p1')],
    proposalId: 'p2', // 새 이동 제안
  });
  assert.equal(s.satisfied, false);
  assert.deepEqual(keys(s.pending), ['agent:a', 'agent:b']);
  assert.equal(s.proposalId, 'p2');
});

test('앵커 미지정 시 최신 제안(non-null)이 앵커가 된다', () => {
  const s = computeConsensusState({
    requiredHolders: [agent('a')],
    votes: [vote(agent('a'), 'agree', 'p1', 1000), vote(agent('a'), 'agree', 'p2', 2000)],
    // proposalId 생략
  });
  assert.equal(s.proposalId, 'p2');
  assert.equal(s.satisfied, true); // 최신 vote 가 p2 agree
});

// ─── reporter override ────────────────────────────────────────────────
test('reporter override 는 이의가 있어도 강제 통과', () => {
  const s = computeConsensusState({
    requiredHolders: [agent('a'), agent('b')],
    reporterHolders: [agent('r')],
    votes: [
      vote(agent('a'), 'object', 'p1'),
      vote(agent('r'), 'agree', 'p1', 1500, true), // override
    ],
    proposalId: 'p1',
  });
  assert.equal(s.satisfied, true);
  assert.deepEqual(s.overriddenBy, { type: 'agent', id: 'r' });
  assert.deepEqual(keys(s.objected), ['agent:a']); // 이의는 그대로 기록
});

test('stale override 는 새 제안을 통과시키지 못한다', () => {
  const s = computeConsensusState({
    requiredHolders: [agent('a')],
    reporterHolders: [agent('r')],
    votes: [vote(agent('r'), 'agree', 'p1', 1000, true)],
    proposalId: 'p2',
  });
  assert.equal(s.satisfied, false);
  assert.equal(s.overriddenBy, undefined);
});

test('override 아닌 reporter 의 일반 agree 는 강제 통과가 아니다', () => {
  const s = computeConsensusState({
    requiredHolders: [agent('a')],
    reporterHolders: [agent('r')],
    votes: [vote(agent('a'), 'object', 'p1'), vote(agent('r'), 'agree', 'p1')],
    proposalId: 'p1',
  });
  assert.equal(s.satisfied, false);
  assert.equal(s.overriddenBy, undefined);
});

// ─── 홀더 1명 ─────────────────────────────────────────────────────────
test('홀더 1명이 agree → 즉시 satisfied', () => {
  const s = computeConsensusState({
    requiredHolders: [agent('solo')],
    votes: [vote(agent('solo'), 'agree')],
    proposalId: 'p1',
  });
  assert.equal(s.satisfied, true);
});

test('홀더 1명 미투표 → pending, not satisfied', () => {
  const s = computeConsensusState({
    requiredHolders: [agent('solo')],
    votes: [],
    proposalId: 'p1',
  });
  assert.equal(s.satisfied, false);
  assert.deepEqual(keys(s.pending), ['agent:solo']);
});

// ─── 잡다한 경계 ──────────────────────────────────────────────────────
test('필수 홀더 0 → 공허하게 satisfied (게이트는 홀더≥2에서만 강제)', () => {
  const s = computeConsensusState({ requiredHolders: [], votes: [], proposalId: 'p1' });
  assert.equal(s.satisfied, true);
});

test('겸직 홀더(같은 party 중복)는 1회만 센다', () => {
  const s = computeConsensusState({
    requiredHolders: [agent('a'), agent('a')],
    votes: [vote(agent('a'), 'agree')],
    proposalId: 'p1',
  });
  assert.equal(s.required.length, 1);
  assert.equal(s.satisfied, true);
});

test('user 홀더도 동일하게 필수 투표자로 취급', () => {
  const s = computeConsensusState({
    requiredHolders: [agent('a'), user('u')],
    votes: [vote(agent('a'), 'agree')],
    proposalId: 'p1',
  });
  assert.equal(s.satisfied, false);
  assert.deepEqual(keys(s.pending), ['user:u']);
});

// ─── metadata 브릿지 (build ↔ parse) ─────────────────────────────────
test('buildConsensusMetadata 는 consensus_vote 마커 + payload 를 심는다', () => {
  const md = buildConsensusMetadata({ status: 'agree', proposalId: 'p1', by: agent('a') });
  assert.equal(md.consensus_vote, true);
  assert.deepEqual(md.consensus, { status: 'agree', proposal_id: 'p1', by: { type: 'agent', id: 'a' } });
});

test('build override → consensus.override:true', () => {
  const md = buildConsensusMetadata({ status: 'agree', proposalId: null, by: agent('r'), override: true });
  assert.equal(md.consensus.override, true);
  assert.equal(md.consensus.proposal_id, null);
});

test('parseConsensusVote 는 build 를 왕복 복원한다', () => {
  const md = buildConsensusMetadata({ status: 'object', proposalId: 'p9', by: user('u'), override: false });
  const v = parseConsensusVote(md, 4242);
  assert.deepEqual(v, { by: { type: 'user', id: 'u' }, status: 'object', proposalId: 'p9', at: 4242 });
});

test('parseConsensusVote 는 마커 없는/손상 metadata 를 null 로', () => {
  assert.equal(parseConsensusVote(null, 1), null);
  assert.equal(parseConsensusVote({}, 1), null);
  assert.equal(parseConsensusVote({ consensus_vote: true }, 1), null); // payload 없음
  assert.equal(parseConsensusVote({ consensus_vote: true, consensus: { status: 'maybe' } }, 1), null);
  assert.equal(parseConsensusVote({ consensus_vote: true, consensus: { status: 'agree', by: { type: 'x', id: '1' } } }, 1), null);
});

test('parse → compute 왕복: 저장된 vote 로 satisfied 판정', () => {
  const md = buildConsensusMetadata({ status: 'agree', proposalId: 'p1', by: agent('a') });
  const v = parseConsensusVote(md, 1000);
  const s = computeConsensusState({ requiredHolders: [agent('a')], votes: [v], proposalId: 'p1' });
  assert.equal(s.satisfied, true);
});
