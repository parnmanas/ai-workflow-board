// 회귀 테스트 — ticket e52e7f64 "[Ontology Graph 3/7] 크로스파일 리졸버
// (Tier 1.5)" 완료조건 1: "entities/index.ts 미러링 배럴 재수출 픽스처가
// 0.95(import-map) 신뢰도로 해소됨을 테스트로 확인."
//
// resolver/cascade.ts, resolver/symbol-index.ts(GraphSymbolIndex),
// resolver/bk-tree.ts, resolver/path-resolution.ts는 전부 DB/DataSource
// 의존이 없는 순수 함수/클래스다(symbol-index.ts 자신의 헤더 코멘트:
// buildGraphSymbolIndex()만 DB를 읽고, GraphSymbolIndex 클래스 자체와
// addFile/addDef/addDeclaresMember는 순수 메모리 자료구조). 이 스위트는
// DB를 전혀 띄우지 않고 GraphSymbolIndex를 직접 손으로 구성해 6-tier
// 캐스케이드 각각을 격리해서 검증한다 — 리졸버 전체를 sql.js에 대해
// end-to-end로 도는 통합 테스트는 ontology-resolver-graph-integration.test.mjs
// 몫(그 파일이 실제 extractFile()/persistFactBundles() 라운드트립까지
// 검증).
//
// 컴파일된 dist/ 대상으로 실행한다(`npm run build` 필요) — 이 스위트가
// 속한 ontology 계열 테스트 전체의 관례(1/7 선례).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', 'dist');

const { GraphSymbolIndex } = await import('file://' + path.join(DIST_ROOT, 'modules/ontology/resolver/symbol-index.js'));
const { resolveImportFactExact, resolveName, resolveRef } = await import(
  'file://' + path.join(DIST_ROOT, 'modules/ontology/resolver/cascade.js')
);
const { BKTree } = await import('file://' + path.join(DIST_ROOT, 'modules/ontology/resolver/bk-tree.js'));
const { resolveRelativeImportCandidates, findSuffixMatchingPaths } = await import(
  'file://' + path.join(DIST_ROOT, 'modules/ontology/resolver/path-resolution.js')
);

let nextId = 0;
function uid(prefix) {
  nextId += 1;
  return `${prefix}-${nextId}`;
}

function makeFile(filePath, facts = {}) {
  return {
    id: uid('file'),
    symbolId: `file:${filePath}`,
    path: filePath,
    facts: {
      refs: facts.refs ?? [],
      imports: facts.imports ?? [],
      exports: facts.exports ?? [],
      heritage: facts.heritage ?? [],
    },
  };
}

function makeDef(filePath, name, opts = {}) {
  const qualifiedName = opts.qualifiedName ?? name;
  return {
    id: uid('def'),
    symbolId: `def:${filePath}#${qualifiedName}`,
    name,
    qualifiedName,
    kind: opts.kind ?? 'function',
    type: opts.type ?? 'Callable',
    path: filePath,
    startLine: opts.startLine ?? 1,
    endLine: opts.endLine ?? 10,
  };
}

describe('cascade tier 1 — import-map (0.95): entities/index.ts 배럴 재수출 미러 픽스처', () => {
  // AWB 자신의 apps/server/src/entities/index.ts가 정확히 이 패턴을 쓴다
  // (barrel이 `export { X } from './X'`로 각 엔티티 파일을 재수출) —
  // DESIGN.md 축 1 완료조건이 지목한 바로 그 픽스처.
  it('barrel이 종단 정의 파일까지 전이적으로 추적돼 0.95/import-map으로 해소된다', () => {
    const index = new GraphSymbolIndex();
    const boardDef = makeDef('entities/Board.ts', 'Board', { kind: 'class', type: 'Type' });
    index.addDef(boardDef);
    index.addFile(makeFile('entities/Board.ts'));
    index.addFile(
      makeFile('entities/index.ts', {
        exports: [{ localName: 'Board', exportedName: 'Board', reExportSource: './Board', startLine: 3 }],
      }),
    );
    const consumer = makeFile('modules/boards/boards.service.ts', {
      imports: [{ localName: 'Board', importedName: 'Board', source: '../../entities/index', isTypeOnly: false, startLine: 1 }],
    });
    index.addFile(consumer);

    const result = resolveImportFactExact(index, consumer, consumer.facts.imports[0]);
    assert.ok(result, '배럴을 거쳐 Board 정의까지 해소돼야 한다');
    assert.equal(result.confidence, 0.95);
    assert.equal(result.resolver, 'import-map');
    assert.equal(result.nodeId, boardDef.id, '배럴 파일 자신이 아니라 종단 정의(Board.ts)를 가리켜야 한다');
  });

  it('확장자 없는 배럴 import(디렉터리 index 관례)도 같은 신뢰도로 해소된다', () => {
    const index = new GraphSymbolIndex();
    const boardDef = makeDef('entities/Board.ts', 'Board', { kind: 'class', type: 'Type' });
    index.addDef(boardDef);
    index.addFile(makeFile('entities/Board.ts'));
    index.addFile(
      makeFile('entities/index.ts', {
        exports: [{ localName: 'Board', exportedName: 'Board', reExportSource: './Board', startLine: 3 }],
      }),
    );
    // `../../entities` (파일명 생략) — path-resolution.ts의 INDEX_BASENAMES
    // 폴백 경로를 탄다(위 테스트는 명시적 `.../index` 경로).
    const consumer = makeFile('modules/boards/boards.service.ts', {
      imports: [{ localName: 'Board', importedName: 'Board', source: '../../entities', isTypeOnly: false, startLine: 1 }],
    });
    index.addFile(consumer);

    const result = resolveImportFactExact(index, consumer, consumer.facts.imports[0]);
    assert.ok(result);
    assert.equal(result.confidence, 0.95);
    assert.equal(result.resolver, 'import-map');
    assert.equal(result.nodeId, boardDef.id);
  });

  it('barrel 재수출이 여러 hop 체인이어도(barrel of barrels) 종단까지 추적한다', () => {
    const index = new GraphSymbolIndex();
    const boardDef = makeDef('entities/Board.ts', 'Board', { kind: 'class', type: 'Type' });
    index.addDef(boardDef);
    index.addFile(makeFile('entities/Board.ts'));
    index.addFile(
      makeFile('entities/index.ts', {
        exports: [{ localName: 'Board', exportedName: 'Board', reExportSource: './Board', startLine: 1 }],
      }),
    );
    // 2-hop: 상위 배럴이 entities 배럴을 그대로 재수출.
    index.addFile(
      makeFile('index.ts', {
        exports: [{ localName: 'Board', exportedName: 'Board', reExportSource: './entities/index', startLine: 1 }],
      }),
    );
    const consumer = makeFile('modules/x.ts', {
      imports: [{ localName: 'Board', importedName: 'Board', source: '../index', isTypeOnly: false, startLine: 1 }],
    });
    index.addFile(consumer);

    const result = resolveImportFactExact(index, consumer, consumer.facts.imports[0]);
    assert.ok(result, '2-hop 재수출 체인도 종단까지 추적돼야 한다');
    assert.equal(result.confidence, 0.95);
    assert.equal(result.nodeId, boardDef.id);
  });
});

describe('cascade tier 2 — same-module (0.90)', () => {
  it('같은 파일 안의 top-level def를 import 없이 해소한다', () => {
    const index = new GraphSymbolIndex();
    const helperDef = makeDef('modules/service.ts', 'helper');
    index.addDef(helperDef);
    const serviceFile = makeFile('modules/service.ts');
    index.addFile(serviceFile);

    const result = resolveName(index, serviceFile, 'helper', null);
    assert.ok(result);
    assert.equal(result.confidence, 0.9);
    assert.equal(result.resolver, 'same-module');
    assert.equal(result.nodeId, helperDef.id);
  });
});

describe('cascade tier 3 — import-suffix (0.85)', () => {
  it('정확한 상대경로 해석이 실패해도 파일경로 suffix가 일치하면 해소된다', () => {
    const index = new GraphSymbolIndex();
    const buttonDef = makeDef('src/shared/widgets/button.ts', 'Button', { kind: 'class', type: 'Type' });
    index.addDef(buttonDef);
    index.addFile(makeFile('src/shared/widgets/button.ts'));
    // 정확한 상대경로 후보는 'src/modules/widgets/button.ts'인데, 실제
    // 파일은 'src/shared/widgets/button.ts'에 있다 — exact tier는
    // 반드시 실패하고 suffix tier만 이걸 찾아낼 수 있어야 한다.
    const consumer = makeFile('src/modules/consumer.ts', {
      imports: [{ localName: 'Button', importedName: 'Button', source: './widgets/button', isTypeOnly: false, startLine: 1 }],
    });
    index.addFile(consumer);

    const result = resolveName(index, consumer, 'Button', null);
    assert.ok(result, 'suffix tier가 button.ts를 찾아내야 한다');
    assert.equal(result.confidence, 0.85);
    assert.equal(result.resolver, 'import-suffix');
    assert.equal(result.nodeId, buttonDef.id);
  });
});

describe('cascade tier 4 — unique-name (0.75)', () => {
  it('import도 same-module도 아니지만 워크스페이스 전체에서 이름이 유일하면 해소된다', () => {
    const index = new GraphSymbolIndex();
    const onlyDef = makeDef('src/only.ts', 'GloballyUniqueThing');
    index.addDef(onlyDef);
    index.addFile(makeFile('src/only.ts'));
    const consumer = makeFile('src/other.ts');
    index.addFile(consumer);

    const result = resolveName(index, consumer, 'GloballyUniqueThing', null);
    assert.ok(result);
    assert.equal(result.confidence, 0.75);
    assert.equal(result.resolver, 'unique-name');
    assert.equal(result.nodeId, onlyDef.id);
  });

  it('동명이인이면 unique-name은 실패하고(추측 금지), 다른 tier도 못 좁히면 완전 미해소로 남는다', () => {
    const index = new GraphSymbolIndex();
    index.addDef(makeDef('src/a.ts', 'Widget', { kind: 'class', type: 'Type', qualifiedName: 'Widget' }));
    index.addDef(makeDef('src/b.ts', 'Widget', { kind: 'class', type: 'Type', qualifiedName: 'Widget' }));
    index.addFile(makeFile('src/a.ts'));
    index.addFile(makeFile('src/b.ts'));
    const consumer = makeFile('src/c.ts');
    index.addFile(consumer);

    // qualifier 없음 -> suffix tier도 즉시 포기, fuzzy도 이름 자체가
    // candidates 2개라 애매해서 포기 -> 전체 캐스케이드가 null을 반환해야
    // 한다("정확한 대상보다 미해소를 택한다"는 이 리졸버 전체의 원칙).
    const result = resolveName(index, consumer, 'Widget', null);
    assert.equal(result, null);
  });
});

describe('cascade tier 5 — suffix (0.55)', () => {
  it('동명이인을 qualifier 텍스트로 좁혀서 해소한다', () => {
    const index = new GraphSymbolIndex();
    const runA = makeDef('src/a.ts', 'run', { kind: 'method', type: 'Callable', qualifiedName: 'ServiceA.run' });
    const runB = makeDef('src/b.ts', 'run', { kind: 'method', type: 'Callable', qualifiedName: 'ServiceB.run' });
    index.addDef(runA);
    index.addDef(runB);
    index.addFile(makeFile('src/a.ts'));
    index.addFile(makeFile('src/b.ts'));
    const consumer = makeFile('src/c.ts');
    index.addFile(consumer);

    const result = resolveName(index, consumer, 'run', 'ServiceA');
    assert.ok(result);
    assert.equal(result.confidence, 0.55);
    assert.equal(result.resolver, 'suffix');
    assert.equal(result.nodeId, runA.id);
  });

  it('qualifier로도 후보가 2개 이상 남으면(여전히 애매) 미해소로 남는다', () => {
    const index = new GraphSymbolIndex();
    // 두 후보 모두 qualifiedName 접두사에 같은 'Shared' 세그먼트를 갖는다
    // -> qualifier='Shared'로는 하나로 못 좁힌다.
    index.addDef(makeDef('src/a.ts', 'run', { kind: 'method', type: 'Callable', qualifiedName: 'Shared.A.run' }));
    index.addDef(makeDef('src/b.ts', 'run', { kind: 'method', type: 'Callable', qualifiedName: 'Shared.B.run' }));
    index.addFile(makeFile('src/a.ts'));
    index.addFile(makeFile('src/b.ts'));
    const consumer = makeFile('src/c.ts');
    index.addFile(consumer);

    const result = resolveName(index, consumer, 'run', 'Shared');
    assert.equal(result, null);
  });
});

describe('cascade tier 6 — fuzzy (0.35), BK-tree 경유', () => {
  it('편집거리 1 이내의 오타를 유일한 후보로 좁혀 해소한다', () => {
    const index = new GraphSymbolIndex();
    const def = makeDef('src/widget.ts', 'WidgetService', { kind: 'class', type: 'Type' });
    index.addDef(def);
    index.addFile(makeFile('src/widget.ts'));
    const consumer = makeFile('src/c.ts');
    index.addFile(consumer);

    // 'WidgetServic' -- 마지막 'e' 하나가 빠진 오타(편집거리 1).
    const result = resolveName(index, consumer, 'WidgetServic', null);
    assert.ok(result, '편집거리 1의 오타는 fuzzy tier가 잡아내야 한다');
    assert.equal(result.confidence, 0.35);
    assert.equal(result.resolver, 'fuzzy');
    assert.equal(result.nodeId, def.id);
  });

  it('동률 최근접 후보가 여럿이면 추측하지 않고 미해소로 남는다', () => {
    const index = new GraphSymbolIndex();
    index.addDef(makeDef('src/a.ts', 'Bat'));
    index.addDef(makeDef('src/b.ts', 'Cot'));
    index.addFile(makeFile('src/a.ts'));
    index.addFile(makeFile('src/b.ts'));
    const consumer = makeFile('src/c.ts');
    index.addFile(consumer);

    // 'Cat'은 'Bat'과 'Cot' 양쪽에서 편집거리 1로 동률.
    const result = resolveName(index, consumer, 'Cat', null);
    assert.equal(result, null);
  });

  it('편집거리가 유일하게 가장 가까워도 그 이름의 def 자체가 여럿이면 미해소로 남는다', () => {
    const index = new GraphSymbolIndex();
    index.addDef(makeDef('src/a.ts', 'Widget', { qualifiedName: 'Widget' }));
    index.addDef(makeDef('src/b.ts', 'Widget', { qualifiedName: 'Widget' }));
    index.addFile(makeFile('src/a.ts'));
    index.addFile(makeFile('src/b.ts'));
    const consumer = makeFile('src/c.ts');
    index.addFile(consumer);

    const result = resolveName(index, consumer, 'Widgt', null); // 'Widget'에서 'e' 탈락, 편집거리 1
    assert.equal(result, null);
  });
});

describe('resolveRef — qualifier가 있는 멤버 접근(Foo.doSomething())', () => {
  it('qualifier를 컨테이너로 해소한 뒤 그 DECLARES 멤버를 찾는다 (컨테이너의 confidence/resolver를 물려받는다)', () => {
    const index = new GraphSymbolIndex();
    const widgetType = makeDef('src/widget.ts', 'Widget', { kind: 'class', type: 'Type' });
    index.addDef(widgetType);
    const renderMethod = makeDef('src/widget.ts', 'render', { kind: 'method', type: 'Callable', qualifiedName: 'Widget.render' });
    index.addDef(renderMethod);
    index.addDeclaresMember(widgetType.id, renderMethod);
    index.addFile(makeFile('src/widget.ts'));
    const consumer = makeFile('src/consumer.ts', {
      imports: [{ localName: 'Widget', importedName: 'Widget', source: './widget', isTypeOnly: false, startLine: 1 }],
    });
    index.addFile(consumer);

    const result = resolveRef(index, consumer, { name: 'render', qualifier: 'Widget' });
    assert.ok(result);
    assert.equal(result.nodeId, renderMethod.id);
    assert.equal(result.confidence, 0.95, '컨테이너(import-map)의 confidence를 그대로 물려받아야 한다');
    assert.equal(result.resolver, 'import-map');
  });

  it('컨테이너는 해소돼도 그 이름의 멤버가 없으면 전역 이름 검색으로 폴백하지 않고 미해소로 남는다', () => {
    const index = new GraphSymbolIndex();
    const widgetType = makeDef('src/widget.ts', 'Widget', { kind: 'class', type: 'Type' });
    index.addDef(widgetType);
    index.addFile(makeFile('src/widget.ts'));
    const consumer = makeFile('src/consumer.ts', {
      imports: [{ localName: 'Widget', importedName: 'Widget', source: './widget', isTypeOnly: false, startLine: 1 }],
    });
    index.addFile(consumer);

    const result = resolveRef(index, consumer, { name: 'missingMethod', qualifier: 'Widget' });
    assert.equal(result, null);
  });

  it('qualifier 자체를 모르면(지역 변수 등) 타입을 추측하지 않고 미해소로 남는다', () => {
    const index = new GraphSymbolIndex();
    const consumer = makeFile('src/consumer.ts');
    index.addFile(consumer);

    const result = resolveRef(index, consumer, { name: 'render', qualifier: 'localVarNotInGraph' });
    assert.equal(result, null);
  });

  it('qualifier가 없으면(bare call) resolveName과 동일하게 동작한다', () => {
    const index = new GraphSymbolIndex();
    const helperDef = makeDef('src/service.ts', 'helper');
    index.addDef(helperDef);
    const serviceFile = makeFile('src/service.ts');
    index.addFile(serviceFile);

    const result = resolveRef(index, serviceFile, { name: 'helper', qualifier: null });
    assert.ok(result);
    assert.equal(result.resolver, 'same-module');
    assert.equal(result.nodeId, helperDef.id);
  });
});

describe('BKTree — 직접 단위테스트', () => {
  it('편집거리 이내의 모든 단어를 거리 오름차순으로 반환하고, 범위 밖은 제외한다', () => {
    const tree = new BKTree();
    for (const w of ['book', 'books', 'boo', 'boot', 'cake', 'cape']) tree.insert(w);
    const matches = tree.query('book', 1);
    const words = matches.map((m) => m.word);
    assert.deepEqual(new Set(words), new Set(['book', 'boo', 'boot', 'books']), 'cake/cape는 편집거리 1 밖이라 빠져야 한다');
    assert.equal(matches[0].word, 'book');
    assert.equal(matches[0].distance, 0);
    for (let i = 1; i < matches.length; i++) assert.ok(matches[i].distance >= matches[i - 1].distance, '거리 오름차순이어야 한다');
  });

  it('maxDistance를 넘는 단어는 절대 반환하지 않는다', () => {
    const tree = new BKTree();
    for (const w of ['alpha', 'beta', 'gamma', 'delta', 'omega']) tree.insert(w);
    const matches = tree.query('alpha', 1);
    assert.deepEqual(matches.map((m) => m.word), ['alpha']);
  });

  it('빈 트리는 항상 빈 배열을 반환한다', () => {
    const tree = new BKTree();
    assert.deepEqual(tree.query('anything', 5), []);
  });

  it('중복 단어를 삽입해도 size가 늘지 않는다', () => {
    const tree = new BKTree();
    tree.insert('same');
    tree.insert('same');
    tree.insert('same');
    assert.equal(tree.size, 1);
  });

  it('queryWithStats()는 query()와 완전히 같은 매치를 반환하고, 방문 노드 수는 트리 크기보다 적다(가지치기가 실제로 일어난다)', () => {
    const words = [
      'apple', 'banana', 'cherry', 'date', 'eggplant', 'fig', 'grape', 'honeydew',
      'kiwi', 'lemon', 'mango', 'nectarine', 'orange', 'papaya', 'quince', 'raspberry',
      'strawberry', 'tangerine', 'ugli', 'vanilla', 'watermelon', 'ximenia', 'yam', 'zucchini',
    ];
    const tree = new BKTree();
    for (const w of words) tree.insert(w);
    assert.equal(tree.size, words.length);

    const stats = tree.queryWithStats('kiwi', 1);
    const direct = tree.query('kiwi', 1);
    assert.deepEqual(stats.matches, direct, 'queryWithStats().matches는 query()와 같은 순회 코드 경로를 공유하므로 결과가 완전히 같아야 한다');
    assert.ok(stats.visitedNodes > 0);
    assert.ok(
      stats.visitedNodes < tree.size,
      `삼각부등식 가지치기가 실제로 작동해 트리 전체(${tree.size}개)를 방문하지 않아야 한다 — 실제 방문 ${stats.visitedNodes}개`,
    );
  });

  it('빈 트리에서 queryWithStats()는 visitedNodes=0을 반환한다', () => {
    const tree = new BKTree();
    const stats = tree.queryWithStats('anything', 5);
    assert.deepEqual(stats.matches, []);
    assert.equal(stats.visitedNodes, 0);
  });
});

describe('path-resolution — 순수 함수 직접 테스트', () => {
  it('resolveRelativeImportCandidates: bare specifier(패키지 임포트)는 후보를 만들지 않는다', () => {
    assert.deepEqual(resolveRelativeImportCandidates('src/a.ts', 'react'), []);
  });

  it('resolveRelativeImportCandidates: 상대경로는 확장자/인덱스 후보를 폭넓게 생성한다', () => {
    const candidates = resolveRelativeImportCandidates('src/modules/a.ts', './widget');
    assert.ok(candidates.includes('src/modules/widget.ts'));
    assert.ok(candidates.includes('src/modules/widget/index.ts'));
  });

  it('findSuffixMatchingPaths: 확장자를 무시하고 경로 세그먼트 suffix로 매칭한다', () => {
    const matches = findSuffixMatchingPaths('./widgets/button', ['src/shared/widgets/button.tsx', 'src/other/thing.ts']);
    assert.deepEqual(matches, ['src/shared/widgets/button.tsx']);
  });
});
