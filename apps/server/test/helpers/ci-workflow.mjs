// test/helpers/ci-workflow.mjs — CI 워크플로가 apps/server 에서 부르는 npm 스크립트를
// 읽는다. 티켓 6ad5989a.
//
// 왜: 등록 감사의 뿌리(registration-audit.mjs 의 CI_ENTRY_SCRIPTS)는 손으로 적는 목록이다.
// 적어 두기만 하면 "목록에는 있는데 CI 는 부르지 않는" 진입점이 그 경로의 파일을 등록으로
// 만든다 — 티켓 6ad5989a 의 버그가 그것이었다. 그래서 가드가 이 모듈로 ci.yml 을 읽어
// 목록과 맞춰 본다.
//
// 세는 것은 "그 스크립트가 실패하면 CI 가 빨개지는 호출" 이다. 부르기는 하지만 실패를
// 삼키는 호출은 세지 않고 이유와 함께 따로 돌려준다:
//   - 알려진 모양이 아닌 job · step `if:` (식을 계산하지 못한다 — ALWAYS_RUN_CONDITIONS)
//   - `continue-on-error`
//   - needs 로 기다리는 잡이 조건부인 잡(그 잡이 건너뛰면 함께 건너뛴다)
//   - `|| …` 로 실패를 덮거나 `&` 로 띄우고 기다리지 않는 명령
//   - 셸 if · 반복 · case 안, `||` · `[ … ] &&` 사슬 뒤, `!` 로 뒤집은 명령
//   - ignore-scripts(옵션이나 npm_config_ignore_scripts) — pre/post 스위트가 빠진다
//   - 실행 때 정하는 스크립트 이름(`npm run ${{ matrix.suite }}`)
//
// 의존성 없이 읽는다(scripts/audit-ci-branch-coverage.mjs 와 같은 이유 — YAML 파서 의존성을
// 들이지 않는다). 아래 YAML 은 워크플로가 쓰는 부분집합이다. 앵커 · 별칭 · 맵 흐름
// 컬렉션 안의 명령, 서브셸 안의 명령처럼 읽지 못하는 모양은 호출로 보이지 않으므로, 대조가
// 빨개지는 쪽으로 틀린다. YAML · 셸 문법 밖에서 테스트를 무력하게 만드는 변경(잡의 env 를
// 바꿔 테스트가 스스로 skip 하게 하는 것 등)은 이 모듈이 보지 못한다. 워크플로가 main push
// 에 걸려 있는지는 scripts/audit-ci-branch-coverage.mjs 가 따로 본다.

import path from 'node:path';
import { shellCommands } from './shell-commands.mjs';

// ── YAML 부분집합 ──────────────────────────────────────────────────────────
// 블록 맵 · 블록 시퀀스 · 평문(여러 줄) · 따옴표 · 블록(| 와 >) 스칼라와 주석을 읽는다.
// 스칼라는 전부 문자열이다(true · 22 도 'true' · '22'). 단순한 흐름 시퀀스([a, b])는
// 배열로 읽는다 — `needs: [build, test]` 를 따라가야 한다. 그 밖의 흐름 컬렉션({a: b} ·
// 중첩)과 앵커 · 별칭 · 태그는 원문 문자열로 남는다.

const indentOf = (line) => line.length - line.trimStart().length;
const isNoise = (line) => /^\s*(#.*)?$/.test(line) || /^(---|\.\.\.)\s*$/.test(line);
const DASH_RE = /^-(?:\s|$)/;
const KEY_RE = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([A-Za-z0-9_$][\w$./-]*))[ \t]*:(?:[ \t]+|$)/;
const BLOCK_HEADER_RE = /^([|>])([+-]?)([1-9]?)([+-]?)[ \t]*(?:#.*)?$/;

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
  const lines = String(text ?? '').split(/\r?\n/);
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
      const rest = body.slice(1).trimStart();
      if (rest === '' || rest.startsWith('#')) {
        i++;
        items.push(node(indent + 1));
      } else if (KEY_RE.test(rest)) {
        items.push(mapping(indent + body.length - rest.length, rest));
      } else {
        items.push(scalarValue(rest, indent));
      }
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
        i++; // 맵 안의 읽을 수 없는 줄(병합 키 `<<: *x` 등)
      }
      skipDeeperThan(col);
      if (i >= lines.length || indentOf(lines[i]) !== col) break;
      body = lines[i].slice(col);
      if (DASH_RE.test(body)) break; // 같은 열의 `-` 는 바깥 시퀀스의 다음 항목이다
    }
    return map;
  }

  function value(rest, col) {
    const text = rest.trim();
    if (text === '' || text.startsWith('#')) {
      i++;
      skipNoise();
      if (i >= lines.length) return null;
      const indent = indentOf(lines[i]);
      if (indent > col) return node(col + 1);
      // `key:` 바로 아래 같은 열에서 시작하는 시퀀스도 그 키의 값이다.
      if (indent === col && DASH_RE.test(lines[i].slice(indent))) return sequence(col);
      return null;
    }
    return scalarValue(text, col);
  }

  function scalarValue(text, parentIndent) {
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

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// job · step `if:` 가운데 "main push 와 PR 마다 돈다" 로 받는 모양. 식을 계산하지 못하므로
// 아는 모양만 받는다. CI 진입점을 부르는 잡 · step 의 조건을 바꾸면, 그 잡이 여전히 main
// push 와 PR 마다 도는지 확인하고 여기에 보탠다(${{ }} 와 공백은 비교 전에 걷어 낸다).
export const ALWAYS_RUN_CONDITIONS = [
  // ci.yml 의 무거운 잡들 — 배포 브랜치 push 와 정기 실행(schedule)만 뺀다.
  "github.ref != 'refs/heads/production.private' && github.event_name != 'schedule'",
  'true',
  'success()',
  'always()',
  '!cancelled()',
];

function normalizeCondition(condition) {
  const text = String(condition).trim();
  const wrapped = /^\$\{\{([\s\S]*)\}\}$/.exec(text);
  return (wrapped ? wrapped[1] : text).replace(/\s+/g, ' ').trim();
}

// 잡 · step 이 매번 돈다고 할 수 없는 이유. 없으면 null.
function conditionGate(node) {
  if (node.if === undefined || node.if === null) return null;
  const condition = normalizeCondition(node.if);
  return ALWAYS_RUN_CONDITIONS.includes(condition)
    ? null
    : `if: ${condition} — main push · PR 마다 도는지 알 수 없다(ALWAYS_RUN_CONDITIONS)`;
}

// 잡 · step 이 그 안의 호출을 "실패하면 CI 가 빨개지는 호출" 로 두지 못하는 이유. 없으면 null.
function gateOf(node) {
  const continueOnError = node['continue-on-error'];
  if (continueOnError !== undefined && continueOnError !== null && String(continueOnError).trim() !== 'false') {
    return conditionGate(node) ?? 'continue-on-error — 실패해도 CI 가 빨개지지 않는다';
  }
  return conditionGate(node);
}

// 잡은 needs 로 기다리는 잡이 건너뛰어지면 함께 건너뛰어진다. 그래서 기다리는 잡의 조건도
// 이 잡의 조건이다(needs 를 따라 끝까지). 순환은 GitHub 가 거부하지만 여기서도 멈춘다.
function needsGate(jobs, id, seen = new Set()) {
  if (seen.has(id)) return null;
  seen.add(id);
  const spec = jobs[id];
  const needs = typeof spec?.needs === 'string' ? [spec.needs] : Array.isArray(spec?.needs) ? spec.needs : [];
  for (const need of needs) {
    const needed = jobs[need];
    if (!isMap(needed)) continue;
    const gate = conditionGate(needed) ?? needsGate(jobs, need, seen);
    if (gate !== null) return `needs: ${need} — ${gate}`;
  }
  return null;
}

// npm 은 npm_config_* 환경 변수를 설정으로 읽는다(이름의 대소문자를 가리지 않는다).
function envIgnoresScripts(env) {
  return isMap(env) && Object.entries(env).some(
    ([name, value]) => /^npm_config_ignore[-_]scripts$/i.test(name) && !/^\s*(false|0)?\s*$/i.test(String(value ?? '')),
  );
}

function runDefaultsDir(node) {
  const dir = isMap(node.defaults) && isMap(node.defaults.run) ? node.defaults.run['working-directory'] : undefined;
  return typeof dir === 'string' ? dir : null;
}

// 저장소 루트 기준 상대 디렉터리를 한 모양으로 — './apps/server/' 와 'apps/server' 는 같다.
function normalizeDir(dir) {
  const normalized = path.posix.normalize(String(dir).replace(/\\/g, '/'));
  return normalized.length > 1 ? normalized.replace(/\/$/, '') : normalized;
}

const SERVER_DIR = 'apps/server';
// apps/server 의 npm workspace 이름. 루트에서 `npm run build -w server` 로 부른다.
const SERVER_WORKSPACES = new Set(['server', SERVER_DIR]);
// 값을 받는 npm 옵션. 그 밖의 옵션은 값을 받지 않는다고 본다(--silent · --if-present 등).
const NPM_VALUE_FLAGS = new Set(['-w', '--workspace', '--prefix', '-C', '--loglevel']);

// 단순 명령 하나가 `npm test` · `npm run <script>` 로 apps/server 의 스크립트를 부르면
// { script, ignoreScripts } 를, 아니면 null 을 돌려준다. cwd 는 저장소 루트 기준이다.
function serverNpmCall(words, cwd) {
  let at = 0;
  while (at < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at])) at++; // FOO=1 npm …
  if (words[at] !== 'npm') return null;

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
    : (prefix === null ? cwd : normalizeDir(path.posix.join(cwd, prefix))) === SERVER_DIR;
  return inServer ? { script, ignoreScripts } : null;
}

// run 블록의 셸 흐름. 명령을 차례로 받아, 복합 명령의 낱말(if · then · fi …)을 걷어 낸
// 명령과, 그 명령이 늘 돌지는 않는 이유(없으면 null)를 돌려준다:
//   - if · while · until · for · case · select 안 — 조건에 따라 돈다
//   - `a || 명령`, `[ … ] && 명령` 처럼 앞 명령의 결과에 따라 도는 사슬
//   - `! 명령` — 결과를 뒤집으니 실패가 실패로 드러나지 않는다
// `{ … }` 묶음은 그대로 돈다. 서브셸 · set +e 같은 것은 보지 않는다.
const SHELL_OPEN = new Set(['if', 'while', 'until', 'for', 'case', 'select']);
const SHELL_CLOSE = new Set(['fi', 'done', 'esac']);
const SHELL_PASS = new Set(['then', 'do', 'else', 'elif', '{', '}']);
const SHELL_TESTS = new Set(['[', '[[', 'test', 'true', 'false']);

function shellFlow() {
  let depth = 0;
  let chained = false; // 이 명령이 앞 명령의 결과에 따라 도는가
  return {
    read({ words: raw, next }) {
      const words = [...raw];
      let negated = false;
      for (;;) {
        if (SHELL_OPEN.has(words[0])) depth++;
        else if (SHELL_CLOSE.has(words[0])) depth = Math.max(0, depth - 1);
        else if (words[0] === '!') negated = true;
        else if (!SHELL_PASS.has(words[0])) break;
        words.shift();
      }
      const why = depth > 0
        ? '셸 if · 반복 · case 안에서 조건에 따라 돈다'
        : chained
          ? '앞 명령의 결과에 따라 돈다(|| 나 [ … ] && 뒤)'
          : negated
            ? '! 로 결과를 뒤집어 실패가 드러나지 않는다'
            : null;
      // 다음 명령이 이 명령의 결과에 따라 도는지: 이 명령 자체가 조건부로 사슬에 있거나,
      // `||` 로 이어지거나(이 명령이 실패해야 돈다), 검사 명령 뒤 `&&` 로 이어진다.
      chained = (next === '&&' || next === '||')
        && (chained || next === '||' || SHELL_TESTS.has(words[0]));
      return { words, next, why };
    },
  };
}

// 워크플로가 apps/server 에서 부르는 npm 스크립트.
//   invoked   — 실패하면 CI 가 빨개지는 호출의 스크립트 이름
//   uncounted — 부르기는 하지만 그렇지 못한 호출 [{ job, script, why }]
// step 의 working-directory, 잡과 워크플로의 defaults.run.working-directory, step 안의 `cd`,
// 루트에서 쓰는 `-w server` · `--prefix` · `-C` 를 따라간다.
export function ciServerNpmInvocations(text) {
  const workflow = parseWorkflowYaml(text);
  const invoked = new Set();
  const uncounted = [];
  if (!isMap(workflow) || !isMap(workflow.jobs)) return { invoked, uncounted };

  const workflowDir = runDefaultsDir(workflow);
  for (const [job, spec] of Object.entries(workflow.jobs)) {
    if (!isMap(spec) || !Array.isArray(spec.steps)) continue;
    const jobDir = runDefaultsDir(spec) ?? workflowDir ?? '.';
    for (const step of spec.steps) {
      if (!isMap(step) || typeof step.run !== 'string') continue;
      let cwd = normalizeDir(typeof step['working-directory'] === 'string' ? step['working-directory'] : jobDir);
      const gate = gateOf(spec) ?? needsGate(workflow.jobs, job) ?? gateOf(step);
      const envIgnores = [workflow.env, spec.env, step.env].some(envIgnoresScripts);
      const shell = shellFlow();
      for (const command of shellCommands(step.run)) {
        const { words, next, why: shellWhy } = shell.read(command);
        if (words[0] === 'cd') {
          cwd = normalizeDir(path.posix.join(cwd, words[1] ?? '.'));
          continue;
        }
        const call = serverNpmCall(words, cwd);
        if (call === null) continue;
        const why = gate
          ?? (call.script.includes('$') ? '스크립트 이름을 실행 때 정한다 — 무엇을 부르는지 알 수 없다' : null)
          ?? shellWhy
          ?? (next === '||' ? '|| 뒤 명령이 실패를 덮는다' : null)
          ?? (next === '&' ? '& 로 띄우고 기다리지 않는다' : null)
          ?? (call.ignoreScripts || envIgnores ? 'ignore-scripts — pre/post 스크립트(스위트)가 돌지 않는다' : null);
        if (why === null) invoked.add(call.script);
        else uncounted.push({ job, script: call.script, why });
      }
    }
  }
  return { invoked, uncounted };
}
