import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDispatchEnvVars } from '../dist/lib/event-dispatcher.js';
import {
  composeTriggerPrompt,
  sharedWorktreeInstructions,
  perTicketWorktreeInstructions,
  repositoryContextInstructions,
  worktreeInstructionsFor,
} from '../dist/lib/prompts.js';

test('확정된 repository context는 비밀 없이 prompt에 직렬화된다', () => {
  const text = repositoryContextInstructions({
    resourceId: 'repo-resource-id',
    cwd: '/agent/.awb/wt/repo/ticket',
    baseBranch: 'main',
    baseSha: '0123456789abcdef',
    workingBranch: 'ticket/full-id-work',
    dirty: true,
    ahead: 2,
    behind: 1,
    resumed: true,
  });
  assert.match(text, /Repository Resource ID: repo-resource-id/);
  assert.match(text, /base branch \/ SHA: main \/ 0123456789abcdef/);
  assert.match(text, /working branch: ticket\/full-id-work/);
  assert.match(text, /dirty: true/);
  assert.match(text, /ahead \/ behind: 2 \/ 1/);
  assert.match(text, /기존 worktree 재개/);
  assert.doesNotMatch(text, /token|password|credential/i);
});

test('dispatch exports the manager-resolved shared worktree contract', () => {
  assert.deepEqual(
    buildDispatchEnvVars(
      { CUSTOM: 'ok' },
      'D:\\AWBAgents\\GameClient\\.awb\\wt\\resource\\shared-0',
      'shared',
      'ticket-123',
    ),
    {
      CUSTOM: 'ok',
      AWB_WORK_FOLDER: 'D:\\AWBAgents\\GameClient\\.awb\\wt\\resource\\shared-0',
      AWB_WORKTREE_MODE: 'shared',
      AWB_TICKET_ID: 'ticket-123',
    },
  );
});

test('reserved AWB worktree keys cannot be spoofed by board environment variables', () => {
  const env = buildDispatchEnvVars(
    {
      AWB_WORK_FOLDER: 'D:\\wrong',
      AWB_WORKTREE_MODE: 'per_ticket',
      AWB_TICKET_ID: 'wrong-ticket',
    },
    'D:\\real\\shared-0',
    'shared',
    'real-ticket',
  );
  assert.equal(env.AWB_WORK_FOLDER, 'D:\\real\\shared-0');
  assert.equal(env.AWB_WORKTREE_MODE, 'shared');
  assert.equal(env.AWB_TICKET_ID, 'real-ticket');
});

test('shared policy is AWB-owned and names the assigned checkout', () => {
  const assigned = 'D:\\AWBAgents\\GameClient\\.awb\\wt\\resource\\shared-0';
  const policy = sharedWorktreeInstructions(assigned);
  const prompt = composeTriggerPrompt(
    { id: 'ticket-123', title: 'Warm build' },
    '',
    '',
    'ticket-123',
    null,
    policy,
  );

  assert.match(prompt, /AWB shared-worktree policy \(mandatory\)/);
  assert.match(prompt, /Do not create another git worktree/);
  assert.match(prompt, /Unity Library\/\) remain warm across tickets/);
  assert.ok(prompt.includes(assigned));
});

test('per-ticket policy is AWB-owned, names the assigned folder, and forbids escaping working_dir', () => {
  const assigned = 'D:\\AWBAgents\\GameClient\\.awb\\wt\\resource\\a1b2c3d4';
  const policy = perTicketWorktreeInstructions(assigned);
  const prompt = composeTriggerPrompt(
    { id: 'ticket-456', title: 'Per-ticket build' },
    '',
    '',
    'ticket-456',
    null,
    policy,
  );

  assert.match(prompt, /AWB per-ticket worktree policy \(mandatory\)/);
  assert.match(prompt, /Do not create another git worktree/);
  // 수용 기준 3 (티켓 41e69c91): working_dir 상위(에이전트 홈 컨테이너)에
  // 어떤 폴더도 만들지 못하도록 명시적으로 금지해야 한다 — 이 티켓이
  // 고치려는 유출이 바로 그 지점이다.
  assert.match(prompt, /above working_dir \(the agent-home container\)/);
  assert.ok(prompt.includes(assigned));
});

test('worktreeInstructionsFor selects policy text by board worktree_mode (ticket 41e69c91 regression)', () => {
  const cwd = 'D:\\AWBAgents\\GameClient\\.awb\\wt\\resource\\a1b2c3d4';

  // 버그였던 부분: 'shared'만 sharedWorktreeInstructions()에 도달했다;
  // 'shared'는 resolver를 거쳐도 동일한 방식으로 연결된 상태를 유지한다.
  assert.equal(worktreeInstructionsFor('shared', cwd), sharedWorktreeInstructions(cwd));

  // 'per_ticket'은 보드 기본값이자 AWB가 실제로 실행되는 모드다 — 이제는
  // shared 정책과 구분되는, per_ticket 전용의 비어있지 않은 문구로
  // 해석되어야 한다 (수용 기준 1, 2).
  const perTicket = worktreeInstructionsFor('per_ticket', cwd);
  assert.equal(perTicket, perTicketWorktreeInstructions(cwd));
  assert.notEqual(perTicket, '');
  assert.notEqual(perTicket, worktreeInstructionsFor('shared', cwd));

  // worktree 컨벤션 이전 보드는 worktree_mode 자체를 보내지 않는다 —
  // resolver는 undefined 모드에 대해 byte-identical(빈 문자열)을 유지해야
  // 하며, 이는 injectWorkFolder의 byte-identity 보장과 동일한 원칙이다
  // (수용 기준 4).
  assert.equal(worktreeInstructionsFor(undefined, cwd), '');
});
