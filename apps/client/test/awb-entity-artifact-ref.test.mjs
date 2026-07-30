import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
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

const renderMarkdownHtml = (input) =>
  renderToStaticMarkup(React.createElement(React.Fragment, null, ...renderMarkdown(input)));

const renderMarkdownText = (input) =>
  new JSDOM(`<main>${renderMarkdownHtml(input)}</main>`).window.document.querySelector('main').textContent;

const occurrences = (text, value) => text.split(value).length - 1;

test('parses all six entity artifact types but SSR never creates an unverified link', () => {
  const input = Object.entries(ids).map(([type, id]) => `#[${type}:${id}|Shared name]`).join(' ');
  assert.equal(parseArtifactRefs(input).length, 6);
  const html = renderMarkdownHtml(input);
  for (const type of Object.keys(ids)) {
    assert.match(html, new RegExp(`data-entity-ref="${type}:${ids[type]}"`));
  }
  assert.doesNotMatch(html, /<a /);
  assert.match(html, /workspace context 없음/);
});

test('short ids remain plain text instead of becoming fake links', () => {
  const input = '#[ticket:11111111|Short]';
  assert.equal(parseArtifactRefs(input).length, 0);
  const html = renderMarkdownHtml(input);
  assert.doesNotMatch(html, /data-ticket-ref/);
  assert.match(html, /11111111/);
});

test('malformed 36-character values remain plain text', () => {
  const malformed = '11111111-1111-1111-1111-111111111111';
  const input = `#[ticket:${malformed}|Malformed]`;
  assert.equal(parseArtifactRefs(input).length, 0);
  const html = renderMarkdownHtml(input);
  assert.doesNotMatch(html, /data-entity-ref/);
});

test('renders prefix, artifact, and suffix exactly once', () => {
  const input = `PREFIX_ONLY #[ticket:${ids.ticket}|Ticket One] SUFFIX_ONLY`;
  const html = renderMarkdownHtml(input);
  const text = renderMarkdownText(input);

  assert.equal(occurrences(text, 'PREFIX_ONLY'), 1);
  assert.equal(occurrences(text, 'Ticket One'), 1);
  assert.equal(occurrences(text, 'SUFFIX_ONLY'), 1);
  assert.equal(occurrences(html, `data-entity-ref="ticket:${ids.ticket}"`), 1);
  assert.ok(text.indexOf('PREFIX_ONLY') < text.indexOf('Ticket One'));
  assert.ok(text.indexOf('Ticket One') < text.indexOf('SUFFIX_ONLY'));
});

test('preserves order and count for multiple artifacts mixed with an agent mention', () => {
  const agentId = '77777777-7777-4777-8777-777777777777';
  const input = [
    'START_ONLY',
    `#[ticket:${ids.ticket}|Ticket One]`,
    'MIDDLE_ONLY',
    `@[agent:${agentId}|Agent Mention]`,
    'AFTER_MENTION_ONLY',
    `#[board:${ids.board}|Board Two]`,
    'END_ONLY',
  ].join(' ');
  const html = renderMarkdownHtml(input);
  const text = renderMarkdownText(input);
  const ordered = [
    'START_ONLY',
    'Ticket One',
    'MIDDLE_ONLY',
    '@Agent Mention',
    'AFTER_MENTION_ONLY',
    'Board Two',
    'END_ONLY',
  ];

  for (const value of ordered) assert.equal(occurrences(text, value), 1, value);
  assert.equal(occurrences(html, 'data-entity-ref='), 2);
  assert.equal(occurrences(html, 'data-mention-raw='), 1);
  for (let index = 1; index < ordered.length; index += 1) {
    assert.ok(text.indexOf(ordered[index - 1]) < text.indexOf(ordered[index]));
  }
});
