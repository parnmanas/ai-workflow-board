// test/helpers/registration-audit.mjs — 테스트 등록 완전성 감사. 티켓 5dc241d8.
//
// fs 를 건드리지 않는 순수 함수만 둔다. 감사 로직이 디스크에 직접 붙어 있으면
// "등록으로 세면 안 되는 것을 세고 있다" 같은 결함을 재현할 길이 없다 — 입력을
// 인자로 받아야 합성 fixture 로 우회 사례를 그대로 만들어 볼 수 있다.
//
// 핵심 개념은 **도달 가능성(runnable)** 이다. test/suites/ 에 파일이 있다는 사실
// 자체는 등록이 아니다. 어떤 npm 스크립트도 `--suite` 로 그 매니페스트를 부르지
// 않거나, 부르는 스크립트가 실제 진입점에서 도달되지 않으면 그 목록은 영영 돌지
// 않는다. 그런 파일에 테스트 경로를 적어 두면 "등록된 것처럼 보이는데 npm test /
// npm run test:qa 어디서도 안 도는" 상태가 되어, 이 가드가 잡으려던 버그
// 클래스(티켓 0b4f089d)를 그대로 통과시킨다. 그래서 참조 집합에는 도달 가능한
// 등록만 넣고, 도달 불가능한 매니페스트는 그 자체를 결함으로 신고한다.

import { suiteFromScriptCommand } from './suite-manifest.mjs';

// 이 저장소에서 테스트가 실제로 호출되는 지점. 도달 가능성 계산의 뿌리다.
//   - CI(.github/workflows/ci.yml)가 apps/server 에서 부르는 것: test, test:qa:pg
//   - test:qa:fast 는 사람이 쓰는 빠른 부분집합.
//   - 나머지는 러너를 거치지 않고 node --test 를 직접 부르는 단독 스크립트다.
//     `npm test` 에서 도달하지는 않지만 실존하는 진입점이라 함께 선언한다.
// 이 목록에 없는 스크립트가 어떤 매니페스트를 독점하고 있으면, 그 매니페스트는
// 아무도 돌리지 않는 목록이라는 뜻이다.
export const TEST_ENTRY_SCRIPTS = [
  'test',
  'test:qa:pg',
  'test:qa:fast',
  'test:catalog-scope',
  'test:auto-notice',
  'test:postgres-schema',
  'test:subtask-gate-contract',
  'test:mention-audit',
];

export const TEST_PATH_RE = /^test\/(?:qa-flows\/)?[A-Za-z0-9_.-]+\.test\.mjs$/;
export const DELEGATION_RE = /^npm run [A-Za-z0-9:_-]+$/;

// 스크립트 커맨드는 셸에서 돈다. 공백으로 쪼개고 감싼 따옴표 한 겹을 벗기면
// 남아 있는 bare test/*.mjs 경로를 집기에 충분하다.
export function tokenizeCommand(command) {
  return String(command ?? '')
    .split(/\s+/)
    .map((tok) => tok.replace(/^["']|["']$/g, ''));
}

// 커맨드 안의 `npm run <script>` 위임 (`pretest` 의 `npm run build && ...` 처럼).
function delegationsInCommand(command) {
  const tokens = tokenizeCommand(command);
  const out = [];
  for (let i = 0; i + 2 < tokens.length; i++) {
    if (tokens[i] === 'npm' && tokens[i + 1] === 'run' && tokens[i + 2]) out.push(tokens[i + 2]);
  }
  return out;
}

// scripts 는 JSON.parse 결과라 Object.prototype 을 상속한다. `scripts['toString']`
// 같은 조회가 함수를 돌려주므로, 존재 여부는 반드시 자기 속성으로만 판정한다.
export function hasScript(scripts, name) {
  return Object.hasOwn(scripts, name);
}

// `npm run <name>` 은 pre<name> → <name> → post<name> 순으로 돈다. pre/post 자신에는
// 다시 pre/post 가 붙지 않으므로 한 겹만 펼친다.
function lifecycleNames(name, scripts) {
  return [`pre${name}`, name, `post${name}`].filter((n) => hasScript(scripts, n));
}

// 진입점에서 출발해 실제로 도는 스크립트 집합을 닫는다. 따라가는 간선은 두 종류다:
// 커맨드 문자열 안의 `npm run`, 그리고 그 스크립트가 도는 매니페스트의 `npm run` step.
// 후자가 있어야 `test` → (test.txt 의 npm run test:qa) → `test:qa` 중첩이 잡힌다.
export function resolveRunnableScripts({ scripts, manifests, entryScripts }) {
  const runnable = new Set();
  const queue = [...entryScripts];

  while (queue.length > 0) {
    const entry = queue.shift();
    for (const name of lifecycleNames(entry, scripts)) {
      if (runnable.has(name)) continue;
      runnable.add(name);

      const command = scripts[name];
      for (const next of delegationsInCommand(command)) queue.push(next);

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
function suitesOf(scripts, runnableScripts) {
  const suites = new Set();
  for (const name of runnableScripts) {
    const suite = suiteFromScriptCommand(scripts[name]);
    if (suite !== null) suites.add(suite);
  }
  return suites;
}

const sorted = (it) => [...it].sort();

// 입력 형태 — scripts 는 { 이름: 커맨드 }, manifests 는 Map<스위트, step 목록>,
// diskTestPaths 는 "test/....test.mjs" 경로들이다.
export function auditRegistration({ scripts, manifests, entryScripts, diskTestPaths }) {
  const onDisk = new Set(diskTestPaths);
  const runnableScripts = resolveRunnableScripts({ scripts, manifests, entryScripts });

  const runnableSuites = suitesOf(scripts, runnableScripts);

  // 참조 집합 = 실제로 도는 등록만. 여기가 이 감사의 핵심 판정이다. 원천이 둘인
  // 이유는 아직 파일을 직접 나열하는 스크립트(test:catalog-scope 등)가 있어서다.
  const referenced = new Set();
  for (const name of runnableScripts) {
    for (const tok of tokenizeCommand(scripts[name])) {
      if (TEST_PATH_RE.test(tok)) referenced.add(tok);
    }
  }
  for (const suite of runnableSuites) {
    for (const step of manifests.get(suite) ?? []) {
      if (TEST_PATH_RE.test(step)) referenced.add(step);
    }
  }

  return {
    runnableScripts,
    runnableSuites,
    referenced,
    // 디스크에 있는데 도는 등록이 없다 — 티켓 0b4f089d 버그 클래스.
    orphans: sorted([...onDisk].filter((p) => !referenced.has(p))),
    // 등록은 있는데 그 경로에 파일이 없다 — 오타·rename·삭제.
    dangling: sorted([...referenced].filter((p) => !onDisk.has(p))),
    // 존재하지만 어떤 진입점에서도 도달되지 않는 매니페스트 — 여기 적은 등록은 안 돈다.
    unreachableSuites: sorted([...manifests.keys()].filter((s) => !runnableSuites.has(s))),
    // --suite 가 실재하지 않는 매니페스트를 가리킨다 — 그 스크립트는 실행 목록 없이 죽는다.
    brokenSuiteTargets: sorted(
      Object.entries(scripts)
        .map(([name, command]) => [name, suiteFromScriptCommand(command)])
        .filter(([, suite]) => suite !== null && !manifests.has(suite))
        .map(([name, suite]) => `${name} -> ${suite}`),
    ),
    // 진입점으로 선언됐는데 package.json 에 없는 스크립트 — 오타면 도달 계산이 조용히 빈다.
    missingEntryScripts: sorted(entryScripts.filter((n) => !hasScript(scripts, n))),
  };
}
