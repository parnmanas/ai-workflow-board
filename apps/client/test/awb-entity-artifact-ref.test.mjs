import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  parseArtifactRefs,
} from '../src/utils/artifactRef.ts';
import { renderMarkdown } from '../src/components/chat/utils/markdown.tsx';

const ids = {
  ticket: '11111111-1111-4111-8111-111111111111',
  agent: '22222222-2222-4222-8222-222222222222',
  board: '33333333-3333-4333-8333-333333333333',
  action: '44444444-4444-4444-8444-444444444444',
  function: '55555555-5555-4555-8555-555555555555',
  schedule: '66666666-6666-4666-8666-666666666666',
};

test('parses all six entity artifact types but SSR never creates an unverified link', () => {
  const input = Object.entries(ids).map(([type, id]) => `#[${type}:${id}|Shared name]`).join(' ');
  assert.equal(parseArtifactRefs(input).length, 6);
  const html = renderToStaticMarkup(React.createElement(React.Fragment, null, ...renderMarkdown(input)));
  for (const type of Object.keys(ids)) {
    assert.match(html, new RegExp(`data-entity-ref="${type}:${ids[type]}"`));
  }
  assert.doesNotMatch(html, /<a /);
  assert.match(html, /workspace context 없음/);
});

test('short ids remain plain text instead of becoming fake links', () => {
  const input = '#[ticket:11111111|Short]';
  assert.equal(parseArtifactRefs(input).length, 0);
  const html = renderToStaticMarkup(React.createElement(React.Fragment, null, ...renderMarkdown(input)));
  assert.doesNotMatch(html, /data-ticket-ref/);
  assert.match(html, /11111111/);
});

test('malformed 36-character values remain plain text', () => {
  const malformed = '11111111-1111-1111-1111-111111111111';
  const input = `#[ticket:${malformed}|Malformed]`;
  assert.equal(parseArtifactRefs(input).length, 0);
  const html = renderToStaticMarkup(React.createElement(React.Fragment, null, ...renderMarkdown(input)));
  assert.doesNotMatch(html, /data-entity-ref/);
});
