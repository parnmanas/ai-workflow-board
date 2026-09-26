// test/sort-suites.mjs 고정. 티켓 ded30c43.
//
// 이 스크립트가 존재하는 이유는 정렬 가드가 **main 에 랜딩한 뒤에야** 돌기
// 때문이다(이 저장소는 PR 없이 ticket 브랜치를 직접 병합한다). 그래서 여기서
// 보는 것은 "정렬이 되는가" 만이 아니라, 손으로 고치다 반복해서 틀린 바로 그
// 자리들이다:
//   - 9afe89f5 가 되돌린 credentials-scope-switch / credentials-scope 쌍.
//     셸 `sort` 는 로케일에 따라 구두점을 무시해 이 둘의 앞뒤를 뒤집는다.
//   - 헤더·끝 개행 같은 "정렬과 무관한 diff" 가 섞이지 않는가.
//   - 순서 외의 것(중복, 첫 step 뒤 주석)을 스크립트가 조용히 바꾸지 않는가 —
//     조용히 고치면 무엇이 도는지, 주석이 무엇을 가리키는지가 바뀐다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main, splitManifest } from './sort-suites.mjs';
import { SUITES_DIR } from './helpers/suite-manifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, 'sort-suites.mjs');

const HEADER = '# 머리말 한 줄.\n# 두 번째 줄.\n';

function makeSuitesDir(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-ded30c43-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, `${name}.txt`), text);
  }
  return dir;
}

// 출력을 삼키되 메시지 검증에 쓸 수 있게 모아 둔다.
function run(argv, dir) {
  const out = [];
  const errs = [];
  const code = main(argv, { dir, log: (m) => out.push(m), err: (m) => errs.push(m) });
  return { code, out: out.join('\n'), err: errs.join('\n') };
}

const read = (dir, name) => fs.readFileSync(path.join(dir, `${name}.txt`), 'utf8');

test('어긋난 매니페스트를 정규 순서로 제자리에 쓴다 — 헤더와 끝 개행은 건드리지 않는다', (t) => {
  const dir = makeSuitesDir(t, {
    test: `${HEADER}test/zebra.test.mjs\nnpm run test:qa\ntest/alpha.test.mjs\n`,
  });

  const { code } = run([], dir);

  assert.equal(code, 0);
  assert.equal(
    read(dir, 'test'),
    `${HEADER}test/alpha.test.mjs\ntest/zebra.test.mjs\nnpm run test:qa\n`,
    '경로가 사전순으로 오고 npm run 위임이 맨 뒤여야 한다',
  );
});

test('헤더 블록은 바이트 그대로 남는다 — 빈 줄과 들여쓴 주석까지', (t) => {
  const header = '# 첫 줄\n\n#   들여쓴 주석\n\n';
  const dir = makeSuitesDir(t, { test: `${header}test/b.test.mjs\ntest/a.test.mjs\n` });

  run([], dir);

  assert.equal(read(dir, 'test'), `${header}test/a.test.mjs\ntest/b.test.mjs\n`);
});

test('끝 개행은 하나로 정규화된다 — 없어도, 여러 개여도', (t) => {
  const dir = makeSuitesDir(t, {
    'no-eol': `${HEADER}test/b.test.mjs\ntest/a.test.mjs`,
    'many-eol': `${HEADER}test/b.test.mjs\ntest/a.test.mjs\n\n\n`,
  });

  run([], dir);

  const expected = `${HEADER}test/a.test.mjs\ntest/b.test.mjs\n`;
  assert.equal(read(dir, 'no-eol'), expected);
  assert.equal(read(dir, 'many-eol'), expected);
});

test('credentials-scope-switch 가 credentials-scope 보다 앞이다 — 9afe89f5 가 되돌린 그 회귀', (t) => {
  // `-`(0x2D) < `.`(0x2E) 라 JS `.sort()` 는 -switch 를 앞에 둔다. 셸 `sort` 는
  // 로케일에 따라 구두점을 무시해 반대로 답하고, 눈으로도 틀리기 쉽다.
  const dir = makeSuitesDir(t, {
    test: `${HEADER}test/credentials-scope.test.mjs\ntest/credentials-scope-switch.test.mjs\n`,
  });

  run([], dir);

  assert.equal(
    read(dir, 'test'),
    `${HEADER}test/credentials-scope-switch.test.mjs\ntest/credentials-scope.test.mjs\n`,
  );
});

test('두 번 돌려도 바이트가 같다', (t) => {
  const dir = makeSuitesDir(t, {
    test: `${HEADER}test/zebra.test.mjs\nnpm run test:qa\ntest/alpha.test.mjs`,
  });

  run([], dir);
  const once = read(dir, 'test');
  const second = run([], dir);

  assert.equal(read(dir, 'test'), once);
  assert.equal(second.code, 0);
  assert.match(second.out, /바꿀 것 없음/, '두 번째에는 바꿀 것이 없다고 말해야 한다');
});

test('첫 step 뒤의 주석은 옮기지 않고 거부한다 — 파일은 한 바이트도 안 바뀐다', (t) => {
  const before = `${HEADER}test/b.test.mjs\n# 이 주석은 아래 줄을 가리킨다\ntest/a.test.mjs\n`;
  const dir = makeSuitesDir(t, { test: before });

  const { code, err } = run([], dir);

  assert.equal(code, 1);
  assert.equal(read(dir, 'test'), before, '거부했으면 원본 그대로여야 한다');
  assert.match(err, /4번째 줄/, '몇 번째 줄인지 찍어야 사람이 찾아간다');
});

test('중복 step 은 합치지 않고 거부한다 — 합치면 도는 횟수가 바뀐다', (t) => {
  const before = `${HEADER}test/b.test.mjs\ntest/a.test.mjs\ntest/b.test.mjs\n`;
  const dir = makeSuitesDir(t, { test: before });

  const { code, err } = run([], dir);

  assert.equal(code, 1);
  assert.equal(read(dir, 'test'), before);
  assert.match(err, /5번째 줄/);
  assert.match(err, /중복 step/);
});

test('--check 는 어긋나면 exit 1 이고 쓰지 않는다', (t) => {
  const before = `${HEADER}test/b.test.mjs\ntest/a.test.mjs\n`;
  const dir = makeSuitesDir(t, { test: before });

  const { code, err } = run(['--check'], dir);

  assert.equal(code, 1);
  assert.equal(read(dir, 'test'), before, '--check 는 진단만 한다');
  assert.match(err, /npm run test:suites:sort/, '조치 명령을 가리켜야 한다');
});

test('--check 는 이미 정규 순서면 exit 0', (t) => {
  const dir = makeSuitesDir(t, { test: `${HEADER}test/a.test.mjs\ntest/b.test.mjs\n` });

  const { code } = run(['--check'], dir);

  assert.equal(code, 0);
});

test('위치 인자로 준 매니페스트만 건드린다', (t) => {
  const other = `${HEADER}test/z.test.mjs\ntest/y.test.mjs\n`;
  const dir = makeSuitesDir(t, { test: `${HEADER}test/b.test.mjs\ntest/a.test.mjs\n`, posttest: other });

  const { code } = run(['test'], dir);

  assert.equal(code, 0);
  assert.equal(read(dir, 'test'), `${HEADER}test/a.test.mjs\ntest/b.test.mjs\n`);
  assert.equal(read(dir, 'posttest'), other, '지정하지 않은 매니페스트는 그대로다');
});

test('없는 매니페스트 이름은 조용히 넘어가지 않는다', (t) => {
  const dir = makeSuitesDir(t, { test: `${HEADER}test/a.test.mjs\n` });

  const { code, err } = run(['tset'], dir);

  assert.equal(code, 1);
  assert.match(err, /tset/);
  assert.match(err, /test/, '있는 것이 무엇인지 알려줘야 오타를 고칠 수 있다');
});

test('step 이 없는 파일은 손대지 않는다 — 빈 매니페스트 판정은 가드의 몫이다', (t) => {
  const before = '# 주석뿐\n\n';
  const dir = makeSuitesDir(t, { test: before });

  const { code } = run([], dir);

  assert.equal(code, 0);
  assert.equal(read(dir, 'test'), before);
});

test('splitManifest 는 첫 step 뒤의 빈 줄을 버리고 헤더의 빈 줄은 남긴다', () => {
  const { header, steps, problems } = splitManifest('# 머리말\n\ntest/a.test.mjs\n\ntest/b.test.mjs\n');
  assert.equal(header, '# 머리말\n\n');
  assert.deepEqual(steps, ['test/a.test.mjs', 'test/b.test.mjs']);
  assert.deepEqual(problems, []);
});

// ── 실제 저장소 ───────────────────────────────────────────────────────────
// 위 fixture 들은 임시 디렉터리를 보므로, CLI 배선(shebang·인자 전달·exit code)과
// 저장소의 현재 상태는 따로 고정한다. 이 테스트가 빨간 상태로 랜딩하는 것이
// 정확히 이 티켓이 없애려는 상황이다.

test('저장소의 매니페스트는 지금 정규 순서다 — CLI 를 실제로 돌려서 본다', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--check'], { encoding: 'utf8' });
  assert.equal(
    r.status,
    0,
    `${SUITES_DIR} 가 정규 순서가 아니다 — apps/server 에서 npm run test:suites:sort 를 `
      + `돌려라.\n${r.stdout}${r.stderr}`,
  );
});
