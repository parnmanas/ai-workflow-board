import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { api } from '../src/api.ts';
import ResolvedArtifactRef from '../src/components/chat/ResolvedArtifactRef.tsx';

const id = '44444444-4444-4444-8444-444444444444';

async function renderWith(result) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://awb.test/ws/workspace-1/chat' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  api.resolveArtifactRefs = async () => [result];
  const root = createRoot(document.getElementById('root'));
  await act(async () => {
    root.render(React.createElement(ResolvedArtifactRef, {
      type: 'action', id, claimedLabel: 'Forged label',
    }));
  });
  await act(async () => {});
  return { dom, root };
}

test('uses canonical resolver label and exact deep link, not the claimed label', async () => {
  const { dom, root } = await renderWith({
    type: 'action', id, available: true, label: 'Canonical action',
    deepLink: `/ws/workspace-1/actions?artifact=${id}`,
    workspaceName: 'Platform', boardName: 'Release board',
  });
  const anchor = dom.window.document.querySelector('a');
  assert.ok(anchor);
  assert.equal(anchor.textContent.trim(), '▶️ Canonical action · Platform / Release board');
  assert.equal(anchor.getAttribute('href'), `/ws/workspace-1/actions?artifact=${id}`);
  assert.doesNotMatch(anchor.textContent, /Forged/);
  root.unmount();
});

for (const reason of ['not_found', 'workspace_access_denied']) {
  test(`${reason} renders a disabled full-id fallback`, async () => {
    const { dom, root } = await renderWith({
      type: 'action', id, available: false, label: 'action', deepLink: null, reason,
    });
    assert.equal(dom.window.document.querySelector('a'), null);
    const chip = dom.window.document.querySelector('[aria-disabled="true"]');
    assert.ok(chip);
    assert.match(chip.textContent, new RegExp(id));
    root.unmount();
  });
}

test('no_detail_surface renders type, canonical name, context, and unavailable state', async () => {
  const { dom, root } = await renderWith({
    type: 'action', id, available: false, label: 'Canonical action', deepLink: null,
    workspaceName: 'Platform', boardName: 'Release board', reason: 'no_detail_surface',
  });
  assert.equal(dom.window.document.querySelector('a'), null);
  const chip = dom.window.document.querySelector('[aria-disabled="true"]');
  assert.ok(chip);
  assert.match(chip.textContent, /action · Canonical action/);
  assert.match(chip.textContent, /Platform \/ Release board/);
  assert.match(chip.textContent, /연결 불가: 상세 화면 없음/);
  root.unmount();
});
