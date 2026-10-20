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

const clubText = '[클럽 사이트 만들기](https://divekin.parnmanas.com/clubs/new)에서 시작하세요. 기존 클럽은 클럽 관리 → 사이트 설정에서 변경할 수 있습니다.';

test('a closing URL delimiter ends the link even when Korean prose follows without whitespace', () => {
  checkLinks(renderMarkdown(clubText), ['https://divekin.parnmanas.com/clubs/new'], clubText);
  for (const text of [
    '(https://example.com/path)에서)',
    '[설명](https://example.com/path)에서',
    '[https://example.com/path]에서',
    '{https://example.com/path}에서',
  ]) {
    checkLinks(renderMarkdown(text), ['https://example.com/path'], text);
  }
});

test('delimiter scanning preserves Korean URL paths and balanced parentheses before the prose', () => {
  for (const url of [
    'https://example.com/클럽/새로만들기',
    'https://example.com/a_(b_(c))',
    'https://example.com/?filter=(클럽)&page=2#설정',
    'http://[::1]:7701/클럽',
  ]) {
    const text = `[설명](${url})에서 시작하세요.`;
    checkLinks(renderMarkdown(text), [url], text);
  }
});

test('a second URL after an unmatched closing delimiter is still linked', () => {
  const text = '[첫째](https://example.com/one)와[둘째](https://example.com/two)에서';
  checkLinks(renderMarkdown(text), ['https://example.com/one', 'https://example.com/two'], text);
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
    type: 'text', payload: { text: clubText + ' 결과 (https://example.com/result)입니다. [설명](https://example.com/a_(b))에서' },
  }]);
  checkLinks(h(SessionTranscript, {
    blocks, decidingRequestId: null, permissionsEnabled: true, onDecidePermission() {},
  }), ['https://divekin.parnmanas.com/clubs/new', 'https://example.com/result', 'https://example.com/a_(b)']);
});
