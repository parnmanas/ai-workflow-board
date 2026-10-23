// test/helpers/ci-workflow.mjs — CI 워크플로가 apps/server 에서 부르는 npm 스크립트를
// 읽는다. 티켓 6ad5989a.
//
// 왜: 등록 감사의 뿌리(registration-audit.mjs 의 CI_ENTRY_SCRIPTS)는 손으로 적는 목록이다.
// 적어 두기만 하면 "목록에는 있는데 CI 는 부르지 않는" 진입점이 그 경로의 파일을 등록으로
// 만든다 — 티켓 6ad5989a 의 버그가 그것이었다. 그래서 가드가 이 모듈로 ci.yml 을 읽어
// 목록과 맞춰 본다.
//
// 세는 호출의 계약은 좁다: **명령 하나뿐인 step**(`npm test`, `npm run <script>`)이
// main push 마다 도는 잡에 있어야 한다. 셸을 해석해 "이 호출의 실패가 CI 를 빨갛게
// 하는가" 를 따지지 않는다 — GitHub 의 기본 셸은 `bash -e`(pipefail 없음)라 파이프 ·
// 끝이 아닌 && · || · 서브셸 · here-doc · set +e 가 저마다 실패를 덮고, 그것을 하나씩
// 흉내 내다 틀린 만큼 가드가 조용히 초록이 된다. 명령이 하나뿐이면 셸 종류와 옵션이
// 결과를 바꾸지 않는다. 실패 때 할 일(로그 덤프 등)은 `if: failure()` step 으로 둔다.
//
// 부르기는 하지만 세지 않는 호출은 이유와 함께 따로 돌려준다:
//   - step 의 run 이 그 명령 하나가 아니다(파이프 · && · || · & · if · here-doc …), 또는 npm
//     앞에 다른 명령(timeout · env …)이 있다
//   - 알려진 모양이 아닌 job · step `if:` (식을 계산하지 못한다 — ALWAYS_RUN_CONDITIONS),
//     또는 needs 로 기다리는 잡의 그런 if:
//   - `continue-on-error`
//   - ignore-scripts(옵션이나 npm_config_ignore_scripts env) — pre/post 스위트가 빠진다
//   - 실행 때 정하는 스크립트 이름(`npm run ${{ matrix.suite }}`)
//   - 워크플로가 main push 에 걸려 있지 않다(push 트리거 · branches · paths 필터)
//   - 위 판단에 쓰는 필드(if · continue-on-error · needs · env · defaults · 병합 키)를 읽지
//     못했다 — 흐름 맵이나 읽지 못한 별칭에 실린 게이트를 놓치지 않으려고, 못 읽으면 세지
//     않는 쪽으로 정한다
// 그래서 이 모듈은 셀 수 없는 것을 세는 쪽으로 틀리지 않게 짰다. 반대로 맞는 호출을 못
// 세면 대조가 빨개지고, 메시지가 무엇을 못 읽었는지 알려 준다. YAML · 셸 밖에서 테스트를
// 무력하게 만드는 변경(잡의 env 를 바꿔 테스트가 스스로 skip 하게 하는 것 등)은 보지 못한다.
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
        i++; // 맵 안의 읽을 수 없는 줄
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
// needs 로 기다리는 잡이 건너뛰어져도 도는 조건(상태 함수가 success() 를 대신한다).
const RUNS_AFTER_SKIPPED_NEEDS = new Set(['always()', '!cancelled()']);

function normalizeCondition(condition) {
  const text = String(condition).trim();
  const wrapped = /^\$\{\{([\s\S]*)\}\}$/.exec(text);
  return (wrapped ? wrapped[1] : text).replace(/\s+/g, ' ').trim();
}

const unread = (field) => `${field} 를 읽지 못했다 — 이 호출이 매번 실패를 드러내는지 판단하지 않는다`;
const absent = (v) => v === undefined || v === null;

function conditionGate(node) {
  if (absent(node.if)) return null;
  if (typeof node.if !== 'string') return unread('if');
  const condition = normalizeCondition(node.if);
  return ALWAYS_RUN_CONDITIONS.includes(condition)
    ? null
    : `if: ${condition} — main push 마다 도는지 알 수 없다(ALWAYS_RUN_CONDITIONS)`;
}

const IGNORE_SCRIPTS = 'ignore-scripts — pre/post 스크립트(스위트)가 돌지 않는다';

// npm 은 npm_config_* 환경 변수를 설정으로 읽는다(이름의 대소문자를 가리지 않는다).
function envGate(env) {
  if (absent(env)) return null;
  if (!isMap(env)) return unread('env');
  const ignores = Object.entries(env).some(
    ([name, value]) => /^npm_config_ignore[-_]scripts$/i.test(name) && !/^\s*(false|0)?\s*$/i.test(String(value ?? '')),
  );
  return ignores ? IGNORE_SCRIPTS : null;
}

// defaults.run.working-directory — 없으면 null, 있으면 { dir } , 못 읽으면 { gate }.
function runDefaults(node) {
  if (absent(node.defaults)) return null;
  if (!isMap(node.defaults)) return { gate: unread('defaults') };
  const run = node.defaults.run;
  if (absent(run)) return null;
  if (!isMap(run)) return { gate: unread('defaults.run') };
  const dir = run['working-directory'];
  if (absent(dir)) return null;
  return typeof dir === 'string' ? { dir } : { gate: unread('defaults.run.working-directory') };
}

// 잡 · step(그리고 워크플로) 자신이 그 안의 호출을 세지 못하게 하는 이유. 없으면 null.
function gateOf(node) {
  if (Object.hasOwn(node, '<<')) return unread('병합 키(<<)');
  const continueOnError = node['continue-on-error'];
  const coe = absent(continueOnError)
    ? null
    : typeof continueOnError !== 'string'
      ? unread('continue-on-error')
      : continueOnError.trim().toLowerCase() === 'false'
        ? null
        : 'continue-on-error — 실패해도 CI 가 빨개지지 않는다';
  return conditionGate(node) ?? coe ?? envGate(node.env) ?? runDefaults(node)?.gate ?? null;
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

// 워크플로가 main push 에 걸려 있는가 — 아니면 거기 있는 호출은 main 에 들어갈 때 돌지 않는다.
// GitHub 규칙: branches(-ignore) 없이 tags(-ignore) 만 있으면 브랜치 push 에는 돌지 않는다.
function triggerGate(on) {
  const events = typeof on === 'string' && /^\w+$/.test(on) ? [on] : Array.isArray(on) ? on : isMap(on) ? Object.keys(on) : null;
  if (events === null) return unread('on');
  if (!events.includes('push')) return 'on: 에 push 가 없다 — main 에 들어갈 때 돌지 않는다';
  const push = isMap(on) ? on.push : null;
  if (absent(push)) return null;
  if (!isMap(push)) return unread('on.push');
  if (!absent(push.paths) || !absent(push['paths-ignore'])) {
    return 'on.push 에 paths 필터가 있다 — 서버를 바꾼 push 에도 돌지 않을 수 있다';
  }
  const list = (v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v : null);
  if (!absent(push.branches)) {
    const branches = list(push.branches);
    if (branches === null) return unread('on.push.branches');
    if (!branches.includes('main')) return 'on.push.branches 에 main 이 없다';
  }
  if (!absent(push['branches-ignore'])) {
    const ignored = list(push['branches-ignore']);
    if (ignored === null || ignored.includes('main')) return 'on.push.branches-ignore 가 main 을 뺄 수 있다';
  }
  if (absent(push.branches) && absent(push['branches-ignore']) && (!absent(push.tags) || !absent(push['tags-ignore']))) {
    return 'on.push 에 tags 필터만 있다 — 브랜치 push 에는 돌지 않는다';
  }
  return null;
}

// 저장소 루트 기준 상대 디렉터리를 한 모양으로 — './apps/server/', 'apps/server',
// '${{ github.workspace }}/apps/server', '$GITHUB_WORKSPACE/apps/server' 는 같다.
const WORKSPACE_RE = /^(?:\$\{\{\s*github\.workspace\s*\}\}|\$\{?GITHUB_WORKSPACE\}?)(?:\/|$)/;
function normalizeDir(dir) {
  const relative = String(dir).replace(/\\/g, '/').replace(WORKSPACE_RE, '');
  const normalized = path.posix.normalize(relative === '' ? '.' : relative);
  return normalized.length > 1 ? normalized.replace(/\/$/, '') : normalized;
}
const joinDir = (cwd, target) => (WORKSPACE_RE.test(target) ? normalizeDir(target) : normalizeDir(path.posix.join(cwd, target)));

const SERVER_DIR = 'apps/server';
// apps/server 의 npm workspace 이름. 루트에서 `npm run build -w server` 로 부른다.
const SERVER_WORKSPACES = new Set(['server', SERVER_DIR]);
// 값을 받는 npm 옵션. 그 밖의 옵션은 값을 받지 않는다고 본다(--silent · --if-present 등).
const NPM_VALUE_FLAGS = new Set(['-w', '--workspace', '--prefix', '-C', '--loglevel']);

// 단순 명령 하나가 `npm test` · `npm run <script>` 로 apps/server 의 스크립트를 부르면
// { script, ignoreScripts, wrapped } 를, 아니면 null 을 돌려준다. cwd 는 저장소 루트 기준이다.
// wrapped 는 npm 앞에 다른 명령(timeout · time · env …)이 있다는 뜻이다.
function serverNpmCall(words, cwd) {
  let at = 0;
  while (at < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at])) at++; // FOO=1 npm …
  const wrapped = words[at] !== 'npm';
  if (wrapped) at = words.indexOf('npm', at);
  if (at === -1) return null;

  const workspaces = [];
  let prefix = null;
  let ignoreScripts = false;
  const positional = [];
  for (let j = at + 1; j < words.length; j++) {
    const word = words[j];
    if (word === '--') break;
    const inline = /^(--?[\w-]+)=(.*)$/.exec(word);
    const flag = inline ? inline[1] : word;
    if (flag === '--ignore-scripts') {
      ignoreScripts = !inline || !/^(false|0)$/i.test(inline[2]);
    } else if (NPM_VALUE_FLAGS.has(flag)) {
      const value = inline ? inline[2] : words[++j];
      if (value === undefined) break;
      if (flag === '--prefix' || flag === '-C') prefix = value;
      else if (flag === '-w' || flag === '--workspace') workspaces.push(value);
    } else if (!word.startsWith('-')) {
      positional.push(word);
    }
  }

  const [command, name] = positional;
  const script = command === 'test' ? 'test' : command === 'run' ? name : undefined;
  if (script === undefined) return null;

  const inServer = workspaces.length > 0
    ? workspaces.some((w) => SERVER_WORKSPACES.has(normalizeDir(w)))
    : (prefix === null ? cwd : joinDir(cwd, prefix)) === SERVER_DIR;
  return inServer ? { script, ignoreScripts, wrapped } : null;
}

const NOT_ALONE = 'step 의 run 이 이 명령 하나가 아니다 — 기본 셸(bash -e, pipefail 없음)에서는 파이프 · '
  + '&& · || · & · if 같은 것이 실패를 덮을 수 있어 세지 않는다. 이 명령 하나만 있는 step 으로 부르고, '
  + '실패 때 할 일은 `if: failure()` step 으로 둔다';

const WRAPPED = 'npm 앞에 다른 명령(timeout · time · env …)이 있다 — 그 명령이 npm 의 종료 코드를 그대로 '
  + '넘기는지 가드는 모른다. 시간 제한은 `timeout-minutes:`, 환경 변수는 step `env:` 로 둔다';

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

  const workflowGate = triggerGate(workflow.on) ?? gateOf(workflow);
  // 디렉터리를 못 읽은 곳(null)의 호출은 apps/server 일 수도 있다 — 세지는 않되 알린다.
  const dirOf = (defaults, inherited) => (defaults === null ? inherited : defaults.gate ? null : defaults.dir);
  const workflowDir = dirOf(runDefaults(workflow), '.');
  for (const [job, spec] of Object.entries(workflow.jobs)) {
    if (!isMap(spec) || !Array.isArray(spec.steps)) continue;
    const jobGate = workflowGate ?? gateOf(spec) ?? needsGate(workflow.jobs, job);
    const jobDir = dirOf(runDefaults(spec), workflowDir);
    for (const step of spec.steps) {
      if (!isMap(step) || typeof step.run !== 'string') continue;
      const ownDir = step['working-directory'];
      const gate = jobGate ?? gateOf(step) ?? (absent(ownDir) || typeof ownDir === 'string' ? null : unread('working-directory'));
      const commands = shellCommands(step.run);
      const single = commands.length === 1 && [null, '\n', ';'].includes(commands[0].next);
      // 디렉터리를 못 읽었으면(null) 그 까닭(defaults · working-directory)이 이미 gate 에 있다.
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
          ?? (call.wrapped ? WRAPPED : null)
          ?? (call.ignoreScripts ? IGNORE_SCRIPTS : null);
        if (why === null) invoked.add(call.script);
        else uncounted.push({ job, script: call.script, why });
      }
    }
  }
  return { invoked, uncounted };
}
