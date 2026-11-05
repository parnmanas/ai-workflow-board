import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { setupDom, mount, act, click, React } from './helpers/jsdom.mjs';
import PullToRefresh from '../src/components/PullToRefresh.tsx';
import { usePageTab } from '../src/hooks/usePageQuery.ts';

const h = React.createElement;

function fixture(t) {
  const dom = setupDom();
  const previousElement = globalThis.Element;
  globalThis.Element = window.Element;
  let refreshes = 0;
  const props = { onRefresh: () => { refreshes++; } };
  const children = h('div', { id: 'scroll', style: { overflowY: 'auto' } },
    h('p', { id: 'target' }, 'Content'), h('textarea'), h('button', null, 'Action'), h('canvas'));
  const view = mount(h(MemoryRouter, null, h(PullToRefresh, props, children)));
  t.after(() => { view.unmount(); dom.cleanup(); globalThis.Element = previousElement; });
  return { view, props, children, count: () => refreshes };
}

function touch(target, type, x, y, count = 1) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: Array.from({ length: count }, (_, identifier) => ({ identifier, clientX: x, clientY: y })) });
  act(() => target.dispatchEvent(event));
  return event;
}
const flushFrames = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 65)); });

test('pull at the top shows progress and refreshes once only after release', async t => {
  const f = fixture(t);
  const target = document.querySelector('#target');
  touch(target, 'touchstart', 100, 100);
  assert.equal(touch(target, 'touchmove', 100, 150).defaultPrevented, true);
  assert.match(document.querySelector('[role="status"]').textContent, /Pull down/);
  touch(target, 'touchmove', 100, 300);
  assert.match(document.querySelector('[role="status"]').textContent, /Release/);
  assert.equal(f.count(), 0);
  touch(target, 'touchend', 100, 300, 0);
  await flushFrames();
  touch(target, 'touchend', 100, 300, 0);
  assert.equal(f.count(), 1);
});

for (const scenario of ['short', 'horizontal', 'upward', 'cancelled', 'multitouch', 'retreated', 'scrolled', 'reached-top', 'outer-scroll']) {
  test(`${scenario} gesture never reloads`, async t => {
    const f = fixture(t);
    const target = document.querySelector('#target');
    const scroll = document.querySelector('#scroll');
    if (scenario === 'scrolled' || scenario === 'reached-top') scroll.scrollTop = 80;
    if (scenario === 'outer-scroll') document.querySelector('main').scrollTop = 80;
    touch(target, 'touchstart', 100, 100);
    if (scenario === 'reached-top') scroll.scrollTop = 0;
    if (scenario === 'horizontal') touch(target, 'touchmove', 150, 110);
    if (scenario === 'upward') touch(target, 'touchmove', 100, 60);
    touch(target, 'touchmove', 100, scenario === 'short' ? 140 : 300, scenario === 'multitouch' ? 2 : 1);
    if (scenario === 'retreated') touch(target, 'touchmove', 100, 130);
    touch(target, scenario === 'cancelled' ? 'touchcancel' : 'touchend', 100, 300, 0);
    await flushFrames();
    assert.equal(f.count(), 0);
    assert.equal(document.querySelector('[role="status"]'), null);
  });
}

for (const selector of ['textarea', 'button', 'canvas']) {
  test(`pulling on ${selector} keeps its native interaction`, async t => {
    const f = fixture(t);
    const target = document.querySelector(selector);
    touch(target, 'touchstart', 100, 100);
    assert.equal(touch(target, 'touchmove', 100, 300).defaultPrevented, false);
    touch(target, 'touchend', 100, 300, 0);
    await flushFrames();
    assert.equal(f.count(), 0);
  });
}

test('opening navigation mid-pull cancels the gesture', async t => {
  const f = fixture(t);
  const target = document.querySelector('#target');
  touch(target, 'touchstart', 100, 100);
  touch(target, 'touchmove', 100, 300);
  f.view.rerender(h(MemoryRouter, null, h(PullToRefresh, { ...f.props, disabled: true }, f.children)));
  touch(target, 'touchend', 100, 300, 0);
  await flushFrames();
  assert.equal(f.count(), 0);
});

test('tab URL preserves other selections and hash; Back and unknown tabs resolve correctly', t => {
  const dom = setupDom();
  function Screen() {
    const [tab, setTab] = usePageTab(['overview', 'history'], 'overview');
    const location = useLocation();
    const navigate = useNavigate();
    return h('div', null, h('output', null, `${tab}|${location.pathname}${location.search}${location.hash}`),
      h('button', { onClick: () => setTab('history') }, 'History'),
      h('button', { onClick: () => navigate('/projects?tab=invalid') }, 'Other'),
      h('button', { onClick: () => navigate(-1) }, 'Back'));
  }
  const view = mount(h(MemoryRouter, { initialEntries: ['/projects?project=p&filter=open#anchor'] }, h(Screen)));
  t.after(() => { view.unmount(); dom.cleanup(); });
  const buttons = [...document.querySelectorAll('button')];
  click(buttons[0]);
  assert.equal(document.querySelector('output').textContent, 'history|/projects?project=p&filter=open&tab=history#anchor');
  click(buttons[1]);
  assert.equal(document.querySelector('output').textContent, 'overview|/projects?tab=invalid');
  click(buttons[2]);
  assert.equal(document.querySelector('output').textContent, 'history|/projects?project=p&filter=open&tab=history#anchor');
});
