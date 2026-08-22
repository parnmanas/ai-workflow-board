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
const { langForPath, EXTRACTOR_VERSION } = await import('file://' + path.join(DIST_ROOT, 'modules/ontology/extraction/types.js'));

describe('langForPath (ticket e14ef1c9)', () => {
  it('maps extensions to the three supported languages, and rejects unknown extensions', () => {
    assert.equal(langForPath('a/b.ts'), 'typescript');
    assert.equal(langForPath('a/b.mts'), 'typescript');
    assert.equal(langForPath('a/b.cts'), 'typescript');
    assert.equal(langForPath('a/b.tsx'), 'tsx');
    assert.equal(langForPath('a/b.js'), 'javascript');
    assert.equal(langForPath('a/b.jsx'), 'javascript');
    assert.equal(langForPath('a/b.mjs'), 'javascript');
    assert.equal(langForPath('a/b.cjs'), 'javascript');
    assert.equal(langForPath('a/b.py'), null);
    assert.equal(langForPath('a/b.json'), null);
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
