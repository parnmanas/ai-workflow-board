// test/helpers/registration-audit.mjs — 테스트 등록 완전성 감사. 티켓 5dc241d8, 6ad5989a.
//
// fs 를 건드리지 않는 순수 함수만 둔다. 감사 로직이 디스크에 직접 붙어 있으면
// "등록으로 세면 안 되는 것을 세고 있다" 같은 결함을 재현할 길이 없다 — 입력을
// 인자로 받아야 합성 fixture 로 우회 사례를 그대로 만들어 볼 수 있다.
//
// 핵심 개념은 **CI 에서의 도달 가능성** 이다. test/suites/ 에 파일이 있다는 사실도,
// package.json 스크립트에 경로가 적혀 있다는 사실도 그 자체로는 등록이 아니다. CI 가
// 부르는 진입점에서 출발해 실제로 실행되는 경로만 등록이다. 아니면 "등록된 것처럼
// 보이는데 CI 에서 한 번도 안 도는" 상태가 되어, 이 가드가 잡으려던 버그
// 클래스(티켓 0b4f089d)를 그대로 통과시킨다.
//
// 티켓 6ad5989a: 예전에는 사람이 쓰는 단독 스크립트(test:catalog-scope 처럼 node --test
// 를 직접 부르는 것)도 진입점으로 선언돼 있었다. CI 는 그 스크립트를 부르지 않는데
// 가드는 거기 적힌 파일을 "등록됨" 으로 셌다. 그래서 CI 에서 한 번도 돌지 않은 파일
// 셋이 가드를 통과했다. 이제 단독 스크립트는 사람이 쓰는 편의일 뿐이고 등록이 아니다.

import { suiteFromScriptCommand } from './suite-manifest.mjs';
import { shellCommands } from './shell-commands.mjs';

// CI(.github/workflows/ci.yml)가 apps/server 에서 부르는 npm 스크립트. 등록의 뿌리는
// 이것뿐이다 — test 는 server-tests 잡(sqlite), test:qa:pg 는 postgres-dialect-matrix 잡.
// 손으로 적는 목록이라 CI 와 어긋날 수 있으므로 test-registration-completeness 가
// ci.yml 을 읽어 대조한다(ci-workflow.mjs · compareCiEntries). 이 목록에 스크립트를
// 보태려면 ci.yml 이 그 스크립트를 main push 와 PR 마다, 실패하면 빨개지게 불러야 한다.
export const CI_ENTRY_SCRIPTS = ['test', 'test:qa:pg'];

// 일부러 CI 밖에 두는 테스트 파일과 그 사유. 사유가 빈 항목은 가드가 거부한다.
// 예외는 필요한 동안만 둔다: 그 파일이 CI 에 등록되거나 디스크에서 사라지면 가드가
// 낡은 예외로 신고하니, 등록하는 쪽이 이 줄을 함께 지운다.
export const CI_EXEMPT_TESTS = {
  'test/qa-flows/mention-audit-retry.test.mjs':
    '보드 제거(d51ee84d) 뒤 없어진 fixture(setupKanbanScene)를 import 해 로드부터 실패한다. '
    + '보드 없는 fixture 로 옮겨 매니페스트에 넣는 일은 티켓 0d5a2fb0 이 맡는다.',
};

// 러너(run-suite)와 이 가드가 아는 테스트 파일 자리 — test/ 바로 아래와 test/qa-flows/.
export const TEST_PATH_RE = /^test\/(?:qa-flows\/)?[A-Za-z0-9_.-]+\.test\.mjs$/;
export const DELEGATION_RE = /^npm run [A-Za-z0-9:_-]+$/;

// scripts 는 JSON.parse 결과라 Object.prototype 을 상속한다. `scripts['toString']`
// 같은 조회가 함수를 돌려주므로, 존재 여부는 반드시 자기 속성으로만 판정한다.
export function hasScript(scripts, name) {
  return Object.hasOwn(scripts, name);
}

// npm 은 스크립트를 sh -c 로 돌린다. 따옴표 · 주석 · 명령 구분자를 셸처럼 읽어야
// `echo test/x.test.mjs` 나 주석 안의 `npm run x` 를 실행으로 세지 않는다.
const commandsOf = (command) => shellCommands(String(command ?? ''));

// 다른 패키지(-w · --workspace · --prefix · -C)로 가는 npm 호출은 이 package.json 의
// 스크립트가 아니다.
const OTHER_PACKAGE_RE = /^(-w|--workspace|--prefix|-C)(=|$)/;

// 커맨드 안의 `npm run <script>` · `npm test` 위임 (`pretest` 의 `npm run build && ...` 처럼).
// 반환: [{ script, ifPresent }] — `--if-present` 는 스크립트가 없어도 실패하지 않는다.
function delegationsInCommand(command) {
  const out = [];
  for (const { words } of commandsOf(command)) {
    if (words[0] !== 'npm') continue;
    // `--` 뒤는 스크립트에 넘기는 인자다 — 거기 있는 -w 는 npm 옵션이 아니다.
    const args = words.slice(1, words.includes('--') ? words.indexOf('--') : words.length);
    if (args.some((w) => OTHER_PACKAGE_RE.test(w))) continue;
    const [verb, name] = args.filter((w) => !w.startsWith('-'));
    const ifPresent = args.includes('--if-present');
    if (verb === 'test') out.push({ script: 'test', ifPresent });
    else if (verb === 'run' && name) out.push({ script: name, ifPresent });
  }
  return out;
}

// 커맨드가 실제로 실행하는 테스트 경로 — `node --test …` 나 러너(`node test/run-suite.mjs …`)
// 에 인자로 준 것만. echo 나 주석에 적힌 경로는 실행이 아니다. `a || node --test x` 같은
// 조건부 실행이나 --test-name-pattern 같은 거르기는 따지지 않는다 — 지금 CI 에서 닿는
// 스크립트는 모두 매니페스트로 돈다(ci.yml 쪽은 ci-workflow.mjs 가 그런 것까지 본다).
function testPathsRunBy(command) {
  const out = [];
  for (const { words } of commandsOf(command)) {
    if (words[0] !== 'node' || !(words.includes('--test') || words.includes('test/run-suite.mjs'))) continue;
    for (const word of words) {
      if (TEST_PATH_RE.test(word)) out.push(word);
    }
  }
  return out;
}

// `npm run <name>` 은 pre<name> → <name> → post<name> 순으로 돈다. pre/post 자신에는
// 다시 pre/post 가 붙지 않으므로 한 겹만 펼친다(`npm test` 는 prepretest 를 돌리지 않는다).
function lifecycleNames(name, scripts) {
  return [`pre${name}`, name, `post${name}`].filter((n) => hasScript(scripts, n));
}

// 진입점에서 출발해 실제로 도는 스크립트 집합을 닫는다. 따라가는 간선은 두 종류다:
// 커맨드 안의 `npm run` · `npm test`, 그리고 그 스크립트가 도는 매니페스트의 `npm run` step.
// 후자가 있어야 `test` → (test.txt 의 npm run test:qa) → `test:qa` 중첩이 잡힌다.
// 이미 본 스크립트는 다시 펼치지 않는다 — 순환 위임에서도 끝난다.
export function resolveRunnableScripts({ scripts, manifests, entryScripts }) {
  const runnable = new Set();
  const queue = [...entryScripts];

  while (queue.length > 0) {
    const entry = queue.shift();
    for (const name of lifecycleNames(entry, scripts)) {
      if (runnable.has(name)) continue;
      runnable.add(name);

      const command = scripts[name];
      for (const { script } of delegationsInCommand(command)) queue.push(script);

      const suite = suiteFromScriptCommand(command);
      if (suite === null) continue;
      for (const step of manifests.get(suite) ?? []) {
        if (step.startsWith('npm run ')) queue.push(step.slice('npm run '.length));
      }
    }
  }
  return runnable;
}

// 도는 스크립트들이 실제로 여는 매니페스트 집합.
function suitesOf(scripts, scriptNames) {
  const suites = new Set();
  for (const name of scriptNames) {
    const suite = suiteFromScriptCommand(scripts[name]);
    if (suite !== null) suites.add(suite);
  }
  return suites;
}

// 스크립트들이 실행하는 테스트 경로 — 그 스크립트가 여는 매니페스트의 step 과, 커맨드가
// `node --test` · 러너에 직접 준 경로. 지금 CI 에서 닿는 스크립트는 모두 매니페스트를
// 쓰지만, 경로를 직접 주는 스크립트를 CI 매니페스트에서 `npm run` 으로 이어도 등록이다.
function testPathsOf(scripts, manifests, scriptNames) {
  const paths = new Set();
  for (const name of scriptNames) {
    for (const testPath of testPathsRunBy(scripts[name])) paths.add(testPath);
  }
  for (const suite of suitesOf(scripts, scriptNames)) {
    for (const step of manifests.get(suite) ?? []) {
      if (TEST_PATH_RE.test(step)) paths.add(step);
    }
  }
  return paths;
}

const sorted = (it) => [...it].sort();

// 입력 형태 — scripts 는 { 이름: 커맨드 }, manifests 는 Map<스위트, step 목록>,
// ciEntryScripts 는 CI 가 부르는 스크립트 이름, exemptions 는 { 경로: 사유 },
// diskTestPaths 는 test/ 아래 모든 *.test.mjs 의 "test/..." 경로(하위 디렉터리 포함)다.
export function auditRegistration({ scripts, manifests, ciEntryScripts, exemptions = {}, diskTestPaths }) {
  const onDisk = new Set(diskTestPaths.filter((p) => TEST_PATH_RE.test(p)));
  const exempt = new Map(Object.entries(exemptions));
  const runnableScripts = resolveRunnableScripts({ scripts, manifests, entryScripts: ciEntryScripts });
  const runnableSuites = suitesOf(scripts, runnableScripts);

  // 등록 = CI 가 실제로 실행하는 경로만. 여기가 이 감사의 핵심 판정이다.
  const registered = testPathsOf(scripts, manifests, runnableScripts);

  // 저장소가 이름으로 적은 모든 테스트 경로와 그 자리 — 도달 여부와 무관하다. 사람이 쓰는
  // 단독 스크립트나 편의 매니페스트가 없는 파일을 가리켜도 그 스크립트는 고장이다.
  const namedAt = new Map();
  const noteNamed = (testPath, where) => namedAt.set(testPath, [...(namedAt.get(testPath) ?? []), where]);
  for (const [script, command] of Object.entries(scripts)) {
    for (const { words } of commandsOf(command)) {
      for (const word of words) {
        if (TEST_PATH_RE.test(word)) noteNamed(word, `package.json ${script}`);
      }
    }
  }
  for (const [suite, steps] of manifests) {
    for (const step of steps) {
      if (TEST_PATH_RE.test(step)) noteNamed(step, `test/suites/${suite}.txt`);
    }
  }

  // 없는 스크립트로 가는 위임 — 그 step 은 CI 에서 "Missing script" 로 죽는다.
  const missingDelegations = [];
  for (const [script, command] of Object.entries(scripts)) {
    for (const { script: target, ifPresent } of delegationsInCommand(command)) {
      if (!ifPresent && !hasScript(scripts, target)) missingDelegations.push(`package.json ${script} → npm run ${target}`);
    }
  }
  for (const [suite, steps] of manifests) {
    for (const step of steps) {
      const target = step.startsWith('npm run ') ? step.slice('npm run '.length) : null;
      if (target !== null && !hasScript(scripts, target)) missingDelegations.push(`test/suites/${suite}.txt → ${step}`);
    }
  }

  const openedSuites = suitesOf(scripts, Object.keys(scripts));

  return {
    runnableScripts,
    runnableSuites,
    registered,
    // 디스크에 있는데 CI 가 실행하는 등록이 없다 — 티켓 0b4f089d 버그 클래스. 단독
    // 스크립트에만 적힌 파일도 여기 걸린다(티켓 6ad5989a).
    orphans: sorted([...onDisk].filter((p) => !registered.has(p) && !exempt.has(p))),
    // 러너도 이 가드도 모르는 자리(test/ 의 다른 하위 디렉터리)의 테스트 파일 — 매니페스트에
    // 적을 수도 없으니 한 번도 돌지 않는다.
    misplacedTests: sorted(diskTestPaths.filter((p) => !TEST_PATH_RE.test(p))),
    // 어딘가에 경로가 적혀 있는데 그 경로에 파일이 없다 — 오타·rename·삭제.
    dangling: sorted([...namedAt.keys()].filter((p) => !onDisk.has(p))),
    namedAt,
    missingDelegations: sorted(missingDelegations),
    // 어떤 스크립트도 --suite 로 열지 않는 매니페스트 — 아무도 읽지 않는 목록이다.
    // 사람용 단독 스크립트가 여는 목록(test-qa-fast)은 죽은 목록이 아니지만, 거기
    // 적힌 파일이 CI 에 등록돼 있지 않으면 orphans 에 걸린다.
    deadSuites: sorted([...manifests.keys()].filter((s) => !openedSuites.has(s))),
    // --suite 가 실재하지 않는 매니페스트를 가리킨다 — 그 스크립트는 실행 목록 없이 죽는다.
    brokenSuiteTargets: sorted(
      Object.entries(scripts)
        .map(([script, command]) => [script, suiteFromScriptCommand(command)])
        .filter(([, suite]) => suite !== null && !manifests.has(suite))
        .map(([script, suite]) => `${script} -> ${suite}`),
    ),
    // CI 진입점으로 선언됐는데 package.json 에 없는 스크립트 — 오타면 도달 계산이 조용히 빈다.
    missingEntryScripts: sorted(ciEntryScripts.filter((n) => !hasScript(scripts, n))),
    // 더는 필요 없는 예외 — 이미 CI 에 등록됐거나(registered) 파일이 없다(missing).
    staleExemptions: sorted(exempt.keys())
      .filter((p) => registered.has(p) || !onDisk.has(p))
      .map((p) => ({ path: p, problem: registered.has(p) ? 'registered' : 'missing' })),
    // 사유 없이 CI 밖에 둔 예외 — 왜 안 도는지 아무도 모르게 된다.
    exemptionsWithoutReason: sorted(
      [...exempt].filter(([, reason]) => typeof reason !== 'string' || reason.trim() === '').map(([p]) => p),
    ),
  };
}

// 손으로 적은 CI 진입점 목록과 ci.yml 이 실제로 부르는 것(ci-workflow.mjs 의
// ciServerNpmInvocations().invoked — 실패하면 CI 가 빨개지는 호출만)을 맞춰 본다.
//   notInvoked — 목록에는 있는데 CI 가 그렇게 부르지 않는다. 그 진입점으로만 닿는 파일이
//                "등록됨" 으로 보이면서 CI 에서는 안 돈다 — 티켓 6ad5989a 의 버그다.
//   undeclared — CI 가 그렇게 부르고 테스트를 도는데 목록에 없다. 그쪽으로만 닿는 파일이
//                고아로 잘못 신고된다(조용한 통과는 아니지만 목록이 CI 를 못 따라갔다).
//                테스트를 돌지 않는 스크립트(`npm run build -w server`)는 상관없다.
export function compareCiEntries({ declared, invoked, scripts, manifests }) {
  const runsTests = (name) => {
    const reach = resolveRunnableScripts({ scripts, manifests, entryScripts: [name] });
    return testPathsOf(scripts, manifests, reach).size > 0;
  };
  return {
    notInvoked: sorted(declared.filter((name) => !invoked.has(name))),
    undeclared: sorted([...invoked].filter((name) => !declared.includes(name) && runsTests(name))),
  };
}
