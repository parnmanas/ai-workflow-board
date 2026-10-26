import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import SessionTranscript from '../src/components/sessions/SessionTranscript.tsx';
import Markdown, { renderMarkdown } from '../src/components/common/Markdown.tsx';
import MessageList from '../src/components/chat/MessageList.tsx';
import { TicketArtifactView } from '../src/components/TicketArtifact.tsx';
import { splitMarkdownImages } from '../src/components/sessions/markdownImages.ts';

export const gravity = String.raw`\[
\text{아래로 당기는 힘}
=\sum_{\text{모든 원자}}
\frac{G\times\text{내 질량}\times\text{원자 질량}}
{(\text{나와 그 원자의 거리})^2}
\times\text{아래 방향 성분의 비율}
\]`;

function render(t, text, transcript = false) {
  const element = transcript ? React.createElement(SessionTranscript, {
    blocks: [{ kind: 'assistant', key: 'answer', text }], decidingRequestId: null,
    permissionsEnabled: true, onDecidePermission() {},
  }) : React.createElement(Markdown, { text });
  const dom = new JSDOM(renderToStaticMarkup(element));
  t.after(() => dom.window.close());
  return dom.window.document;
}

test('session renders the supplied Korean gravity formula as display math with fractions and sums', t => {
  const doc = render(t, gravity, true);
  assert.equal(doc.querySelectorAll('.katex-display').length, 1);
  assert.equal(doc.querySelectorAll('.katex-error').length, 0);
  assert.equal(doc.querySelectorAll('math mfrac').length, 1);
  assert.match(doc.querySelector('math').textContent, /아래.*당기는.*힘/);
  assert.match(doc.querySelector('annotation').textContent, /\\sum/);
});

test('all four delimiters render and math syntax remains isolated from Markdown', t => {
  const doc = render(t, String.raw`Inline \(x_i^2\), $y_1$, then \[a*b+c*d\] and $$\frac{1}{2}$$.`);
  assert.equal(doc.querySelectorAll('.katex').length, 4);
  assert.equal(doc.querySelectorAll('.katex-display').length, 2);
  assert.equal(doc.querySelectorAll('em').length, 0);
});

test('currency, escaped dollars, code spans and fenced examples stay literal', t => {
  const text = 'Prices $5 and $10; \\$20. `\\(x\\)` and `` ` $x$ \\[y\\] ``\n\n```math\n\\[literal\\]\n```';
  const doc = render(t, text);
  assert.equal(doc.querySelectorAll('.katex').length, 0);
  assert.match(doc.body.textContent, /Prices \$5 and \$10/);
  assert.equal(doc.querySelector('pre code').textContent, '\\[literal\\]\n');
  assert.equal(doc.querySelectorAll('[aria-label="Copy code"]').length, 1);
});

test('incomplete streamed math preserves its delimiters; invalid TeX does not lose following prose', t => {
  for (const text of [String.raw`\[\frac{1}{`, String.raw`\(x_`, '$$x^']) {
    const doc = render(t, text);
    assert.equal(doc.querySelector('.math-pending').textContent, text);
    assert.equal(doc.querySelectorAll('.katex').length, 0);
  }
  const doc = render(t, String.raw`\[\frac{\] 뒤 문장은 남습니다.`);
  assert.equal(doc.querySelectorAll('.katex-error').length, 1);
  assert.match(doc.body.textContent, /뒤 문장은 남습니다/);
});

test('headings, nested lists, tables, tasks, quotes, strike and named links have semantic markup', t => {
  const doc = render(t, '# 제목\n\n1. 첫째\n   - 하위\n\n- [x] 완료\n- [ ] 대기\n\n> 인용\n\n~~취소~~\n\n| 이름 | 값 |\n| --- | ---: |\n| 질량 | $m$ |\n\n[사이트](https://example.com)');
  assert.equal(doc.querySelector('h1').textContent, '제목');
  assert.equal(doc.querySelector('ol ul li').textContent, '하위');
  assert.equal(doc.querySelectorAll('input[type=checkbox][disabled]').length, 2);
  assert.equal(doc.querySelectorAll('table tbody tr').length, 1);
  assert.equal(doc.querySelectorAll('td .katex').length, 1);
  // Message content is authored text, not a translated UI label.
  assert.equal(doc.querySelector('del').textContent, '취소');
  assert.equal(doc.querySelector('blockquote').textContent.trim(), '인용');
  assert.equal(doc.querySelector('a').textContent, '사이트');
  assert.equal(doc.querySelector('a').rel, 'noopener noreferrer');
});

test('raw HTML, unsafe links and untrusted TeX cannot introduce active elements', t => {
  const doc = render(t, String.raw`<script>alert(1)</script>

[bad](javascript:alert%281%29) [data](data:text/html,test)

\[\href{javascript:alert(1)}{click}\]
\[\includegraphics{https://example.com/tracker.png}\]`);
  assert.equal(doc.querySelectorAll('script, iframe, img, a, [onclick]').length, 0);
  assert.match(doc.body.textContent, /bad/);
});

test('structured mention pills and ticket cards survive Markdown parsing', t => {
  const doc = render(t, '**담당:** @[user:user-1|민수]\n\n@[ticket:ticket-1|수식 수정]');
  assert.equal(doc.querySelector('[data-mention-raw]').textContent, '@민수');
  assert.match(doc.body.textContent, /수식 수정/);
  assert.doesNotMatch(doc.body.textContent, /@\[ticket/);
});

test('formula-shaped link destinations stay intact and labels can contain inline math', t => {
  const doc = render(t, String.raw`[\(x\)](https://example.com/$x$) and https://example.com/$y$`);
  assert.equal(doc.querySelectorAll('.katex').length, 1);
  assert.deepEqual([...doc.querySelectorAll('a')].map(a => a.getAttribute('href')), ['https://example.com/$x$', 'https://example.com/$y$']);
});

test('formula and multi-backtick examples never trigger image/file preview loading', () => {
  const text = String.raw`\[\text{![example](./x.png)}\]` + '\n`` ` ![code](./code.png) ``\n![real](./real.png)';
  assert.deepEqual(splitMarkdownImages(text).filter(s => s.kind === 'image').map(s => s.target), ['./real.png']);
});

test('code source preserves CRLF, blank lines and incomplete streamed fences', t => {
  for (const suffix of ['```', '']) {
    const code = '  echo hi\r\n\tvalue\r\n\r\n';
    const doc = render(t, '```sh\r\n' + code + suffix);
    // HTML parsing normalizes CRLF; the React output retains the actual code source.
    assert.equal(doc.querySelector('pre code').textContent, code.replaceAll('\r\n', '\n'));
    assert.equal(doc.querySelectorAll('[aria-label="Copy code"]').length, 1);
  }
});

test('nested and indented code never exposes internal math placeholders', t => {
  for (const source of ['    \\[x\\]', '> ```tex\n> \\[x\\]\n> ```']) {
    const doc = render(t, source);
    assert.equal(doc.querySelectorAll('.katex').length, 0);
    assert.match(doc.querySelector('pre code').textContent, /\\\[x\\\]/);
    assert.doesNotMatch(doc.body.textContent, /AWBMATH/);
  }
});


test('chat messages and ticket descriptions/comments use the shared math and table renderer', t => {
  const text = gravity + '\n\n| 이름 | 값 |\n| --- | --- |\n| 질량 | $m$ |';
  const elements = [
    React.createElement('div', null, renderMarkdown(text)),
    React.createElement(MessageList, { participantCount: 1, messages: [{ id: 'm1', content: text, sender_type: 'agent', sender_name: 'Host/Agent', created_at: '2026-10-26T00:00:00Z' }] }),
    React.createElement(TicketArtifactView, { state: { status: 'loaded', ticket: { id: 't1', title: '수식', description: text } } }),
    React.createElement(TicketArtifactView, { state: { status: 'loaded', ticket: { id: 't1', title: '수식', comments: [{ id: 'c1', author: 'Host/Agent', author_type: 'agent', content: text }] } } }),
  ];
  for (const element of elements) {
    const dom = new JSDOM(renderToStaticMarkup(element));
    t.after(() => dom.window.close());
    const doc = dom.window.document;
    assert.equal(doc.querySelectorAll('.awb-markdown .katex-display').length, 1);
    assert.equal(doc.querySelectorAll('.awb-markdown table').length, 1);
    assert.equal(doc.querySelectorAll('td .katex').length, 1);
  }
});

test('shared renderer retains participant mentions, role pills and literal code examples', t => {
  const element = React.createElement(Markdown, {
    text: '@Rolf @reviewer @[user:u1|민수] `@Rolf`',
    participants: [{ id: 'a1', name: 'Rolf', type: 'agent' }],
  });
  const dom = new JSDOM(renderToStaticMarkup(element));
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  assert.equal(doc.querySelectorAll('[aria-label="Mention: @Rolf"]').length, 1);
  assert.equal(doc.querySelectorAll('[aria-label="Mention: @reviewer"]').length, 1);
  assert.equal(doc.querySelector('[data-mention-raw]').getAttribute('data-mention-raw'), '@[user:u1|민수]');
  assert.equal(doc.querySelector('code').textContent, '@Rolf');
});
