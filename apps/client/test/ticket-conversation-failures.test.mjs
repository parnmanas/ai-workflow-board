import test from 'node:test';
import assert from 'node:assert/strict';
import { isRoutineSystemComment, ticketExecutionFailure } from '../src/tickets/commentVisibility.ts';

// Shape of the persisted fc68c00b failure, including the legacy body-only reason.
const authFailure = {
  id: 'failure', author_type: 'system', type: 'system',
  metadata: { reason: 'silent_exit', exit_code: 1 },
  repeat_count: 2,
  content: '⚠️ Subagent exited without leaving a ticket comment (non-zero exit code 1).\n\n'
    + '_cli=codex · exit_code=1 · reason=auth_failure · trigger=example_\n\n'
    + 'Last CLI output:\n```\nYour access token could not be refreshed because your refresh token was already used. Please log out and sign in again.\n```',
};

test('default conversation keeps persisted failures and replies while hiding status bookkeeping', () => {
  const comments = [
    { id: 'moved', author_type: 'system', metadata: {}, content: '📋 Ticket moved from To Do to In Progress' },
    authFailure,
    { id: 'reply', author_type: 'user', parent_id: 'failure', metadata: {}, content: '확인해주세요' },
  ];
  assert.deepEqual(comments.filter(c => !isRoutineSystemComment(c)).map(c => c.id), ['failure', 'reply']);
  assert.equal(comments.filter(isRoutineSystemComment).length, 1);
});

test('legacy refresh-token failures show the cause and recovery steps without changing the stored log', () => {
  const original = structuredClone(authFailure);
  const notice = ticketExecutionFailure(authFailure);
  assert.match(notice.title, /인증 실패/);
  assert.match(notice.guidance, /이미 사용된 refresh token/);
  assert.match(notice.guidance, /다시 로그인.*재실행/);
  assert.deepEqual(authFailure, original);
});

test('other silent exits remain visible even without a warning prefix or auth classifier', () => {
  const comment = { ...authFailure, content: 'Process exited', metadata: { reason: 'silent_exit', exit_code: 0 } };
  assert.equal(isRoutineSystemComment(comment), false);
  assert.match(ticketExecutionFailure(comment).title, /결과를 확인/);
  assert.doesNotMatch(ticketExecutionFailure(comment).guidance, /로그인/);
});

test('other operational warnings remain visible while normal system records stay optional', () => {
  assert.equal(isRoutineSystemComment({ author_type: 'system', metadata: {}, content: '  ⚠️ 실행 호스트 연결 실패' }), false);
  assert.equal(isRoutineSystemComment({ author_type: 'system', content: 'Ticket created' }), true);
});

test('user text or quoted auth_failure output does not become a credential failure notice', () => {
  assert.equal(ticketExecutionFailure({ ...authFailure, author_type: 'user' }), null);
  const comment = { ...authFailure, content: '⚠️ Process exited\n\n_cli=codex · exit_code=1_\n\n```\nreason=auth_failure\n```' };
  assert.doesNotMatch(ticketExecutionFailure(comment).title, /인증 실패/);
});
