import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as waitImmediate } from 'node:timers/promises';

import { EventDispatcher } from '../dist/lib/event-dispatcher.js';

test('archive board_update forwards repository resource id to worktree cleanup', async () => {
  const removals = [];
  const worktreeManager = {
    enabled: true,
    async removeTicketWorktrees(opts) {
      removals.push(opts);
      return 1;
    },
    async removeTicketRunWorkspace() {
      return false;
    },
  };
  const managedAgentContexts = {
    list() {
      return [{ working_dir: '/managed/agent/repo' }];
    },
  };
  const dispatcher = new EventDispatcher(
    { delegation: { worktreeIsolation: true } },
    { worktreeManager, managedAgentContexts },
  );

  dispatcher.handleBoardUpdate(JSON.stringify({
    event_type: 'board_update',
    entity_type: 'ticket',
    action: 'archived',
    ticket_id: 'aaaaaaaa-1111-2222-3333-444444444444',
    repository_resource_id: 'repo-resource-archive',
  }));
  await waitImmediate();

  assert.deepEqual(removals, [{
    baseWorkingDir: '/managed/agent/repo',
    ticketId: 'aaaaaaaa-1111-2222-3333-444444444444',
    repositoryResourceId: 'repo-resource-archive',
  }]);
});
