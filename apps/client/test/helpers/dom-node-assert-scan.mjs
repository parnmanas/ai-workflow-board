// jsdom 노드를 node:assert 의 비교 인자로 넘기는 패턴을 소스에서 찾아내는 스캐너.
// 가드 테스트(`test/dom-node-assert-guard.test.mjs`)가 이 모듈을 쓰고, 같은 모듈이
// 자기 자신의 판정 규칙을 픽스처로 단언한다 — 스캐너가 조용히 아무것도 못 잡는
// no-op 으로 썩는 것을 막기 위해서다.
//
// ── 왜 이걸 막아야 하나 (티켓 b207d941, 최초 실측은 티켓 7957aedb) ──
// `assert.equal(container.querySelector('…'), null)` 는 통과할 때는 멀쩡하다.
// 그런데 실패하는 순간 node:assert 가 양쪽 인자를 util.inspect 로 펼치는데,
// 이때 쓰는 옵션이 `depth: 1000` + `getters: true` 다. jsdom element 는
// parentNode → ownerDocument → defaultView → 전역으로 이어지는 순환 그래프이고
// getter 까지 전부 호출되므로 인스펙션이 폭주한다.
//
// 실측: 같은 회귀를 두 형태로 실패시켰을 때
//   - 노드를 인자로 넘긴 판: 파일 전체가 62.7초 뒤 SIGKILL. TAP 에는
//     `failureType: 'testCodeFailure'` 만 남고 어느 단언이 왜 틀렸는지 안 보인다.
//   - boolean 으로 좁힌 판: 108ms 에 `AssertionError: <메시지>` 한 줄.
// `--test-concurrency=1` 로는 막히지 않는다 — 동시성이 아니라 실패 경로의 문제다.
//
// ── 무엇을 검사하나 ──
// 실패 시 인자를 인스펙션하는 **양성** 비교 계열(equal/strictEqual/deepEqual/
// deepStrictEqual)의 첫째·둘째 인자가 DOM 노드로 평가되는지 본다.
//   - `assert.ok(node, msg)` 는 검사하지 않는다: 실패하려면 node 가 falsy 여야 하므로
//     인스펙션 대상이 null/undefined 라 안전하다.
//   - `assert.notEqual(node, null)` 같은 **음성** 계열도 검사하지 않는다: 실패는
//     "두 값이 같다"는 뜻이라 expected 가 리터럴 null 이면 actual 도 null 이다.
// 즉 "실패했을 때 노드가 인스펙션될 수 있는가" 만 기준으로 삼는다.

/** 실패 시 양쪽 인자를 인스펙션하는 비교 함수들. */
export const INSPECTING_EQUALITY_FNS = ['equal', 'strictEqual', 'deepEqual', 'deepStrictEqual'];

/** 표현식의 꼬리가 이 모양이면 DOM 노드(또는 null)로 평가된다. */
const NODE_TAILS = [
  /\bquerySelector\(.*\)\s*$/s,
  /\bgetElementById\(.*\)\s*$/s,
  /\.closest\(.*\)\s*$/s,
  /\bquerySelectorAll\(.*\)\s*\[[^\]]*\]\s*$/s,
  /\bgetElementsBy\w+\(.*\)\s*\[[^\]]*\]\s*$/s,
  /\.(parentElement|parentNode|offsetParent|firstElementChild|lastElementChild|nextElementSibling|previousElementSibling|firstChild|lastChild|activeElement)\s*$/,
];

/**
 * 표현식의 꼬리가 이 모양이면 스칼라(문자열·숫자·불리언)로 좁혀진 것이라 안전하다.
 * DOM 쿼리를 포함하더라도 `.length`/`.value`/`.getAttribute(...)` 처럼 끝났으면
 * assert 에 실제로 넘어가는 값은 노드가 아니다.
 */
const SCALAR_TAILS =
  /\.(length|value|textContent|innerText|innerHTML|outerHTML|id|className|tagName|nodeName|nodeType|checked|disabled|selected|readOnly|hidden|type|href|src|alt|title|placeholder|pathname|search|hash|name|size|rows|cols)\s*$/;

/** 호출로 끝나면서 결과가 스칼라/배열인 메서드들. */
const SCALAR_CALL_TAILS =
  /\.(getAttribute|hasAttribute|getAttributeNames|trim|toLowerCase|toUpperCase|includes|startsWith|endsWith|indexOf|join|map|filter|slice|split|matches|contains|at)\(.*\)\s*$/s;

/**
 * 문자열·템플릿·주석의 **내용만** 같은 길이의 공백으로 지운다(줄바꿈과 오프셋은 보존).
 * `'assert.equal('` 같은 문자열 리터럴이 코드로 오인되는 것을 막는다.
 */
export function maskLiterals(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      const stop = nl === -1 ? src.length : nl;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      const stop = close === -1 ? src.length : close + 2;
      for (let k = i; k < stop; k++) out += src[k] === '\n' ? '\n' : ' ';
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      out += c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') {
          out += src[i + 1] === '\n' ? ' \n' : '  ';
          i += 2;
          continue;
        }
        if (src[i] === c) {
          out += c;
          i++;
          break;
        }
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** `open` 위치의 여는 괄호에 대응하는 닫는 괄호를 찾아 인자 문자열을 돌려준다. */
function readBalanced(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const ch = masked[i];
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) {
      depth--;
      if (depth === 0) return { inner: masked.slice(open + 1, i), end: i };
    }
  }
  return null;
}

/** 최상위 콤마로만 인자를 쪼갠다(중첩 호출·객체 리터럴 안의 콤마는 무시). */
function splitArgs(inner) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner) {
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

/** 최상위에서 주어진 연산자들로 쪼갠다. */
function splitTopLevel(expr, ops) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    const op = depth === 0 ? ops.find((o) => expr.startsWith(o, i)) : null;
    if (op) {
      parts.push(cur);
      cur = '';
      i += op.length - 1;
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

/** 최상위에 비교 연산자가 있으면 그 표현식은 boolean 이라 안전하다. */
function hasTopLevelComparison(expr) {
  let depth = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (
      depth === 0 &&
      (expr.startsWith('===', i) || expr.startsWith('!==', i) || expr.startsWith('==', i) || expr.startsWith('!=', i))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 표현식이 DOM 노드(또는 노드 아니면 null)로 평가되는지 판정한다.
 * `nodeNames` 는 같은 파일 안에서 노드를 돌려주는 것으로 이미 확인된 헬퍼·변수 이름 집합.
 */
export function isNodeValued(expr, nodeNames = new Set()) {
  let e = String(expr).trim();
  if (!e) return false;

  // 통째로 감싼 괄호 벗기기
  while (e.startsWith('(')) {
    const bal = readBalanced(e, 0);
    if (!bal || bal.end !== e.length - 1) break;
    e = e.slice(1, -1).trim();
  }
  if (!e) return false;

  // 명시적으로 좁힌 형태 — 안전
  if (/^(!|Boolean\s*\(|String\s*\(|Number\s*\(|typeof\s|JSON\.)/.test(e)) return false;
  if (hasTopLevelComparison(e)) return false;

  // `a || b`, `a ?? b` 는 어느 한쪽이라도 노드면 노드로 본다 (`find(...) || null` 관용구)
  const alternatives = splitTopLevel(e, ['||', '??']);
  if (alternatives.length > 1) return alternatives.some((a) => isNodeValued(a, nodeNames));

  if (SCALAR_TAILS.test(e) || SCALAR_CALL_TAILS.test(e)) return false;
  if (NODE_TAILS.some((re) => re.test(e))) return true;

  // 노드가 담긴 변수
  if (nodeNames.has(e)) return true;

  // 노드를 돌려주는 것으로 확인된 헬퍼의 **바깥쪽** 호출.
  // `optionLabels(repoSelect(container))` 처럼 안쪽에 끼어 있기만 한 경우는 제외해야 한다 —
  // 바깥 호출이 결과를 스칼라로 좁히므로 실제로 assert 에 넘어가는 값은 노드가 아니다.
  const head = e.match(/^([\w$]+)\s*\(/);
  if (head && nodeNames.has(head[1])) {
    const bal = readBalanced(e, e.indexOf('('));
    if (bal && bal.end === e.length - 1) return true;
  }
  return false;
}

/** 중괄호 본문에서 최상위 `return <expr>;` 들을 뽑는다. */
function returnsInBlock(masked, braceAt) {
  const bal = readBalanced(masked, braceAt);
  if (!bal) return [];
  return [...bal.inner.matchAll(/\breturn\s+([^;]+);/g)].map((r) => r[1]);
}

/**
 * 함수가 돌려줄 수 있는 표현식들을 모은다.
 *
 * 본문은 반드시 **그 선언에 속한** 균형 잡힌 중괄호로 잘라낸다. 고정 길이 창으로
 * 자르거나(뒤따르는 다른 함수의 `return` 을 제 것으로 오인 — `optionLabels`/
 * `selectedLabel` 오탐) 파일 아무 데서나 `=>` 를 찾으면(그 화살표가 한참 뒤의 다른
 * 함수라 본문을 통째로 놓침 — `subList` 미검출) 둘 다 판정이 틀어진다.
 */
function returnedExpressions(masked, decl) {
  if (decl.kind === 'function') {
    const paren = masked.indexOf('(', decl.at);
    if (paren === -1) return [];
    const params = readBalanced(masked, paren);
    if (!params) return [];
    const brace = masked.indexOf('{', params.end);
    return brace === -1 ? [] : returnsInBlock(masked, brace);
  }

  // 화살표 함수: `=>` 바로 뒤가 블록이면 블록 본문, 아니면 concise 본문 한 표현식.
  const rest = masked.slice(decl.bodyAt);
  const offset = rest.length - rest.trimStart().length;
  if (rest[offset] === '{') return returnsInBlock(masked, decl.bodyAt + offset);
  return [splitTopLevel(rest.slice(offset), [';', '\n'])[0]];
}

/**
 * 파일 안에서 DOM 노드로 평가되는 이름(헬퍼 함수 · 지역 변수)을 모은다.
 * `const list = root.querySelector(...); return list;` 처럼 한 단계 우회한
 * 경우까지 잡기 위해 고정점(fixpoint)으로 반복한다.
 */
export function collectNodeNames(masked) {
  const nodeNames = new Set();

  const assignments = [...masked.matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*([^;]+);/g)].map((m) => ({
    name: m[1],
    expr: m[2],
  }));

  const functions = [];
  for (const m of masked.matchAll(/function\s+([\w$]+)\s*\(/g)) {
    functions.push({ kind: 'function', name: m[1], at: m.index });
  }
  for (const m of masked.matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*(?:\([^)]*\)|[\w$]+)\s*=>/g)) {
    functions.push({ kind: 'arrow', name: m[1], at: m.index, bodyAt: m.index + m[0].length });
  }

  // 이름이 추가되면 그에 의존하던 다른 이름도 노드가 될 수 있으므로 변화가 없을 때까지 돈다.
  for (let pass = 0; pass < 6; pass++) {
    const before = nodeNames.size;

    for (const { name, expr } of assignments) {
      if (!nodeNames.has(name) && isNodeValued(expr, nodeNames)) nodeNames.add(name);
    }

    for (const decl of functions) {
      if (nodeNames.has(decl.name)) continue;
      if (returnedExpressions(masked, decl).some((r) => isNodeValued(r, nodeNames))) nodeNames.add(decl.name);
    }

    if (nodeNames.size === before) break;
  }
  return nodeNames;
}

/**
 * 소스 한 벌을 훑어 위반 지점을 돌려준다.
 * `{ line, fn, argIndex, snippet }[]`
 */
export function scanSource(src) {
  const masked = maskLiterals(src);
  const nodeNames = collectNodeNames(masked);
  const violations = [];

  const callRe = new RegExp(`\\bassert\\.(${INSPECTING_EQUALITY_FNS.join('|')})\\s*\\(`, 'g');
  let m;
  while ((m = callRe.exec(masked))) {
    const open = m.index + m[0].length - 1;
    const bal = readBalanced(masked, open);
    if (!bal) continue;

    const maskedArgs = splitArgs(bal.inner);
    const rawArgs = splitArgs(src.slice(open + 1, bal.end));

    for (let i = 0; i < Math.min(2, maskedArgs.length); i++) {
      if (!isNodeValued(maskedArgs[i], nodeNames)) continue;
      violations.push({
        line: src.slice(0, m.index).split('\n').length,
        fn: m[1],
        argIndex: i,
        snippet: (rawArgs[i] ?? '').trim().replace(/\s+/g, ' ').slice(0, 100),
      });
      break; // 한 호출당 한 번만 보고한다
    }
  }
  return violations;
}
