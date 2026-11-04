import { ui, uiPattern } from './helpers/i18n.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, mount, click, React, act } from './helpers/jsdom.mjs';
import { api } from '../src/api.ts';
import SessionTranscript from '../src/components/sessions/SessionTranscript.tsx';
import { buildTranscript } from '../src/components/sessions/sessionTranscript.logic.ts';

const html = '<!DOCTYPE html><html><head><title>504: Gateway time-out</title></head><body>Cloudflare private diagnostic details</body></html>';
const loaders = {
  image: () => api.getHostSessionImage('host', 'claude', 'session', 'image-ref'),
  local: () => api.getHostSessionLocalImage('host', 'claude', 'session', './shot.png', '/repo'),
};

function setup(t) {
  const dom = setupDom();
  t.mock.method(globalThis, 'fetch');
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = dom.window.localStorage;
  t.after(() => { if (previousStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = previousStorage; });
  t.after(() => dom.cleanup());
}

for (const [kind, load] of Object.entries(loaders)) {
  test(`${kind}: a gateway HTML error stays concise and retry recovers the image`, async (t) => {
    setup(t);
    let calls = 0;
    globalThis.fetch.mock.mockImplementation(async () => {
      calls++;
      return calls === 1
        ? new Response(html, { status: 504, headers: { 'Content-Type': 'text/html' } })
        : new Response(new Blob(['image bytes'], { type: 'image/png' }));
    });
    t.mock.method(URL, 'createObjectURL', () => 'blob:retried-image');
    const revoke = t.mock.method(URL, 'revokeObjectURL', () => {});
    const event = kind === 'image'
      ? { type: 'image', payload: { image_ref: 'image-ref', mime_type: 'image/png', size: 11 } }
      : { type: 'text', payload: { text: '![screenshot](./shot.png)' } };
    const blocks = buildTranscript([{ ...event, id: '1', seq: 1, turn_id: 'turn', created_at: new Date().toISOString() }]);
    const view = mount(React.createElement(SessionTranscript, {
      blocks, decidingRequestId: null, permissionsEnabled: true, onDecidePermission() {},
      loadImage: load, loadLocalImage: load,
    }));
    let unmounted = false;
    t.after(() => { if (!unmounted) view.unmount(); });
    await act(async () => {});
    assert.match(view.container.textContent, uiPattern('서버 응답 시간이 초과되었습니다 (HTTP {0}). 잠시 후 다시 시도해 주세요.', {0: 504}));
    assert.doesNotMatch(view.container.textContent, /DOCTYPE|<html|Cloudflare|private diagnostic/);
    assert.equal(calls, 1, 'failed images do not retry in a loop');
    const retry = [...view.container.querySelectorAll('button')].find((button) => button.textContent === ui("다시 시도"));
    assert.ok(retry);
    await act(async () => { click(retry); });
    await act(async () => {});
    assert.equal(calls, 2);
    assert.equal(view.container.querySelector('img')?.getAttribute('src'), 'blob:retried-image');
    assert.doesNotMatch(view.container.textContent, uiPattern("이미지를 가져오지 못했습니다"));
    view.unmount();
    unmounted = true;
    assert.equal(revoke.mock.calls.length, 1, 'retry image URL is released on unmount');
  });

  test(`${kind}: API error details and HTTP status are preserved`, async (t) => {
    setup(t);
    globalThis.fetch.mock.mockImplementation(async () => Response.json({ message: 'Image is no longer available', error: 'image_not_found' }, { status: 404 }));
    await assert.rejects(load, (error) => error.message === 'Image is no longer available' && error.code === 'image_not_found' && error.status === 404);
  });

  test(`${kind}: malformed JSON and HTML inside JSON cannot leak page source`, async (t) => {
    setup(t);
    for (const body of ['null', '{broken', JSON.stringify({ message: html })]) {
      globalThis.fetch.mock.mockImplementation(async () => new Response(body, { status: 502 }));
      await assert.rejects(load, (error) => error.message.includes('HTTP 502') && !error.message.includes('<html'));
    }
  });
}

test('image: the event mime types the untyped bytes so downloads get an extension and the app clipboard takes them — never SVG', async (t) => {
  setup(t);
  // 서버는 세션 이미지를 형식 없이 준다(형식은 이벤트가 든다).
  globalThis.fetch.mock.mockImplementation(async () => new Response(new Blob(['image bytes']), { headers: { 'Content-Type': 'application/octet-stream' } }));
  const made = [];
  t.mock.method(URL, 'createObjectURL', (blob) => { made.push(blob); return `blob:typed-${made.length}`; });
  t.mock.method(URL, 'revokeObjectURL', () => {});
  const events = [
    { type: 'image', payload: { image_ref: 'png-ref', mime_type: 'image/png', size: 11 } },
    { type: 'image', payload: { image_ref: 'svg-ref', mime_type: 'image/svg+xml', size: 11 } },
  ].map((event, i) => ({ ...event, id: String(i + 1), seq: i + 1, turn_id: 'turn', created_at: new Date().toISOString() }));
  const view = mount(React.createElement(SessionTranscript, {
    blocks: buildTranscript(events), decidingRequestId: null, permissionsEnabled: true, onDecidePermission() {},
    loadImage: (ref) => api.getHostSessionImage('host', 'claude', 'session', ref),
  }));
  t.after(() => view.unmount());
  await act(async () => {});
  assert.deepEqual(made.map((blob) => blob.type).sort(), ['application/octet-stream', 'image/png'], 'PNG is typed, SVG stays bytes');
  for (const blob of made) assert.equal(await blob.text(), 'image bytes', 'typing keeps the bytes');
});
