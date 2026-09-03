// 회귀 테스트 — approve 등급을 승인 요청이 불가능한 런타임에 고를 때 운영자에게
// 경고가 보이는지 (ticket 5851e435, 리뷰 라운드2).
//
// 배경: 매니저는 `approve` + `native_approvals=false` 조합의 spawn 을 거부한다.
// 그 사실을 저장 시점 전에 알려주지 않으면 운영자는 저장한 뒤 디스패치가 막히는
// 것을 보고서야 알게 된다. Permission mode 셀렉트의 라벨이 "Approve — ask
// through AWB" 라 더더욱 오해를 부른다.
//
// 실제 컴포넌트를 마운트해 셀렉트를 바꾸고 화면 상태를 단언한다(소스 문자열
// 검사가 아니다).

import test from 'node:test';
import assert from 'node:assert/strict';
import { React, act, mount, setupDom } from './helpers/jsdom.mjs';

const { default: RuntimeConfigFields } = await import(
  '../src/components/admin/RuntimeConfigFields.tsx'
);

const CLI_TIERS = { strict: 'native', approve: 'approximated', trusted: 'native' };
const ACP_TIERS = { strict: 'native', approve: 'native', trusted: 'native' };

function selectionFor(runtime, permissionMode) {
  return {
    runtime,
    strategy: 'single',
    permissionMode,
    profile: '',
    maxChildren: '',
    maxIterations: '',
  };
}

function render({ runtime, permissionMode, permissionTiers }) {
  const dom = setupDom();
  const view = mount(React.createElement(RuntimeConfigFields, {
    value: selectionFor(runtime, permissionMode),
    onChange() {},
    permissionTiers,
  }));
  return {
    warning: () => view.container.querySelector('[data-testid="approve-unsupported-warning"]'),
    text: () => view.container.textContent || '',
    cleanup() { view.unmount(); dom.cleanup(); },
  };
}

test('approve + 승인 브리지 없는 런타임 → 경고가 보인다', async () => {
  const h = render({
    runtime: 'claude',
    permissionMode: 'approve',
    permissionTiers: { claude: CLI_TIERS },
  });
  try {
    await act(async () => {});
    const warning = h.warning();
    assert.ok(warning, 'approve 를 골랐는데 경고가 렌더되지 않았다');
    assert.match(warning.textContent, /claude/, '어느 런타임이 문제인지 밝혀야 한다');
    assert.match(warning.textContent, /차단/, '저장 후 디스패치가 막힌다는 결과를 알려야 한다');
    // 세 출구를 모두 제시해야 운영자가 한 번에 결정할 수 있다.
    assert.match(warning.textContent, /Trusted/);
    assert.match(warning.textContent, /Strict/);
    assert.match(warning.textContent, /Hermes/);
    // 한글이 \uXXXX 리터럴로 깨지지 않고 실제 텍스트로 렌더돼야 한다.
    assert.equal(warning.textContent.includes('\\u'), false, warning.textContent);
  } finally {
    h.cleanup();
  }
});

test('approve + 승인 브리지 있는 런타임(hermes) → 경고가 없다', async () => {
  const h = render({
    runtime: 'hermes',
    permissionMode: 'approve',
    permissionTiers: { hermes: ACP_TIERS },
  });
  try {
    await act(async () => {});
    assert.equal(h.warning(), null, 'hermes 는 실제로 승인을 요청할 수 있으므로 경고 대상이 아니다');
  } finally {
    h.cleanup();
  }
});

test('approve 가 아닌 등급에서는 경고가 없다', async () => {
  for (const mode of ['trusted', 'strict', '']) {
    const h = render({
      runtime: 'claude',
      permissionMode: mode,
      permissionTiers: { claude: CLI_TIERS },
    });
    try {
      await act(async () => {});
      assert.equal(h.warning(), null, `permissionMode=${mode || '(미선택)'}`);
    } finally {
      h.cleanup();
    }
  }
});

test('Host 가 permission_tiers 를 보고하지 않으면 경고를 지어내지 않는다', async () => {
  // 구버전 매니저는 이 필드를 아예 안 보낸다. 보고된 적 없는 사실을 서버도
  // 클라이언트도 만들어내지 않는다는 계약.
  for (const tiers of [undefined, {}, { claude: undefined }]) {
    const h = render({ runtime: 'claude', permissionMode: 'approve', permissionTiers: tiers });
    try {
      await act(async () => {});
      assert.equal(h.warning(), null, `permissionTiers=${JSON.stringify(tiers)}`);
    } finally {
      h.cleanup();
    }
  }
});
