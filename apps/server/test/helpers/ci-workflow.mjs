// test/helpers/ci-workflow.mjs — CI 워크플로가 apps/server 에서 부르는 npm 스크립트를
// 읽는다. 티켓 6ad5989a.
//
// 왜: 등록 감사의 뿌리(registration-audit.mjs 의 CI_ENTRY_SCRIPTS)는 손으로 적는 목록이다.
// 적어 두기만 하면 "목록에는 있는데 CI 는 부르지 않는" 진입점이 그 경로의 파일을 등록으로
// 만든다 — 티켓 6ad5989a 의 버그가 그것이었다. 그래서 가드가 이 모듈로 ci.yml 을 읽어
// 목록과 맞춰 본다.
//
// 세는 호출의 계약은 좁다: **명령 하나뿐인 step**(`npm test`, `npm run <script>`, 아는 옵션만)이
// main push 마다 도는 잡에 있어야 한다. 셸을 해석해 "이 호출의 실패가 CI 를 빨갛게
// 하는가" 를 따지지 않는다 — GitHub 의 기본 셸은 `bash -e`(pipefail 없음)라 파이프 ·
// 끝이 아닌 && · || · 서브셸 · here-doc · set +e 가 저마다 실패를 덮고, 그것을 하나씩
// 흉내 내다 틀린 만큼 가드가 조용히 초록이 된다. 명령이 하나뿐이면 보통 셸(bash · sh · pwsh ·
// powershell · cmd)에서는 그 종료 코드가 step 의 결과다. 실패 때 할 일(로그 덤프 등)은
// `if: failure()` step 으로 둔다.
//
// 부르기는 하지만 세지 않는 호출은 이유와 함께 따로 돌려준다:
//   - step 의 run 이 그 명령 하나가 아니다(다른 줄 · 파이프 · && · || · & · if · here-doc …),
//     npm 앞에 다른 명령(timeout · env …)이 있다, 스크립트에 인자를 넘긴다
//   - 모르는 npm 옵션(--if-present · --ignore-scripts 와 그 줄임 · --script-shell …)이나
//     npm · 셸 설정을 바꾸는 환경 변수(npm_config_* · BASH_ENV) — 명령 앞 대입, step · 잡 ·
//     워크플로 env, 앞 step 이 GITHUB_ENV 나 `npm config set` 으로 남긴 것
//   - 보통 셸이 아닌 shell:
//   - 알려진 모양이 아닌 job · step `if:` (식을 계산하지 못한다 — ALWAYS_RUN_CONDITIONS),
//     또는 needs 로 기다리는 잡의 그런 if:
//   - `continue-on-error`
//   - 실행 때 정하는 스크립트 이름(`npm run ${{ matrix.suite }}`)
//   - 워크플로가 main push 에 걸려 있지 않다(push 트리거 · branches 패턴 · paths · tags 필터)
//   - 위 판단에 쓰는 필드를 읽지 못했다(흐름 맵 · 모르는 별칭 · 태그 · 앵커를 붙인 키 · 병합 키
//     같은 모양) — 거기 실린 게이트를 놓치지 않으려고 못 읽으면 세지 않는 쪽으로 정한다
// 맞는 호출을 못 세면 대조가 빨개지고, 메시지가 무엇을 못 읽었는지 알려 준다. 이 모듈이 보지
// 못하는 것: 저장소 밖의 npm 설정(러너의 ~/.npmrc — 저장소의 .npmrc 는 npmrcProblems 가 본다),
// 잡의 env 를 바꿔 테스트가 스스로 skip 하게 하는 것처럼 YAML · 셸 밖에서 테스트를 무력하게
// 만드는 변경.
//
// 의존성 없이 읽는다(scripts/audit-ci-branch-coverage.mjs 와 같은 이유 — YAML 파서 의존성을
// 들이지 않는다).

import path from 'node:path';
import { shellCommands } from './shell-commands.mjs';

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ── YAML 부분집합 ──────────────────────────────────────────────────────────
// 블록 맵 · 블록 시퀀스 · 평문(여러 줄) · 따옴표 · 블록(| 와 >) 스칼라, 주석, 앵커 · 별칭을
// 읽는다. 병합 키(`<<`)는 펼치지 않고 보통 키로 둔다(YAML 1.2 와 js-yaml 이 그렇다 — 아래 CI
// 읽기는 `<<` 가 있는 노드를 못 읽은 것으로 다룬다). 스칼라는 전부 문자열이다(true · 22 도
// 'true' · '22'). 단순한
// 흐름 시퀀스([a, b])는 배열로 읽는다 — `needs: [build, test]` 를 따라가야 한다. 그 밖의
// 흐름 컬렉션({a: b} · 중첩 · 중간에 주석이 낀 여러 줄)과 태그는 원문 문자열로 남는다 —
// 아래 CI 읽기는 게이트 필드에서 그런 문자열을 "읽지 못함" 으로 다룬다.

const indentOf = (line) => line.length - line.trimStart().length;
const isNoise = (line) => /^\s*(#.*)?$/.test(line) || /^(---|\.\.\.)\s*$/.test(line);
const DASH_RE = /^-(?:\s|$)/;
const KEY_RE = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|(<<|[A-Za-z0-9_$][\w$./-]*))[ \t]*:(?:[ \t]+|$)/;
const BLOCK_HEADER_RE = /^([|>])([+-]?)([1-9]?)([+-]?)[ \t]*(?:#.*)?$/;
const ANCHOR_RE = /^&([^\s,[\]{}]+)(?:[ \t]+|$)/;
const ALIAS_RE = /^\*([^\s,[\]{}]+)[ \t]*(?:#.*)?$/;

const DOUBLE_ESCAPES = { n: '\n', t: '\t', r: '\r', 0: '\0' };
const unescapeDouble = (text) => text.replace(/\\(.)/g, (_, ch) => DOUBLE_ESCAPES[ch] ?? ch);

// 평문 스칼라의 꼬리 주석. YAML 에서 # 는 맨 앞이거나 공백 뒤에 올 때만 주석이다.
function splitPlainComment(text) {
  const at = text.search(/(^|[ \t])#/);
  return at === -1 ? { value: text.trim(), comment: false } : { value: text.slice(0, at).trim(), comment: true };
}

// 단순한 흐름 시퀀스 `[a, b, 'c']`. 중첩되거나 맵이 섞이면 원문 그대로 둔다.
function flowSequence(value) {
  const inner = /^\[([^[\]{}]*)\]$/.exec(value);
  if (!inner) return value;
  return inner[1]
    .split(',')
    .map((item) => item.trim().replace(/^(['"])(.*)\1$/, '$2'))
    .filter((item) => item !== '');
}

// 맵 안에서 키로 읽지 못한 줄(앵커 · 태그 · `?` 를 붙인 키 등)이 있었다는 표시. 그 줄이 게이트
// 키(if: false 같은)였을 수 있으니, 읽는 쪽은 이 표시가 있는 맵을 못 읽은 것으로 다룬다.
export const UNREADABLE_KEY = '\u0000못 읽은 키';

// `__proto__` 같은 키가 프로토타입을 바꾸지 않게 정의로 넣는다.
function put(map, key, value) {
  Object.defineProperty(map, key, { value, enumerable: true, writable: true, configurable: true });
}

export function parseWorkflowYaml(text) {
  // 파일 맨 앞의 BOM 은 내용이 아니다(js-yaml 도 걷어 낸다).
  const lines = String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const anchors = new Map();
  let i = 0; // 다음에 읽을 줄

  const skipNoise = () => {
    while (i < lines.length && isNoise(lines[i])) i++;
  };
  // 앞의 노드가 다 읽지 못하고 남긴 더 깊은 줄 — 건너뛰어야 바깥 루프가 나아간다.
  const skipDeeperThan = (indent) => {
    for (skipNoise(); i < lines.length && indentOf(lines[i]) > indent; skipNoise()) i++;
  };

  function node(minIndent) {
    skipNoise();
    if (i >= lines.length) return null;
    const indent = indentOf(lines[i]);
    if (indent < minIndent) return null;
    const body = lines[i].slice(indent);
    if (DASH_RE.test(body)) return sequence(indent);
    if (KEY_RE.test(body)) return mapping(indent, body);
    return scalarValue(body, indent - 1);
  }

  function sequence(indent) {
    const items = [];
    for (skipNoise(); i < lines.length && indentOf(lines[i]) === indent; skipNoise()) {
      const body = lines[i].slice(indent);
      if (!DASH_RE.test(body)) break;
      const content = body.slice(1).trimStart();
      // `- &a key: v` 의 맵은 앵커가 시작하는 열에 있다 — 다음 키도 그 열에 온다.
      const col = indent + body.length - content.length;
      const anchor = ANCHOR_RE.exec(content);
      const rest = anchor ? content.slice(anchor[0].length).trimStart() : content;
      let item;
      if (rest === '' || rest.startsWith('#')) {
        i++;
        item = node(indent + 1);
      } else if (KEY_RE.test(rest)) {
        item = mapping(col, rest);
      } else {
        item = scalarValue(rest, indent);
      }
      if (anchor) anchors.set(anchor[1], item);
      items.push(item);
      skipDeeperThan(indent);
    }
    return items;
  }

  // col 은 키의 열이다. 첫 항목이 시퀀스의 `- ` 뒤에 붙어 있으면 firstBody 가 그 글이다.
  function mapping(col, firstBody) {
    const map = {};
    let body = firstBody;
    for (;;) {
      const key = KEY_RE.exec(body);
      if (key) {
        const name = key[1] !== undefined ? unescapeDouble(key[1]) : key[2] !== undefined ? key[2].replace(/''/g, "'") : key[3];
        put(map, name, value(body.slice(key[0].length), col));
      } else {
        put(map, UNREADABLE_KEY, true);
        i++;
      }
      skipDeeperThan(col);
      if (i >= lines.length || indentOf(lines[i]) !== col) break;
      body = lines[i].slice(col);
      if (DASH_RE.test(body)) break; // 같은 열의 `-` 는 바깥 시퀀스의 다음 항목이다
    }
    return map;
  }

  function value(rest, col) {
    let text = rest.trim();
    const anchor = ANCHOR_RE.exec(text);
    if (anchor) text = text.slice(anchor[0].length).trim();
    const result = text === '' || text.startsWith('#') ? nested(col) : scalarValue(text, col);
    if (anchor) anchors.set(anchor[1], result);
    return result;
  }

  // `key:` 뒤가 비었다 — 값은 다음 줄부터의 더 깊은 노드이거나, 같은 열에서 시작하는 시퀀스다.
  function nested(col) {
    i++;
    skipNoise();
    if (i >= lines.length) return null;
    const indent = indentOf(lines[i]);
    if (indent > col) return node(col + 1);
    if (indent === col && DASH_RE.test(lines[i].slice(indent))) return sequence(col);
    return null;
  }

  function scalarValue(text, parentIndent) {
    const alias = ALIAS_RE.exec(text);
    if (alias) {
      i++;
      // 모르는 별칭은 원문으로 남는다 — 읽는 쪽이 못 읽은 값으로 다룬다.
      return anchors.has(alias[1]) ? anchors.get(alias[1]) : `*${alias[1]}`;
    }
    const header = BLOCK_HEADER_RE.exec(text);
    if (header) return block(header, parentIndent);
    if (text[0] === '"' || text[0] === "'") return quoted(text);
    return flowSequence(plain(text, parentIndent));
  }

  // 평문. parentIndent 보다 깊은 다음 줄들은 공백으로, 사이의 빈 줄은 줄바꿈으로 접혀 같은
  // 값이 된다. 주석이 나오면 그 스칼라는 거기서 끝난다.
  function plain(text, parentIndent) {
    let { value: out, comment } = splitPlainComment(text);
    i++;
    while (!comment) {
      let j = i;
      while (j < lines.length && lines[j].trim() === '') j++;
      if (j >= lines.length || indentOf(lines[j]) <= parentIndent || lines[j].trim().startsWith('#')) break;
      const part = splitPlainComment(lines[j].trim());
      out += j > i ? '\n'.repeat(j - i) + part.value : ` ${part.value}`;
      comment = part.comment;
      i = j + 1;
    }
    return out;
  }

  // 따옴표. 닫는 따옴표가 다음 줄에 있으면 줄바꿈을 공백으로 접어 잇는다.
  function quoted(text) {
    const q = text[0];
    let buf = text.slice(1);
    let out = '';
    for (;;) {
      for (let k = 0; k < buf.length; k++) {
        const c = buf[k];
        if (q === '"' && c === '\\' && k + 1 < buf.length) {
          out += unescapeDouble(buf.slice(k, k + 2));
          k++;
        } else if (c === q && q === "'" && buf[k + 1] === "'") {
          out += "'";
          k++;
        } else if (c === q) {
          i++;
          return out;
        } else {
          out += c;
        }
      }
      i++;
      if (i >= lines.length) return out;
      out += ' ';
      buf = lines[i].trim();
    }
  }

  // 블록. `|` 는 줄을 그대로 두고, `>` 는 이어진 보통 줄을 공백 하나로 접는다(빈 줄과 더
  // 깊이 들여쓴 줄 앞뒤의 줄바꿈은 남는다). `run: >` 의 두 줄은 명령 하나다.
  function block(header, parentIndent) {
    i++;
    const raw = [];
    while (i < lines.length && (lines[i].trim() === '' || indentOf(lines[i]) > parentIndent)) raw.push(lines[i++]);
    while (raw.length > 0 && raw.at(-1).trim() === '') raw.pop();
    if (raw.length === 0) return '';

    const explicit = Number(header[3] || 0);
    const base = explicit > 0 ? parentIndent + explicit : indentOf(raw.find((line) => line.trim() !== ''));
    const content = raw.map((line) => (line.trim() === '' ? '' : line.slice(Math.min(base, indentOf(line)))));
    if (header[1] === '|') return content.join('\n');

    // 접기: 보통 줄 둘 사이의 줄바꿈 하나는 공백이 되고, 사이에 빈 줄이 있으면 그 수만큼의
    // 줄바꿈만 남는다. 더 깊이 들여쓴 줄의 앞뒤 줄바꿈은 접지 않는다.
    let out = '';
    let previous = null; // 앞의 비지 않은 줄이 'normal' 인가 'more' 인가
    let empties = 0;
    raw.forEach((line, k) => {
      if (line.trim() === '') {
        empties++;
        return;
      }
      const kind = indentOf(line) > base ? 'more' : 'normal';
      if (previous === null) out = '\n'.repeat(empties);
      else if (previous === 'normal' && kind === 'normal') out += empties > 0 ? '\n'.repeat(empties) : ' ';
      else out += '\n'.repeat(empties + 1);
      out += content[k];
      previous = kind;
      empties = 0;
    });
    return out;
  }

  return node(0);
}


// ── CI 가 apps/server 에서 부르는 npm 스크립트 ─────────────────────────────

// job · step `if:` 가운데 "main push 마다 돈다" 로 받는 모양. 식을 계산하지 못하므로 아는
// 모양만 받는다. CI 진입점을 부르는 잡 · step 의 조건을 바꾸면, 그 잡이 여전히 main push 와
// PR 마다 도는지 확인하고 여기에 보탠다(${{ }} 와 공백은 비교 전에 걷어 낸다).
export const ALWAYS_RUN_CONDITIONS = [
  // ci.yml 의 무거운 잡들 — 배포 브랜치 push 와 정기 실행(schedule)만 뺀다.
  "github.ref != 'refs/heads/production.private' && github.event_name != 'schedule'",
  'true',
  'success()',
  'always()',
  '!cancelled()',
];
// needs 로 기다리는 잡이 건너뛰어져도 도는 조건. 상태 함수가 없거나 success() 면 GitHub 가
// 건너뛴 needs 뒤의 잡도 건너뛴다.
const RUNS_AFTER_SKIPPED_NEEDS = new Set(['always()', '!cancelled()']);

function normalizeCondition(condition) {
  const text = String(condition).trim();
  const wrapped = /^\$\{\{([\s\S]*)\}\}$/.exec(text);
  return (wrapped ? wrapped[1] : text).replace(/\s+/g, ' ').trim();
}

const absent = (v) => v === undefined || v === null;
// 맵이면서, 키로 읽지 못한 줄이나 펼치지 않은 병합 키가 없다.
const readableMap = (v) => isMap(v) && !Object.hasOwn(v, UNREADABLE_KEY) && !Object.hasOwn(v, '<<');
const unread = (field) => `${field} 를 읽지 못했다(흐름 맵 · 모르는 별칭 · 태그 · 앵커를 붙인 키 · 병합 키 같은 `
  + '모양) — 거기 게이트가 실려 있을 수 있어 세지 않는다. 블록 맵 · 시퀀스로 적으면 읽는다';

function conditionGate(node) {
  if (absent(node.if)) return null;
  if (typeof node.if !== 'string') return unread('if');
  const condition = normalizeCondition(node.if);
  return ALWAYS_RUN_CONDITIONS.includes(condition)
    ? null
    : `if: ${condition} — main push 마다 도는지 알 수 없다(ALWAYS_RUN_CONDITIONS)`;
}

// npm 은 npm_config_* 환경 변수(대소문자 · - 와 _ 를 가리지 않는다)와 .npmrc 를 설정으로 읽는다.
// 스크립트를 도는 방식과 무관하다고 아는 설정(레지스트리 · 인증 · 출력 · 설치 정책) 말고는 바꾸는
// 것으로 본다 — ignore_scripts 는 pre/post 스위트를 빼고, script_shell 은 스크립트를 아무것도 안
// 하는 셸로 돌릴 수 있고, userconfig 는 그런 설정이 든 다른 파일을 읽힌다. BASH_ENV 는 bash 가
// step 스크립트보다 먼저 읽는다.
const HARMLESS_NPM_CONFIG = new Set([
  'loglevel', 'color', 'progress', 'fund', 'audit', 'audit_level', 'update_notifier', 'cache',
  'registry', 'strict_ssl', 'ca', 'cafile', 'always_auth', 'prefer_offline', 'prefer_online',
  'engine_strict', 'legacy_peer_deps', 'save_exact', 'save_prefix', 'package_lock',
]);
function envProblem(name, value) {
  const key = String(name).toLowerCase().replace(/-/g, '_');
  if (key === 'bash_env') return name;
  if (!key.startsWith('npm_config_')) return null;
  const option = key.slice('npm_config_'.length);
  // `//registry.example/:_authToken` · `@scope:registry` — 레지스트리별 인증 · 주소다.
  if (HARMLESS_NPM_CONFIG.has(option) || option.startsWith('//') || option.startsWith('@')) return null;
  if (option === 'ignore_scripts' && /^\s*(false|0)?\s*$/i.test(String(value ?? ''))) return null;
  return name;
}
const configGate = (what) => `${what} — npm · 셸이 스크립트를 도는 방식을 바꿀 수 있다`;

function envGate(env) {
  if (absent(env)) return null;
  if (!readableMap(env)) return unread('env');
  for (const [name, value] of Object.entries(env)) {
    if (envProblem(name, value) !== null) return configGate(`env 의 ${name}`);
  }
  return null;
}

// 보통 셸이 아닌 shell: — 사용자 템플릿(`true {0}` 같은)은 그 명령의 종료 코드를 버릴 수 있다.
const PLAIN_SHELLS = new Set(['bash', 'sh', 'pwsh', 'powershell', 'cmd']);
function shellGate(shell) {
  if (absent(shell)) return null;
  if (typeof shell !== 'string') return unread('shell');
  return PLAIN_SHELLS.has(shell.trim()) ? null : `shell: ${shell.trim()} — 보통 셸(bash · sh · pwsh · powershell · cmd)이 아니다`;
}

// defaults.run 의 working-directory · shell — 없으면 { dir: null, gate: null }.
function runDefaults(node) {
  if (absent(node.defaults)) return { dir: null, gate: null };
  if (!readableMap(node.defaults)) return { dir: null, gate: unread('defaults') };
  const run = node.defaults.run;
  if (absent(run)) return { dir: null, gate: null };
  if (!readableMap(run)) return { dir: null, gate: unread('defaults.run') };
  const dir = run['working-directory'];
  if (!absent(dir) && typeof dir !== 'string') return { dir: null, gate: unread('defaults.run.working-directory') };
  return { dir: absent(dir) ? null : dir, gate: shellGate(run.shell) };
}

// 잡 · step(그리고 워크플로) 자신이 그 안의 호출을 세지 못하게 하는 이유. 없으면 null.
function gateOf(node) {
  if (!readableMap(node)) return unread('키');
  const continueOnError = node['continue-on-error'];
  const coe = absent(continueOnError)
    ? null
    : typeof continueOnError !== 'string'
      ? unread('continue-on-error')
      : continueOnError.trim().toLowerCase() === 'false'
        ? null
        : 'continue-on-error — 실패해도 CI 가 빨개지지 않는다';
  return conditionGate(node) ?? coe ?? envGate(node.env) ?? shellGate(node.shell) ?? runDefaults(node).gate;
}

// 잡은 needs 로 기다리는 잡이 건너뛰어지면 함께 건너뛰어진다. 그래서 기다리는 잡의 if: 도
// 이 잡의 조건이다(needs 를 따라 끝까지). 기다리는 잡의 continue-on-error 는 상관없다 —
// 실패해도 그 잡은 성공으로 끝나 이 잡이 돈다. 순환은 GitHub 가 거부하지만 여기서도 멈춘다.
function needsGate(jobs, id, seen = new Set()) {
  if (seen.has(id)) return null;
  seen.add(id);
  const spec = jobs[id];
  if (absent(spec.needs)) return null;
  const needs = typeof spec.needs === 'string' ? [spec.needs] : Array.isArray(spec.needs) ? spec.needs : null;
  if (needs === null || needs.some((need) => typeof need !== 'string' || !Object.hasOwn(jobs, need) || !isMap(jobs[need]))) {
    return unread('needs');
  }
  if (typeof spec.if === 'string' && RUNS_AFTER_SKIPPED_NEEDS.has(normalizeCondition(spec.if))) return null;
  for (const need of needs) {
    const gate = conditionGate(jobs[need]) ?? needsGate(jobs, need, seen);
    if (gate !== null) return `needs: ${need} — ${gate}`;
  }
  return null;
}

// GitHub 필터 패턴이 main 을 고르는가. *, **, ? 만 읽는다 — 그 밖의 문법([] · + · {})이면 null.
// main 에는 / 가 없으니 * 와 ** 의 차이(/ 를 넘는가)는 여기서 상관없다.
function patternMatchesMain(pattern) {
  if (typeof pattern !== 'string' || /[[\]{}+]/.test(pattern)) return null;
  const source = pattern
    .replace(/[.^$()|\\]/g, '\\$&')
    .replace(/\*+|\?/g, (glob) => (glob === '?' ? '.' : '.*'));
  return new RegExp(`^${source}$`).test('main');
}

const unreadTrigger = (field) => `${field} 를 읽지 못했다 — 워크플로가 main push 에 도는지 판단하지 않는다`;

// 워크플로가 main push 에 걸려 있는가 — 아니면 거기 있는 호출은 main 에 들어갈 때 돌지 않는다.
// GitHub 규칙: branches 는 차례대로 보고 마지막으로 맞은 패턴이 정한다(! 는 뺀다). branches
// (-ignore) 없이 tags(-ignore) 만 있으면 브랜치 push 에는 돌지 않는다.
function triggerGate(on) {
  const events = typeof on === 'string' && /^\w+$/.test(on) ? [on] : Array.isArray(on) ? on : readableMap(on) ? Object.keys(on) : null;
  if (events === null) return unreadTrigger('on');
  if (!events.includes('push')) return 'on: 에 push 가 없다 — main 에 들어갈 때 돌지 않는다';
  const push = isMap(on) ? on.push : null;
  if (absent(push)) return null;
  if (!readableMap(push)) return unreadTrigger('on.push');
  if (!absent(push.paths) || !absent(push['paths-ignore'])) {
    return 'on.push 에 paths 필터가 있다 — 서버를 바꾼 push 에도 돌지 않을 수 있다';
  }
  const list = (v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v : null);
  if (!absent(push.branches)) {
    const branches = list(push.branches);
    if (branches === null) return unreadTrigger('on.push.branches');
    let picked = false;
    for (const pattern of branches) {
      const negated = typeof pattern === 'string' && pattern.startsWith('!');
      const match = patternMatchesMain(negated ? pattern.slice(1) : pattern);
      if (match === null) return unreadTrigger('on.push.branches');
      if (match) picked = !negated;
    }
    if (!picked) return 'on.push.branches 가 main 을 고르지 않는다';
  }
  if (!absent(push['branches-ignore'])) {
    const ignored = list(push['branches-ignore']);
    if (ignored === null) return unreadTrigger('on.push.branches-ignore');
    for (const pattern of ignored) {
      const match = patternMatchesMain(pattern);
      if (match === null) return unreadTrigger('on.push.branches-ignore');
      if (match) return 'on.push.branches-ignore 가 main 을 뺀다';
    }
  }
  if (absent(push.branches) && absent(push['branches-ignore']) && (!absent(push.tags) || !absent(push['tags-ignore']))) {
    return 'on.push 에 tags 필터만 있다 — 브랜치 push 에는 돌지 않는다';
  }
  return null;
}

// 저장소 루트 기준 상대 디렉터리를 한 모양으로 — './apps/server/', 'apps/server',
// '${{ github.workspace }}/apps/server' 는 같다. working-directory 는 ${{ }} 만 풀린다 —
// `$GITHUB_WORKSPACE` 는 셸이 푸는 것이라 `cd` 대상에서만 같은 뜻이다(joinDir).
const WORKSPACE_EXPR_RE = /^\$\{\{\s*github\.workspace\s*\}\}(?:\/|$)/;
const WORKSPACE_ENV_RE = /^\$\{?GITHUB_WORKSPACE\}?(?:\/|$)/;
function normalizeDir(dir) {
  const relative = String(dir).replace(/\\/g, '/').replace(WORKSPACE_EXPR_RE, '');
  const normalized = path.posix.normalize(relative === '' ? '.' : relative);
  return normalized.length > 1 ? normalized.replace(/\/$/, '') : normalized;
}
function joinDir(cwd, target) {
  if (WORKSPACE_ENV_RE.test(target)) return normalizeDir(target.replace(WORKSPACE_ENV_RE, ''));
  if (WORKSPACE_EXPR_RE.test(target)) return normalizeDir(target);
  return normalizeDir(path.posix.join(cwd, target));
}

const SERVER_DIR = 'apps/server';
// apps/server 의 npm workspace 이름. 루트에서 `npm run build -w server` 로 부른다.
const SERVER_WORKSPACES = new Set(['server', SERVER_DIR]);
// 세어도 되는 npm 옵션 — 값을 받는 것과 받지 않는 것. 이 밖의 옵션은 스크립트가 도는 방식을
// 바꿀 수 있다고 본다(--if-present 는 스크립트가 없어도 0 으로 끝나고, npm 은 옵션 이름의
// 줄임 `--ignore-script` 도 받아들인다).
const NPM_VALUE_FLAGS = new Set(['-w', '--workspace', '--prefix', '-C', '--loglevel']);
const NPM_PLAIN_FLAGS = new Set(['--silent', '-s', '--quiet', '-q', '--color', '--no-color']);

// 단순 명령 하나가 `npm test` · `npm run <script>` 로 apps/server 의 스크립트를 부르면
// { script, problem } 을, 아니면 null 을 돌려준다. problem 은 그 호출을 세지 못하는 이유다
// (없으면 null). cwd 는 저장소 루트 기준이다.
function serverNpmCall(words, cwd) {
  let at = 0;
  let problem = null;
  for (; at < words.length && /^[A-Za-z_][\w-]*=/.test(words[at]); at++) {
    const [name, ...value] = words[at].split('=');
    if (envProblem(name, value.join('=')) !== null) problem ??= configGate(`명령 앞의 ${name}=`);
  }
  if (words[at] !== 'npm') {
    problem = 'npm 앞에 다른 명령(timeout · time · env …)이 있다 — 그 명령이 npm 의 종료 코드를 그대로 '
      + '넘기는지 가드는 모른다. 시간 제한은 `timeout-minutes:`, 환경 변수는 step `env:` 로 둔다';
    at = words.indexOf('npm', at);
    if (at === -1) return null;
  }

  const workspaces = [];
  let prefix = null;
  const positional = [];
  let passesArgs = false;
  for (let j = at + 1; j < words.length; j++) {
    const word = words[j];
    if (word === '--') {
      passesArgs = j + 1 < words.length;
      break;
    }
    const inline = /^(--?[\w-]+)=(.*)$/.exec(word);
    const flag = inline ? inline[1] : word;
    if (NPM_VALUE_FLAGS.has(flag)) {
      const value = inline ? inline[2] : words[++j];
      if (value === undefined) break;
      if (flag === '--prefix' || flag === '-C') prefix = value;
      else if (flag === '-w' || flag === '--workspace') workspaces.push(value);
    } else if (flag === '--ignore-scripts' && inline && /^(false|0)$/i.test(inline[2])) {
      // 명시적으로 끈 것은 괜찮다.
    } else if (word.startsWith('-')) {
      if (!NPM_PLAIN_FLAGS.has(word)) problem ??= configGate(`npm 옵션 ${word}`);
    } else {
      positional.push(word);
    }
  }

  const [command, name, ...extra] = positional;
  const script = command === 'test' ? 'test' : command === 'run' ? name : undefined;
  if (script === undefined) return null;
  if (command === 'test' && name !== undefined) extra.unshift(name);
  if (extra.length > 0 || passesArgs) {
    problem ??= '스크립트에 인자를 넘긴다 — 무엇이 도는지 바뀔 수 있다. 인자가 필요하면 그 인자를 담은 '
      + 'package.json 스크립트를 따로 둔다';
  }

  const inServer = workspaces.length > 0
    ? workspaces.some((w) => SERVER_WORKSPACES.has(normalizeDir(w)))
    : (prefix === null ? cwd : joinDir(cwd, prefix)) === SERVER_DIR;
  return inServer ? { script, problem } : null;
}

const NOT_ALONE = 'step 의 run 이 이 명령 하나가 아니다 — 다른 줄이 하나라도 있으면(set -euo pipefail · '
  + 'echo ::group:: 도) 세지 않는다. 기본 셸(bash -e, pipefail 없음)에서는 파이프 · && · || · & · if 같은 '
  + '것이 실패를 덮을 수 있어서다. 이 명령 하나만 있는 step 으로 부르고, 실패 때 할 일은 `if: failure()` '
  + 'step 으로 둔다';

// 앞 step 이 뒤 step 들의 npm · 셸 설정을 바꿨는가 — GITHUB_ENV 에 npm_config_* · BASH_ENV 를
// 쓰거나, `npm config set` · `npm set` 으로 사용자 .npmrc 를 바꾼다.
function taintsLaterSteps(run) {
  return (/GITHUB_ENV/.test(run) && /npm_config_|BASH_ENV/i.test(run)) || /\bnpm\s+(?:config\s+)?set\b/.test(run);
}

// 워크플로가 apps/server 에서 부르는 npm 스크립트.
//   invoked   — 명령 하나뿐인 step 으로, main push 마다 도는 잡에서 부르는 스크립트 이름
//   uncounted — 부르기는 하지만 그렇지 못한 호출 [{ job, script, why }]
// step 의 working-directory, 잡과 워크플로의 defaults.run.working-directory, 루트에서 쓰는
// `-w server` · `--prefix` · `-C` 를 따라간다. 명령이 여럿인 step 의 `cd` 는 그 step 에서
// 찾은 호출을 알리는 데만 쓴다(그 호출은 어차피 세지 않는다).
export function ciServerNpmInvocations(text) {
  const workflow = parseWorkflowYaml(text);
  const invoked = new Set();
  const uncounted = [];
  if (!isMap(workflow) || !isMap(workflow.jobs)) return { invoked, uncounted };

  const workflowDefaults = runDefaults(workflow);
  const workflowGate = triggerGate(workflow.on) ?? gateOf(workflow);
  for (const [job, spec] of Object.entries(workflow.jobs)) {
    if (!isMap(spec) || !Array.isArray(spec.steps)) continue;
    const jobDefaults = runDefaults(spec);
    const jobGate = workflowGate ?? gateOf(spec) ?? needsGate(workflow.jobs, job);
    // 디렉터리를 못 읽었으면(null) 그 까닭(defaults · working-directory)이 이미 gate 에 있다.
    const jobDir = jobDefaults.gate !== null || workflowDefaults.gate !== null
      ? null
      : jobDefaults.dir ?? workflowDefaults.dir ?? '.';
    let tainted = null;
    for (const step of spec.steps) {
      if (!isMap(step) || typeof step.run !== 'string') continue;
      const ownDir = step['working-directory'];
      const gate = jobGate
        ?? gateOf(step)
        ?? (absent(ownDir) || typeof ownDir === 'string' ? null : unread('working-directory'))
        ?? tainted;
      if (taintsLaterSteps(step.run)) tainted ??= configGate('앞 step 이 GITHUB_ENV 나 npm config set 으로 설정을 남겼다');
      const commands = shellCommands(step.run);
      const single = commands.length === 1 && [null, '\n', ';'].includes(commands[0].next);
      const startDir = typeof ownDir === 'string' ? ownDir : absent(ownDir) ? jobDir : null;
      let cwd = startDir === null ? null : normalizeDir(startDir);
      for (const { words } of commands) {
        if (words[0] === 'cd') {
          if (cwd !== null) cwd = joinDir(cwd, words[1] ?? '.');
          continue;
        }
        const call = serverNpmCall(words, cwd ?? SERVER_DIR);
        if (call === null) continue;
        const why = gate
          ?? (call.script.includes('$') ? '스크립트 이름을 실행 때 정한다 — 무엇을 부르는지 알 수 없다' : null)
          ?? (single ? null : NOT_ALONE)
          ?? call.problem;
        if (why === null) invoked.add(call.script);
        else uncounted.push({ job, script: call.script, why });
      }
    }
  }
  return { invoked, uncounted };
}

// 저장소에 둔 .npmrc 가 스크립트를 도는 방식을 바꾸는가 — 그러면 CI 의 모든 npm 호출에 걸린다.
// 반환: 문제가 된 설정 줄들. `;` · `#` 주석과 빈 줄은 건너뛴다.
export function npmrcProblems(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith(';') && !line.startsWith('#'))
    .filter((line) => {
      const at = line.indexOf('=');
      const name = (at === -1 ? line : line.slice(0, at)).trim();
      const value = at === -1 ? 'true' : line.slice(at + 1).trim();
      return envProblem(`npm_config_${name}`, value) !== null;
    });
}
