// WASM 문법 로딩 — web-tree-sitter Parser/Language(ticket e14ef1c9, DESIGN.md
// 축 1). 이 모듈은 워커 스레드 안에서만 임포트된다: Parser/Language/Tree는
// 워커 하나의 WASM 힙에 묶인 stateful 객체라 메인 스레드와 공유할 수 없다
// (trap #2, research-extraction.md §6).
//
// 그래머 소스: `kreuzberg-dev/tree-sitter-language-pack`(371언어, ABI14,
// MIT)는 npm 패키지가 아니다(직접 확인 — `npm view tree-sitter-language-pack`
// 404, Python/kreuzberg 생태계 배포로 추정) — DESIGN.md 축 1 자신이 이미
// "tree-sitter-wasms/@vscode/tree-sitter-wasm을 상위 ~20개 언어의 번들
// fallback으로" 명시했고, npm에 실재하는 유일한 옵션이 그 fallback이라
// AWB 자신의 코퍼스(TS/TSX/JS)에는 fallback이 곧 유일한 실전 경로다 —
// typescript/tsx 문법을 모두 포함한다. 371언어 전체 커버리지가 필요해지면
// 이 파일에 그래머 항목을 추가하는 것만으로 확장 가능(langForPath +
// GRAMMAR_FILES + 언어별 tag query 한 벌).
import * as path from 'path';
import { Parser, Language, Query } from 'web-tree-sitter';
import type { ExtractionLang } from './types';
import { TYPESCRIPT_FAMILY_TAGS_QUERY } from './tag-queries/typescript-family';
import { JAVASCRIPT_TAGS_QUERY } from './tag-queries/javascript';

const GRAMMAR_FILES: Record<ExtractionLang, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
};

const TAG_QUERY_SOURCE: Record<ExtractionLang, string> = {
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
const queryCache = new Map<ExtractionLang, Promise<Query>>();

async function loadLanguage(lang: ExtractionLang): Promise<Language> {
  await ensureParserInit();
  let p = languageCache.get(lang);
  if (!p) {
    p = Language.load(path.join(grammarDir(), GRAMMAR_FILES[lang]));
    languageCache.set(lang, p);
  }
  return p;
}

async function loadQuery(lang: ExtractionLang): Promise<Query> {
  let p = queryCache.get(lang);
  if (!p) {
    p = loadLanguage(lang).then((language) => new Query(language, TAG_QUERY_SOURCE[lang]));
    queryCache.set(lang, p);
  }
  return p;
}

export interface LangHandle {
  lang: ExtractionLang;
  language: Language;
  query: Query;
}

/** 한 워커 안에서 언어 하나당 한 번만 로드/파싱되는 (Language, Query) 쌍을
 *  반환한다. 이후 호출은 캐시된 Promise를 그대로 재사용 — Parser는 호출자가
 *  직접 만들고 `setLanguage()`로 갈아끼우는 게 더 저렴하다(Parser 자체는
 *  가벼운 객체, Language.load()가 비싼 쪽). */
export async function getLangHandle(lang: ExtractionLang): Promise<LangHandle> {
  const [language, query] = await Promise.all([loadLanguage(lang), loadQuery(lang)]);
  return { lang, language, query };
}

/** 부팅/워커 기동 시 스모크 테스트 — 3줄짜리 픽스처를 파싱해서 그래머가
 *  실제로 로드/파싱되는지 확인한다(research-extraction.md §6 trap #1: ABI
 *  불일치는 로드 시점이 아니라 파싱 시점에야 조용히 죽거나 빈 트리를 낼 수
 *  있어서, 매 언어를 실제로 한 번 파싱해봐야 한다). 실패하면 그 언어를
 *  quarantine(스킵)할 수 있도록 언어별로 개별 실행한다. */
export async function smokeTestGrammar(lang: ExtractionLang): Promise<{ ok: boolean; error: string | null }> {
  try {
    const { language, query } = await getLangHandle(lang);
    const parser = new Parser();
    try {
      parser.setLanguage(language);
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
