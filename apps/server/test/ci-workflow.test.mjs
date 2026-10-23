// ci.yml 읽기 — 티켓 6ad5989a.
//
// 등록 가드(test-registration-completeness)는 CI 진입점 목록을 ci.yml 과 대조한다. 그
// 대조가 믿을 만하려면 ci.yml 을 YAML 과 셸이 읽는 대로 읽어야 한다. 독립 리뷰에서 나온
// 실패가 다 그 어긋남이었다:
//   - `run: >` 의 두 줄은 명령 하나인데 둘로 읽었다.
//   - 주석으로 막은 `# npm run build && npm run test:qa:pg` 를 호출로 셌다.
//   - 이어진 줄의 꼬리 주석을 명령으로 읽었다.
// 셋 다 CI 가 부르지 않는 스크립트를 부른다고 믿게 해서 가드를 조용히 초록으로 둔다.
// 여기서는 그런 모양을 하나씩 고정한다. 기대값은 js-yaml · bash 가 읽는 결과와 같다 — 이 파서가
// 일부러 원문으로 두는 모양(맵 · 중첩 흐름 컬렉션)만 빼고.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shellCommands } from './helpers/shell-commands.mjs';
import { ALWAYS_RUN_CONDITIONS, ciServerNpmInvocations, parseWorkflowYaml } from './helpers/ci-workflow.mjs';

const invokedIn = (yaml) => [...ciServerNpmInvocations(yaml).invoked].sort();

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

test('YAML: __proto__ 키는 프로토타입을 바꾸지 않는다', () => {
  const doc = parseWorkflowYaml('__proto__:\n  polluted: yes\nok: 1\n');
  assert.equal(Object.getPrototypeOf(doc), Object.prototype);
  assert.deepEqual(Object.keys(doc), ['__proto__', 'ok'], '자기 키로 남는다');
  assert.equal(doc.polluted, undefined);
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

// ── CI 호출 ────────────────────────────────────────────────────────────────

// 실제 ci.yml 의 모양을 줄여 옮겼다: 무거운 잡의 if: 조건, step 키 사이의 주석과 env 맵,
// 루트에서 부르는 `-w server`, 다른 workspace, npm 이 아닌 직접 실행.
const FIXTURE_WORKFLOW = `
name: CI
on:
  push:
    branches:
      - main
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
`;

test('CI 호출: apps/server 에서 부르는 npm 스크립트만 모은다', () => {
  const { invoked, uncounted } = ciServerNpmInvocations(FIXTURE_WORKFLOW);
  assert.deepEqual(
    [...invoked].sort(),
    ['build', 'test', 'test:qa:pg'],
    'working-directory 의 npm test · npm run, 루트의 -w server 만 apps/server 호출이다 — '
      + 'client · agent-manager 와 npm 이 아닌 직접 실행은 아니다. ${{ }} 로 감싼 알려진 조건도 같은 조건이다',
  );
  assert.deepEqual(uncounted, []);
});

test('CI 호출: cd · --prefix · -C · workspace 형태 · 환경 변수 접두 · 여러 줄 명령을 따라간다', () => {
  const yaml = `
jobs:
  a:
    steps:
      - name: block
        run: |
          echo start
          cd apps/server && npm run test:block
          npm run test:args -- -w client
      - name: prefix and line continuation
        run: |
          npm --prefix apps/server run test:prefix
          npm -C apps/server --loglevel warn run test:short-prefix
          npm --prefix apps/server \\
            run test:continued
      - name: workspace forms
        run: npm run test:ws-path -w apps/server && npm run test:ws-inline --workspace=server
      - name: env assignment
        working-directory: apps/server
        run: NODE_OPTIONS=--max-old-space-size=4096 npm run test:env
      - name: folded plain
        working-directory: apps/server
        run: npm run build
          && npm run test:folded
      - name: cd does not leak into the next step
        run: npm run test:root-only
`;
  assert.deepEqual(invokedIn(yaml), [
    'build',
    'test:args',
    'test:block',
    'test:continued',
    'test:env',
    'test:folded',
    'test:prefix',
    'test:short-prefix',
    'test:ws-inline',
    'test:ws-path',
  ], '`--` 뒤의 -w 는 스크립트 인자다. cd 는 그 step 안에서만 유효하다');
});

test('CI 호출: 잡과 워크플로의 defaults.run.working-directory 를 따른다', () => {
  const yaml = `
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
`;
  assert.deepEqual(invokedIn(yaml), ['test:workflow-default']);
});

// 리뷰가 실험으로 만든 "조용한 초록" 모양들 — YAML · 셸이 읽는 대로 읽으면 호출이 아니다.
test('CI 호출: 주석으로 막은 줄 · 접힌 블록 · 이어진 줄의 주석 · 따옴표 안의 명령은 호출이 아니다', () => {
  const yaml = `
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
`;
  assert.deepEqual(invokedIn(yaml), []);
});

test('CI 호출: 접힌 블록이 한 명령을 두 줄로 나눠 써도 하나로 읽는다', () => {
  const yaml = `
jobs:
  a:
    steps:
      - working-directory: apps/server
        run: >-
          npm run
          test:qa:pg
`;
  assert.deepEqual(invokedIn(yaml), ['test:qa:pg']);
});

test('CI 호출: 따옴표 안의 이스케이프를 지나 뒤의 명령까지 읽는다', () => {
  const yaml = `
jobs:
  a:
    steps:
      - working-directory: apps/server
        run: "echo \\"go\\" && npm run test:after-quote"
`;
  assert.deepEqual(invokedIn(yaml), ['test:after-quote']);
});

test('CI 호출: 실패해도 CI 를 빨갛게 하지 못하는 호출은 세지 않고 이유를 남긴다', () => {
  const yaml = `
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
      - continue-on-error: false
        if: \${{ !cancelled() }}
        working-directory: apps/server
        run: npm run test:counted
  shell-swallowed:
    steps:
      - working-directory: apps/server
        run: |
          npm run test:or-true || true
          npm run test:background &
          npm run test:and && echo done
          npm run test:redirect 2>&1 | tee log.txt
  ignore-scripts:
    env:
      npm_config_ignore_scripts: 'true'
    steps:
      - working-directory: apps/server
        run: npm run test:env-ignore
  ignore-scripts-flag:
    steps:
      - working-directory: apps/server
        run: npm test --ignore-scripts && npm run test:flag-off --ignore-scripts=false
      - working-directory: apps/server
        env:
          NPM_CONFIG_IGNORE_SCRIPTS: 'false'
        run: npm run test:env-off
  dynamic:
    steps:
      - working-directory: apps/server
        run: npm run \${{ matrix.suite }}
  shell-flow:
    steps:
      - working-directory: apps/server
        run: |
          if [ "$GITHUB_EVENT_NAME" = workflow_dispatch ]; then
            npm run test:in-if
          fi
          if [ -n "$X" ]; then npm run test:in-if-line; fi
          for suite in a b; do npm run test:in-loop; done
          [ -n "$RUN_PG" ] && echo pg && npm run test:after-check
          npm run build || npm run test:after-or
          ! npm run test:negated
          { npm run test:grouped; }
          npm run test:after-blocks
`;
  const { invoked, uncounted } = ciServerNpmInvocations(yaml);
  assert.deepEqual(
    [...invoked].sort(),
    ['test:after-blocks', 'test:and', 'test:counted', 'test:env-off', 'test:flag-off', 'test:grouped', 'test:redirect'],
    '&& · 파이프(pipefail) · 2>&1 · { } 묶음, 그리고 셸 블록이 닫힌 뒤의 명령은 실패가 그대로 드러난다',
  );
  assert.deepEqual(
    uncounted.map(({ job, script }) => `${job} ${script}`).sort(),
    [
      'allowed-to-fail test:job-coe',
      'dispatch-only test:dispatch-only',
      'dynamic ${{',
      'ignore-scripts test:env-ignore',
      'ignore-scripts-flag test',
      'shell-flow build',
      'shell-flow test:after-check',
      'shell-flow test:after-or',
      'shell-flow test:in-if',
      'shell-flow test:in-if-line',
      'shell-flow test:in-loop',
      'shell-flow test:negated',
      'shell-swallowed test:background',
      'shell-swallowed test:or-true',
      'steps-gated test:step-coe',
      'steps-gated test:step-if',
    ],
  );
  const why = Object.fromEntries(uncounted.map((u) => [u.script, u.why]));
  assert.match(why['test:dispatch-only'], /^if: github\.event_name == 'workflow_dispatch'/);
  assert.match(why['test:job-coe'], /continue-on-error/);
  assert.match(why['test:or-true'], /\|\|/);
  assert.match(why['test:background'], /&/);
  assert.match(why.test, /ignore-scripts/);
  assert.match(why['${{'], /실행 때/);
  assert.match(why['test:in-if'], /if · 반복/);
  assert.match(why['test:after-check'], /앞 명령의 결과/);
  assert.match(why['test:after-or'], /앞 명령의 결과/);
  assert.match(why['test:negated'], /!/);
});

// 잡은 needs 로 기다리는 잡이 건너뛰어지면 함께 건너뛰어진다. 기다리는 잡이 조건부면 이
// 잡도 조건부다 — continue-on-error 는 다르다(실패해도 기다리던 잡은 돈다).
test('CI 호출: needs 로 기다리는 잡이 조건부면 그 호출도 세지 않는다', () => {
  const yaml = `
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
`;
  const { invoked, uncounted } = ciServerNpmInvocations(yaml);
  assert.deepEqual([...invoked].sort(), ['test:after-build', 'test:after-coe']);
  assert.deepEqual(
    uncounted.map(({ script, why }) => [script, why.split(' — ')[0]]),
    [['test:after-gated', 'needs: gated'], ['test:chain', 'needs: after-gated']],
  );
  assert.match(uncounted[1].why, /needs: after-gated — needs: gated — if: github\.event_name/);
});

test('CI 호출: 알려진 조건 목록은 지금 ci.yml 의 무거운 잡 조건을 담는다', () => {
  assert.ok(
    ALWAYS_RUN_CONDITIONS.includes("github.ref != 'refs/heads/production.private' && github.event_name != 'schedule'"),
  );
});
