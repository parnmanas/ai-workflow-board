import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDispatchEnvVars } from '../dist/lib/event-dispatcher.js';

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
