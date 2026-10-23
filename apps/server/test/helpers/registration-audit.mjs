// test/helpers/registration-audit.mjs — 테스트 등록 완전성 감사. 티켓 5dc241d8, 6ad5989a.
//
// fs 를 건드리지 않는 순수 함수만 둔다. 감사 로직이 디스크에 직접 붙어 있으면
// "등록으로 세면 안 되는 것을 세고 있다" 같은 결함을 재현할 길이 없다 — 입력을
// 인자로 받아야 합성 fixture 로 우회 사례를 그대로 만들어 볼 수 있다.
//
// 핵심 개념은 **CI 에서의 도달 가능성** 이다. test/suites/ 에 파일이 있다는 사실도,
// package.json 스크립트에 경로가 적혀 있다는 사실도 그 자체로는 등록이 아니다. CI 가
// 부르는 진입점에서 출발해 실제로 닿는 경로만 등록이다. 아니면 "등록된 것처럼
// 보이는데 CI 에서 한 번도 안 도는" 상태가 되어, 이 가드가 잡으려던 버그
// 클래스(티켓 0b4f089d)를 그대로 통과시킨다.
//
// 티켓 6ad5989a: 예전에는 사람이 쓰는 단독 스크립트(test:catalog-scope 처럼 node --test
// 를 직접 부르는 것)도 진입점으로 선언돼 있었다. CI 는 그 스크립트를 부르지 않는데
// 가드는 거기 적힌 파일을 "등록됨" 으로 셌다. 그래서 CI 에서 한 번도 돌지 않은 파일
// 셋이 가드를 통과했다. 이제 단독 스크립트는 사람이 쓰는 편의일 뿐이고 등록이 아니다.

import path from 'node:path';
import { suiteFromScriptCommand } from './suite-manifest.mjs';

// CI(.github/workflows/ci.yml)가 apps/server 에서 부르는 npm 스크립트. 등록의 뿌리는
// 이것뿐이다 — test 는 server-tests 잡(sqlite), test:qa:pg 는 postgres-dialect-matrix 잡.
// 손으로 적는 목록이라 CI 와 어긋날 수 있으므로 test-registration-completeness 가
// ci.yml 을 읽어 대조한다(compareCiEntries). 이 목록에 스크립트를 보태려면 ci.yml 이
// 그 스크립트를 실제로 불러야 한다.
export const CI_ENTRY_SCRIPTS = ['test', 'test:qa:pg'];

// 일부러 CI 밖에 두는 테스트 파일과 그 사유. 사유가 빈 항목은 가드가 거부한다.
// 예외는 필요한 동안만 둔다: 그 파일이 CI 에 등록되거나 디스크에서 사라지면 가드가
// 낡은 예외로 신고하니, 등록하는 쪽이 이 줄을 함께 지운다.
export const CI_EXEMPT_TESTS = {
  'test/qa-flows/mention-audit-retry.test.mjs':
    '보드 제거(d51ee84d) 뒤 없어진 fixture(setupKanbanScene)를 import 해 로드부터 실패한다. '
    + '보드 없는 fixture 로 옮겨 매니페스트에 넣는 일은 티켓 0d5a2fb0 이 맡는다.',
};

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
function suitesOf(scripts, scriptNames) {
  const suites = new Set();
  for (const name of scriptNames) {
    const suite = suiteFromScriptCommand(scripts[name]);
    if (suite !== null) suites.add(suite);
  }
  return suites;
}

// 스크립트들이 도는 테스트 경로 — 커맨드에 직접 적힌 것과, 그 스크립트가 여는
// 매니페스트의 step. 원천이 둘인 이유는 아직 파일을 직접 나열하는 스크립트가 있어서다.
function testPathsOf(scripts, manifests, scriptNames) {
  const paths = new Set();
  for (const name of scriptNames) {
    for (const tok of tokenizeCommand(scripts[name])) {
      if (TEST_PATH_RE.test(tok)) paths.add(tok);
    }
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
// diskTestPaths 는 "test/....test.mjs" 경로들이다.
export function auditRegistration({ scripts, manifests, ciEntryScripts, exemptions = {}, diskTestPaths }) {
  const onDisk = new Set(diskTestPaths);
  const exempt = new Map(Object.entries(exemptions));
  const runnableScripts = resolveRunnableScripts({ scripts, manifests, entryScripts: ciEntryScripts });
  const runnableSuites = suitesOf(scripts, runnableScripts);

  // 등록 = CI 가 실제로 도는 경로만. 여기가 이 감사의 핵심 판정이다.
  const registered = testPathsOf(scripts, manifests, runnableScripts);

  // 저장소가 이름으로 적은 모든 테스트 경로 — 도달 여부와 무관하다. 사람이 쓰는
  // 단독 스크립트나 편의 매니페스트가 없는 파일을 가리켜도 그 스크립트는 고장이다.
  const named = new Set();
  for (const command of Object.values(scripts)) {
    for (const tok of tokenizeCommand(command)) {
      if (TEST_PATH_RE.test(tok)) named.add(tok);
    }
  }
  for (const steps of manifests.values()) {
    for (const step of steps) {
      if (TEST_PATH_RE.test(step)) named.add(step);
    }
  }

  const openedSuites = suitesOf(scripts, Object.keys(scripts));

  return {
    runnableScripts,
    runnableSuites,
    registered,
    // 디스크에 있는데 CI 가 도는 등록이 없다 — 티켓 0b4f089d 버그 클래스. 단독
    // 스크립트에만 적힌 파일도 여기 걸린다(티켓 6ad5989a).
    orphans: sorted([...onDisk].filter((p) => !registered.has(p) && !exempt.has(p))),
    // 어딘가에 경로가 적혀 있는데 그 경로에 파일이 없다 — 오타·rename·삭제.
    dangling: sorted([...named].filter((p) => !onDisk.has(p))),
    // 어떤 스크립트도 --suite 로 열지 않는 매니페스트 — 아무도 읽지 않는 목록이다.
    // 사람용 단독 스크립트가 여는 목록(test-qa-fast)은 죽은 목록이 아니지만, 거기
    // 적힌 파일이 CI 에 등록돼 있지 않으면 orphans 에 걸린다.
    deadSuites: sorted([...manifests.keys()].filter((s) => !openedSuites.has(s))),
    // --suite 가 실재하지 않는 매니페스트를 가리킨다 — 그 스크립트는 실행 목록 없이 죽는다.
    brokenSuiteTargets: sorted(
      Object.entries(scripts)
        .map(([name, command]) => [name, suiteFromScriptCommand(command)])
        .filter(([, suite]) => suite !== null && !manifests.has(suite))
        .map(([name, suite]) => `${name} -> ${suite}`),
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

// ── ci.yml 대조 ─────────────────────────────────────────────────────────────
// CI_ENTRY_SCRIPTS 는 손으로 적는 목록이다. 적어 두기만 하면 티켓 6ad5989a 의 버그가
// 그대로 돌아온다 — 목록에는 있는데 CI 는 부르지 않는 진입점이 그 경로의 파일을
// "등록됨" 으로 만든다. 그래서 가드가 ci.yml 을 읽어 목록과 맞춰 본다.
//
// 워크플로 YAML 은 의존성 없이 들여쓰기로 읽는다(scripts/audit-ci-branch-coverage.mjs
// 와 같은 이유 — YAML 파서 의존성을 들이지 않는다). 읽는 것은 시퀀스 항목(step)의
// 스칼라 키 `run` · `working-directory` 뿐이다. 이 파서가 놓친 step 은 "CI 가 부르지
// 않음" 으로 보이므로, 워크플로 형식이 바뀌면 대조가 빨개지는 쪽으로만 틀린다.

const indentOf = (line) => line.length - line.trimStart().length;

// 평문 스칼라의 꼬리 주석과, 감싼 따옴표 한 겹을 벗긴다.
function scalarValue(text) {
  const t = text.trim();
  if (t.startsWith('"') || t.startsWith("'")) {
    const end = t.indexOf(t[0], 1);
    return end > 0 ? t.slice(1, end) : t.slice(1);
  }
  return t.replace(/(^|\s+)#.*$/, '');
}

// 워크플로의 모든 시퀀스 항목 가운데 `run` 키가 있는 것 — 곧 셸 step 이다.
// 반환: [{ run, 'working-directory'? }, ...] (그 항목의 바로 아래 스칼라 키만 담는다).
export function workflowRunSteps(yaml) {
  const lines = String(yaml ?? '').split(/\r?\n/);
  const items = [];
  const open = []; // 열린 시퀀스 항목 — { dash: '-' 의 열, keyCol: 키의 열, fields }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const indent = indentOf(line);

    let body = line.slice(indent);
    let keyCol = indent;
    const dash = body.match(/^-(?:\s+|$)/);
    if (dash) {
      while (open.length > 0 && open.at(-1).dash >= indent) open.pop();
      keyCol = indent + dash[0].length;
      const item = { dash: indent, keyCol, fields: {} };
      open.push(item);
      items.push(item.fields);
      body = body.slice(dash[0].length);
      if (body === '') continue;
    } else {
      while (open.length > 0 && open.at(-1).keyCol > indent) open.pop();
    }

    const kv = body.match(/^([A-Za-z0-9_-]+):(?:\s+(.*))?$/);
    if (!kv) continue;
    const [, key, rawValue = ''] = kv;

    let value;
    if (/^[|>][-+0-9]*$/.test(scalarValue(rawValue))) {
      // 블록 스칼라(`run: |`) — 키보다 깊이 들여쓴 줄과 빈 줄이 그 값이다.
      const block = [];
      while (i + 1 < lines.length && (lines[i + 1].trim() === '' || indentOf(lines[i + 1]) > keyCol)) {
        block.push(lines[++i].trim());
      }
      value = block.join('\n');
    } else {
      value = scalarValue(rawValue);
      // 여러 줄로 이어 쓴 평문 스칼라 — 더 깊이 들여쓴 다음 줄들은 같은 값이다.
      if (value !== '' && !/^["']/.test(rawValue.trim())) {
        while (i + 1 < lines.length && lines[i + 1].trim() !== '' && indentOf(lines[i + 1]) > keyCol) {
          value += ` ${lines[++i].trim()}`;
        }
      }
    }

    const owner = open.at(-1);
    if (owner && owner.keyCol === keyCol) owner.fields[key] = value;
  }
  return items.filter((fields) => Object.hasOwn(fields, 'run'));
}

// 저장소 루트 기준 상대 디렉터리를 한 모양으로 — './apps/server/' 와 'apps/server' 는 같다.
function normalizeDir(dir) {
  const normalized = path.posix.normalize(String(dir).replace(/\\/g, '/'));
  return normalized.length > 1 ? normalized.replace(/\/$/, '') : normalized;
}

const SERVER_DIR = 'apps/server';
// apps/server 의 npm workspace 이름. 루트에서 `npm run build -w server` 로 부른다.
const SERVER_WORKSPACES = new Set(['server', SERVER_DIR]);
const NPM_VALUE_FLAGS = new Set(['-w', '--workspace', '--prefix']);

// 단순 명령 하나가 `npm test` · `npm run <script>` 로 apps/server 의 스크립트를 부르면
// 그 이름을, 아니면 null 을 돌려준다. cwd 는 저장소 루트 기준 상대 경로다.
function serverNpmScript(tokens, cwd) {
  let at = 0;
  while (at < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[at])) at++; // FOO=1 npm …
  if (tokens[at] !== 'npm') return null;

  const workspaces = [];
  let prefix = null;
  const positional = [];
  for (let j = at + 1; j < tokens.length; j++) {
    const tok = tokens[j];
    if (tok === '--') break;
    const inline = tok.match(/^(-w|--workspace|--prefix)=(.*)$/);
    const flag = inline ? inline[1] : NPM_VALUE_FLAGS.has(tok) ? tok : null;
    if (flag !== null) {
      const value = inline ? inline[2] : tokens[++j];
      if (value === undefined) break;
      if (flag === '--prefix') prefix = value;
      else workspaces.push(value);
      continue;
    }
    if (!tok.startsWith('-')) positional.push(tok);
  }

  const [command, arg] = positional;
  let script = null;
  if (command === 'test') script = 'test';
  else if (command === 'run' && arg) script = arg;
  if (script === null) return null;

  if (workspaces.length > 0) {
    return workspaces.some((w) => SERVER_WORKSPACES.has(normalizeDir(w))) ? script : null;
  }
  const dir = prefix === null ? cwd : normalizeDir(path.posix.join(cwd, prefix));
  return dir === SERVER_DIR ? script : null;
}

// ci.yml 이 apps/server 에서 부르는 npm 스크립트 이름 집합. step 의 working-directory,
// 그 step 안의 `cd`, 그리고 루트에서 쓰는 `-w server` / `--prefix` 를 따라간다.
export function ciServerNpmScripts(yaml) {
  const invoked = new Set();
  for (const step of workflowRunSteps(yaml)) {
    let cwd = normalizeDir(step['working-directory'] ?? '.');
    const commands = String(step.run)
      .replace(/\\\r?\n/g, ' ')
      .split(/\r?\n|&&|\|\||;|\|/);
    for (const command of commands) {
      const tokens = tokenizeCommand(command).filter((tok) => tok !== '');
      if (tokens[0] === 'cd') {
        cwd = normalizeDir(path.posix.join(cwd, tokens[1] ?? '.'));
        continue;
      }
      const script = serverNpmScript(tokens, cwd);
      if (script !== null) invoked.add(script);
    }
  }
  return invoked;
}

// 손으로 적은 CI 진입점 목록과 ci.yml 이 실제로 부르는 것을 맞춰 본다.
//   notInvoked — 목록에는 있는데 ci.yml 이 부르지 않는다. 그 진입점으로만 닿는 파일이
//                "등록됨" 으로 보이면서 CI 에서는 안 돈다 — 티켓 6ad5989a 의 버그다.
//   undeclared — ci.yml 이 부르고 테스트를 도는데 목록에 없다. 그쪽으로만 닿는 파일이
//                고아로 잘못 신고된다(조용한 통과는 아니지만 목록이 CI 를 못 따라갔다).
//                테스트를 돌지 않는 스크립트(`npm run build -w server`)는 상관없다.
export function compareCiEntries({ declared, invoked, scripts, manifests }) {
  const runsTests = (name) => {
    const reach = resolveRunnableScripts({ scripts, manifests, entryScripts: [name] });
    return testPathsOf(scripts, manifests, reach).size > 0;
  };
  return {
    notInvoked: sorted(declared.filter((name) => !invoked.has(name))),
    undeclared: sorted(
      [...invoked].filter((name) => !declared.includes(name) && hasScript(scripts, name) && runsTests(name)),
    ),
  };
}
