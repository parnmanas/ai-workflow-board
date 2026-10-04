import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as waitImmediate } from 'node:timers/promises';

import { EventDispatcher } from '../dist/lib/event-dispatcher.js';

async function waitFor(pred, { timeoutMs = 3000, stepMs = 5 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (pred()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return pred();
}

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
    { delegation: {} },
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

test('terminal 이동은 저장소 기본 브랜치보다 티켓 base를 우선해 미반영 브랜치를 보존한다', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/agent/tickets/')) {
      return new Response(JSON.stringify({
        terminal_entered_at: '2026-08-25T00:00:00.000Z',
        base_branch: 'release/custom-base',
        base_repo: {
          id: 'repo-resource-terminal',
          default_branch: 'main',
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const cleanups = [];
  let branchDeleted = false;
  const worktreeManager = {
    enabled: true,
    async cleanupTerminalTicketGit(opts) {
      cleanups.push(opts);
      // 이 픽스처의 티켓 브랜치는 main에는 반영됐지만 커스텀 base에는 미반영이다.
      // 잘못 main을 기준으로 삼으면 삭제되고, 티켓 base를 기준으로 삼으면 보존된다.
      branchDeleted = opts.baseBranch === 'main';
      return {
        removedWorktrees: branchDeleted ? 1 : 0,
        heldReasons: branchDeleted ? [] : ['base 브랜치에 반영되지 않음'],
        remainingBranches: branchDeleted ? [] : ['ticket/aaaaaaaa-1111-2222-3333-444444444444-custom'],
      };
    },
  };
  const managedAgentContexts = {
    list() {
      return [{ working_dir: '/managed/agent/repo' }];
    },
  };
  const dispatcher = new EventDispatcher(
    { url: 'http://awb.test', apiKey: 'test-key', delegation: {} },
    { worktreeManager, managedAgentContexts },
  );

  dispatcher.handleBoardUpdate(JSON.stringify({
    event_type: 'board_update',
    entity_type: 'ticket',
    action: 'moved',
    ticket_id: 'aaaaaaaa-1111-2222-3333-444444444444',
  }));

  assert.equal(await waitFor(() => cleanups.length === 1), true, 'terminal 정리가 실행돼야 한다');
  assert.equal(cleanups[0].baseBranch, 'release/custom-base');
  assert.equal(cleanups[0].repositoryResourceId, 'repo-resource-terminal');
  assert.equal(branchDeleted, false, '커스텀 base에 미반영된 티켓 브랜치는 보존해야 한다');
});

// ── board-less projects (docs/tickets.md): main clone folders ───────────────
// Ticket worktrees may live in a project's main clone (`<main>/.awb/wt/<ticket8>`)
// instead of a working_dir. Cleanup must reach them via the persisted main-clone
// registry (knownMainClones) and/or the REST ticket's base_repo.main_clone_dir.

test('board-less done (status_changed) cleans the working_dir AND every known main clone', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/agent/tickets/')) {
      // Board-less REST ticket: no board_id, status done. terminal_entered_at is
      // deliberately absent to prove the authoritative `done` status gates too.
      return Response.json({
        status: 'done',
        updated_at: '2026-10-05T00:00:00.000Z',
        base_branch: '',
        project_id: 'project-1',
        base_repo: { id: 'project-1', default_branch: 'main', main_clone_dir: '/srv/web-from-rest' },
      });
    }
    return Response.json({});
  };

  const cleanups = [];
  const worktreeManager = {
    enabled: true,
    async knownMainClones() { return ['/srv/web', '/srv/web-from-rest']; },
    async cleanupTerminalTicketGit(opts) {
      cleanups.push(opts);
      return { removedWorktrees: 0, heldReasons: [], remainingBranches: [] };
    },
  };
  const managedAgentContexts = { list: () => [{ working_dir: '/managed/agent/repo' }] };
  const dispatcher = new EventDispatcher(
    { url: 'http://awb.test', apiKey: 'test-key', delegation: {} },
    { worktreeManager, managedAgentContexts },
  );

  dispatcher.handleBoardUpdate(JSON.stringify({
    event_type: 'board_update',
    entity_type: 'ticket',
    action: 'status_changed',
    status: 'done',
    current_column_kind: 'terminal',
    ticket_id: 'aaaaaaaa-1111-2222-3333-444444444444',
  }));

  assert.equal(await waitFor(() => cleanups.length === 3), true, `cleanups=${JSON.stringify(cleanups)}`);
  const common = { ticketId: 'aaaaaaaa-1111-2222-3333-444444444444', baseBranch: 'main', repositoryResourceId: 'project-1' };
  assert.deepEqual(cleanups, [
    { baseWorkingDir: '/managed/agent/repo', ...common },
    { mainCloneDir: '/srv/web', ...common },
    { mainCloneDir: '/srv/web-from-rest', ...common },
  ]);
});

test('a board ticket whose legacy root status is done is NOT cleaned without terminal_entered_at', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/agent/tickets/')) {
      return Response.json({ board_id: 'board-1', current_column_id: 'col-progress', status: 'done', terminal_entered_at: null });
    }
    return Response.json({});
  };
  let fetched = false;
  const cleanups = [];
  const worktreeManager = {
    enabled: true,
    async knownMainClones() { fetched = true; return ['/srv/web']; },
    async cleanupTerminalTicketGit(opts) { cleanups.push(opts); return { removedWorktrees: 0 }; },
  };
  const dispatcher = new EventDispatcher(
    { url: 'http://awb.test', apiKey: 'test-key', delegation: {} },
    { worktreeManager, managedAgentContexts: { list: () => [{ working_dir: '/managed/agent/repo' }] } },
  );
  dispatcher.handleBoardUpdate(JSON.stringify({
    event_type: 'board_update', entity_type: 'ticket', action: 'moved',
    ticket_id: 'bbbbbbbb-1111-2222-3333-444444444444',
  }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(cleanups, []);
  assert.equal(fetched, false, 'the gate stops before touching any repository');
});

test('archive removes the ticket worktree from known main clones too', async () => {
  const removals = [];
  const worktreeManager = {
    enabled: true,
    async knownMainClones() { return ['/srv/web']; },
    async removeTicketWorktrees(opts) {
      removals.push(opts);
      return opts.mainCloneDir ? 1 : 0;
    },
    async removeTicketRunWorkspace() { return false; },
  };
  const dispatcher = new EventDispatcher(
    { delegation: {} },
    { worktreeManager, managedAgentContexts: { list: () => [{ working_dir: '/managed/agent/repo' }] } },
  );
  dispatcher.handleBoardUpdate(JSON.stringify({
    event_type: 'board_update',
    entity_type: 'ticket',
    action: 'archived',
    ticket_id: 'aaaaaaaa-1111-2222-3333-444444444444',
    repository_resource_id: 'project-1',
  }));
  assert.equal(await waitFor(() => removals.length === 2), true);
  assert.deepEqual(removals, [
    { mainCloneDir: '/srv/web', ticketId: 'aaaaaaaa-1111-2222-3333-444444444444', repositoryResourceId: 'project-1' },
    { baseWorkingDir: '/managed/agent/repo', ticketId: 'aaaaaaaa-1111-2222-3333-444444444444', repositoryResourceId: 'project-1' },
  ]);
});
