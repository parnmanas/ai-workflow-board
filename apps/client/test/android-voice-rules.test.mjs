// Android 앱의 상시 음성(apps/android/.../voice/VoiceRules.java)은 웹 음성 규칙의 네이티브 사본이다.
// 원본은 apps/client/src/voice/wake.logic.ts 다. 한쪽만 바꾸면 화면과 앱이 다르게 굴어 — 예를 들어
// 깨어난 뒤 첫 요청의 안내 한 줄이 달라 operator 가 [[sleep]] 규칙을 모르게 된다 — 이 테스트가 막는다.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WAKE_PROMPT_NOTE, SLEEP_MARKER, WAKE_IDLE_SLEEP_MS } from '../src/voice/wake.logic.ts';
import { NOTIFICATION_FOLLOW_UP_MS } from '../src/voice/wakeState.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const java = fs.readFileSync(path.join(ROOT, 'apps/android/app/src/main/java/com/parnmanas/awb/voice/VoiceRules.java'), 'utf8');
const ts = fs.readFileSync(path.join(ROOT, 'apps/client/src/voice/wake.logic.ts'), 'utf8');

function javaString(name) {
  const m = java.match(new RegExp(`${name}\\s*=\\s*([\\s\\S]*?);`));
  assert.ok(m, `${name} not found`);
  // "a" + SLEEP_MARKER + "b" 꼴만 쓴다.
  return m[1].split('+').map((part) => {
    const p = part.trim();
    if (p === 'SLEEP_MARKER') return SLEEP_MARKER;
    return JSON.parse(p);
  }).join('');
}

test('깨어난 뒤 첫 요청의 안내 한 줄과 잠들기 표시가 같다', () => {
  assert.equal(javaString('SLEEP_MARKER'), SLEEP_MARKER);
  assert.equal(javaString('WAKE_PROMPT_NOTE'), WAKE_PROMPT_NOTE);
});

test('군소리 목록과 "보고해" 판정이 같다', () => {
  const tsFillers = ts.match(/const FILLERS = new Set\(\[([^\]]*)\]\)/)[1];
  const javaFillers = java.match(/FILLERS = new HashSet<>\(Arrays\.asList\(([^)]*)\)\)/)[1];
  const list = (src) => [...src.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]).sort();
  assert.deepEqual(list(javaFillers), list(tsFillers));

  const tsReport = ts.match(/return \/(\^\(보고해[^/]*)\/i\.test/)[1];
  const javaReport = java.match(/REPORT_REQUEST_RE = Pattern\.compile\(\s*"([^"]*)"/)[1].replace(/\\\\/g, '\\');
  assert.equal(javaReport, tsReport);
});

test('잠들기 · 이어 듣기 시간이 같다', () => {
  assert.equal(Number(java.match(/WAKE_IDLE_SLEEP_MS = ([\d_]+);/)[1].replace(/_/g, '')), WAKE_IDLE_SLEEP_MS);
  assert.equal(Number(java.match(/NOTIFICATION_FOLLOW_UP_MS = ([\d_]+);/)[1].replace(/_/g, '')), NOTIFICATION_FOLLOW_UP_MS);
});
