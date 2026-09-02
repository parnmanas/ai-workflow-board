// Regression guard — every claude agent on the instance went down at once
// because ONE stored `claude_oauth_token` credential held a hard line break
// inside the secret: `claude setup-token` output was copied out of a wrapped
// terminal, so the value arrived as `…NHm9xS\n VFxMT6Y…` (110 chars for a
// 108-char token).
//
// Nothing downstream trimmed it. The manager exported it verbatim as
// CLAUDE_CODE_OAUTH_TOKEN, the CLI put it in an Authorization header, and
// every spawn died ~1s in with `terminal_reason: "api_error"` — verified
// live: the same token with whitespace stripped authenticated fine.
//
// Covered here:
//   - single-line secrets have ALL whitespace stripped (interior breaks are
//     what actually killed it — a plain .trim() would NOT have caught this)
//   - multi-line blob fields (.credentials.json / auth.json / config.toml)
//     keep their interior newlines and are only end-trimmed
//   - the three server paths that must apply it: credential create, credential
//     update, and the manager-facing credential read (the read matters because
//     it heals rows already stored damaged, without operator re-entry)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MULTILINE_CREDENTIAL_FIELDS,
  normalizeCredentialField,
  normalizeCredentialFields,
} from '../dist/common/credential-fields.js';

const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SERVER_SRC, rel), 'utf8');

// The live failure, reproduced at its exact shape: wrap injected `\n ` at
// offset 79 of a 108-char `sk-ant-oat01-` token.
const HEAD = `sk-ant-oat01-${'A'.repeat(66)}`;
const TAIL = 'B'.repeat(29);
const GOOD_TOKEN = HEAD + TAIL;
const WRAPPED_TOKEN = `${HEAD}\n ${TAIL}`;

test('interior line break in an oauth token is stripped, not merely trimmed', () => {
  assert.equal(WRAPPED_TOKEN.length, GOOD_TOKEN.length + 2);
  assert.notEqual(WRAPPED_TOKEN.trim(), GOOD_TOKEN, 'trim() alone cannot fix an interior wrap');
  assert.equal(normalizeCredentialField('oauth_token', WRAPPED_TOKEN), GOOD_TOKEN);
});

test('every single-line secret field is whitespace-stripped', () => {
  for (const field of ['oauth_token', 'api_key', 'token', 'base_url', 'model']) {
    assert.equal(normalizeCredentialField(field, ' a\nb\tc '), 'abc', `field ${field}`);
  }
});

test('multi-line blob fields keep interior newlines and are only end-trimmed', () => {
  const blob = '{\n  "accessToken": "x"\n}';
  for (const field of MULTILINE_CREDENTIAL_FIELDS) {
    assert.equal(normalizeCredentialField(field, `\n${blob}\n `), blob, `field ${field}`);
  }
});

test('normalizeCredentialFields maps a whole credential and leaves non-strings alone', () => {
  const out = normalizeCredentialFields({
    oauth_token: WRAPPED_TOKEN,
    config_toml: ' a = 1\nb = 2 ',
    enabled: true,
  });
  assert.equal(out.oauth_token, GOOD_TOKEN);
  assert.equal(out.config_toml, 'a = 1\nb = 2');
  assert.equal(out.enabled, true);
});

test('credential create and update both normalize before encrypting', () => {
  const src = read('modules/credentials/credentials.controller.ts');
  assert.match(
    src,
    /const plaintext = JSON\.stringify\(normalizeCredentialFields\(credData\)\)/,
    'POST /api/credentials must normalize before encrypt',
  );
  assert.match(
    src,
    /encrypt\(JSON\.stringify\(normalizeCredentialFields\(merged\)\)\)/,
    'PATCH /api/credentials/:id must normalize the merged map, so an edit also heals a stored value',
  );
});

test('CLI auto-login normalizes captured fields before the required-field check', () => {
  const src = read('modules/credentials/cli-login-session.service.ts');
  const normalizeAt = src.indexOf('normalizeCredentialFields(args.credentialFields');
  const requiredAt = src.indexOf('credential_fields.${requiredField');
  assert.ok(normalizeAt > 0, 'cli-login must normalize captured credential fields');
  assert.ok(
    normalizeAt < requiredAt,
    'normalization must run before the required-field check, or a wrapped capture passes validation',
  );
});

test('the manager-facing credential read heals damaged rows and logs the repair', () => {
  const src = read('modules/agent-manager/agent-manager.controller.ts');
  assert.match(src, /fields = normalizeCredentialFields\(raw\)/);
  assert.match(
    src,
    /had whitespace inside/,
    'a healed credential must be logged so the operator knows to re-save it at rest',
  );
});
