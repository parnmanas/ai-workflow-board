// Regression-grep — 다중담당자·합의 T3 (ticket 40024001). The behavioural test
// (test/qa-flows/comment-mention-self-exclusion.test.mjs) boots NestJS and
// asserts a co-holder role fan-out notifies everyone EXCEPT the author. This
// file is the cheap static companion: it fails fast if a future refactor strips
// the self-exclusion wiring off any of the three comment_mention surfaces, or
// lets the consensus-vote marker literal drift away from its single source
// (common/consensus-meta.ts). Catches accidental reverts in
// PR-review-without-flow-tests scenarios (the primary-strand plan's item E).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '..', 'src');
function read(...p) { return fs.readFileSync(path.resolve(SRC, ...p), 'utf8'); }

test('consensus-meta is the single source of the consensus_vote marker', () => {
  const src = read('common', 'consensus-meta.ts');
  assert.match(
    src,
    /CONSENSUS_VOTE_META_KEY\s*=\s*'consensus_vote'/,
    'consensus-meta.ts must define CONSENSUS_VOTE_META_KEY = \'consensus_vote\'',
  );
  assert.match(
    src,
    /export\s+function\s+isConsensusVoteComment\s*\(/,
    'consensus-meta.ts must export isConsensusVoteComment(...)',
  );
  // The predicate must gate on an explicit === true so a null/garbage bag reads
  // as "ordinary discussion comment" (the safe default that keeps fan-out flowing).
  assert.match(
    src,
    /\]\s*===\s*true/,
    'isConsensusVoteComment must require an explicit === true match',
  );
});

test('trigger-loop reads the consensus marker via consensus-meta (no inline drift)', () => {
  const src = read('modules', 'agents', 'trigger-loop.service.ts');
  assert.match(
    src,
    /import\s*\{[^}]*isConsensusVoteComment[^}]*\}\s*from\s*'\.\.\/\.\.\/common\/consensus-meta'/,
    'trigger-loop must import isConsensusVoteComment from common/consensus-meta',
  );
  assert.match(
    src,
    /return\s+isConsensusVoteComment\(/,
    '_commentSuppressesFanout must delegate to isConsensusVoteComment',
  );
  // The old inline literal must be gone so the marker lives in exactly one place.
  assert.doesNotMatch(
    src,
    /meta\?\.\s*consensus_vote\s*===\s*true/,
    'trigger-loop must not re-inline the consensus_vote literal',
  );
});

test('resolveMentions accepts excludeActor and drops the author on both mention branches', () => {
  const src = read('services', 'mention.service.ts');
  assert.match(
    src,
    /excludeActor\s*\?:\s*\{\s*type:\s*'user'\s*\|\s*'agent';\s*id:\s*string\s*\}/,
    'resolveMentions must accept opts.excludeActor',
  );
  // isActor must be consulted in BOTH the role fan-out loop and the direct-ref
  // branch — two `continue` guards (the helper itself is an arrow assignment,
  // `const isActor = ...`, so it does not add a call-shaped match).
  const isActorCalls = (src.match(/isActor\s*\(/g) || []).length;
  assert.ok(
    isActorCalls >= 2,
    `expected isActor consulted in both mention branches (>=2 call sites), found ${isActorCalls}`,
  );
});

test('all three comment_mention surfaces pass excludeActor into resolveMentions', () => {
  // MCP add_comment + ask_question
  const commentTools = read('modules', 'mcp', 'tools', 'comment-tools.ts');
  const mcpExcludeCalls = (commentTools.match(/resolveMentions\([^)]*excludeActor/gs) || []).length;
  assert.ok(
    mcpExcludeCalls >= 2,
    `add_comment and ask_question must both pass excludeActor (found ${mcpExcludeCalls})`,
  );
  // REST _dispatchCommentMentions
  const rest = read('modules', 'tickets', 'tickets.controller.ts');
  assert.match(
    rest,
    /resolveMentions\([\s\S]*?excludeActor/,
    'REST _dispatchCommentMentions must pass excludeActor',
  );
});
