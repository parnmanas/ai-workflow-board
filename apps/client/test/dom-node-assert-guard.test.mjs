// jsdom 노드를 node:assert 비교 인자로 넘기는 것을 막는 정적 가드 (티켓 b207d941).
//
// 판정 로직과 그 근거는 `helpers/dom-node-assert-scan.mjs` 상단 주석에 있다. 요약하면:
// 실패한 순간 node:assert 가 `depth: 1000` + `getters: true` 로 util.inspect 를 돌리는데
// jsdom element 는 순환 그래프라 인스펙션이 폭주해, 읽을 수 있는 한 줄 실패 대신
// 러너가 통째로 SIGKILL 된다. 통과할 때는 멀쩡하므로 CI 는 초록이고, 그 화면이
// **회귀하는 날에만** 드러난다 — 즉 회귀 안전망이 가장 필요한 순간에 무력해진다.
//
// 이 가드는 `test-registration-guard.test.mjs` 와 같은 방식(소스 스캔)으로 재발을 막는다.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanSource, isNodeValued, collectNodeNames, maskLiterals } from './helpers/dom-node-assert-scan.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = path.resolve(__dirname, '..');
const TEST_DIR = __dirname;

// 의도적으로 허용하는 지점. 항목을 추가할 땐 반드시 사유를 남길 것 —
// 사유 없는 예외는 이 가드가 막으려는 바로 그 "조용한 잠복"을 다시 만든다.
// 키는 `test/파일경로:줄번호` 가 아니라 `test/파일경로` 다(줄번호는 편집마다 어긋난다).
const ALLOWLIST = {
  // 'test/example.test.mjs': '사유...',
};

function listSourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.isFile() && full.endsWith('.mjs')) out.push(full);
  }
  return out;
}

const relative = (full) => path.relative(CLIENT_ROOT, full).split(path.sep).join('/');

test('apps/client/test/ 어디에도 jsdom 노드를 assert 비교 인자로 넘기는 곳이 없다', () => {
  const offenders = [];
  for (const file of listSourceFiles(TEST_DIR)) {
    const rel = relative(file);
    if (rel in ALLOWLIST) continue;
    for (const v of scanSource(fs.readFileSync(file, 'utf8'))) {
      offenders.push(`${rel}:${v.line}  assert.${v.fn} 의 ${v.argIndex + 1}번째 인자 — ${v.snippet}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'jsdom 노드가 node:assert 의 비교 인자로 넘어갑니다. 실패하는 순간 util.inspect 가 ' +
      'element → document → window 순환 그래프를 펼쳐 러너가 SIGKILL 로 죽고, 어느 단언이 왜 ' +
      '틀렸는지 전혀 남지 않습니다.\n' +
      '고치는 법: 부재는 `assert.equal(Boolean(root.querySelector(…)), false, "메시지")`, ' +
      '존재는 `assert.ok(node, "메시지")`, 포커스는 `assertFocused(node, "메시지")`' +
      '(helpers/jsdom.mjs), 그 밖엔 개수(`.length`)·라벨(`.textContent`)처럼 스칼라로 좁히세요.\n' +
      `위반 지점:\n${offenders.join('\n')}`,
  );
});

test('ALLOWLIST 항목이 전부 실재하는 파일을 가리킨다 (stale 항목 없음)', () => {
  const onDisk = new Set(listSourceFiles(TEST_DIR).map(relative));
  const stale = Object.keys(ALLOWLIST).filter((f) => !onDisk.has(f));

  assert.deepEqual(stale, [], `ALLOWLIST 에 더 이상 존재하지 않는 파일 항목이 있습니다 — 정리하세요:\n${stale.join('\n')}`);
});

test('ALLOWLIST 값은 모두 공백이 아닌 사유 문자열이다 (무사유 예외 방지)', () => {
  const unreasoned = Object.entries(ALLOWLIST)
    .filter(([, reason]) => typeof reason !== 'string' || reason.trim() === '')
    .map(([file]) => file);

  assert.deepEqual(unreasoned, [], `ALLOWLIST 항목에는 사유 문자열이 필요합니다:\n${unreasoned.join('\n')}`);
});

// ── 스캐너 자기검증 ───────────────────────────────────────────────────────────
// 위 전수 검사는 위반이 0건이면 통과한다. 그래서 스캐너가 어떤 이유로든 아무것도
// 못 잡는 no-op 으로 썩어도 똑같이 초록이 된다. 아래 픽스처가 그 경우를 막는다 —
// 잡아야 할 것을 실제로 잡는지, 잡으면 안 되는 것을 안 잡는지 양쪽 다 고정한다.

const MUST_FLAG = [
  ['부재 단언에 노드를 그대로', `assert.equal(container.querySelector('.x'), null, '없어야 한다');`],
  ['여러 줄로 쪼갠 호출', `assert.equal(\n  view.container.querySelector('textarea'),\n  null,\n  '없어야 한다',\n);`],
  ['expected 자리에 노드', `assert.equal(null, container.querySelector('.x'), '없어야 한다');`],
  ['포커스 비교(양쪽 다 노드)', `assert.equal(document.activeElement, button, '포커스');`],
  ['strictEqual 도 같은 함정', `assert.strictEqual(document.getElementById('a'), null);`],
  ['deepEqual 도 같은 함정', `assert.deepEqual(el.closest('form'), null);`],
  [
    '노드를 돌려주는 헬퍼를 거친 경우',
    `function subList(view, label) {\n  const list = view.container.querySelector('div');\n  return list;\n}\nassert.equal(subList(view, 'Teams'), null, '접혀야 한다');`,
  ],
];

const MUST_NOT_FLAG = [
  ['Boolean 으로 좁힘', `assert.equal(Boolean(container.querySelector('.x')), false, '없어야 한다');`],
  ['개수로 좁힘', `assert.equal(container.querySelectorAll('img').length, 0);`],
  ['속성 값으로 좁힘', `assert.equal(container.querySelector('input').value, '');`],
  ['getAttribute 로 좁힘', `assert.equal(groupRow(view, 'Boards').getAttribute('aria-current'), null);`],
  ['비교 연산자로 boolean 화', `assert.equal(buildBadge.querySelector('.x') != null, true, '배지');`],
  ['assert.ok 는 실패해도 falsy 만 인스펙션', `assert.ok(container.querySelector('.x'), '있어야 한다');`],
  ['음성 비교는 실패 시 actual 이 null', `assert.notEqual(container.querySelector('.x'), null);`],
  [
    '바깥 호출이 스칼라로 좁히는 경우',
    `function repoSelect(c) {\n  const el = c.querySelector('select');\n  return el;\n}\nfunction optionLabels(select) {\n  return [...select.options].map((o) => o.textContent);\n}\nassert.deepEqual(optionLabels(repoSelect(container)), ['a']);`,
  ],
  ['문자열 안의 코드 모양은 코드가 아니다', `assert.equal(msg, "assert.equal(container.querySelector('x'), null)");`],
];

test('스캐너가 잡아야 할 형태를 실제로 잡는다 (가드가 no-op 으로 썩지 않음)', () => {
  const missed = MUST_FLAG.filter(([, code]) => scanSource(code).length === 0).map(([label]) => label);
  assert.deepEqual(missed, [], `스캐너가 놓친 위반 형태:\n${missed.join('\n')}`);
});

test('스캐너가 안전한 형태를 오탐하지 않는다', () => {
  const falsePositives = MUST_NOT_FLAG.filter(([, code]) => scanSource(code).length > 0).map(([label]) => label);
  assert.deepEqual(falsePositives, [], `스캐너가 안전한 코드를 위반으로 오탐했습니다:\n${falsePositives.join('\n')}`);
});

test('maskLiterals 는 문자열 내용만 지우고 오프셋·줄바꿈을 보존한다', () => {
  const src = `const a = 'he\\'llo';\n// assert.equal(x, null)\nconst b = \`multi\nline\`;`;
  const masked = maskLiterals(src);
  assert.equal(masked.length, src.length, '마스킹이 오프셋을 바꾸면 줄번호 보고가 어긋난다');
  assert.equal(masked.split('\n').length, src.split('\n').length, '줄 수가 보존되어야 한다');
  assert.equal(masked.includes('assert.equal'), false, '주석 안의 코드 모양은 지워져야 한다');
  assert.equal(masked.includes('const a ='), true, '코드 자체는 남아야 한다');
});

test('collectNodeNames 는 노드 헬퍼만 모으고 스칼라 헬퍼는 제외한다', () => {
  const src = `
function repoSelect(c) {
  const el = c.querySelector('select');
  return el;
}
function optionLabels(select) {
  return [...select.options].map((o) => o.textContent);
}
`;
  const names = collectNodeNames(maskLiterals(src));
  assert.equal(names.has('repoSelect'), true, '노드를 돌려주는 헬퍼는 모아야 한다');
  assert.equal(names.has('optionLabels'), false, '스칼라 배열을 돌려주는 헬퍼는 모으면 안 된다');
  assert.equal(isNodeValued('optionLabels(repoSelect(c))', names), false, '바깥 호출이 스칼라면 안전하다');
  assert.equal(isNodeValued('repoSelect(c)', names), true, '노드 헬퍼의 바깥 호출은 노드다');
});
