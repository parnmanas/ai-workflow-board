import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  entityDeepLink,
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

test('parses and renders all six entity artifact types', () => {
  const input = Object.entries(ids).map(([type, id]) => `#[${type}:${id}|Shared name]`).join(' ');
  assert.equal(parseArtifactRefs(input).length, 6);
  const html = renderToStaticMarkup(React.createElement(React.Fragment, null, ...renderMarkdown(input)));
  assert.match(html, new RegExp(`data-ticket-ref="${ids.ticket}"`));
  assert.match(html, new RegExp(`data-agent-ref="${ids.agent}"`));
  assert.match(html, new RegExp(`data-board-ref="${ids.board}"`));
  for (const type of ['action', 'function', 'schedule']) {
    assert.match(html, new RegExp(`data-entity-ref="${type}:${ids[type]}"`));
  }
});

test('deep links preserve full ids and route to the correct detail surface', () => {
  assert.equal(entityDeepLink('agent', ids.agent, 'ws'), `/ws/ws/agents/${ids.agent}`);
  assert.equal(entityDeepLink('board', ids.board, 'ws'), `/ws/ws/boards/${ids.board}`);
  assert.equal(entityDeepLink('action', ids.action, 'ws'), `/ws/ws/actions?artifact=${ids.action}`);
  assert.equal(entityDeepLink('function', ids.function, 'ws'), `/ws/ws/functions?artifact=${ids.function}`);
  assert.equal(entityDeepLink('schedule', ids.schedule, 'ws'), `/ws/ws/schedules?artifact=${ids.schedule}`);
  assert.equal(entityDeepLink('ticket', ids.ticket, 'ws'), null);
});

test('short ids remain plain text instead of becoming fake links', () => {
  const input = '#[ticket:11111111|Short]';
  assert.equal(parseArtifactRefs(input).length, 0);
  const html = renderToStaticMarkup(React.createElement(React.Fragment, null, ...renderMarkdown(input)));
  assert.doesNotMatch(html, /data-ticket-ref/);
  assert.match(html, /11111111/);
});
