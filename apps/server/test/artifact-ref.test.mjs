import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/common/artifact-ref.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const module = { exports: {} };
vm.runInNewContext(`(function(exports,module){${js}})(module.exports,module)`, { module });
const refs = module.exports;

const ids = {
  ticket: '11111111-1111-4111-8111-111111111111',
  agent: '22222222-2222-4222-8222-222222222222',
  board: '33333333-3333-4333-8333-333333333333',
  action: '44444444-4444-4444-8444-444444444444',
  function: '55555555-5555-4555-8555-555555555555',
  schedule: '66666666-6666-4666-8666-666666666666',
};

test('formats and parses every supported AWB entity with full ids and names', () => {
  const text = Object.entries(ids).map(([type, id]) =>
    refs.formatArtifactRef(type, id, `Same name`),
  ).join(' ');
  const parsed = refs.parseArtifactRefs(text);
  assert.deepEqual(Array.from(parsed, (r) => r.type), Object.keys(ids));
  assert.deepEqual(Array.from(parsed, (r) => r.id), Object.values(ids));
  assert.equal(new Set(parsed.map((r) => r.id)).size, 6, 'same-name entities remain id-distinct');
});

test('rejects shortened ids and missing human-readable labels', () => {
  assert.throws(() => refs.formatArtifactRef('ticket', '11111111', 'Ticket'));
  assert.throws(() => refs.formatArtifactRef('ticket', ids.ticket, ''));
  assert.equal(refs.parseArtifactRefs('#[ticket:11111111|Ticket]').length, 0);
});

test('rejects malformed 36-character UUID lookalikes', () => {
  const malformed = '11111111-1111-1111-1111-111111111111';
  assert.throws(() => refs.formatArtifactRef('ticket', malformed, 'Ticket'));
  assert.equal(refs.parseArtifactRefs(`#[ticket:${malformed}|Ticket]`).length, 0);
});

test('unavailable entities are stable text, never fake artifact links', () => {
  const output = refs.formatUnavailableArtifact('action', ids.action, 'Deploy', '권한 없음');
  assert.match(output, new RegExp(ids.action));
  assert.match(output, /권한 없음/);
  assert.doesNotMatch(output, /#\[/);
});

test('artifact sigil is isolated from notification mentions', () => {
  const mentionSource = fs.readFileSync(new URL('../src/services/mention.service.ts', import.meta.url), 'utf8');
  assert.match(mentionSource, /@\\\[/);
  assert.doesNotMatch(mentionSource, /#\\\[/);
});
