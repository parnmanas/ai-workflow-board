// 의존성 없는 in-process BK-tree(ticket e52e7f64, DESIGN.md 축 1 —
// REVIEW-NOTES.md S6). fuzzy(~0.35) tier 전용 — pairwise 문자열 비교가
// O(refs × defs)로 폭발하는 걸 피하기 위해, 워크스페이스 심볼명 전체에
// 대해 편집거리 기반 O(log n) 평균 룩업을 제공한다(메트릭 트리의 표준
// 결과 — 삼각부등식으로 후보 서브트리를 가지치기한다). sql.js FTS5는
// 기본 빌드에 컴파일돼 있지 않아(같은 리뷰 지적) 채택 불가라고 이미
// REVIEW-NOTES.md S6에서 명시적으로 기각됐다 — 이 파일은 SQLite 확장이
// 전혀 필요 없다.

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  let prev = new Array<number>(bl + 1);
  let curr = new Array<number>(bl + 1);
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

interface BKNode {
  word: string;
  children: Map<number, BKNode>;
}

export interface BKMatch {
  word: string;
  distance: number;
}

export interface BKQueryStats {
  matches: BKMatch[];
  /** 이번 query()가 실제로 방문한 노드 수(= levenshtein 호출 횟수). 트리
   *  전체 크기 이하로 항상 bounded — 삼각부등식 가지치기가 실제로 작동하는지
   *  wall-clock 없이 결정론적으로 계측하기 위한 용도(scripts/benchmark-bk-tree.mjs,
   *  리뷰 지적 — 완료조건 2를 wall-clock 노이즈가 아니라 실제 게이트로). */
  visitedNodes: number;
}

/** 편집거리 메트릭 위의 BK-tree — insert()는 추출 런당 워크스페이스 심볼명
 *  전체에 대해 한 번씩, query()는 미해소 참조 하나당 한 번 호출된다. 둘 다
 *  평균 O(log n) 노드 방문(가지치기 덕분) — pairwise 비교(O(n))와 달리
 *  워크스페이스 규모가 커져도 완만하게 스케일한다. */
export class BKTree {
  private root: BKNode | null = null;
  private _size = 0;

  get size(): number {
    return this._size;
  }

  insert(word: string): void {
    if (!this.root) {
      this.root = { word, children: new Map() };
      this._size += 1;
      return;
    }
    let cur = this.root;
    for (;;) {
      const d = levenshtein(word, cur.word);
      if (d === 0) return; // 이미 트리에 있는 단어 — 중복 삽입 없음
      const child = cur.children.get(d);
      if (!child) {
        cur.children.set(d, { word, children: new Map() });
        this._size += 1;
        return;
      }
      cur = child;
    }
  }

  /** word와 편집거리 maxDistance 이하인 모든 단어를 distance 오름차순(동률은
   *  사전순)으로 반환한다. */
  query(word: string, maxDistance: number): BKMatch[] {
    return this.queryWithStats(word, maxDistance).matches;
  }

  /** query()와 완전히 같은 순회 코드 경로를 공유하되(별도로 복제된 로직
   *  아님), 실제로 방문한 노드 수도 함께 반환한다 — query()의 기존
   *  시그니처/동작은 그대로 유지된다. */
  queryWithStats(word: string, maxDistance: number): BKQueryStats {
    if (!this.root) return { matches: [], visitedNodes: 0 };
    const out: BKMatch[] = [];
    let visitedNodes = 0;
    const stack: BKNode[] = [this.root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      visitedNodes += 1;
      const d = levenshtein(word, node.word);
      if (d <= maxDistance) out.push({ word: node.word, distance: d });
      // 삼각부등식 가지치기: edge와 d의 차이가 maxDistance를 넘는 자식
      // 서브트리는 절대 maxDistance 안의 매치를 담을 수 없다 — 이게
      // BK-tree가 O(log n)인 이유(pairwise면 이 가지치기가 없다).
      for (const [edge, child] of node.children) {
        if (Math.abs(edge - d) <= maxDistance) stack.push(child);
      }
    }
    out.sort((a, b) => a.distance - b.distance || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));
    return { matches: out, visitedNodes };
  }
}
