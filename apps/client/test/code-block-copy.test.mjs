import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, mount, click, React, act } from './helpers/jsdom.mjs';
import { renderMarkdown } from '../src/components/common/Markdown.tsx';
import { splitMarkdownFences } from '../src/utils/markdownFences.ts';
import { splitMarkdownImages } from '../src/components/sessions/markdownImages.ts';
import CodeBlock from '../src/components/common/CodeBlock.tsx';
import SessionTranscript from '../src/components/sessions/SessionTranscript.tsx';
import { buildTranscript } from '../src/components/sessions/sessionTranscript.logic.ts';

const h = React.createElement;
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
function clipboard(t, value) {
  const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value });
  t.after(() => {
    if (previous) Object.defineProperty(navigator, 'clipboard', previous);
    else delete navigator.clipboard;
  });
}

test('fenced scripts copy literal whitespace without language, fences or interpreted HTML/mentions', async t => {
  const dom = setupDom();
  const copied = [];
  clipboard(t, { writeText: async text => { copied.push(text); } });
  const code = '  echo "<script>alert(1)</script>"\r\n\t@[user:id|Name]\r\n\r\n';
  const view = mount(h('div', null, renderMarkdown(`Before\n\`\`\`bash\r\n${code}\`\`\`\nAfter`)));
  t.after(() => { view.unmount(); dom.cleanup(); });
  assert.equal(document.querySelector('pre code').textContent, code);
  assert.equal(Boolean(document.querySelector('script, [data-mention-raw]')), false);
  click(document.querySelector('button[aria-label="Copy code"]'));
  await flush();
  assert.deepEqual(copied, [code]);
  assert.match(document.querySelector('button').textContent, /Copied!/);
});

test('inline code stays inline; independent code blocks copy only their own content', async t => {
  const dom = setupDom();
  const copied = [];
  clipboard(t, { writeText: async text => { copied.push(text); } });
  const view = mount(h('div', null, renderMarkdown('Use `npm test`.\n```sh\nnpm test\n```\n~~~sql\nSELECT 1;\n~~~')));
  t.after(() => { view.unmount(); dom.cleanup(); });
  const buttons = document.querySelectorAll('button[aria-label="Copy code"]');
  assert.equal(buttons.length, 2);
  click(buttons[1]); await flush();
  assert.deepEqual(copied, ['SELECT 1;\n']);
  assert.equal(buttons[0].textContent, 'Copy');
});

test('streaming blocks and longer fences protect literal preview links', () => {
  const text = '  ````md\n```js\n![example](./image.png)\n```\n  ````\n![real](./real.png)';
  const code = splitMarkdownFences(text).find(s => s.kind === 'code');
  assert.equal(code.code, '```js\n![example](./image.png)\n```\n');
  assert.deepEqual(splitMarkdownImages(text).filter(s => s.kind === 'image').map(s => s.target), ['./real.png']);
  const streaming = '~~~sh\necho "[unfinished]"\n';
  assert.equal(splitMarkdownImages(streaming)[0].text, streaming);
  assert.equal(splitMarkdownFences(streaming)[0].code, 'echo "[unfinished]"\n');
});

test('copy uses the latest streamed code and resets the previous success label', async t => {
  const dom = setupDom();
  const copied = [];
  clipboard(t, { writeText: async text => { copied.push(text); } });
  const view = mount(h(CodeBlock, { code: 'echo one' }));
  t.after(() => { view.unmount(); dom.cleanup(); });
  click(document.querySelector('button')); await flush();
  view.rerender(h(CodeBlock, { code: 'echo one\necho two' }));
  assert.equal(document.querySelector('button').textContent, 'Copy');
  click(document.querySelector('button')); await flush();
  assert.deepEqual(copied, ['echo one', 'echo one\necho two']);
});

test('HTTP clipboard fallback preserves focus and selection and removes its temporary textarea', async t => {
  const dom = setupDom();
  clipboard(t, undefined);
  let copied;
  document.execCommand = command => {
    assert.equal(command, 'copy');
    copied = document.querySelector('textarea').value;
    return true;
  };
  const view = mount(h(CodeBlock, { code: '  literal\n' }));
  t.after(() => { view.unmount(); dom.cleanup(); });
  const button = document.querySelector('button');
  button.focus();
  const range = document.createRange();
  range.selectNodeContents(document.querySelector('pre code'));
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);
  click(button); await flush();
  assert.equal(copied, '  literal\n');
  assert.equal(Boolean(document.querySelector('textarea')), false);
  assert.ok(document.activeElement === button);
  assert.equal(window.getSelection().toString(), '  literal\n');
});

test('denied copy shows a recoverable error and never reports success', async t => {
  const dom = setupDom();
  clipboard(t, { writeText: async () => { throw new Error('denied'); } });
  document.execCommand = () => { throw new Error('unavailable'); };
  const view = mount(h(CodeBlock, { code: 'npm test' }));
  t.after(() => { view.unmount(); dom.cleanup(); });
  click(document.querySelector('button')); await flush();
  assert.match(document.querySelector('[role="alert"]').textContent, /Copy failed/);
  assert.equal(document.querySelector('button').textContent, 'Copy');
  assert.equal(Boolean(document.querySelector('textarea')), false);
});

test('session assistant code and clipped tool output share copy controls; output copies all received text', async t => {
  const dom = setupDom();
  const copied = [];
  clipboard(t, { writeText: async text => { copied.push(text); } });
  const output = 'x'.repeat(21000) + 'last line';
  const events = [
    { type: 'text', payload: { text: '```sh\necho hi\n```' } },
    { type: 'tool_call', payload: { tool_call_id: 'tool-1', title: 'Shell', kind: 'execute', input: { command: 'echo hi' } } },
    { type: 'tool_update', payload: { tool_call_id: 'tool-1', status: 'completed', output } },
  ].map((event, index) => ({ ...event, id: String(index), seq: index, turn_id: 'turn', created_at: '2026-10-15T00:00:00Z' }));
  const view = mount(h(SessionTranscript, { blocks: buildTranscript(events), decidingRequestId: null, permissionsEnabled: true, onDecidePermission() {} }));
  t.after(() => { view.unmount(); dom.cleanup(); });
  const buttons = document.querySelectorAll('button[aria-label="Copy code"]');
  assert.equal(buttons.length, 3);
  assert.ok(document.querySelectorAll('pre')[2].textContent.length < output.length);
  click(buttons[2]); await flush();
  assert.deepEqual(copied, [output]);
});
