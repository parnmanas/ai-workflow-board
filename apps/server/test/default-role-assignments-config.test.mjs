// Board default role holders — config module (ticket d94a1b87).
//
// Covers the pure JSON shape contract that the whole feature hinges on:
//   (a) parse fails safe to {} on null / empty / malformed / non-object input
//   (b) parse normalizes: trims ids, drops empty holders, drops empty slugs,
//       de-dupes repeated holders, drops the illegal agent_id+user_id entry
//   (c) validate REJECTS bad write-path shapes (non-array holders, both ids on
//       one holder) and ACCEPTS + normalizes valid input
//   (d) serialize collapses an empty/holder-less config to null and round-trips
//       a real one back through parse unchanged
//
// Imports the compiled module from dist/ (built by `npm run build`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDefaultRoleAssignments,
  validateDefaultRoleAssignmentsInput,
  serializeDefaultRoleAssignments,
} from '../dist/common/default-role-assignments-config.js';

test('parse: null / empty / malformed fail safe to {}', () => {
  assert.deepEqual(parseDefaultRoleAssignments(null), {});
  assert.deepEqual(parseDefaultRoleAssignments(undefined), {});
  assert.deepEqual(parseDefaultRoleAssignments(''), {});
  assert.deepEqual(parseDefaultRoleAssignments('{not json'), {});
  assert.deepEqual(parseDefaultRoleAssignments('[]'), {}); // array is not a map
  assert.deepEqual(parseDefaultRoleAssignments('null'), {});
});

test('parse: normalizes — trims, drops empties, de-dupes, drops illegal dual-id', () => {
  const raw = JSON.stringify({
    assignee: [{ agent_id: ' a1 ' }, { agent_id: 'a1' }], // dup after trim → one
    reviewer: [{ user_id: 'u1' }, { agent_id: '', user_id: '' }], // second is vacant → dropped
    reporter: [{ agent_id: 'a2', user_id: 'u2' }], // illegal dual-id → dropped → slug drops
    '': [{ agent_id: 'a9' }], // empty slug → dropped
    planner: [], // no holders → dropped
  });
  assert.deepEqual(parseDefaultRoleAssignments(raw), {
    assignee: [{ agent_id: 'a1' }],
    reviewer: [{ user_id: 'u1' }],
  });
});

test('validate: rejects bad shapes', () => {
  const nonArray = validateDefaultRoleAssignmentsInput({ assignee: { agent_id: 'a1' } });
  assert.equal(nonArray.ok, false);

  const dualId = validateDefaultRoleAssignmentsInput({ assignee: [{ agent_id: 'a1', user_id: 'u1' }] });
  assert.equal(dualId.ok, false);

  const badHolder = validateDefaultRoleAssignmentsInput({ assignee: ['a1'] });
  assert.equal(badHolder.ok, false);
});

test('validate: accepts + normalizes a valid config', () => {
  const res = validateDefaultRoleAssignmentsInput({
    assignee: [{ agent_id: ' a1 ' }],
    reviewer: [{ agent_id: 'a2' }, { agent_id: 'a2' }], // dup collapses
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.value, {
    assignee: [{ agent_id: 'a1' }],
    reviewer: [{ agent_id: 'a2' }],
  });
});

test('serialize: empty / holder-less → null', () => {
  assert.equal(serializeDefaultRoleAssignments(null), null);
  assert.equal(serializeDefaultRoleAssignments({}), null);
  assert.equal(serializeDefaultRoleAssignments({ assignee: [] }), null);
  assert.equal(serializeDefaultRoleAssignments({ assignee: [{ agent_id: '', user_id: '' }] }), null);
});

test('serialize → parse round-trips a real config', () => {
  const cfg = { assignee: [{ agent_id: 'a1' }], reviewer: [{ user_id: 'u1' }] };
  const stored = serializeDefaultRoleAssignments(cfg);
  assert.equal(typeof stored, 'string');
  assert.deepEqual(parseDefaultRoleAssignments(stored), cfg);
});
