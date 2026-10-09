// GitHub 최신 APK 조회 — apps/client/src/githubRelease.ts.
//
// 고정하는 것:
//   1. 다운로드는 고정 latest 링크다. 새 릴리즈가 곧바로 최신본이 되며,
//      API가 막힌 환경에서도 다운로드는 된다.
//   2. 버전 표시는 latest 릴리즈 JSON에서 `awb-android.apk` 에셋을 골라 붙인다.
//      에셋이 없으면 null — 호출 쪽이 "미게시"로 떨어진다.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GITHUB_ANDROID_APK_URL,
  GITHUB_ANDROID_ASSET_NAME,
  formatApkSize,
  pickApkAsset,
} from '../src/githubRelease.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const releaseJson = {
  tag_name: 'android-v1.0',
  published_at: '2026-10-09T12:00:00Z',
  assets: [
    { name: 'notes.txt', size: 12, browser_download_url: 'https://example.test/notes.txt' },
    { name: 'awb-android.apk', size: 11289870, updated_at: '2026-10-09T12:01:00Z', browser_download_url: 'https://example.test/awb-android.apk' },
  ],
};

test('고정 링크는 latest/download/에셋명이다', () => {
  assert.equal(
    GITHUB_ANDROID_APK_URL,
    `https://github.com/parnmanas/ai-workflow-board/releases/latest/download/${GITHUB_ANDROID_ASSET_NAME}`,
  );
});

test('릴리즈 JSON에서 APK 에셋만 고른다', () => {
  const hit = pickApkAsset(releaseJson);
  assert.deepEqual(hit, {
    tag: 'android-v1.0',
    name: 'awb-android.apk',
    size: 11289870,
    publishedAt: '2026-10-09T12:01:00Z',
    downloadUrl: 'https://example.test/awb-android.apk',
  });
});

test('에셋이 없으면 null이다', () => {
  assert.equal(pickApkAsset({ tag_name: 'x', assets: [] }), null);
  assert.equal(pickApkAsset(null), null);
  assert.equal(pickApkAsset({ tag_name: 'x', assets: [{ name: 'other.apk' }] }), null);
});

test('용량 표기', () => {
  assert.equal(formatApkSize(0), '');
  assert.equal(formatApkSize(512), '1 KB');
  assert.equal(formatApkSize(11289870), '10.8 MB');
});

test('자료실 최상단에 APK 카드가 있다', () => {
  assert.match(read('src/components/LibraryPage.tsx'), /<GithubApkCard \/>/);
});
