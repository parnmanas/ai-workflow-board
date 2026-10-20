import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { renderMarkdown } from '../src/components/chat/utils/markdown.tsx';
import SessionTranscript from '../src/components/sessions/SessionTranscript.tsx';
import { buildTranscript } from '../src/components/sessions/sessionTranscript.logic.ts';

const h = React.createElement;

function checkLinks(element, hrefs, originalText) {
  const dom = new JSDOM(renderToStaticMarkup(h('main', null, element)));
  try {
    const main = dom.window.document.querySelector('main');
    const links = [...main.querySelectorAll('a')];
    assert.deepEqual(links.map(link => link.getAttribute('href')), hrefs);
    assert.deepEqual(links.map(link => link.textContent), hrefs);
    for (const link of links) {
      assert.equal(link.target, '_blank');
      assert.equal(link.rel, 'noopener noreferrer');
    }
    if (originalText !== undefined) assert.equal(main.textContent, originalText);
  } finally {
    dom.window.close();
  }
}

test('shared chat renderer excludes closing prose brackets and punctuation without dropping text', () => {
  for (const text of [
    '(https://example.com/path)',
    '((https://example.com/path)).',
    '[자료](https://example.com/path)',
    '참고 [https://example.com/path],',
    '참고 {https://example.com/path}.',
    'https://example.com/path!',
    '<https://example.com/path>',
    '"https://example.com/path"',
    "'https://example.com/path'",
  ]) {
    checkLinks(renderMarkdown(text), ['https://example.com/path'], text);
  }
});

test('balanced and encoded URL parentheses, queries, fragments and IPv6 hosts stay intact', () => {
  for (const url of [
    'https://example.com/wiki/Function_(mathematics)',
    'https://example.com/a_(b_(c))',
    'https://example.com/a%28b%29',
    'https://example.com/?filter=(a,b)&page=2#section',
    'http://[::1]:7701/path',
  ]) {
    const text = `참고 (${url}).`;
    checkLinks(renderMarkdown(text), [url], text);
  }
});

test('multiple links keep their own destinations and code remains literal', () => {
  const text = '(https://example.com/one), https://example.com/two.';
  checkLinks(renderMarkdown(text), ['https://example.com/one', 'https://example.com/two'], text);
  checkLinks(renderMarkdown('`https://example.com/code)`\n```\nhttps://example.com/fenced)\n```'), []);
  checkLinks(renderMarkdown('[bad](javascript:alert(1)) [bad](data:text/html,test)'), []);
});

test('session transcript uses the same corrected link destinations', () => {
  const blocks = buildTranscript([{
    id: 'text-1', seq: 1, turn_id: 'turn-1', created_at: '2026-10-21T00:00:00Z',
    type: 'text', payload: { text: '결과 (https://example.com/result). [설명](https://example.com/a_(b))' },
  }]);
  checkLinks(h(SessionTranscript, {
    blocks, decidingRequestId: null, permissionsEnabled: true, onDecidePermission() {},
  }), ['https://example.com/result', 'https://example.com/a_(b)']);
});
