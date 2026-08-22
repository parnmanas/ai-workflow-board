// 실브라우저(jsdom) 스모크: ChunkLoadErrorBoundary — 흰 화면 대신 안내 배너
// (ticket 2cae7314).
//
// React.lazy 의 청크 로드 실패는 렌더 중 예외로 표면화된다 — 이 스모크는 그 계약을
// "렌더 중 던지는 자식"으로 재현해 경계가 실제로 화면에 배너를 그리는지 실마운트로
// 고정한다. 클릭 시 window.location.reload() 호출 자체는 jsdom 이 Location.reload
// 를 재정의 불가로 만들어 스텁할 수 없어(네이티브 not-implemented) 검증 범위에서
// 제외 — 순수 판단 로직(isChunkLoadError/shouldReloadForChunkError)은
// chunk-reload.test.mjs 가 이미 커버한다.
//
// 실행:  node --import tsx --test apps/client/test/smoke-chunk-error-boundary.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { setupDom, mount, React } from './helpers/jsdom.mjs';
import { ChunkLoadErrorBoundary } from '../src/components/common/ChunkLoadErrorBoundary.tsx';

const h = React.createElement;

// 렌더 중 던지는 테스트 전용 컴포넌트 — React.lazy 가 청크 로드 실패 시 렌더 중
// reject 사유를 그대로 던지는 것과 동일한 형태(경계 입장에선 출처가 무관하다).
function Boom({ error }) {
  throw error;
}

test('청크 로드 실패 모양의 오류는 "새 버전이 배포되었습니다" 안내로 흡수된다', () => {
  const dom = setupDom();
  try {
    mount(
      h(
        ChunkLoadErrorBoundary,
        null,
        h(Boom, { error: new TypeError('Failed to fetch dynamically imported module: https://x/y.js') }),
      ),
    );

    const alert = document.querySelector('[role="alert"]');
    assert.ok(alert, '흰 화면 대신 role=alert 배너가 떠야 한다');
    assert.match(alert.textContent, /새 버전이 배포되었습니다/);

    const retryButton = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '새로고침');
    assert.ok(retryButton, '새로고침 버튼이 노출돼야 한다');
  } finally {
    dom.cleanup();
  }
});

test('청크 로드 실패가 아닌 일반 렌더 오류는 일반 안내로 흡수된다(오분류 방지)', () => {
  const dom = setupDom();
  try {
    mount(
      h(
        ChunkLoadErrorBoundary,
        null,
        h(Boom, { error: new TypeError("Cannot read properties of undefined (reading 'foo')") }),
      ),
    );

    const alert = document.querySelector('[role="alert"]');
    assert.ok(alert, '이 경우도 흰 화면 대신 배너가 떠야 한다');
    assert.match(alert.textContent, /문제가 발생했습니다/);
    assert.doesNotMatch(alert.textContent, /새 버전이 배포되었습니다/, '무관한 오류를 배포 안내로 오분류하면 안 된다');
  } finally {
    dom.cleanup();
  }
});
