// 회귀 테스트 — ticket e14ef1c9
// "[Ontology Graph 2/7] 추출 워커 — tree-sitter WASM Tier 1 + NestJS
// 리플렉션 룰셋"
//
// extract-file.ts(tree-sitter WASM 태그 쿼리 -> FactBundle)와
// decorator-rules.ts(ast-grep NestJS 룰셋 -> DecoratorFact[])의 순수 함수
// 정확성만 검증한다 — DB/워커풀은 다른 두 스위트(
// ontology-extraction-decorator-dogfood.test.mjs,
// ontology-extraction-population-nonblocking.test.mjs) 몫.
//
// 컴파일된 dist/ 대상으로 실행한다(`npm run build` 필요, test 스크립트가
// 보장) — 1/7의 ontology-sqljs-independent-datasource.test.mjs와 같은 관례.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', 'dist');

const { extractFile } = await import('file://' + path.join(DIST_ROOT, 'modules/ontology/extraction/extract-file.js'));
const { extractDecoratorFacts } = await import('file://' + path.join(DIST_ROOT, 'modules/ontology/extraction/decorator-rules.js'));
const { langForPath, EXTRACTOR_VERSION, TAG_QUERY_VERIFIED_LANGS } = await import('file://' + path.join(DIST_ROOT, 'modules/ontology/extraction/types.js'));
const { smokeTestGrammar } = await import('file://' + path.join(DIST_ROOT, 'modules/ontology/extraction/grammars.js'));

// tree-sitter-wasms가 실제로 번들하는 36개 언어 전체(리뷰 지적 라운드 1 —
// `ls node_modules/tree-sitter-wasms/out`으로 직접 확인한 그대로) — 이
// 목록이 grammars.ts의 GRAMMAR_FILES/types.ts의 ExtractionLang과 어긋나면
// 이 테스트가 즉시 깨진다.
const ALL_36_LANGS = [
  'typescript', 'tsx', 'javascript', 'bash', 'c', 'cpp', 'c_sharp', 'css', 'dart',
  'elisp', 'elixir', 'elm', 'embedded_template', 'go', 'html', 'java', 'json',
  'kotlin', 'lua', 'objc', 'ocaml', 'php', 'python', 'ql', 'rescript', 'ruby',
  'rust', 'scala', 'solidity', 'swift', 'systemrdl', 'tlaplus', 'toml', 'vue',
  'yaml', 'zig',
];

describe('langForPath — 36-language tree-sitter-wasms bundle (ticket e14ef1c9, 리뷰 지적 라운드 1)', () => {
  it('maps the TS/JS family via its own multi-extension branch', () => {
    assert.equal(langForPath('a/b.ts'), 'typescript');
    assert.equal(langForPath('a/b.mts'), 'typescript');
    assert.equal(langForPath('a/b.cts'), 'typescript');
    assert.equal(langForPath('a/b.tsx'), 'tsx');
    assert.equal(langForPath('a/b.js'), 'javascript');
    assert.equal(langForPath('a/b.jsx'), 'javascript');
    assert.equal(langForPath('a/b.mjs'), 'javascript');
    assert.equal(langForPath('a/b.cjs'), 'javascript');
  });

  it('maps a sample of the other 33 bundled languages by extension', () => {
    assert.equal(langForPath('a/b.py'), 'python');
    assert.equal(langForPath('a/b.rs'), 'rust');
    assert.equal(langForPath('a/b.go'), 'go');
    assert.equal(langForPath('a/b.rb'), 'ruby');
    assert.equal(langForPath('a/b.java'), 'java');
    assert.equal(langForPath('a/b.php'), 'php');
    assert.equal(langForPath('a/b.swift'), 'swift');
    assert.equal(langForPath('a/b.kt'), 'kotlin');
    assert.equal(langForPath('a/b.yaml'), 'yaml');
    assert.equal(langForPath('a/b.yml'), 'yaml');
    assert.equal(langForPath('a/b.toml'), 'toml');
    assert.equal(langForPath('a/b.json'), 'json');
  });

  it('rejects a genuinely unrecognized extension', () => {
    assert.equal(langForPath('a/b.xyz-not-a-real-extension'), null);
    assert.equal(langForPath('a/b'), null);
  });

  it('TAG_QUERY_VERIFIED_LANGS is exactly the hand-verified TS/TSX/JS set — extraction is honestly scoped narrower than grammar loading', () => {
    assert.deepEqual([...TAG_QUERY_VERIFIED_LANGS].sort(), ['javascript', 'tsx', 'typescript']);
  });

  // trap #1(research-extraction.md §6)이 바로 이걸 예견했다 — ABI 불일치는
  // 로드 시점이 아니라 실제로 한 번 파싱해봐야 드러난다. 이 스위트를 처음
  // 작성하며 36개 전부를 실제로 돌려본 결과 3개가 진짜로 깨졌다: elm/ql은
  // "memory access out of bounds"(WASM 힙 경계 침범 — 전형적 ABI
  // 불일치), yaml은 "resolved is not a function". 세 개 다 재현
  // 가능하고 안정적이다(반복 실행해도 항상 이 3개만 실패) — 나머지
  // 33개는 항상 통과한다. quarantine 대상을 하드코딩하는 대신 매번 실제로
  // 돌려서 확인한다 — 언젠가 tree-sitter-wasms가 이 그래머들을 고치면
  // 이 테스트가 자동으로 "예상과 다르게 통과함"을 잡아낸다(아래 두 번째
  // 단언).
  const KNOWN_GRAMMAR_LOAD_FAILURES = new Set(['elm', 'ql', 'yaml']);

  it('33 of the 36 bundled grammars load and parse cleanly; the 3 known-broken ones are quarantined by name, not silently ignored', async () => {
    const unexpectedFailures = [];
    const unexpectedSuccesses = [];
    for (const lang of ALL_36_LANGS) {
      const result = await smokeTestGrammar(lang);
      const expectedToFail = KNOWN_GRAMMAR_LOAD_FAILURES.has(lang);
      if (!result.ok && !expectedToFail) unexpectedFailures.push(`${lang}: ${result.error}`);
      if (result.ok && expectedToFail) unexpectedSuccesses.push(lang);
    }
    assert.deepEqual(unexpectedFailures, [], `quarantine 목록 밖의 언어가 깨졌다(회귀) — ${JSON.stringify(unexpectedFailures)}`);
    assert.deepEqual(unexpectedSuccesses, [], `quarantine 목록의 언어가 이제 통과한다 — KNOWN_GRAMMAR_LOAD_FAILURES에서 빼야 한다: ${JSON.stringify(unexpectedSuccesses)}`);
  });

  it('extractFile honestly skips extraction for a grammar-loadable-but-unverified language, without pretending it parsed', async () => {
    const bundle = await extractFile('fixture.py', 'def hello():\n    pass\n', 'python');
    assert.equal(bundle.skippedReason, 'no_tag_query_for_language');
    assert.deepEqual(bundle.defs, []);
  });

  // elm/ql/yaml은 오늘 기준 셋 다 태그 쿼리도 없다(!query 분기가 먼저
  // 스킵한다) — 하지만 실제로 어느 try/catch가 먼저 걸리는지는 이 프로세스
  // 안에서 이전에 어떤 그래머들이 이미 로드됐는지(WASM 런타임 공유 상태)에
  // 따라 갈린다는 걸 직접 관찰했다: 이 테스트를 단독 프로세스에서 돌리면
  // elm/ql은 setLanguage()에서 "Incompatible language version"으로,
  // yaml은 parse()에서 별개의 내부 에러로 깨지지만(위 스모크 테스트 결과),
  // 같은 프로세스에서 다른 그래머 수십 개를 먼저 로드한 뒤에는 그중 일부가
  // getLangHandle() 자체에서 먼저 실패하는 것으로 관측되기도 한다 — 정확히
  // *어느* try/catch가 잡느냐는 비결정적이지만, *어느 쪽이든 항상 잡아서
  // 크래시 없이 정직한 스킵으로 떨어진다*는 것이 이 방어 코드가 실제로
  // 보장해야 하는 불변식이다. 그래서 정확한 skippedReason 값 하나로
  // 고정하지 않고 "두 스킵 카테고리 중 하나"로 단언한다.
  const VALID_GRAMMAR_SKIP_REASONS = new Set(['no_tag_query_for_language', 'grammar_load_failed']);

  it('extractFile never throws for any of the 3 grammar-quarantined languages — always resolves to a clean, known skippedReason', async () => {
    for (const lang of KNOWN_GRAMMAR_LOAD_FAILURES) {
      const bundle = await extractFile(`fixture.${lang}`, 'placeholder content\n', lang);
      assert.ok(
        VALID_GRAMMAR_SKIP_REASONS.has(bundle.skippedReason),
        `${lang}: skippedReason이 알려진 스킵 카테고리가 아니다 — ${bundle.skippedReason}`,
      );
      assert.deepEqual(bundle.defs, []);
    }
  });
});

describe('extractFile — TypeScript fact bundle shape (ticket e14ef1c9, DESIGN.md 축 1 Tier 1)', () => {
  const SRC = `
import { Foo, Bar as Baz } from './foo';
import * as ns from './ns';
import Default from './default';
import type { OnlyType } from './types-only';
export { A, B as C } from './re-export';

/** doc for MyClass */
export class MyClass extends Base implements IFoo, IBar {
  private x: number = 1;

  /** doc for method */
  async doThing(a: number): Promise<void> {
    this.other.call(a);
    plainCall(a);
    new Something();
  }
}

export function topFn() {}

export const arrowFn = (x: number) => x + 1;

interface IFoo extends IBase {
  bar(): void;
}

type MyType = { a: number };

enum Color { Red, Green }

class NotExported {}
`;

  it('extracts defs with correct kind, nesting (qualifiedName/parentQualifiedName), and exported flag', async () => {
    const bundle = await extractFile('fixture.ts', SRC, 'typescript');
    assert.equal(bundle.path, 'fixture.ts');
    assert.equal(bundle.lang, 'typescript');
    assert.equal(bundle.hasParseError, false);
    assert.equal(bundle.skippedReason, null);
    assert.equal(bundle.extractorVersion, EXTRACTOR_VERSION);
    assert.equal(bundle.fileHash, '', 'extract-file.ts는 fileHash를 채우지 않는다 — worker.ts(XXH3)의 몫');

    const byQn = Object.fromEntries(bundle.defs.map((d) => [d.qualifiedName, d]));

    assert.equal(byQn['MyClass'].kind, 'class');
    assert.equal(byQn['MyClass'].parentQualifiedName, null);
    assert.equal(byQn['MyClass'].exported, true);
    assert.equal(byQn['MyClass'].docstring, '/** doc for MyClass */');

    assert.equal(byQn['MyClass.x'].kind, 'field');
    assert.equal(byQn['MyClass.x'].parentQualifiedName, 'MyClass');
    assert.equal(byQn['MyClass.x'].exported, false, 'class 멤버는 독립적으로 exported로 표시되지 않는다');

    assert.equal(byQn['MyClass.doThing'].kind, 'method');
    assert.equal(byQn['MyClass.doThing'].parentQualifiedName, 'MyClass');
    assert.equal(byQn['MyClass.doThing'].docstring, '/** doc for method */');

    assert.equal(byQn['topFn'].kind, 'function');
    assert.equal(byQn['topFn'].exported, true);

    assert.equal(byQn['arrowFn'].kind, 'function', '변수에 바인딩된 화살표 함수는 function으로 합류');
    assert.equal(byQn['arrowFn'].exported, true);

    assert.equal(byQn['IFoo'].kind, 'interface');
    assert.equal(byQn['IFoo'].exported, false, '이 fixture의 IFoo는 export 안 됨');

    assert.equal(byQn['MyType'].kind, 'type');
    assert.equal(byQn['Color'].kind, 'enum');

    assert.equal(byQn['NotExported'].kind, 'class');
    assert.equal(byQn['NotExported'].exported, false);
  });

  it('resolves heritage facts to the real (possibly nested) qualifiedName, not just the bare name', async () => {
    const bundle = await extractFile('fixture.ts', SRC, 'typescript');
    const byRelation = (name, rel) => bundle.heritage.find((h) => h.ofQualifiedName === name && h.relation === rel);

    assert.ok(byRelation('MyClass', 'extends'));
    assert.equal(byRelation('MyClass', 'extends').targetName, 'Base');
    const implementsTargets = bundle.heritage.filter((h) => h.ofQualifiedName === 'MyClass' && h.relation === 'implements').map((h) => h.targetName);
    assert.deepEqual(implementsTargets.sort(), ['IBar', 'IFoo']);

    assert.ok(byRelation('IFoo', 'extends'));
    assert.equal(byRelation('IFoo', 'extends').targetName, 'IBase');
  });

  it('extracts refs (unresolved call/new — qualifier + call shape)', async () => {
    const bundle = await extractFile('fixture.ts', SRC, 'typescript');
    const qualified = bundle.refs.find((r) => r.name === 'call' && r.qualifier === 'this.other');
    assert.ok(qualified, 'this.other.call(a)를 qualified call로 캡처해야 한다');
    assert.equal(qualified.callShape, 'call');

    const plain = bundle.refs.find((r) => r.name === 'plainCall');
    assert.ok(plain);
    assert.equal(plain.qualifier, null);
    assert.equal(plain.callShape, 'call');

    const ctor = bundle.refs.find((r) => r.name === 'Something' && r.callShape === 'new');
    assert.ok(ctor);
  });

  it('joins import name captures with their statement-level source, including alias/namespace/default/type-only', async () => {
    const bundle = await extractFile('fixture.ts', SRC, 'typescript');
    const byLocal = Object.fromEntries(bundle.imports.map((i) => [i.localName, i]));

    assert.equal(byLocal['Foo'].importedName, 'Foo');
    assert.equal(byLocal['Foo'].source, './foo');
    assert.equal(byLocal['Foo'].isTypeOnly, false);

    assert.equal(byLocal['Baz'].importedName, 'Bar', 'alias — importedName은 원본 이름, localName은 별칭');
    assert.equal(byLocal['Baz'].source, './foo');

    assert.equal(byLocal['ns'].source, './ns');
    assert.equal(byLocal['Default'].importedName, 'default');
    assert.equal(byLocal['Default'].source, './default');

    assert.equal(byLocal['OnlyType'].source, './types-only');
    assert.equal(byLocal['OnlyType'].isTypeOnly, true, "'import type { X } from ...' 전체 문 형태는 감지해야 한다");
  });

  it('joins export specifier captures with their statement-level re-export source', async () => {
    const bundle = await extractFile('fixture.ts', SRC, 'typescript');
    const byLocal = Object.fromEntries(bundle.exports.map((e) => [e.localName, e]));

    assert.equal(byLocal['A'].exportedName, 'A');
    assert.equal(byLocal['A'].reExportSource, './re-export');
    assert.equal(byLocal['B'].exportedName, 'C', 'alias — exportedName은 별칭');
    assert.equal(byLocal['B'].reExportSource, './re-export');
  });

  it('returns partial results (not a throw) for a file with a syntax error, and flags hasParseError', async () => {
    const broken = 'export class Broken { method( { }';
    const bundle = await extractFile('broken.ts', broken, 'typescript');
    assert.equal(bundle.hasParseError, true);
    assert.equal(bundle.skippedReason, null, '파싱 에러여도 스킵이 아니라 부분 결과를 반환해야 한다');
  });

  it('skips (skippedReason set, no parse attempted) content over the size cap', async () => {
    const huge = 'x'.repeat(2_000_001);
    const bundle = await extractFile('huge.ts', huge, 'typescript');
    assert.equal(bundle.skippedReason, 'file_too_large');
    assert.deepEqual(bundle.defs, []);
  });
});

describe('extractFile — JavaScript grammar (no interface/type/enum, different field-def node shape)', () => {
  it('extracts class/method/field/heritage from plain JS without TS-only constructs', async () => {
    const src = `
class Base {}
class Foo extends Base {
  x = 1;
  method() { return 1; }
}
function topFn() {}
const arrow = () => 1;
`;
    const bundle = await extractFile('fixture.js', src, 'javascript');
    assert.equal(bundle.hasParseError, false);
    const byQn = Object.fromEntries(bundle.defs.map((d) => [d.qualifiedName, d]));
    assert.equal(byQn['Foo'].kind, 'class');
    assert.equal(byQn['Foo.x'].kind, 'field');
    assert.equal(byQn['Foo.method'].kind, 'method');
    assert.equal(byQn['topFn'].kind, 'function');
    assert.equal(byQn['arrow'].kind, 'function');

    const heritage = bundle.heritage.find((h) => h.ofQualifiedName === 'Foo');
    assert.ok(heritage);
    assert.equal(heritage.relation, 'extends');
    assert.equal(heritage.targetName, 'Base');
  });
});

describe('extractDecoratorFacts — minimal NestJS ast-grep ruleset (ticket e14ef1c9, REVIEW-NOTES.md I6)', () => {
  const SRC = `
@UseGuards(AuthGuard)
@Controller('boards')
export class BoardsController {
  @UseGuards(AdminGuard)
  @Get('x')
  method1() {}

  @UseGuards(AuthGuard, RoleGuard)
  method2() {}

  @UseInterceptors(LoggingInterceptor)
  method3() {}

  @UsePipes(ValidationPipe)
  method4() {}
}

@Injectable()
export class SomeService {
  @Cron('0 0 * * *')
  handleCron() {}

  @EventPattern('foo.bar')
  handleEvent(data) {}
}
`;

  it('finds class- and method-level guard/interceptor/pipe decorators with the correct decorated target (sibling lookup, not ancestor)', () => {
    const facts = extractDecoratorFacts('fixture.ts', SRC, 'typescript');

    const classGuard = facts.find((f) => f.family === 'guard' && f.targetKind === 'class');
    assert.ok(classGuard, 'AuthGuard가 클래스 레벨 @UseGuards를 커버해야 한다 (완료조건 2의 실제 대상)');
    assert.equal(classGuard.targetName, 'BoardsController');
    assert.deepEqual(classGuard.argIdentifiers, ['AuthGuard']);

    const method1Guard = facts.find((f) => f.family === 'guard' && f.targetName === 'method1');
    assert.ok(method1Guard, '메서드 데코레이터가 감싸는 클래스가 아니라 메서드 자신으로 귀속돼야 한다');
    assert.deepEqual(method1Guard.argIdentifiers, ['AdminGuard']);

    const method2Guard = facts.find((f) => f.family === 'guard' && f.targetName === 'method2');
    assert.deepEqual(method2Guard.argIdentifiers.sort(), ['AuthGuard', 'RoleGuard'], '다중 인자 — 콤마 토큰이 식별자로 새지 않아야 한다');

    const interceptor = facts.find((f) => f.family === 'interceptor');
    assert.equal(interceptor.targetName, 'method3');
    assert.deepEqual(interceptor.argIdentifiers, ['LoggingInterceptor']);

    const pipe = facts.find((f) => f.family === 'pipe');
    assert.equal(pipe.targetName, 'method4');
    assert.deepEqual(pipe.argIdentifiers, ['ValidationPipe']);
  });

  it('detects @Cron()/@EventPattern() with no identifier args (string-literal arguments only)', () => {
    const facts = extractDecoratorFacts('fixture.ts', SRC, 'typescript');
    const cron = facts.find((f) => f.family === 'cron');
    assert.ok(cron);
    assert.equal(cron.targetName, 'handleCron');
    assert.deepEqual(cron.argIdentifiers, []);

    const eventPattern = facts.find((f) => f.family === 'event_pattern');
    assert.ok(eventPattern);
    assert.equal(eventPattern.targetName, 'handleEvent');
    assert.deepEqual(eventPattern.argIdentifiers, []);
  });

  it('returns no facts for plain JavaScript (NestJS decorators are a TS-only convention)', () => {
    const facts = extractDecoratorFacts('fixture.js', SRC, 'javascript');
    assert.deepEqual(facts, []);
  });

  it('returns no facts for a file with no matching decorators', () => {
    const facts = extractDecoratorFacts('fixture.ts', 'export class Plain {}', 'typescript');
    assert.deepEqual(facts, []);
  });
});
