// Base repo binding on dispatch (ticket 8c3befa8).
//
// Two goals, enforced by code (not convention):
//  1. Auto-bind the board environment repo as the DEFAULT base repo — a ticket
//     with no base_repo_resource_id inherits the merged environment's first
//     repository (its resource_id → the Resource's url + default_branch).
//  2. Force a base repo — an assignee dispatched onto an active (branch-work)
//     column with NO resolvable repo is pended, not emitted (no repo guessing).
//
// The pure precedence/guard logic runs against the compiled dist; the dispatch
// wiring + wire delivery are pinned as static source guards (the injection is
// deep inside _emitTrigger, which is not cheaply bootable in isolation — the
// board-lessons-dispatch test uses the same split).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  pickBaseRepoResourceId,
  requiresBaseRepo,
  shouldBlockDispatchForMissingRepo,
} from '../dist/common/base-repo-binding.js';
import { EVENT_TYPES } from '../dist/modules/events/event-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}
function code(relPath) {
  return stripComments(fs.readFileSync(path.join(ROOT, 'src', relPath), 'utf8'));
}

// ── 1. pickBaseRepoResourceId — goal 1 precedence ─────────────────────────────

test('ticket base repo wins over the board environment', () => {
  const r = pickBaseRepoResourceId('ticket-repo', [{ resource_id: 'env-repo' }]);
  assert.deepEqual(r, { resourceId: 'ticket-repo', source: 'ticket' });
});

test('empty ticket repo falls back to the board environment first repository', () => {
  const r = pickBaseRepoResourceId('', [{ resource_id: 'env-repo-0' }, { resource_id: 'env-repo-1' }]);
  assert.deepEqual(r, { resourceId: 'env-repo-0', source: 'board_env' });
});

test('whitespace-only ticket repo is treated as empty and falls back', () => {
  const r = pickBaseRepoResourceId('   ', [{ resource_id: 'env-repo-0' }]);
  assert.equal(r.resourceId, 'env-repo-0');
  assert.equal(r.source, 'board_env');
});

test('url-only environment repos (no resource_id) are NOT a valid fallback', () => {
  // A repo without a resource_id can't carry a credential → binding it would
  // recreate the very push failure this ticket prevents. Skip it, pick the
  // first entry that DOES have a resource_id.
  const r = pickBaseRepoResourceId('', [{ url: 'https://x/y.git' }, { resource_id: 'real-repo' }]);
  assert.deepEqual(r, { resourceId: 'real-repo', source: 'board_env' });
});

test('no ticket repo and no environment repo → none', () => {
  assert.deepEqual(pickBaseRepoResourceId('', []), { resourceId: '', source: 'none' });
  assert.deepEqual(pickBaseRepoResourceId('', null), { resourceId: '', source: 'none' });
  assert.deepEqual(pickBaseRepoResourceId(null, undefined), { resourceId: '', source: 'none' });
  assert.deepEqual(pickBaseRepoResourceId('', [{ url: 'https://x/y.git' }]), { resourceId: '', source: 'none' });
});

// ── 2. requiresBaseRepo — goal 2 guard scope ──────────────────────────────────

test('assignee on an active column requires a base repo', () => {
  assert.equal(requiresBaseRepo('assignee', 'active'), true);
});

test('non-pushing roles/columns are never blocked by the guard', () => {
  // Only the assignee on an active column checks out a worktree and pushes.
  assert.equal(requiresBaseRepo('reviewer', 'active'), false);
  assert.equal(requiresBaseRepo('planner', 'active'), false);
  assert.equal(requiresBaseRepo('reporter', 'active'), false);
  assert.equal(requiresBaseRepo('assignee', 'review'), false);
  assert.equal(requiresBaseRepo('assignee', 'merging'), false);
  assert.equal(requiresBaseRepo('assignee', 'terminal'), false);
  assert.equal(requiresBaseRepo('assignee', undefined), false);
  assert.equal(requiresBaseRepo('assignee', null), false);
  assert.equal(requiresBaseRepo('', 'active'), false);
});

// ── 2b. shouldBlockDispatchForMissingRepo — the literal branch-work guard ──────

test('block: assignee+active with no resolved repo — pend regardless of what was (not) declared', () => {
  // Both failure shapes collapse to the same input under the literal guard: a
  // ticket that declared a repo which did not resolve (deleted Resource), AND the
  // acceptance scenario where the ticket AND the board env are both empty. Ticket
  // 8c3befa8 goal 2 / verification ("보드에 environment repo 가 없는 상태로
  // base_repo 미지정 → 추정 없이 pend/차단") demands the block be UNCONDITIONAL on
  // prior declaration — mirroring agent-manager's own missing_repository_resource
  // fail-closed. The removed `repoWasExpected` gate is exactly what let the
  // both-empty acceptance scenario slip through and emit (the reviewer's P1).
  assert.equal(shouldBlockDispatchForMissingRepo({
    role: 'assignee', columnKind: 'active', hasResolvedBaseRepo: false,
  }), true);
});

test('NO block: a repo resolved (ticket or env backfill)', () => {
  assert.equal(shouldBlockDispatchForMissingRepo({
    role: 'assignee', columnKind: 'active', hasResolvedBaseRepo: true,
  }), false);
});

test('NO block: non-pushing role/column even when no repo resolved', () => {
  // requiresBaseRepo scopes the guard to the sole branch-work pairing; planner /
  // reviewer / QA / chat dispatches never push, so a missing repo never pends them.
  for (const [role, columnKind] of [['reviewer', 'active'], ['planner', 'active'], ['assignee', 'review'], ['assignee', 'merging'], ['assignee', 'terminal']]) {
    assert.equal(shouldBlockDispatchForMissingRepo({
      role, columnKind, hasResolvedBaseRepo: false,
    }), false, `${role}/${columnKind} must not be blocked`);
  }
});

// ── 3. dispatch wiring guards (_emitTrigger) ──────────────────────────────────

test('_emitTrigger backfills base_repo from the board environment (goal 1)', () => {
  const src = code('modules/agents/trigger-loop.service.ts');
  assert.match(src, /pickBaseRepoResourceId\(/, 'must call the backfill picker');
  // Only backfills when the ticket has no base repo of its own.
  assert.match(src, /if \(!baseRepoId && baseRepoWorkspaceId\)/, 'backfill must be gated on an empty ticket base repo');
  // baseBranch inherits the resolved Resource default_branch when empty.
  assert.match(src, /if \(!baseBranch\) baseBranch = baseRepo\.default_branch/, 'empty base_branch must fall back to default_branch');
});

test('_emitTrigger pends (does not emit) when a branch-work dispatch has no resolved repo (goal 2)', () => {
  const src = code('modules/agents/trigger-loop.service.ts');
  assert.match(src, /shouldBlockDispatchForMissingRepo\(\{/, 'must gate on the shouldBlockDispatchForMissingRepo predicate');
  assert.match(src, /hasResolvedBaseRepo: !!baseRepo/, 'must pass the resolved-repo state');
  // The literal guard must NOT gate on a "repo was expected" heuristic — that gate
  // is what let the both-empty acceptance scenario slip through (reviewer P1). It
  // must be gone so a branch-work dispatch with no repo always pends.
  assert.doesNotMatch(src, /repoWasExpected/, 'the repoWasExpected gate must be removed (literal block)');
  // The guard must SKIP the emit — pend then return before activityEvents.emit.
  assert.match(src, /await this\._pendForMissingBaseRepo\(ticket, agentId, role, triggerSource\);\s*return '';/, 'guard must pend and return without emitting');
});

test('_pendForMissingBaseRepo sets pending_user_action + is idempotent', () => {
  const src = code('modules/agents/trigger-loop.service.ts');
  assert.match(src, /_pendForMissingBaseRepo\(/, 'pend helper must exist');
  assert.match(src, /pending_user_action = true/, 'must set the pending flag');
  assert.match(src, /pending_set_by = 'TriggerLoopService'/, 'must stamp the pend actor');
  // Idempotent re-read: an already-pending/archived ticket is left untouched.
  assert.match(src, /if \(!fresh \|\| fresh\.pending_user_action \|\| fresh\.pending_on_tickets \|\| fresh\.archived_at\)/, 'must not double-pend');
});

// ── 4. SSE wire delivery guard (flatten) ──────────────────────────────────────

test('agent_trigger flatten() forwards base_repo + base_branch to the manager', () => {
  const src = code('modules/events/event-registry.ts');
  const flat = src.slice(src.indexOf("eventType: 'agent_trigger'"));
  assert.match(flat, /base_repo:\s*p\.base_repo/, 'flatten() must forward base_repo — the manager reads it off the flattened event');
  assert.match(flat, /base_branch:\s*p\.base_branch/, 'flatten() must forward base_branch');
});

// ── 5. REAL wire payload — run the actual map()→flatten() the server emits ─────
// Board lesson: verify event changes with the real wire payload, not just a
// source grep. agent-manager's event-dispatcher does JSON.parse(raw) then reads
// ev.base_repo / ev.base_branch off the FLATTENED shape (resolveBootstrapRepository).
// This drives the exact map→flatten path the server runs before SSE.

function agentTriggerDef() {
  const def = EVENT_TYPES.find((d) => d.eventType === 'agent_trigger');
  assert.ok(def && typeof def.map === 'function' && typeof def.flatten === 'function', 'agent_trigger def with map+flatten must exist');
  return def;
}

test('real wire: a resolved base_repo survives map()→flatten() onto the SSE shape', () => {
  const def = agentTriggerDef();
  const env = def.map({
    trigger_id: 'trg-1', ticket_id: 't-1', agent_id: 'a-1', role: 'assignee',
    base_repo: { id: 'res-1', name: 'AWB', url: 'https://github.com/x/y.git', default_branch: 'main' },
    base_branch: 'feature-x',
    timestamp: '2026-07-15T00:00:00.000Z',
  });
  const wire = def.flatten(env);
  // This is exactly what agent-manager JSON.parses and reads.
  assert.equal(wire.base_repo?.id, 'res-1', 'base_repo must reach the flattened wire (was silently dropped before)');
  assert.equal(wire.base_repo?.url, 'https://github.com/x/y.git');
  assert.equal(wire.base_branch, 'feature-x', 'base_branch must reach the flattened wire');
});

test('real wire: a repo-less trigger flattens to base_repo=null (manager falls back to env)', () => {
  const def = agentTriggerDef();
  const env = def.map({
    trigger_id: 'trg-2', ticket_id: 't-2', agent_id: 'a-2', role: 'planner',
    // no base_repo / base_branch — a non-code dispatch
    timestamp: '2026-07-15T00:00:00.000Z',
  });
  const wire = def.flatten(env);
  assert.equal(wire.base_repo, null, 'absent base_repo flattens to null, not undefined-dropped');
  assert.equal(wire.base_branch, '', 'absent base_branch flattens to empty string');
});
