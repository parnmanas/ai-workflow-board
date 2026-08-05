// 테스트 등록 누락 가드 (source: 티켓 2db21f87, 이 티켓 81b428e0).
//
// apps/client/package.json 의 `pretest`/`test` 스크립트는 실행할 테스트 파일을
// 명시적으로 나열한다. apps/client/test/ 에 새 *.test.mjs 파일을 추가하고 이
// 목록에 등록하는 걸 잊으면 `npm test`/CI 어느 쪽도 에러 없이 그 파일을 그냥
// 건너뛴다 — 서로 다른 작업에서 최소 5개 회귀 테스트가 이런 식으로 실행 대상에서
// 누락된 적이 있다. 이 가드는 디스크에 있는 모든 *.test.mjs 파일(이 파일 자신
// 포함)이 pretest+test 스크립트 어딘가에 등록되어 있는지 대조한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = path.resolve(__dirname, '..');
const TEST_DIR = __dirname;

// 의도적으로 npm test 대상에서 제외하는 파일. 항목을 추가할 땐 반드시 사유를 남길 것 —
// 사유 없는 제외는 이 가드가 막으려는 바로 그 "조용한 누락"을 다시 만든다.
const ALLOWLIST = {
  // 'test/example.test.mjs': '사유...',
};

function listTestFilesRecursive(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTestFilesRecursive(full));
    } else if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
      out.push(path.relative(CLIENT_ROOT, full).split(path.sep).join('/'));
    }
  }
  return out;
}

function registeredTestFiles() {
  const pkg = JSON.parse(fs.readFileSync(path.join(CLIENT_ROOT, 'package.json'), 'utf8'));
  const combined = [pkg.scripts?.pretest, pkg.scripts?.test].filter(Boolean).join(' ');
  const matches = combined.match(/test\/[\w./-]+\.test\.mjs/g) || [];
  return new Set(matches);
}

test('apps/client/test/ 의 모든 *.test.mjs 파일이 package.json pretest/test 스크립트에 등록되어 있다', () => {
  const onDisk = listTestFilesRecursive(TEST_DIR);
  const registered = registeredTestFiles();

  const missing = onDisk.filter((f) => !registered.has(f) && !(f in ALLOWLIST));

  assert.deepEqual(
    missing,
    [],
    `다음 테스트 파일이 apps/client/package.json 의 pretest/test 스크립트에 등록되어 있지 않습니다. ` +
      `등록하거나, 의도적 제외라면 이 파일의 ALLOWLIST 에 사유와 함께 추가하세요:\n${missing.join('\n')}`,
  );
});

test('ALLOWLIST 항목이 전부 실재하는 파일을 가리킨다 (stale 항목 없음)', () => {
  const onDisk = new Set(listTestFilesRecursive(TEST_DIR));
  const stale = Object.keys(ALLOWLIST).filter((f) => !onDisk.has(f));

  assert.deepEqual(
    stale,
    [],
    `ALLOWLIST 에 더 이상 존재하지 않는 파일 항목이 있습니다 — 정리하세요:\n${stale.join('\n')}`,
  );
});

test('ALLOWLIST 값은 모두 공백이 아닌 사유 문자열이다 (무사유 제외 방지)', () => {
  const unreasoned = Object.entries(ALLOWLIST)
    .filter(([, reason]) => typeof reason !== 'string' || reason.trim() === '')
    .map(([file]) => file);

  assert.deepEqual(
    unreasoned,
    [],
    `ALLOWLIST 항목은 공백이 아닌 사유 문자열이 필요합니다(빈 문자열/문자열이 아닌 값은 무사유 제외로 간주) — 사유가 없는 항목:\n${unreasoned.join('\n')}`,
  );
});
