// WASM 문법 로딩 — web-tree-sitter Parser/Language(ticket e14ef1c9, DESIGN.md
// 축 1). 이 모듈은 워커 스레드 안에서만 임포트된다: Parser/Language/Tree는
// 워커 하나의 WASM 힙에 묶인 stateful 객체라 메인 스레드와 공유할 수 없다
// (trap #2, research-extraction.md §6).
//
// 그래머 소스 — 리뷰 지적(라운드 1)으로 재검증·확장: 티켓이 인용한
// `kreuzberg-dev/tree-sitter-language-pack`은 그 이름으로는 npm 패키지가
// 아니다. 실재하는 패키지는 `@xberg-io/` 스코프(`@xberg-io/
// tree-sitter-language-pack` — 371언어, native N-API 8개 플랫폼 바이너리;
// `@xberg-io/tree-sitter-language-pack-wasm` — 같은 371언어, 언어당 .wasm이
// 아니라 Rust 코어 전체를 하나로 컴파일한 단일 WASM 블롭 + 자체 JS
// wrapper)인데, 둘 다 직접 설치해 확인한 결과 web-tree-sitter의
// `Language.load(path)`가 기대하는 "언어당 로드 가능한 .wasm 파일" 소스가
// 아니라 자기 완결적인 별도 Parser/Node/Tree API를 노출한다 — web-tree-sitter와
// 나란히 쓸 방법이 없고, 채택하려면 티켓이 명시한 "web-tree-sitter(WASM)"
// 자체를 버려야 한다(이 티켓 범위에서 임의로 뒤집지 않는다).
// tree-sitter-wasms(이미 의존성, Unlicense)가 실제로 web-tree-sitter와
// 맞물리는 유일한 다국어 grammar 소스라 그 번들 전체(36언어, `ls
// node_modules/tree-sitter-wasms/out` 직접 확인)로 그래머 파일 매핑을
// 넓혔다. 문법 로딩(smokeTestGrammar)은 36개 전부 대상이지만, 태그 쿼리
// 기반 fact 추출은 types.ts의 TAG_QUERY_VERIFIED_LANGS(typescript/tsx/
// javascript)만 보장 — 나머지는 그래머는 로드되지만 태그 쿼리가 없다
// (extract-file.ts가 정직하게 skippedReason으로 스킵).
import * as path from 'path';
import { Parser, Language, Query } from 'web-tree-sitter';
import type { ExtractionLang } from './types';
import { TAG_QUERY_VERIFIED_LANGS } from './types';
import { TYPESCRIPT_FAMILY_TAGS_QUERY } from './tag-queries/typescript-family';
import { JAVASCRIPT_TAGS_QUERY } from './tag-queries/javascript';

const GRAMMAR_FILES: Record<ExtractionLang, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  bash: 'tree-sitter-bash.wasm',
  c: 'tree-sitter-c.wasm',
  cpp: 'tree-sitter-cpp.wasm',
  c_sharp: 'tree-sitter-c_sharp.wasm',
  css: 'tree-sitter-css.wasm',
  dart: 'tree-sitter-dart.wasm',
  elisp: 'tree-sitter-elisp.wasm',
  elixir: 'tree-sitter-elixir.wasm',
  elm: 'tree-sitter-elm.wasm',
  embedded_template: 'tree-sitter-embedded_template.wasm',
  go: 'tree-sitter-go.wasm',
  html: 'tree-sitter-html.wasm',
  java: 'tree-sitter-java.wasm',
  json: 'tree-sitter-json.wasm',
  kotlin: 'tree-sitter-kotlin.wasm',
  lua: 'tree-sitter-lua.wasm',
  objc: 'tree-sitter-objc.wasm',
  ocaml: 'tree-sitter-ocaml.wasm',
  php: 'tree-sitter-php.wasm',
  python: 'tree-sitter-python.wasm',
  ql: 'tree-sitter-ql.wasm',
  rescript: 'tree-sitter-rescript.wasm',
  ruby: 'tree-sitter-ruby.wasm',
  rust: 'tree-sitter-rust.wasm',
  scala: 'tree-sitter-scala.wasm',
  solidity: 'tree-sitter-solidity.wasm',
  swift: 'tree-sitter-swift.wasm',
  systemrdl: 'tree-sitter-systemrdl.wasm',
  tlaplus: 'tree-sitter-tlaplus.wasm',
  toml: 'tree-sitter-toml.wasm',
  vue: 'tree-sitter-vue.wasm',
  yaml: 'tree-sitter-yaml.wasm',
  zig: 'tree-sitter-zig.wasm',
};

// TAG_QUERY_VERIFIED_LANGS 밖은 의도적으로 값이 없다 — 그래머는 로드되지만
// 태그 쿼리가 없다는 신호(loadQuery가 null을 반환).
const TAG_QUERY_SOURCE: Partial<Record<ExtractionLang, string>> = {
  typescript: TYPESCRIPT_FAMILY_TAGS_QUERY,
  tsx: TYPESCRIPT_FAMILY_TAGS_QUERY,
  javascript: JAVASCRIPT_TAGS_QUERY,
};

function grammarDir(): string {
  // node_modules/tree-sitter-wasms/out/*.wasm — 워크스페이스 루트에
  // 호이스트된 node_modules를 따라간다(npm workspaces 기본 동작).
  return path.join(require.resolve('tree-sitter-wasms/package.json'), '..', 'out');
}

let initPromise: Promise<void> | null = null;
async function ensureParserInit(): Promise<void> {
  if (!initPromise) initPromise = Parser.init();
  await initPromise;
}

const languageCache = new Map<ExtractionLang, Promise<Language>>();
const queryCache = new Map<ExtractionLang, Promise<Query | null>>();

async function loadLanguage(lang: ExtractionLang): Promise<Language> {
  await ensureParserInit();
  let p = languageCache.get(lang);
  if (!p) {
    p = Language.load(path.join(grammarDir(), GRAMMAR_FILES[lang]));
    languageCache.set(lang, p);
  }
  return p;
}

async function loadQuery(lang: ExtractionLang): Promise<Query | null> {
  let p = queryCache.get(lang);
  if (!p) {
    const source = TAG_QUERY_SOURCE[lang];
    p = source === undefined
      ? Promise.resolve(null)
      : loadLanguage(lang).then((language) => new Query(language, source));
    queryCache.set(lang, p);
  }
  return p;
}

export interface LangHandle {
  lang: ExtractionLang;
  language: Language;
  /** TAG_QUERY_VERIFIED_LANGS 밖의 언어는 null — 그래머는 로드됐지만 태그
   *  쿼리가 없다. 호출부(extract-file.ts)가 이 경우를 스킵으로 처리한다. */
  query: Query | null;
}

/** 한 워커 안에서 언어 하나당 한 번만 로드/파싱되는 (Language, Query) 쌍을
 *  반환한다. 이후 호출은 캐시된 Promise를 그대로 재사용 — Parser는 호출자가
 *  직접 만들고 `setLanguage()`로 갈아끼우는 게 더 저렴하다(Parser 자체는
 *  가벼운 객체, Language.load()가 비싼 쪽). */
export async function getLangHandle(lang: ExtractionLang): Promise<LangHandle> {
  const [language, query] = await Promise.all([loadLanguage(lang), loadQuery(lang)]);
  return { lang, language, query };
}

/** 부팅/워커 기동 시 스모크 테스트 — 그래머가 실제로 로드/파싱되는지
 *  확인한다(research-extraction.md §6 trap #1: ABI 불일치는 로드 시점이
 *  아니라 파싱 시점에야 조용히 죽거나 빈 트리를 낼 수 있어서, 매 언어를
 *  실제로 한 번 파싱해봐야 한다). 실패하면 그 언어를 quarantine(스킵)할
 *  수 있도록 언어별로 개별 실행한다. 태그 쿼리가 검증된 언어는 픽스처가
 *  실제 def.function 캡처를 내는지까지 확인하고, 그 밖의 언어는 빈 문자열
 *  파싱이 죽지 않는지만 확인한다(언어별 문법 픽스처를 손으로 고르지
 *  않고도 36개 전부를 균일하게 스모크 테스트하기 위해서). */
export async function smokeTestGrammar(lang: ExtractionLang): Promise<{ ok: boolean; error: string | null }> {
  try {
    const { language, query } = await getLangHandle(lang);
    const parser = new Parser();
    try {
      parser.setLanguage(language);
      if (!TAG_QUERY_VERIFIED_LANGS.has(lang) || !query) {
        const tree = parser.parse('');
        if (!tree) return { ok: false, error: 'parse() returned null' };
        tree.delete();
        return { ok: true, error: null };
      }
      const fixture = lang === 'javascript' ? 'function f() { return 1; }' : 'function f(): number { return 1; }';
      const tree = parser.parse(fixture);
      if (!tree) return { ok: false, error: 'parse() returned null' };
      try {
        const matches = query.matches(tree.rootNode);
        if (!matches.some((m) => m.captures.some((c) => c.name === 'def.function'))) {
          return { ok: false, error: 'smoke fixture did not yield a def.function capture' };
        }
      } finally {
        tree.delete();
      }
      return { ok: true, error: null };
    } finally {
      parser.delete();
    }
  } catch (e: unknown) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

export { Parser };
