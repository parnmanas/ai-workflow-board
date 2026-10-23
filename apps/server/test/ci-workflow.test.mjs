// ci.yml 읽기 — 티켓 6ad5989a.
//
// 등록 가드(test-registration-completeness)는 CI 진입점 목록을 ci.yml 과 대조한다. 그
// 대조가 믿을 만하려면 두 가지가 맞아야 한다.
//   - ci.yml 을 YAML 이 읽는 대로 읽는다. 아래 YAML fixture 의 기대값은 js-yaml 과 같다 —
//     이 파서가 일부러 원문으로 두는 모양(맵 · 중첩 흐름 컬렉션, 주석이 낀 여러 줄 흐름
//     시퀀스, 흐름 시퀀스 안의 별칭)과 펼치지 않는 병합 키(<<)만 빼고. 그런 모양이 게이트
//     필드(if · needs · env …)에 오면 CI 읽기가 "못 읽음" 으로 다뤄 세지 않는다.
//   - 셀 수 없는 호출을 세지 않는다. 독립 리뷰 두 번이 셸을 흉내 내는 규칙마다 구멍을
//     찾았다 — pipefail 없는 기본 셸(bash -e)의 파이프, 끝이 아닌 &&, || 가 덮는 범위,
//     here-doc, 서브셸. 그래서 명령 하나뿐인 step 만 센다. 아래 CI fixture 는 그 규칙과,
//     그것이 막는 모양들을 고정한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shellCommands } from './helpers/shell-commands.mjs';
import {
  ALWAYS_RUN_CONDITIONS,
  UNREADABLE_KEY,
  ciServerNpmInvocations,
  npmrcProblems,
  parseWorkflowYaml,
} from './helpers/ci-workflow.mjs';

const invokedIn = (yaml) => [...ciServerNpmInvocations(yaml).invoked].sort();
const uncountedIn = (yaml) => ciServerNpmInvocations(yaml).uncounted.map(({ job, script }) => `${job} ${script}`).sort();
// main push 에 걸린 워크플로 — 트리거를 보지 않는 fixture 는 이것으로 감싼다.
const onMainPush = (body) => `on:\n  push:\n    branches: [main]\n${body}`;

// ── YAML 부분집합 ──────────────────────────────────────────────────────────

test('YAML: step 의 키 사이 주석 · 중첩 맵 · 그 안의 시퀀스를 건너 같은 step 의 키를 읽는다', () => {
  const doc = parseWorkflowYaml(`
jobs:
  a:
    steps:
      - name: x
        with:
          paths:
            - a
            - b
          run: not-a-step-key
  # 더 얕은 주석도 step 을 끝내지 않는다
        working-directory: apps/server
        run: npm test
`);
  assert.deepEqual(doc.jobs.a.steps, [
    { name: 'x', with: { paths: ['a', 'b'], run: 'not-a-step-key' }, 'working-directory': 'apps/server', run: 'npm test' },
  ]);
});

test('YAML: 블록 | 는 줄을 그대로, > 는 이어진 보통 줄을 공백으로 접는다', () => {
  const doc = parseWorkflowYaml(`
literal: |
  one
  two

  three
folded: >
  echo "pg matrix temporarily disabled"
  npm run test:qa:pg

  next paragraph
    more indented
  last
after: 1
`);
  assert.equal(doc.literal, 'one\ntwo\n\nthree');
  assert.equal(doc.folded, 'echo "pg matrix temporarily disabled" npm run test:qa:pg\nnext paragraph\n  more indented\nlast');
  assert.equal(doc.after, '1', '블록 뒤의 형제 키를 삼키지 않는다');
});

test('YAML: 블록 run 뒤에 오는 형제 키도 그 step 의 키다', () => {
  const doc = parseWorkflowYaml(`
steps:
  - run: |
      npm run a

      npm run b
    working-directory: apps/server
`);
  assert.deepEqual(doc.steps, [{ run: 'npm run a\n\nnpm run b', 'working-directory': 'apps/server' }]);
});

test('YAML: 평문은 여러 줄로 이어지고, 꼬리 주석에서 끝난다', () => {
  const doc = parseWorkflowYaml(`
run: echo pg matrix disabled
  for now # && npm run test:qa:pg
next: npm run build
  && npm run test:x
`);
  assert.equal(doc.run, 'echo pg matrix disabled for now', '주석 뒤는 값이 아니다');
  assert.equal(doc.next, 'npm run build && npm run test:x');
});

test('YAML: 따옴표 스칼라의 이스케이프와 키', () => {
  const doc = parseWorkflowYaml(`
double: "echo \\"go\\" && npm run test:qa:pg"
single: 'it''s # not a comment'
"on": push
multi: "npm run build
  && npm run test:multi"
after: 1
`);
  assert.equal(doc.double, 'echo "go" && npm run test:qa:pg');
  assert.equal(doc.single, "it's # not a comment");
  assert.equal(doc.on, 'push');
  assert.equal(doc.multi, 'npm run build && npm run test:multi', '여러 줄 따옴표는 줄바꿈을 공백으로 접는다');
  assert.equal(doc.after, '1');
});

test('YAML: 키와 같은 열에서 시작하는 시퀀스, -   키 꼴, 빈 - 항목', () => {
  const doc = parseWorkflowYaml(`
steps:
- uses: x
-   name: wide
    run: npm test
-
  run: npm run nested
after: 1
`);
  assert.deepEqual(doc.steps, [{ uses: 'x' }, { name: 'wide', run: 'npm test' }, { run: 'npm run nested' }]);
  assert.equal(doc.after, '1');
});

test('YAML: 단순한 흐름 시퀀스는 배열로, 그 밖의 흐름 컬렉션은 원문으로 읽는다', () => {
  const doc = parseWorkflowYaml(`
needs: [build, 'test', "lint",]
none: []
os: [ubuntu-latest,
     windows-latest]
map: {a: 1}
nested: [[a], b]
`);
  assert.deepEqual(doc.needs, ['build', 'test', 'lint']);
  assert.deepEqual(doc.none, []);
  assert.deepEqual(doc.os, ['ubuntu-latest', 'windows-latest']);
  assert.equal(doc.map, '{a: 1}');
  assert.equal(doc.nested, '[[a], b]');
});

test('YAML: 파일 맨 앞의 BOM 은 내용이 아니다', () => {
  assert.deepEqual(parseWorkflowYaml('\uFEFFon: push\njobs: {}\n'), { on: 'push', jobs: '{}' });
});

test('YAML: __proto__ 키는 프로토타입을 바꾸지 않는다', () => {
  const doc = parseWorkflowYaml('__proto__:\n  polluted: yes\nok: 1\n');
  assert.equal(Object.getPrototypeOf(doc), Object.prototype);
  assert.deepEqual(Object.keys(doc), ['__proto__', 'ok'], '자기 키로 남는다');
  assert.equal(doc.polluted, undefined);
});


test('YAML: 앵커와 별칭 — 스칼라 · 맵 · 시퀀스 · 시퀀스 항목, 앵커가 키 앞에 붙은 항목', () => {
  const doc = parseWorkflowYaml(`
a: &heavy github.ref != 'x' && y
b: *heavy # 꼬리 주석
x:
  env: &hardened
    npm_config_ignore_scripts: "true"
y:
  env: *hardened
deps: &deps [build, gated]
needs: *deps
steps:
  - &checkout
    uses: actions/checkout@x
  - *checkout
  - &named name: n
    run: r
unknown: *nope
`);
  assert.equal(doc.b, "github.ref != 'x' && y");
  assert.deepEqual(doc.y.env, { npm_config_ignore_scripts: 'true' });
  assert.deepEqual(doc.needs, ['build', 'gated']);
  assert.deepEqual(doc.steps, [{ uses: 'actions/checkout@x' }, { uses: 'actions/checkout@x' }, { name: 'n', run: 'r' }]);
  assert.equal(doc.unknown, '*nope', '모르는 별칭은 원문으로 남는다');
});

test('YAML: 키로 읽지 못한 줄은 버리지 않고 표시를 남긴다', () => {
  const doc = parseWorkflowYaml('a: 1\n&x b: 2\nc: 3\n');
  assert.equal(doc.a, '1');
  assert.equal(doc.c, '3');
  assert.equal(doc[UNREADABLE_KEY], true, '그 줄이 게이트 키였을 수 있다 — 읽는 쪽이 이 맵을 못 읽은 것으로 다룬다');
  assert.equal(Object.hasOwn(parseWorkflowYaml('a: 1\n'), UNREADABLE_KEY), false);
});

test('YAML: 병합 키(<<)는 펼치지 않고 보통 키로 둔다', () => {
  const doc = parseWorkflowYaml(`
base: &base
  if: false
job:
  <<: *base
  steps: []
`);
  assert.deepEqual(doc.job, { '<<': { if: 'false' }, steps: [] });
});

test('YAML: 문서 표시 · 들여쓰기 지시자 · 큰따옴표 이스케이프 · 항목 · 값 뒤의 주석 · 단어 안의 #', () => {
  const doc = parseWorkflowYaml(`---
indented: |2
    two extra
  base
tabbed: "a\\tb"
'it''s': quoted key
items:
  - # 주석 뒤에 맵이 온다
    a: 1
nested: # 주석 뒤에 맵이 온다
  b: 2
hash: b#c
trailing: |
  only

plainBlank: one
  two

  three
`);
  assert.equal(doc.indented, '  two extra\nbase');
  assert.equal(doc.tabbed, 'a\tb');
  assert.equal(doc["it's"], 'quoted key');
  assert.deepEqual(doc.items, [{ a: '1' }]);
  assert.deepEqual(doc.nested, { b: '2' });
  assert.equal(doc.hash, 'b#c');
  assert.equal(doc.trailing, 'only');
  assert.equal(doc.plainBlank, 'one two\nthree');
});
// ── 셸 분해 ────────────────────────────────────────────────────────────────

test('셸: 따옴표 안의 구분자 · 주석은 그대로 낱말이다', () => {
  assert.deepEqual(shellCommands('echo "skipping; npm run x" && echo \'a # b\''), [
    { words: ['echo', 'skipping; npm run x'], next: '&&' },
    { words: ['echo', 'a # b'], next: null },
  ]);
});

test('셸: 단어를 여는 # 부터 줄 끝까지는 주석이다', () => {
  assert.deepEqual(shellCommands('echo off\n# npm run build && npm run test:qa:pg\nnpm test # 꼬리\nurl=a#b'), [
    { words: ['echo', 'off'], next: '\n' },
    { words: ['npm', 'test'], next: '\n' },
    { words: ['url=a#b'], next: null },
  ]);
});

test('셸: 구분자와 다음 명령 — || · & · | · ; , 그리고 리다이렉션의 & 는 구분자가 아니다', () => {
  assert.deepEqual(
    shellCommands('a || b; c | d & e 2>&1 &>/dev/null').map(({ words, next }) => [words.join(' '), next]),
    [['a', '||'], ['b', ';'], ['c', '|'], ['d', '&'], ['e 2>&1 &>/dev/null', null]],
  );
});

test('셸: 따옴표 밖의 \\ 와 큰따옴표 안의 \\" 는 다음 글자를 그대로 둔다', () => {
  assert.deepEqual(shellCommands('echo a\\;b "c \\" ; d" && npm test'), [
    { words: ['echo', 'a;b', 'c " ; d'], next: '&&' },
    { words: ['npm', 'test'], next: null },
  ]);
});

test('셸: 줄 끝 \\ 는 다음 줄과 잇는다', () => {
  assert.deepEqual(shellCommands('npm --prefix apps/server \\\n  run test:x'), [
    { words: ['npm', '--prefix', 'apps/server', 'run', 'test:x'], next: null },
  ]);
});


test('셸: 탭 · CR 은 공백이고, 작은따옴표 안의 \\ 와 <& 는 그대로 둔다', () => {
  assert.deepEqual(shellCommands("npm\ttest\r\necho 'a\\b' <&3"), [
    { words: ['npm', 'test'], next: '\n' },
    { words: ['echo', 'a\\b', '<&3'], next: null },
  ]);
});

// ── CI 호출 ────────────────────────────────────────────────────────────────

// 실제 ci.yml 의 모양을 줄여 옮겼다: push 트리거, 무거운 잡의 if: 조건, step 키 사이의
// 주석과 env 맵, 루트에서 부르는 `-w server`, 다른 workspace, npm 이 아닌 직접 실행,
// 명령이 둘인 smoke step.
const FIXTURE_WORKFLOW = `
name: CI
on:
  pull_request:
  push:
    branches:
      - main
      - production.private
jobs:
  server-tests:
    if: github.ref != 'refs/heads/production.private' && github.event_name != 'schedule'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@abc # v4
      - name: Install dependencies
        run: npm ci
      - name: Run apps/server full test suite (build + top-level)
        working-directory: apps/server
        # 주석이 키 사이에 있다
        env:
          SQLJS_TURN_STACKS: '1'
        run: npm test
  pg:
    if: \${{ github.ref != 'refs/heads/production.private'   && github.event_name != 'schedule' }}
    runs-on: ubuntu-latest
    env:
      DB_TYPE: postgres
    steps:
      - name: Build server
        run: npm run build -w server
      - name: Run on Postgres
        working-directory: ./apps/server/ # 꼬리 주석은 디렉터리가 아니다
        run: npm run test:qa:pg
  other:
    runs-on: ubuntu-latest
    steps:
      - name: Client
        run: npm run test:e2e -w client
      - name: Manager
        working-directory: apps/agent-manager
        run: npm run test:manager
      - name: Direct guard
        working-directory: apps/server
        run: node --test --test-force-exit test/chat-room-join-cast-guard.test.mjs
      - name: Smoke
        run: npm run build -w server && npm run test:e2e:ontology -w client
`;

test('CI 호출: apps/server 의 npm 스크립트를 명령 하나뿐인 step 으로 부르는 것만 센다', () => {
  const { invoked, uncounted } = ciServerNpmInvocations(FIXTURE_WORKFLOW);
  assert.deepEqual(
    [...invoked].sort(),
    ['build', 'test', 'test:qa:pg'],
    'working-directory 의 npm test · npm run, 루트의 -w server 만 apps/server 호출이다 — '
      + 'client · agent-manager 와 npm 이 아닌 직접 실행은 아니다. ${{ }} 로 감싼 알려진 조건도 같은 조건이다',
  );
  assert.deepEqual(
    uncounted.map(({ job, script }) => `${job} ${script}`),
    ['other build'],
    '명령이 둘인 step 의 build 는 찾되 세지 않는다',
  );
});

test('CI 호출: 명령 하나를 적는 여러 모양을 읽는다', () => {
  const yaml = onMainPush(`
jobs:
  a:
    steps:
      - run: npm --prefix apps/server run test:prefix
      - run: npm --prefix=apps/server run test:prefix-inline
      - run: npm -C apps/server --loglevel warn run test:short-prefix
      - run: npm run test:ws-path -w apps/server
      - run: npm run test:ws-inline --workspace=server
      - run: npm --workspace server run test:ws-first
      - working-directory: apps/server
        run: NODE_OPTIONS=--max-old-space-size=4096 npm run test:env
      - working-directory: apps/server
        run: |
          npm run test:block   # 꼬리 주석

      - working-directory: apps/server
        run: >-
          npm run
          test:folded
      - working-directory: apps/server
        run: "npm run test:quoted"
      - working-directory: \${{ github.workspace }}/apps/server
        run: npm run test:workspace-expr
      - working-directory: \${{github.workspace}}/apps/server
        run: npm run test:workspace-expr-tight
      - working-directory: $GITHUB_WORKSPACE/apps/server
        run: npm run test:literal-env-dir
      - working-directory: apps\\\\server
        run: npm run test:backslash
      - working-directory: apps/server
        run: npm run test:bare-dashes --
      - working-directory: apps/server
        run: npm run test:semicolon;
      - working-directory: apps/server
        run: "npm run test:trailing-newline\\n"
      - working-directory: apps/server
        run: npm --silent run test:silent -s --loglevel=warn --ignore-scripts=false
      - working-directory: apps/server
        run: npm run
      - run: npm run test:root-only
`);
  assert.deepEqual(invokedIn(yaml), [
    'test:backslash',
    'test:bare-dashes',
    'test:block',
    'test:env',
    'test:folded',
    'test:prefix',
    'test:prefix-inline',
    'test:quoted',
    'test:semicolon',
    'test:short-prefix',
    'test:silent',
    'test:trailing-newline',
    'test:workspace-expr',
    'test:workspace-expr-tight',
    'test:ws-first',
    'test:ws-inline',
    'test:ws-path',
  ], '이름 없는 `npm run` 은 호출이 아니다. 루트의 npm run 은 apps/server 가 아니다. working-directory 는 '
    + '${{ }} 만 풀린다 — $GITHUB_WORKSPACE 를 그대로 적은 디렉터리는 apps/server 가 아니다');
});

test('CI 호출: 잡과 워크플로의 defaults.run.working-directory 를 따른다', () => {
  const yaml = onMainPush(`
defaults:
  run:
    working-directory: apps/server
jobs:
  a:
    steps:
      - run: npm run test:workflow-default
      - working-directory: apps/client
        run: npm run test:client-own
  b:
    defaults:
      run:
        working-directory: apps/agent-manager
    steps:
      - run: npm run test:job-default
`);
  assert.deepEqual(invokedIn(yaml), ['test:workflow-default']);
});

// 두 리뷰가 찾은 모양들이다. GitHub 의 기본 셸은 `bash -e {0}` 이라 pipefail 이 없고, 끝이
// 아닌 && 의 실패에는 멈추지 않으며, || 는 앞의 목록 전체를 덮는다. 그런 것을 하나씩 흉내
// 내는 대신, 그 명령 하나가 아니면 세지 않는다. 찾은 호출은 이유와 함께 알린다.
test('CI 호출: step 의 run 이 그 명령 하나가 아니면 세지 않는다 — 셸이 실패를 덮을 수 있다', () => {
  const yaml = onMainPush(`
jobs:
  a:
    steps:
      - working-directory: apps/server
        run: npm run test:pipe 2>&1 | tee pg.log
      - working-directory: apps/server
        run: |
          npm run test:and-not-last && echo done
          echo next
      - working-directory: apps/server
        run: npm run test:and-or && echo ok || echo failed
      - working-directory: apps/server
        run: npm run test:or-handler || { echo "::error::failed"; exit 1; }
      - working-directory: apps/server
        run: npm run test:background &
      - working-directory: apps/server
        run: |
          if [ "$GITHUB_EVENT_NAME" = workflow_dispatch ]; then
            npm run test:in-if
          fi
      - working-directory: apps/server
        run: |
          cat >> "$GITHUB_STEP_SUMMARY" <<'EOF'
          Re-enable with:
          npm run test:heredoc
          EOF
      - working-directory: apps/server
        run: |
          exit 0  # disabled
          npm run test:after-exit
      - run: |
          (
            cd apps/server
            npm run test:subshell
          ) || echo continuing
      - run: cd "$GITHUB_WORKSPACE/apps/server" && npm run test:after-cd
      - working-directory: apps/client
        run: cd "$GITHUB_WORKSPACE/apps/server" && npm run test:abs-cd
      - run: |
          cd apps
          cd server
          npm run test:after-two-cds
      - run: cd "\${GITHUB_WORKSPACE}/apps/server" && npm run test:brace-env-cd
`);
  const { invoked, uncounted } = ciServerNpmInvocations(yaml);
  assert.deepEqual([...invoked], []);
  assert.deepEqual(uncounted.map((u) => u.script).sort(), [
    'test:abs-cd',
    'test:after-cd',
    'test:after-exit',
    'test:after-two-cds',
    'test:and-not-last',
    'test:and-or',
    'test:background',
    'test:brace-env-cd',
    'test:heredoc',
    'test:in-if',
    'test:or-handler',
    'test:pipe',
    'test:subshell',
  ], '명령이 여럿인 step 의 cd 를 따라가 그 안의 호출을 찾는다');
  for (const { script, why } of uncounted) assert.match(why, /이 명령 하나가 아니다/, script);
});

test('CI 호출: npm 앞에 다른 명령이 있으면 세지 않고 이유를 남긴다', () => {
  const { invoked, uncounted } = ciServerNpmInvocations(onMainPush(`
jobs:
  a:
    steps:
      - working-directory: apps/server
        run: timeout 45m npm run test:qa:pg
`));
  assert.deepEqual([...invoked], []);
  assert.equal(uncounted.length, 1);
  assert.match(uncounted[0].why, /timeout-minutes/);
});

// 리뷰가 만든 "조용한 초록" 모양 — YAML · 셸이 읽는 대로 읽으면 애초에 호출이 아니다.
test('CI 호출: 주석으로 막은 줄 · 접힌 블록 · 이어진 줄의 주석 · 따옴표 안의 명령은 호출이 아니다', () => {
  const yaml = onMainPush(`
jobs:
  a:
    steps:
      - name: commented out
        working-directory: apps/server
        run: |
          echo disabled
          # npm run build && npm run test:commented
      - name: folded into one echo
        working-directory: apps/server
        run: >
          echo "pg matrix temporarily disabled"
          npm run test:folded-away
      - name: continuation comment
        working-directory: apps/server
        run: echo pg matrix disabled
          for now # && npm run test:comment-tail
      - name: quoted separator
        working-directory: apps/server
        run: echo "skipping; npm run test:quoted"
`);
  assert.deepEqual(invokedIn(yaml), []);
});

test('CI 호출: 실패해도 CI 를 빨갛게 하지 못하는 잡 · step 의 호출은 세지 않고 이유를 남긴다', () => {
  const yaml = onMainPush(`
jobs:
  dispatch-only:
    if: github.event_name == 'workflow_dispatch'
    steps:
      - working-directory: apps/server
        run: npm run test:dispatch-only
  allowed-to-fail:
    continue-on-error: true
    steps:
      - working-directory: apps/server
        run: npm run test:job-coe
  steps-gated:
    steps:
      - if: false
        working-directory: apps/server
        run: npm run test:step-if
      - continue-on-error: 'true'
        working-directory: apps/server
        run: npm run test:step-coe
      - continue-on-error: False
        if: \${{ !cancelled() }}
        working-directory: apps/server
        run: npm run test:counted
      - if: true
        working-directory: apps/server
        run: npm run test:if-true
      - if: success()
        working-directory: apps/server
        run: npm run test:if-success
      - if: always()
        working-directory: apps/server
        run: npm run test:if-always
  ignore-scripts:
    env:
      npm_config_ignore_scripts: 'true'
    steps:
      - working-directory: apps/server
        run: npm run test:job-env-ignore
  ignore-scripts-step:
    steps:
      - working-directory: apps/server
        env:
          NPM_CONFIG_IGNORE_SCRIPTS: 'true'
        run: npm run test:step-env-ignore
      - working-directory: apps/server
        env:
          NPM_CONFIG_IGNORE_SCRIPTS: 'false'
        run: npm run test:env-off
      - working-directory: apps/server
        run: npm test --ignore-scripts
      - working-directory: apps/server
        run: npm run test:flag-off --ignore-scripts=false
  dynamic:
    steps:
      - working-directory: apps/server
        run: npm run \${{ matrix.suite }}
`);
  const { invoked, uncounted } = ciServerNpmInvocations(yaml);
  assert.deepEqual(
    [...invoked].sort(),
    ['test:counted', 'test:env-off', 'test:flag-off', 'test:if-always', 'test:if-success', 'test:if-true'],
  );
  assert.deepEqual(uncounted.map(({ job, script }) => `${job} ${script}`).sort(), [
    'allowed-to-fail test:job-coe',
    'dispatch-only test:dispatch-only',
    'dynamic ${{',
    'ignore-scripts test:job-env-ignore',
    'ignore-scripts-step test',
    'ignore-scripts-step test:step-env-ignore',
    'steps-gated test:step-coe',
    'steps-gated test:step-if',
  ]);
  const why = Object.fromEntries(uncounted.map((u) => [u.script, u.why]));
  assert.match(why['test:dispatch-only'], /^if: github\.event_name == 'workflow_dispatch'/);
  assert.match(why['test:job-coe'], /continue-on-error/);
  assert.match(why['test:step-env-ignore'], /NPM_CONFIG_IGNORE_SCRIPTS/);
  assert.match(why.test, /ignore-scripts/);
  assert.match(why['${{'], /실행 때/);
});

test('CI 호출: 워크플로 env 의 ignore-scripts 는 모든 호출에 걸린다', () => {
  const yaml = onMainPush(`
env:
  npm_config_ignore_scripts: '1'
jobs:
  a:
    steps:
      - working-directory: apps/server
        run: npm test
`);
  assert.deepEqual(invokedIn(yaml), []);
  assert.deepEqual(uncountedIn(yaml), ['a test']);
});

// 게이트를 실은 필드를 못 읽었는데 세면, 그 게이트가 CI 를 조용히 초록으로 둔다. 못 읽으면
// 세지 않는다 — 대조가 빨개지고 메시지가 무엇을 못 읽었는지 알린다.
test('CI 호출: 게이트 필드를 못 읽으면 세지 않는다 — 흐름 맵 · 모르는 별칭 · 병합 키 · 주석이 낀 needs', () => {
  const yaml = onMainPush(`
jobs:
  build:
    steps:
      - run: echo build
  gated:
    if: github.event_name == 'workflow_dispatch'
    steps:
      - run: echo gated
  flow-env:
    env: { npm_config_ignore_scripts: 'true' }
    steps:
      - working-directory: apps/server
        run: npm run test:flow-env
  alias-env:
    env: *nope
    steps:
      - working-directory: apps/server
        run: npm run test:alias-env
  merged:
    <<: *base
    steps:
      - working-directory: apps/server
        run: npm run test:merged
  comment-in-needs:
    needs: [build, # build first
      gated]
    steps:
      - working-directory: apps/server
        run: npm run test:comment-in-needs
  ghost-needs:
    needs: [ghost]
    steps:
      - working-directory: apps/server
        run: npm run test:ghost-needs
  odd-fields:
    steps:
      - if: [a]
        working-directory: apps/server
        run: npm run test:list-if
      - continue-on-error: [x]
        working-directory: apps/server
        run: npm run test:list-coe
      - working-directory: [apps/server]
        run: npm run test:list-dir
  flow-defaults:
    defaults: { run: { working-directory: apps/server } }
    steps:
      - run: npm run test:flow-defaults
`);
  assert.deepEqual(invokedIn(yaml), []);
  const why = Object.fromEntries(ciServerNpmInvocations(yaml).uncounted.map((u) => [u.script, u.why]));
  assert.deepEqual(Object.keys(why).sort(), [
    'test:alias-env',
    'test:comment-in-needs',
    'test:flow-defaults',
    'test:flow-env',
    'test:ghost-needs',
    'test:list-coe',
    'test:list-dir',
    'test:list-if',
    'test:merged',
  ]);
  for (const [script, reason] of Object.entries(why)) assert.match(reason, /읽지 못했다/, script);
  assert.match(why['test:comment-in-needs'], /^needs /);
  assert.match(why['test:merged'], /병합 키/);
  assert.match(why['test:flow-defaults'], /^defaults /);
  assert.match(why['test:list-dir'], /^working-directory /);
  assert.match(why['test:list-if'], /^if /);
  assert.match(why['test:list-coe'], /^continue-on-error /);
  assert.match(why['test:flow-env'], /^env /);
});

test('CI 호출: 앵커로 나눠 쓴 조건 · env · needs 를 따라간다', () => {
  const yaml = onMainPush(`
jobs:
  first:
    if: &heavy-cond github.ref != 'refs/heads/production.private' && github.event_name != 'schedule'
    env: &hardened
      npm_config_ignore_scripts: 'true'
    steps:
      - working-directory: apps/server
        run: npm run test:first
  second:
    if: *heavy-cond
    steps:
      - working-directory: apps/server
        run: npm run test:second
  third:
    env: *hardened
    steps:
      - working-directory: apps/server
        run: npm run test:third
  gated:
    if: false
    steps:
      - run: echo gated
  fourth:
    needs: &deps [gated]
    steps:
      - working-directory: apps/server
        run: npm run test:fourth
  fifth:
    needs: *deps
    steps:
      - working-directory: apps/server
        run: npm run test:fifth
`);
  assert.deepEqual(invokedIn(yaml), ['test:second']);
  assert.deepEqual(uncountedIn(yaml), ['fifth test:fifth', 'first test:first', 'fourth test:fourth', 'third test:third']);
});

// 잡은 needs 로 기다리는 잡이 건너뛰어지면 함께 건너뛰어진다. 기다리는 잡이 조건부면 이
// 잡도 조건부다 — 이 잡 자신이 always() · !cancelled() 면 다르고, 기다리는 잡의
// continue-on-error 도 다르다(실패해도 기다리던 잡은 돈다).
test('CI 호출: needs 로 기다리는 잡이 조건부면 그 호출도 세지 않는다', () => {
  const yaml = onMainPush(`
jobs:
  gated:
    if: github.event_name == 'workflow_dispatch'
    steps:
      - run: echo hi
  build:
    steps:
      - run: echo build
  after-gated:
    needs: [build, gated]
    steps:
      - working-directory: apps/server
        run: npm run test:after-gated
  chain:
    needs: after-gated
    steps:
      - working-directory: apps/server
        run: npm run test:chain
  after-build:
    needs: build
    steps:
      - working-directory: apps/server
        run: npm run test:after-build
  allowed-to-fail:
    continue-on-error: true
    steps:
      - run: echo x
  after-allowed-to-fail:
    needs: [allowed-to-fail]
    steps:
      - working-directory: apps/server
        run: npm run test:after-coe
  always-after-gated:
    if: always()
    needs: gated
    steps:
      - working-directory: apps/server
        run: npm run test:always-after-gated
  wrapped-always-after-gated:
    if: \${{ always() }}
    needs: gated
    steps:
      - working-directory: apps/server
        run: npm run test:wrapped-always-after-gated
  not-cancelled-after-gated:
    if: '!cancelled()'
    needs: gated
    steps:
      - working-directory: apps/server
        run: npm run test:not-cancelled-after-gated
  success-after-gated:
    if: success()
    needs: gated
    steps:
      - working-directory: apps/server
        run: npm run test:success-after-gated
  true-after-gated:
    if: true
    needs: gated
    steps:
      - working-directory: apps/server
        run: npm run test:true-after-gated
  cycle-a:
    needs: cycle-b
    steps:
      - working-directory: apps/server
        run: npm run test:cycle
  cycle-b:
    needs: cycle-a
    steps:
      - run: echo b
`);
  const { invoked, uncounted } = ciServerNpmInvocations(yaml);
  assert.deepEqual([...invoked].sort(), [
    'test:after-build',
    'test:after-coe',
    'test:always-after-gated',
    'test:cycle',
    'test:not-cancelled-after-gated',
    'test:wrapped-always-after-gated',
  ]);
  assert.deepEqual(
    uncounted.map(({ script, why }) => [script, why.split(' — ')[0]]),
    [
      ['test:after-gated', 'needs: gated'],
      ['test:chain', 'needs: after-gated'],
      ['test:success-after-gated', 'needs: gated'],
      ['test:true-after-gated', 'needs: gated'],
    ],
    '상태 함수가 없거나 success() 면 건너뛴 needs 뒤의 잡도 건너뛴다',
  );
  assert.match(uncounted[1].why, /needs: after-gated — needs: gated — if: github\.event_name/);
});

test('CI 호출: 워크플로가 main push 에 걸려 있지 않으면 세지 않는다', () => {
  const job = `
jobs:
  a:
    steps:
      - working-directory: apps/server
        run: npm test
`;
  const reason = (on) => {
    const { invoked, uncounted } = ciServerNpmInvocations(`on: ${on}${job}`);
    return invoked.size === 1 ? null : uncounted[0]?.why ?? '';
  };
  const push = (body) => `\n  push:\n${body.split('\n').map((line) => `    ${line}`).join('\n')}`;

  for (const [on, label] of [
    ['push', 'on: push'],
    ['[push, pull_request]', '흐름 시퀀스'],
    [push('branches: main'), '문자열 하나인 branches'],
    [push("branches: ['*']"), '* 는 main 을 고른다'],
    [push("branches: ['**']"), '** 는 main 을 고른다'],
    [push("branches: ['mai?n']"), '? 는 앞 글자가 없거나 하나다'],
    [push("branches: ['ma+in']"), '+ 는 앞 글자가 하나 이상이다'],
    [push("branches:\n  - 'm[a-z]in'"), '[] 는 한 글자 범위다'],
    [push("branches: ['!main', main]"), '마지막으로 맞은 패턴이 정한다'],
    [push('branches-ignore: [release, "rel/**"]'), 'main 을 빼지 않는 branches-ignore'],
    [push('branches: [main]\ntags: [v*]'), 'branches 가 있으면 tags 는 상관없다'],
  ]) {
    assert.equal(reason(on), null, label);
  }

  for (const [on, pattern, label] of [
    ['[pull_request, workflow_dispatch]', /push 가 없다/, 'push 가 없다'],
    [push('paths: [docs/**]'), /paths 필터/, 'paths'],
    [push('paths-ignore: [apps/server/**]'), /paths 필터/, 'paths-ignore'],
    [push('branches: [release]'), /main 을 고르지 않는다/, 'main 이 없는 branches'],
    [push("branches: [main, '!main']"), /main 을 고르지 않는다/, '뒤의 ! 가 main 을 뺀다'],
    [push('branches-ignore: [main]'), /branches-ignore 가 main 을 뺀다/, 'branches-ignore: main'],
    [push("branches-ignore: ['ma*']"), /branches-ignore 가 main 을 뺀다/, 'branches-ignore 패턴'],
    [push("branches-ignore: ['**']\ntags: [v*]"), /branches-ignore 가 main 을 뺀다/, 'tags 만 받는 흔한 모양'],
    [push('tags: [v*]'), /tags 필터만/, 'tags 만'],
    [push('tags-ignore: [v*]'), /tags 필터만/, 'tags-ignore 만'],
    [push("branches: ['ma?n']"), /main 을 고르지 않는다/, '? 는 한 글자가 아니다 — ma?n 은 mn · man 이다'],
    [push("branches: ['m.in']"), /main 을 고르지 않는다/, '. 은 글자 그대로다'],
    [push("branches-ignore: ['mai?n']"), /branches-ignore 가 main 을 뺀다/, 'branches-ignore 의 ?'],
    [push("branches:\n  - '[main'"), /on\.push\.branches 를 읽지 못했다/, '닫히지 않은 []'],
    [push("branches: ['m[a-z]in']"), /on\.push\.branches 를 읽지 못했다/, '펼치지 못한 흐름 시퀀스'],
    [push("branches-ignore:\n  - '[main'"), /on\.push\.branches-ignore 를 읽지 못했다/, 'branches-ignore 의 닫히지 않은 []'],
    [push("branches: ['?main']"), /on\.push\.branches 를 읽지 못했다/, '앞 글자가 없는 ?'],
    [push('branches: { a: b }'), /on\.push\.branches 를 읽지 못했다/, '흐름 맵 branches'],
    [push('branches-ignore: { a: b }'), /on\.push\.branches-ignore 를 읽지 못했다/, '흐름 맵 branches-ignore'],
    [push('branches:\n  a: b'), /on\.push\.branches 를 읽지 못했다/, '블록 맵 branches'],
    [push('branches-ignore:\n  a: b'), /on\.push\.branches-ignore 를 읽지 못했다/, '블록 맵 branches-ignore'],
    ['\n  push:\n  !!str other: y', /on 를 읽지 못했다/, '키로 읽지 못한 줄이 있는 on'],
    ['\n  push: anything', /on\.push 를 읽지 못했다/, '맵이 아닌 push'],
    ['{ push: {} }', /on 를 읽지 못했다 — 워크플로가 main push 에 도는지/, '흐름 맵 on'],
  ]) {
    assert.match(reason(on) ?? '(셌다)', pattern, label);
  }
  assert.match(ciServerNpmInvocations(job).uncounted[0].why, /on 를 읽지 못했다/, 'on: 이 없는 워크플로');
});

test('CI 호출: 알려진 조건 목록은 지금 ci.yml 의 무거운 잡 조건을 담는다', () => {
  assert.ok(
    ALWAYS_RUN_CONDITIONS.includes("github.ref != 'refs/heads/production.private' && github.event_name != 'schedule'"),
  );
});

test('CI 호출: 모르는 npm 옵션 · 스크립트 인자 · 명령 앞의 npm 설정은 세지 않는다', () => {
  const { invoked, uncounted } = ciServerNpmInvocations(onMainPush(`
jobs:
  a:
    steps:
      - working-directory: apps/server
        run: npm run test:if-present --if-present
      - working-directory: apps/server
        run: npm test --ignore-script
      - working-directory: apps/server
        run: npm run test:script-shell --script-shell=true
      - working-directory: apps/server
        run: npm_config_ignore_scripts=true npm run test:prefix-env
      - working-directory: apps/server
        run: NPM_CONFIG_IGNORE_SCRIPTS=1 npm run test:prefix-env-upper
      - working-directory: apps/server
        run: BASH_ENV=/tmp/x npm run test:bash-env
      - working-directory: apps/server
        run: npm run test:extra-arg extra
      - working-directory: apps/server
        run: npm run test:after-dashes -- -w client
      - working-directory: apps/server
        run: NODE_OPTIONS=--max-old-space-size=4096 npm run test:node-options
      - working-directory: apps/server
        run: npm run test:ignore-true --ignore-scripts=true
      - working-directory: apps/server
        run: npm run test:all-workspaces -ws
      - working-directory: apps/server
        run: npm run test:ignore-zero --ignore-scripts=0
      - working-directory: apps/server
        run: npm run test:ignore-upper --ignore-scripts=FALSE
      - working-directory: apps/server
        run: npm_config_ignore_scripts=FALSE npm run test:prefix-upper-false
      - working-directory: apps/server
        run: NODE_OPTIONS=--test-skip-pattern=flaky npm run test:node-skip
      - working-directory: apps/server
        run: npm run test:harmless-flags -q -d -dd --verbose --foreground-scripts --color=always --no-update-notifier --no-fund --no-audit --no-progress --no-ignore-scripts
`));
  assert.deepEqual(
    [...invoked].sort(),
    ['test:harmless-flags', 'test:node-options'],
    '스크립트를 도는 방식과 무관한 옵션 · 환경 변수는 괜찮다',
  );
  const why = Object.fromEntries(uncounted.map((u) => [u.script, u.why]));
  assert.deepEqual(Object.keys(why).sort(), [
    'test',
    'test:after-dashes',
    'test:all-workspaces',
    'test:bash-env',
    'test:extra-arg',
    'test:if-present',
    'test:ignore-true',
    'test:ignore-upper',
    'test:ignore-zero',
    'test:node-skip',
    'test:prefix-env',
    'test:prefix-env-upper',
    'test:prefix-upper-false',
    'test:script-shell',
  ], 'npm 은 명령 옵션의 ignore-scripts 를 정확히 false 일 때만 끈다 — =0 · =FALSE 는 켠다');
  assert.match(why['test:ignore-true'], /npm 옵션 --ignore-scripts=true/);
  assert.match(why['test:if-present'], /npm 옵션 --if-present/);
  assert.match(why.test, /npm 옵션 --ignore-script/, 'npm 은 옵션 이름의 줄임도 받아들인다');
  assert.match(why['test:prefix-env'], /명령 앞의 npm_config_ignore_scripts=/);
  assert.match(why['test:extra-arg'], /인자를 넘긴다/);
  assert.match(why['test:after-dashes'], /인자를 넘긴다/);

  const testWithArg = ciServerNpmInvocations(onMainPush(`
jobs:
  a:
    steps:
      - working-directory: apps/server
        run: npm test extra
`));
  assert.deepEqual([...testWithArg.invoked], []);
  assert.match(testWithArg.uncounted[0].why, /인자를 넘긴다/, '`npm test <인자>` 도 스크립트에 인자를 넘긴다');
});

test('CI 호출: env 의 npm · 셸 설정 — 스크립트를 도는 방식을 바꾸는 것만 막는다', () => {
  const step = (name, env) => `
  ${name}:
    steps:
      - working-directory: apps/server
        env:
          ${env}
        run: npm run test:${name}`;
  const yaml = onMainPush(`
jobs:${step('bash-env', 'BASH_ENV: /tmp/x')}${step('userconfig', 'npm_config_userconfig: /tmp/npmrc')}${step('hyphen', "npm_config_ignore-scripts: 'true'")}${step('zero', "npm_config_ignore_scripts: '0'")}${step('audit', "npm_config_audit: 'false'")}${step('registry', 'NPM_CONFIG_REGISTRY: https://r.example')}${step('fetch', "NPM_CONFIG_FETCH_RETRIES: '5'")}${step('empty', "npm_config_ignore_scripts: ''")}${step('upper-false', "npm_config_ignore_scripts: 'FALSE'")}${step('globalconfig', 'npm_config_globalconfig: /tmp/npmrc')}${step('npm-node-options', 'npm_config_node_options: --max-old-space-size=4096')}${step('node-test-skip', "NODE_OPTIONS: '--test-skip-pattern=flaky'")}${step('node-test-underscore', "NODE_OPTIONS: '--test_skip_pattern=flaky'")}${step('node-memory', "NODE_OPTIONS: '--max-old-space-size=4096'")}
`);
  assert.deepEqual(invokedIn(yaml), ['test:audit', 'test:empty', 'test:fetch', 'test:node-memory', 'test:registry', 'test:zero']);
  assert.deepEqual(uncountedIn(yaml), [
    'bash-env test:bash-env',
    'globalconfig test:globalconfig',
    'hyphen test:hyphen',
    'node-test-skip test:node-test-skip',
    'node-test-underscore test:node-test-underscore',
    'npm-node-options test:npm-node-options',
    'upper-false test:upper-false',
    'userconfig test:userconfig',
  ], 'env 의 ignore-scripts 는 false · 0 · 빈 값만 끈다');
});

// GITHUB_ENV 와 사용자 .npmrc 는 같은 잡의 뒤 step 들로 이어진다.
test('CI 호출: 앞 step 이 GITHUB_ENV 나 npm config set 으로 남긴 설정은 뒤 step 의 호출에 걸린다', () => {
  const yaml = onMainPush(`
jobs:
  github-env:
    steps:
      - working-directory: apps/server
        run: npm run test:before-taint
      - run: echo "npm_config_ignore_scripts=true" >> "$GITHUB_ENV"
      - working-directory: apps/server
        run: npm run test:after-github-env
  npm-config-set:
    steps:
      - run: npm config set ignore-scripts true
      - working-directory: apps/server
        run: npm run test:after-config-set
  other-env:
    steps:
      - run: echo "FOO=1" >> "$GITHUB_ENV"
      - working-directory: apps/server
        run: npm run test:after-other-env
  harmless-env:
    steps:
      - run: echo "npm_config_registry=https://r.example" >> "$GITHUB_ENV"
      - run: npm config set registry https://r.example
      - run: npm config set registry=https://r.example
      - run: echo "npm_config_ignore_scripts=false" >> "$GITHUB_ENV"
      - working-directory: apps/server
        run: npm run test:after-harmless
  bash-env:
    steps:
      - run: echo "BASH_ENV=/tmp/x" >> $GITHUB_ENV
      - working-directory: apps/server
        run: npm run test:after-bash-env
  upper-env:
    steps:
      - run: echo NPM_CONFIG_IGNORE_SCRIPTS=1 >> $GITHUB_ENV
      - working-directory: apps/server
        run: npm run test:after-upper-env
  npm-set:
    steps:
      - run: npm set ignore-scripts true
      - working-directory: apps/server
        run: npm run test:after-npm-set
  c-set:
    steps:
      - run: npm c set ignore-scripts true
      - working-directory: apps/server
        run: npm run test:after-c-set
  located-set:
    steps:
      - run: npm --location=user config set ignore-scripts=true
      - working-directory: apps/server
        run: npm run test:after-located-set
  npmrc-write:
    steps:
      - run: echo "ignore-scripts=true" >> ~/.npmrc
      - working-directory: apps/server
        run: npm run test:after-npmrc
  workspace-npmrc:
    steps:
      - run: echo "ignore-scripts=true" > .npmrc
      - working-directory: apps/server
        run: npm run test:after-workspace-npmrc
  home-npmrc:
    steps:
      - run: cp .github/ci.npmrc "$HOME/.npmrc"
      - working-directory: apps/server
        run: npm run test:after-home-npmrc
  env-spaced:
    steps:
      - run: echo "NODE_OPTIONS=--max-old-space-size=4096 --test-skip-pattern=flaky" >> "$GITHUB_ENV"
      - working-directory: apps/server
        run: npm run test:after-env-spaced
  env-quoted-value:
    steps:
      - run: echo 'npm_config_ignore_scripts="true"' >> "$GITHUB_ENV"
      - working-directory: apps/server
        run: npm run test:after-env-quoted
  env-heredoc:
    steps:
      - run: |
          cat >> "$GITHUB_ENV" <<EOF
          NODE_OPTIONS=--max-old-space-size=4096 --test-skip-pattern=flaky
          EOF
      - working-directory: apps/server
        run: npm run test:after-env-heredoc
  env-multiline:
    steps:
      - run: |
          echo "NODE_OPTIONS<<EOF" >> "$GITHUB_ENV"
          echo "--max-old-space-size=4096" >> "$GITHUB_ENV"
          echo "EOF" >> "$GITHUB_ENV"
      - working-directory: apps/server
        run: npm run test:after-env-multiline
  env-node-options:
    steps:
      - run: echo "NODE_OPTIONS=--test-skip-pattern=flaky" >> "$GITHUB_ENV"
      - working-directory: apps/server
        run: npm run test:after-env-node-options
  set-from-variables:
    steps:
      - run: npm config set "$KEY" "$VALUE"
      - working-directory: apps/server
        run: npm run test:after-set-variables
  set-with-location:
    steps:
      - run: npm config set registry https://r.example --location user
      - working-directory: apps/server
        run: npm run test:after-set-with-location
`);
  assert.deepEqual(
    invokedIn(yaml),
    ['test:after-harmless', 'test:after-other-env', 'test:after-set-with-location', 'test:before-taint'],
    '앞 step 만 뒤 step 에 걸리고, 잡을 넘지 않는다. 스크립트와 무관한 설정은 걸리지 않는다 — '
      + '--location user 의 user 는 설정 이름이 아니다',
  );
  assert.deepEqual(uncountedIn(yaml), [
    'bash-env test:after-bash-env',
    'c-set test:after-c-set',
    'env-heredoc test:after-env-heredoc',
    'env-multiline test:after-env-multiline',
    'env-node-options test:after-env-node-options',
    'env-quoted-value test:after-env-quoted',
    'env-spaced test:after-env-spaced',
    'github-env test:after-github-env',
    'home-npmrc test:after-home-npmrc',
    'located-set test:after-located-set',
    'npm-config-set test:after-config-set',
    'npm-set test:after-npm-set',
    'npmrc-write test:after-npmrc',
    'set-from-variables test:after-set-variables',
    'upper-env test:after-upper-env',
    'workspace-npmrc test:after-workspace-npmrc',
  ], 'GITHUB_ENV 값은 따옴표째 · 줄 끝까지 읽고, 여러 줄 문법은 읽지 않고 문제로 본다');
  const why = Object.fromEntries(ciServerNpmInvocations(yaml).uncounted.map((u) => [u.script, u.why]));
  assert.match(why['test:after-npmrc'], /actions\/setup-node/, '.npmrc 를 쓰는 까닭(인증)에 맞는 길을 알린다');
  assert.doesNotMatch(why['test:after-bash-env'], /HARMLESS_NPM_CONFIG/, 'npm 설정이 아닌 것에 npm 설정 목록을 권하지 않는다');
  assert.match(why['test:after-c-set'], /HARMLESS_NPM_CONFIG/);
});

test('CI 호출: 보통 셸이 아닌 shell: 은 세지 않는다', () => {
  const yaml = onMainPush(`
jobs:
  plain:
    defaults:
      run:
        shell: bash
    steps:
      - working-directory: apps/server
        run: npm run test:defaults-bash
      - working-directory: apps/server
        shell: pwsh
        run: npm run test:pwsh
      - working-directory: apps/server
        shell: sh
        run: npm run test:sh
      - working-directory: apps/server
        shell: cmd
        run: npm run test:cmd
      - working-directory: apps/server
        shell: powershell
        run: npm run test:powershell
      - working-directory: apps/server
        shell: bash -eo pipefail {0}
        run: npm run test:bash-template
      - working-directory: apps/server
        shell: bash --noprofile --norc -euxo pipefail {0}
        run: npm run test:bash-long-template
  custom-step:
    steps:
      - working-directory: apps/server
        shell: true {0}
        run: npm run test:custom-step
  custom-defaults:
    defaults:
      run:
        shell: bash -c 'exit 0' {0}
    steps:
      - working-directory: apps/server
        run: npm run test:custom-defaults
  list-shell:
    steps:
      - working-directory: apps/server
        shell: [bash]
        run: npm run test:list-shell
`);
  assert.deepEqual(invokedIn(yaml), [
    'test:bash-long-template',
    'test:bash-template',
    'test:cmd',
    'test:defaults-bash',
    'test:powershell',
    'test:pwsh',
    'test:sh',
  ], 'bash · sh 에 흔한 옵션만 붙인 템플릿은 보통 셸이다');
  const why = Object.fromEntries(ciServerNpmInvocations(yaml).uncounted.map((u) => [u.script, u.why]));
  assert.match(why['test:custom-step'], /^shell: true \{0\}/);
  assert.match(why['test:custom-defaults'], /^shell: bash -c/);
  assert.match(why['test:list-shell'], /^shell 를 읽지 못했다/);
});

// 키로 읽지 못한 줄이 게이트 키(if: false)였을 수 있다 — 그 맵은 못 읽은 것으로 다룬다.
test('CI 호출: 앵커 · 태그 · ? 를 붙인 키처럼 키로 읽지 못한 줄이 있는 step 은 세지 않는다', () => {
  const yaml = onMainPush(`
jobs:
  a:
    steps:
      - working-directory: apps/server
        &g if: false
        run: npm run test:anchored-key
      - working-directory: apps/server
        !!str if: false
        run: npm run test:tagged-key
      - working-directory: apps/server
        ? if
        : false
        run: npm run test:explicit-key
`);
  const { invoked, uncounted } = ciServerNpmInvocations(yaml);
  assert.deepEqual([...invoked], []);
  assert.deepEqual(uncounted.map((u) => u.script).sort(), ['test:anchored-key', 'test:explicit-key', 'test:tagged-key']);
  for (const { script, why } of uncounted) assert.match(why, /^키 를 읽지 못했다/, script);
});

test('CI 호출: defaults.run 이나 그 working-directory 를 못 읽으면 세지 않는다', () => {
  const yaml = onMainPush(`
jobs:
  run-string:
    defaults:
      run: apps/server
    steps:
      - run: npm run test:run-string
  dir-list:
    defaults:
      run:
        working-directory: [apps/server]
    steps:
      - run: npm run test:dir-list
`);
  assert.deepEqual(invokedIn(yaml), []);
  const why = Object.fromEntries(ciServerNpmInvocations(yaml).uncounted.map((u) => [u.script, u.why]));
  assert.match(why['test:run-string'], /^defaults\.run 를 읽지 못했다/);
  assert.match(why['test:dir-list'], /^defaults\.run\.working-directory 를 읽지 못했다/);
});

test('.npmrc: 스크립트를 도는 방식을 바꾸는 설정만 문제로 신고한다', () => {
  assert.deepEqual(
    npmrcProblems([
      'registry=https://r.example',
      '//r.example/:_authToken=${TOKEN}',
      '@acme:registry=https://acme.example',
      '; 주석',
      '# 주석',
      'fund=false',
      'engine-strict=true',
      'fetch-retries=5',
      'ignore-scripts=false',
      'ignore-scripts=0',
    ].join('\n')),
    [],
  );
  assert.deepEqual(
    npmrcProblems('ignore-scripts=true\nscript-shell = /bin/true\nuserconfig=/tmp/x\nignore-scripts\nignore-scripts=\nignore-scripts=FALSE\n'),
    ['ignore-scripts=true', 'script-shell = /bin/true', 'userconfig=/tmp/x', 'ignore-scripts', 'ignore-scripts=', 'ignore-scripts=FALSE'],
    '값 없는 줄과 빈 값은 켠다. 끄는 값은 false · 0 뿐이다',
  );
});

test('CI 호출: 잡 container 의 env 도 본다', () => {
  const yaml = onMainPush(`
jobs:
  in-container:
    container:
      image: node:22
      env:
        npm_config_ignore_scripts: 'true'
    steps:
      - working-directory: apps/server
        run: npm run test:container-env
  image-only:
    container: node:22
    steps:
      - working-directory: apps/server
        run: npm run test:image-only
  odd-container:
    container: [node]
    steps:
      - working-directory: apps/server
        run: npm run test:odd-container
`);
  assert.deepEqual(invokedIn(yaml), ['test:image-only']);
  const why = Object.fromEntries(ciServerNpmInvocations(yaml).uncounted.map((u) => [u.script, u.why]));
  assert.match(why['test:container-env'], /env 의 npm_config_ignore_scripts/);
  assert.match(why['test:odd-container'], /^container 를 읽지 못했다/);
});

// npm 은 --help · --version · --usage · -h · -v 를 받으면 아무 스크립트도 돌리지 않고 0 으로 끝난다.
// 그러니 이것들은 "무관한 설정" 이 아니다 — 허용 목록에 잘못 보태지면 여기가 빨개진다.
test('CI 호출: 스크립트를 돌리지 않는 npm 옵션(--help · --version · --usage · -h · -v)은 세지 않는다', () => {
  for (const option of ['--help', '--version', '--usage', '-h', '-v']) {
    const { invoked, uncounted } = ciServerNpmInvocations(onMainPush(`
jobs:
  a:
    steps:
      - working-directory: apps/server
        run: npm test ${option}
`));
    assert.deepEqual([...invoked], [], option);
    assert.match(uncounted[0]?.why ?? '', new RegExp(`npm 옵션 ${option}`), option);
  }
});

test('required PG environment: missing, wrong and dynamic DB_TYPE cannot count as PG coverage', () => {
  const options = { requiredEnvByScript: { 'test:qa:pg': { DB_TYPE: 'postgres' } } };
  const workflow = ({ global = '', job = '', step = '', command = 'npm run test:qa:pg' } = {}) => onMainPush(`
${global}
jobs:
  pg:
${job}
    steps:
      - working-directory: apps/server
${step}
        run: ${command}
`);
  for (const input of [
    {},
    { job: '    env:\n      DB_TYPE: sqlite' },
    { job: '    env:\n      DB_TYPE: ${{ matrix.db }}' },
    { job: '    env:\n      DB_TYPE: postgres', step: '        env:\n          DB_TYPE: sqlite' },
    { job: '    env:\n      DB_TYPE: postgres', command: 'DB_TYPE=sqlite npm run test:qa:pg' },
    { global: 'env:\n  DB_TYPE: postgres', job: '    env:\n      DB_TYPE: sqlite' },
  ]) {
    const result = ciServerNpmInvocations(workflow(input), options);
    assert.equal(result.invoked.has('test:qa:pg'), false, JSON.stringify(input));
    assert.match(result.uncounted[0].why, /DB_TYPE=postgres/);
  }
  for (const input of [
    { job: '    env:\n      DB_TYPE: postgres' },
    { global: 'env:\n  DB_TYPE: postgres' },
    { job: '    env:\n      DB_TYPE: sqlite', step: '        env:\n          DB_TYPE: postgres' },
    { command: 'DB_TYPE=postgres npm run test:qa:pg' },
  ]) {
    assert.equal(ciServerNpmInvocations(workflow(input), options).invoked.has('test:qa:pg'), true, JSON.stringify(input));
  }
  assert.equal(ciServerNpmInvocations(workflow({ command: 'npm test' }), options).invoked.has('test'), true);
});


test('required PG environment cannot rely on YAML after a GITHUB_ENV write', () => {
  const result = ciServerNpmInvocations(onMainPush(`
jobs:
  pg:
    env:
      DB_TYPE: postgres
    steps:
      - run: echo 'DB_TYPE=sqlite' >> "$GITHUB_ENV"
      - run: npm run test:qa:pg
        working-directory: apps/server
`), { requiredEnvByScript: { 'test:qa:pg': { DB_TYPE: 'postgres' } } });
  assert.equal(result.invoked.has('test:qa:pg'), false);
  assert.match(result.uncounted[0].why, /DB_TYPE=postgres/);
});
