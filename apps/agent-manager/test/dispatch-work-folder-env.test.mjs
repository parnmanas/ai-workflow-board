import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDispatchEnvVars } from '../dist/lib/event-dispatcher.js';
import {
  composeTriggerPrompt,
  sharedWorktreeInstructions,
  perTicketWorktreeInstructions,
  worktreeInstructionsFor,
} from '../dist/lib/prompts.js';

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
  // acceptance criterion 3 (ticket 41e69c91): must explicitly forbid creating
  // anything above working_dir (the agent-home container) — that is the exact
  // leak this ticket fixes.
  assert.match(prompt, /above working_dir \(the agent-home container\)/);
  assert.ok(prompt.includes(assigned));
});

test('worktreeInstructionsFor selects policy text by board worktree_mode (ticket 41e69c91 regression)', () => {
  const cwd = 'D:\\AWBAgents\\GameClient\\.awb\\wt\\resource\\a1b2c3d4';

  // The bug: only 'shared' ever reached sharedWorktreeInstructions(); 'shared'
  // stays wired the same way through the resolver.
  assert.equal(worktreeInstructionsFor('shared', cwd), sharedWorktreeInstructions(cwd));

  // 'per_ticket' is the board default and the mode AWB actually runs in — it
  // must now resolve to non-empty, per-ticket-flavored text distinct from the
  // shared policy (acceptance criteria 1 and 2).
  const perTicket = worktreeInstructionsFor('per_ticket', cwd);
  assert.equal(perTicket, perTicketWorktreeInstructions(cwd));
  assert.notEqual(perTicket, '');
  assert.notEqual(perTicket, worktreeInstructionsFor('shared', cwd));

  // A pre-worktree-convention board never sends worktree_mode at all — the
  // resolver must stay byte-identical (empty) for undefined mode, mirroring
  // injectWorkFolder's byte-identity guarantee (acceptance criterion 4).
  assert.equal(worktreeInstructionsFor(undefined, cwd), '');
});
