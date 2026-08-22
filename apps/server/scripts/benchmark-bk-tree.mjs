#!/usr/bin/env node
// BK-tree fuzzy tier 벤치마크 (ticket e52e7f64, DESIGN.md 축 1, 완료조건 2:
// "BK-tree 룩업이 O(log n) 스케일(pairwise 대비)임을 벤치마크로 확인").
//
// DESIGN.md 축 1 자신의 주장: fuzzy tier를 pairwise 문자열 비교로 구현하면
// O(refs × defs)로 폭발한다(문서 예시: 10 MLOC 규모에서 약 120k lookup ×
// 280k-심볼 테이블 비교) — BK-tree는 삼각부등식 가지치기로 평균 O(log n)
// 룩업을 낸다(resolver/bk-tree.ts 헤더 코멘트). 이 스크립트는 그 주장을
// 실측한다: 워크스페이스 심볼 수 n을 키워가며 (a) BK-tree query()와 (b)
// 순수 pairwise 선형 스캔의 룩업당 평균 시간을 같은 질의 집합에 대해
// 재고, 전자가 n에 대해 훨씬 완만하게 자라는지 보여준다. 두 경로가 정확히
// 같은 매치 집합을 반환하는지도 매 구간마다 확인한다 — 속도 차이가 정확도
// 희생의 대가가 아님을 보장하기 위해서다.
//
// pairwise 베이스라인은 resolver/bk-tree.ts 내부의 (export 안 된)
// levenshtein() 구현을 그대로 복제했다 — "가장 단순한 대안"을 정확히
// 재현해야 비교가 의미있다.
//
// 사용법:
//   (cd apps/server && npm run build)
//   node apps/server/scripts/benchmark-bk-tree.mjs [--sizes 1000,4000,16000] [--queries 200]
//
// 기본 sizes는 수 초 안에 끝나도록 보수적으로 잡았다 — 더 큰 n(예:
// research-storage.md/DESIGN.md가 인용하는 ~280k 심볼 규모)으로 밀어붙이고
// 싶으면 --sizes로 직접 늘려라(단, pairwise 베이스라인은 O(n)이라 n을
// 올릴수록 이 스크립트 자체의 실행 시간도 선형으로 늘어난다).

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');

function parseArgs(argv) {
  const out = { sizes: [1000, 4000, 16000], queries: 200 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sizes') out.sizes = argv[++i].split(',').map(Number);
    else if (a === '--queries') out.queries = Number(argv[++i]);
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));

const { BKTree } = await import('file://' + path.join(DIST, 'modules/ontology/resolver/bk-tree.js'));

// resolver/bk-tree.ts의 (export 안 된) levenshtein()과 동일 구현.
function levenshtein(a, b) {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  let prev = new Array(bl + 1);
  let curr = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= bl; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[bl];
}

function pairwiseQueryCount(words, word, maxDistance) {
  let count = 0;
  for (const w of words) {
    if (levenshtein(word, w) <= maxDistance) count += 1;
  }
  return count;
}

// 코드 식별자스러운 결정론적(재현 가능한) 심볼명 n개 생성 — 실제
// 워크스페이스 심볼 테이블의 분포를 흉내낸다(prefix+stem+suffix 조합,
// camelCase). Math.random()을 쓰지 않는다 — 같은 n이면 항상 같은 코퍼스가
// 나와야 실행 간 결과를 비교할 수 있다.
const PREFIXES = ['get', 'set', 'create', 'update', 'delete', 'resolve', 'handle', 'process', 'validate', 'build', 'make', 'find', 'list', 'sync', 'load', 'save'];
const STEMS = ['User', 'Widget', 'Service', 'Manager', 'Controller', 'Repository', 'Provider', 'Factory', 'Adapter', 'Client', 'Store', 'Cache', 'Queue', 'Worker', 'Handler', 'Listener', 'Emitter', 'Config', 'Session', 'Ticket'];
const SUFFIXES = ['', 'Async', 'Impl', 'Base', 'V2', 'Internal', 'Legacy', 'Draft'];

function generateSymbolNames(n) {
  const names = [];
  outer: for (const p of PREFIXES) {
    for (const s of STEMS) {
      for (const suf of SUFFIXES) {
        names.push(`${p}${s}${suf}`);
        if (names.length >= n) break outer;
      }
    }
  }
  // PREFIXES x STEMS x SUFFIXES 조합(2560개)보다 큰 n을 요청하면 숫자
  // 접미사로 채운다.
  let extra = 0;
  while (names.length < n) {
    names.push(`sym${extra}Extra`);
    extra += 1;
  }
  return names;
}

// 질의 집합: 코퍼스에서 고르게 뽑아 각 이름의 끝 1글자를 지운 "타이핑
// 실수" 버전 — fuzzy tier가 실전에서 받는 입력과 같은 모양(원본과
// 편집거리 1, cascade.ts의 FUZZY_MAX_DISTANCE=2 이내).
function generateQueries(names, count) {
  const step = Math.max(1, Math.floor(names.length / count));
  const queries = [];
  for (let i = 0; i < names.length && queries.length < count; i += step) {
    const name = names[i];
    queries.push(name.length > 1 ? name.slice(0, -1) : name);
  }
  return queries;
}

function timeMs(fn) {
  const start = process.hrtime.bigint();
  fn();
  const end = process.hrtime.bigint();
  return Number(end - start) / 1e6;
}

async function main() {
  const MAX_DISTANCE = 2; // cascade.ts FUZZY_MAX_DISTANCE와 동일
  console.log(`BK-tree vs pairwise 벤치마크 — sizes=[${args.sizes.join(', ')}], queries=${args.queries}, maxDistance=${MAX_DISTANCE}\n`);

  const rows = [];
  for (const n of args.sizes) {
    const names = generateSymbolNames(n);
    const queries = generateQueries(names, args.queries);

    const tree = new BKTree();
    for (const name of names) tree.insert(name);

    let bkResultCount = 0;
    const bkTotalMs = timeMs(() => {
      for (const q of queries) bkResultCount += tree.query(q, MAX_DISTANCE).length;
    });

    let pwResultCount = 0;
    const pwTotalMs = timeMs(() => {
      for (const q of queries) pwResultCount += pairwiseQueryCount(names, q, MAX_DISTANCE);
    });

    if (bkResultCount !== pwResultCount) {
      throw new Error(
        `n=${n}: BK-tree(${bkResultCount}개 매치)와 pairwise(${pwResultCount}개 매치)가 다른 결과를 반환했다 — ` +
          `벤치마크 무효, correctness 버그부터 조사해야 한다`,
      );
    }

    const bkAvgUs = (bkTotalMs * 1000) / queries.length;
    const pwAvgUs = (pwTotalMs * 1000) / queries.length;
    rows.push({ n, bkTotalMs, bkAvgUs, pwTotalMs, pwAvgUs, matches: bkResultCount });
    console.log(
      `n=${n}\ttree.size=${tree.size}\tBK-tree ${bkTotalMs.toFixed(2)}ms total / ${bkAvgUs.toFixed(2)}us per query\t` +
        `pairwise ${pwTotalMs.toFixed(2)}ms total / ${pwAvgUs.toFixed(2)}us per query\tspeedup=${(pwAvgUs / bkAvgUs).toFixed(1)}x\t` +
        `(결과 일치: ${bkResultCount}개 매치 총합)`,
    );
  }

  console.log('\n스케일링 추세(직전 구간 대비 n 배율 vs 룩업당 평균시간 배율):');
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    const nRatio = cur.n / prev.n;
    const bkRatio = cur.bkAvgUs / prev.bkAvgUs;
    const pwRatio = cur.pwAvgUs / prev.pwAvgUs;
    const verdict = pwRatio > bkRatio ? 'BK-tree가 더 완만하게 스케일 (기대한 결과)' : '경고: 이 구간에서 BK-tree가 pairwise보다 가파르게 스케일';
    console.log(`  n ${prev.n} -> ${cur.n} (${nRatio}x): BK-tree ${bkRatio.toFixed(2)}x, pairwise ${pwRatio.toFixed(2)}x  — ${verdict}`);
  }
}

await main();
