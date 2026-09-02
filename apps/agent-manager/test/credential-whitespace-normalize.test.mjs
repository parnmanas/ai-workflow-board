// Manager-side half of the "every claude agent went down at once" guard (see
// apps/server/test/credential-whitespace-normalize.test.mjs for the incident).
//
// The manager must not rely on the server having the fix — it is the last gate
// before the secret becomes CLAUDE_CODE_OAUTH_TOKEN on a child process, and
// two of its paths never re-fetch from AWB at all (reload_config /
// restart-from-snapshot read the on-disk credential.json written by an older
// build, which still holds the damaged value).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MULTILINE_CREDENTIAL_FIELDS,
  normalizeCredentialField,
  normalizeCredentialFields,
} from '../dist/lib/credential-fields.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const HEAD = `sk-ant-oat01-${'A'.repeat(66)}`;
const TAIL = 'B'.repeat(29);
const GOOD_TOKEN = HEAD + TAIL;
const WRAPPED_TOKEN = `${HEAD}\n ${TAIL}`;

test('a wrapped oauth token is repaired and reported as repaired', () => {
  const { fields, repaired } = normalizeCredentialFields({ oauth_token: WRAPPED_TOKEN });
  assert.equal(fields.oauth_token, GOOD_TOKEN);
  assert.deepEqual(repaired, ['oauth_token']);
});

test('a clean credential reports no repair, so the log stays quiet', () => {
  const { fields, repaired } = normalizeCredentialFields({ api_key: GOOD_TOKEN });
  assert.equal(fields.api_key, GOOD_TOKEN);
  assert.deepEqual(repaired, []);
});

test('multi-line blobs survive intact', () => {
  const blob = '{\n  "accessToken": "x"\n}';
  for (const field of MULTILINE_CREDENTIAL_FIELDS) {
    assert.equal(normalizeCredentialField(field, `${blob}\n`), blob, `field ${field}`);
  }
  const { repaired } = normalizeCredentialFields({ auth_json: blob });
  assert.deepEqual(repaired, [], 'an already-clean blob must not be reported as repaired');
});

test('normalizeCredentialFields tolerates a missing fields map', () => {
  assert.deepEqual(normalizeCredentialFields(undefined), { fields: {}, repaired: [] });
  assert.deepEqual(normalizeCredentialFields(null), { fields: {}, repaired: [] });
});

test('the AWB fetch path normalizes before the required-field check and returns the clean map', () => {
  const src = read('lib/agent-manager-commands.ts');
  const normalizeAt = src.indexOf('normalizeCredentialFields(fetched.fields)');
  const requiredAt = src.indexOf('const required = REQUIRED_CREDENTIAL_FIELDS[fetched.provider]');
  assert.ok(normalizeAt > 0, 'fetched credential must be normalized');
  assert.ok(normalizeAt < requiredAt, 'normalization must precede the required-field check');
  assert.doesNotMatch(
    src.slice(normalizeAt),
    /fields: fetched\.fields/,
    'the resolved credential must carry the normalized fields, not the raw fetch',
  );
});

test('the on-disk credential snapshot is normalized on both write and read', () => {
  const src = read('lib/managed-agent-store.ts');
  assert.match(
    src,
    /normalizeCredentialFields\(\s*raw\.fields && typeof raw\.fields === 'object' \? raw\.fields : \{\},?\s*\)/,
    'readAgentCredential must heal snapshots written by an older build (reload_config never re-fetches)',
  );
  assert.match(
    src,
    /normalizeCredentialFields\(credential\.fields\)/,
    'writeAgentCredential must store the normalized value',
  );
});
