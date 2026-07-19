// 결과물 카드 렌더 계약 테스트 — F2-4 ⓒ (ticket d21b28fc).
//
// 빌드/배포 결과물 ref(metadata.artifact_refs)를 MessageList 가 ArtifactRefCard 로
// 렌더한다. 배포 URL 이 있으면 링크(<a target=_blank>), 없으면 비인터랙티브 배지(<span>).
// 상태 톤·짧은 커밋·종류 배지·접근성 라벨을 react-dom/server 로 jsdom 없이 고정한다
// (순수 프레젠테이션 — api/부수효과 없음).
//
// 실행:  node --import tsx --test apps/client/test/artifact-ref-card.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import ArtifactRefCard from '../src/components/chat/ArtifactRefCard.tsx';

const render = (artifact) => renderToStaticMarkup(React.createElement(ArtifactRefCard, { artifact }));

test('배포(url 있음) → 새 탭 링크 + 종류/상태/짧은 커밋', () => {
  const html = render({ kind: 'deploy', title: 'production', status: 'deployed', commit: 'abcdef1234567', url: 'https://app.example.com' });
  assert.match(html, /<a /); // url 있으면 링크로
  assert.match(html, /href="https:\/\/app\.example\.com"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /data-artifact-ref="deploy"/);
  assert.match(html, /배포/); // 종류 배지(한글)
  assert.match(html, /🚀/); // 배포 아이콘
  assert.match(html, /production/); // title
  assert.match(html, /data-artifact-status="deployed"/); // 상태 배지
  assert.match(html, /abcdef1/); // 7자 짧은 커밋
  assert.doesNotMatch(html, /abcdef1234567/); // 전체 커밋은 노출 안 함
  assert.match(html, /aria-label="배포 결과물: production \(deployed\) — 열기"/);
});

test('빌드(url 없음) → 비인터랙티브 배지(span, 링크 아님)', () => {
  const html = render({ kind: 'build', title: 'server', status: 'ok', commit: 'deadbeef99' });
  assert.doesNotMatch(html, /<a /); // 링크 아님
  assert.match(html, /data-artifact-ref="build"/);
  assert.match(html, /빌드/); // 종류 배지
  assert.match(html, /🔨/); // 빌드 아이콘
  assert.match(html, /server/);
  assert.match(html, /data-artifact-status="ok"/);
  assert.match(html, /deadbee/); // 짧은 커밋 7자
  assert.match(html, /aria-label="빌드 결과물: server \(ok\)"/); // "열기" 없음(링크 아님)
});

test('실패 빌드 → status 배지 노출(위험 톤 대상)', () => {
  const html = render({ kind: 'build', title: 'client', status: 'failed' });
  assert.match(html, /data-artifact-status="failed"/);
  assert.match(html, /failed/);
});

test('status/commit/url 없어도 종류·title 로 렌더된다', () => {
  const html = render({ kind: 'build', title: 'server' });
  assert.doesNotMatch(html, /<a /);
  assert.doesNotMatch(html, /data-artifact-status/); // 상태 배지 없음
  assert.match(html, /server/);
  assert.match(html, /aria-label="빌드 결과물: server"/); // 상태 괄호 없음
});

test('미매핑 종류 → 코드 그대로 + 기본 아이콘', () => {
  const html = render({ kind: 'weird', title: 'x' });
  assert.match(html, /data-artifact-ref="weird"/);
  assert.match(html, /weird/); // KIND_LABEL 미매핑 → 코드 문자열
  assert.match(html, /📦/); // 기본 아이콘
});
