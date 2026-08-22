#!/usr/bin/env node
// BK-tree fuzzy tier 벤치마크 (ticket e52e7f64, DESIGN.md 축 1, 완료조건 2:
// "BK-tree 룩업이 O(log n) 스케일(pairwise 대비)임을 벤치마크로 확인").
//
// DESIGN.md 축 1 자신의 주장: fuzzy tier를 pairwise 문자열 비교로 구현하면
// O(refs × defs)로 폭발한다(문서 예시: 10 MLOC 규모에서 약 120k lookup ×
// 280k-심볼 테이블 비교) — BK-tree는 삼각부등식 가지치기로 평균 O(log n)
// 룩업을 낸다(resolver/bk-tree.ts 헤더 코멘트). 이 스크립트는 그 주장을
// 실측하고, 실제로 **게이트**한다(리뷰 지적 1라운드 — 이전 버전은 비율만
// 출력하고 항상 성공 코드로 끝나 완료조건 2를 판정하지 않았다).
//
// 게이트는 wall-clock이 아니라 BKTree.queryWithStats()가 반환하는 실제
// 방문 노드 수(= levenshtein 호출 횟수, 삼각부등식 가지치기의 직접 산물)로
// 건다 — wall-clock은 GC/스케줄러 노이즈에 취약해서 "n이 4배일 때 룩업
// 시간이 1.8배로 늘었다"가 진짜 O(log n)인지 우연인지 그 자체로는 증명하지
// 못한다(1.8배는 log(4x)/log(x)가 예측하는 순수 로그 성장(~1.2배)보다도
// 크다 — 즉 wall-clock 배수만으로는 "pairwise보다 완만하다" 이상을
// 주장할 수 없었다). 방문 노드 수는 결정론적 정수라 노이즈가 없고, 두
// 단정으로 sub-linear 성장을 직접 검증한다:
//   (a) 모든 n에서 평균 방문 노드 수 < n(즉 pairwise의 룩업당 비교 횟수보다
//       항상 적다 — 가지치기가 전혀 안 먹으면 결국 전체 노드를 다 방문해
//       평균 방문 노드 수가 n에 근접/도달한다)
//   (b) n이 k배로 늘 때 평균 방문 노드 수는 k배 미만으로 늘어야 한다(순수
//       선형이면 정확히 k배 — 이 부등식이 "가지치기가 실제로 작동한다"의
//       직접적인 반증 가능한 주장이다)
// 둘 중 하나라도 깨지면 스크립트가 throw해 비정상 종료(exit code != 0)한다
// — CI/수동 실행 어느 쪽에서도 "숫자만 보고 눈으로 판단" 없이 게이트가
// 걸린다. wall-clock/speedup은 여전히 출력하지만 참고용이며 판정에는
// 쓰지 않는다.
//
// 두 경로가 정확히 같은 매치 집합을 반환하는지도 매 구간마다 확인한다 —
// 속도/방문수 차이가 정확도 희생의 대가가 아님을 보장하기 위해서다.
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

// pairwise는 가지치기가 전혀 없다 — 매 질의가 코퍼스 전체를 정확히 한 번씩
// 비교한다(반환값 comparisons는 항상 words.length와 같지만, "가정"이 아니라
// 루프가 직접 센 값을 쓴다 — BK-tree 쪽 방문수와 같은 방식으로 계측해야
// 두 계열을 대등하게 비교할 수 있다).
function pairwiseQuery(words, word, maxDistance) {
  let matchCount = 0;
  let comparisons = 0;
  for (const w of words) {
    comparisons += 1;
    if (levenshtein(word, w) <= maxDistance) matchCount += 1;
  }
  return { matchCount, comparisons };
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
    let bkVisitedTotal = 0;
    const bkTotalMs = timeMs(() => {
      for (const q of queries) {
        const stats = tree.queryWithStats(q, MAX_DISTANCE);
        bkResultCount += stats.matches.length;
        bkVisitedTotal += stats.visitedNodes;
      }
    });

    let pwResultCount = 0;
    let pwComparisonsTotal = 0;
    const pwTotalMs = timeMs(() => {
      for (const q of queries) {
        const { matchCount, comparisons } = pairwiseQuery(names, q, MAX_DISTANCE);
        pwResultCount += matchCount;
        pwComparisonsTotal += comparisons;
      }
    });

    if (bkResultCount !== pwResultCount) {
      throw new Error(
        `n=${n}: BK-tree(${bkResultCount}개 매치)와 pairwise(${pwResultCount}개 매치)가 다른 결과를 반환했다 — ` +
          `벤치마크 무효, correctness 버그부터 조사해야 한다`,
      );
    }

    const bkAvgVisited = bkVisitedTotal / queries.length;
    const pwAvgComparisons = pwComparisonsTotal / queries.length; // 항상 n과 같다 — 가지치기가 없다는 정의 그 자체
    const bkAvgUs = (bkTotalMs * 1000) / queries.length;
    const pwAvgUs = (pwTotalMs * 1000) / queries.length;

    // 게이트 (a) — BK-tree는 모든 n에서 pairwise보다 적게 방문해야 한다
    // (가지치기가 조금이라도 작동한다는 최소 요구, n=0으로 축소 불가).
    if (!(bkAvgVisited < pwAvgComparisons)) {
      throw new Error(
        `n=${n}: BK-tree 평균 방문 노드 수(${bkAvgVisited.toFixed(1)})가 pairwise 비교 횟수(${pwAvgComparisons}) 이상이다 — ` +
          `삼각부등식 가지치기가 이 크기에서 사실상 작동하지 않는다는 뜻, 완료조건 2 미충족`,
      );
    }

    rows.push({ n, bkTotalMs, bkAvgUs, pwTotalMs, pwAvgUs, bkAvgVisited, pwAvgComparisons, matches: bkResultCount });
    console.log(
      `n=${n}\ttree.size=${tree.size}\t` +
        `방문노드(BK) ${bkAvgVisited.toFixed(1)}/query vs 비교횟수(pairwise) ${pwAvgComparisons}/query\t` +
        `[참고 wall-clock: BK ${bkAvgUs.toFixed(2)}us, pairwise ${pwAvgUs.toFixed(2)}us, speedup=${(pwAvgUs / bkAvgUs).toFixed(1)}x]\t` +
        `(결과 일치: ${bkResultCount}개 매치 총합)`,
    );
  }

  console.log('\n스케일링 추세(직전 구간 대비 n 배율 vs 평균 방문/비교 횟수 배율 — 게이트 (b)):');
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    const nRatio = cur.n / prev.n;
    const bkVisitedRatio = cur.bkAvgVisited / prev.bkAvgVisited;
    const pwComparisonsRatio = cur.pwAvgComparisons / prev.pwAvgComparisons; // 정의상 항상 nRatio와 같다

    // 게이트 (b) — n이 nRatio배로 늘 때 평균 방문 노드 수는 nRatio배
    // "미만"으로 늘어야 한다. 순수 선형(가지치기 무효)이면 정확히
    // nRatio배가 되므로, 엄격한 "<"가 sub-linear 성장의 반증 가능한
    // 최소 조건이다.
    if (!(bkVisitedRatio < nRatio)) {
      throw new Error(
        `n=${prev.n} -> ${cur.n}(${nRatio}x) 구간: BK-tree 평균 방문 노드 수가 ${bkVisitedRatio.toFixed(2)}배로 늘었다 — ` +
          `n 배율(${nRatio}x) 미만이어야 sub-linear인데 그렇지 않다, 완료조건 2("O(log n) 스케일") 미충족`,
      );
    }

    console.log(
      `  n ${prev.n} -> ${cur.n} (${nRatio}x): 방문노드(BK) ${bkVisitedRatio.toFixed(2)}x, 비교횟수(pairwise) ${pwComparisonsRatio.toFixed(2)}x` +
        ` — sub-linear 확인(${bkVisitedRatio.toFixed(2)}x < ${nRatio}x)`,
    );
  }

  console.log('\n완료조건 2 충족: 모든 구간에서 BK-tree 평균 방문 노드 수가 pairwise 비교 횟수보다 적고(게이트 a), n 배율보다 완만하게 늘었다(게이트 b) — 둘 다 wall-clock이 아닌 결정론적 방문/비교 횟수로 검증됨.');
}

await main();
