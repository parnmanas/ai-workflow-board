// Ontology Graph 추출 워커(ticket e14ef1c9, DESIGN.md 축 1 — Extraction pipeline,
// Tier 1). 파일별 fact bundle 계약 — research-extraction.md §5.1 / DESIGN.md
// §2.1이 명시한 필드 그대로: defs[]/refs[]/imports[]/exports[]/heritage[]/
// docstrings[] + file_hash(XXH3) + extractor_version. 파일 간 상태 공유 없음
// — 이 타입들은 순수하게 "이 파일 하나"의 사실만 담는다. 크로스파일 해소
// (refs[]→CALLS/REFERENCES, heritage[]→EXTENDS/IMPLEMENTS, imports[]→IMPORTS)는
// 3/7 리졸버(ticket 미배정) 몫 — 이 파일에서 만드는 어떤 타입도 다른 파일의
// 정보를 참조하지 않는다.

// 리뷰 지적(라운드 1) — 그래머 소스를 tree-sitter-wasms 36개 문법 전체로
// 넓혔다. 애초 티켓이 인용한 `kreuzberg-dev/tree-sitter-language-pack`은
// 그 이름으로는 npm 패키지가 아니었다 — 실제로는 `@xberg-io/` 스코프
// 아래 있고(`@xberg-io/tree-sitter-language-pack`, 371언어, native N-API;
// `@xberg-io/tree-sitter-language-pack-wasm`, 같은 371언어, 단일 WASM
// 블롭) 둘 다 web-tree-sitter의 `Language.load()`가 기대하는 "언어당
// 로드 가능한 .wasm 파일"이 아니라 자기 완결적인 별도 Parser/Node/Tree
// API를 노출한다(직접 설치해 확인 — node_modules/@xberg-io/*/index.d.ts,
// ts_pack_core_wasm.js) — web-tree-sitter와 나란히 쓸 수 없고, 채택하려면
// web-tree-sitter 자체를 버려야 한다(티켓이 명시한 "web-tree-sitter(WASM)"
// 기술 선택 자체를 뒤집는 결정이라 이 티켓 범위에서 임의로 하지 않는다).
// tree-sitter-wasms(이미 package.json 의존성, Unlicense)가 실제로
// web-tree-sitter와 맞물리는 유일한 다국어 grammar 소스라 그 번들
// 전체(36언어, `ls node_modules/tree-sitter-wasms/out` 직접 확인)로
// 그래머 로딩 범위를 넓혔다 — 문법 로딩(smokeTestGrammar)은 36개
// 전부, 태그 쿼리 기반 fact 추출(defs/refs/imports/exports/heritage)은
// 이 티켓이 실제로 검증·dogfood한 typescript/tsx/javascript만 보장한다.
// 나머지는 extract-file.ts가 `skippedReason: 'no_tag_query_for_language'`로
// 정직하게 스킵한다(조용히 빈 결과를 내지 않음).
export type ExtractionLang =
  | 'typescript' | 'tsx' | 'javascript'
  | 'bash' | 'c' | 'cpp' | 'c_sharp' | 'css' | 'dart' | 'elisp' | 'elixir' | 'elm'
  | 'embedded_template' | 'go' | 'html' | 'java' | 'json' | 'kotlin' | 'lua' | 'objc'
  | 'ocaml' | 'php' | 'python' | 'ql' | 'rescript' | 'ruby' | 'rust' | 'scala'
  | 'solidity' | 'swift' | 'systemrdl' | 'tlaplus' | 'toml' | 'vue' | 'yaml' | 'zig';

/** 태그 쿼리(defs/refs/imports/exports/heritage 추출)가 실제로 검증·구현된
 *  언어 — 이 집합 밖은 grammars.ts가 그래머는 로드하지만 extract-file.ts는
 *  파싱 없이 `skippedReason`으로 스킵한다. */
export const TAG_QUERY_VERIFIED_LANGS: ReadonlySet<ExtractionLang> = new Set(['typescript', 'tsx', 'javascript']);

export type DefKind =
  | 'class' | 'interface' | 'function' | 'method' | 'type' | 'enum' | 'field' | 'variable';

export interface DefFact {
  /** 파일 내에서 안정적인, 중첩을 반영한 이름 — 예: `FooClass.barMethod`. */
  qualifiedName: string;
  name: string;
  kind: DefKind;
  startLine: number; // 1-based
  endLine: number;
  startByte: number;
  endByte: number;
  /** 이 def를 직접 감싸는 def의 qualifiedName — 최상위면 null (CONTAINS vs
   *  DECLARES를 나누는 근거: 파일이 최상위를 CONTAINS, 부모 def가 멤버를
   *  DECLARES). */
  parentQualifiedName: string | null;
  exported: boolean;
  docstring: string | null;
  /** ticket 964014f5(증분 갱신, DESIGN.md 축 4) — 이 def의 "body" 자식
   *  노드(tree-sitter `body` named field)가 시작하는 byte offset. 클래스/
   *  인터페이스/함수/메서드/enum처럼 구분되는 body 블록이 있으면 그
   *  시작 offset, type alias/field/variable처럼 body 개념이 없으면 null
   *  (이 경우 signature_hash는 전체 [startByte,endByte)를 커버 — 그런
   *  def는 "본문만 편집"이 애초에 성립하지 않으므로 모든 편집이 곧
   *  시그니처 변경이다). extract-file.ts가 채우고, 실제 해시 계산은
   *  hash-bundle.ts(관심사 분리 — worker.ts의 fileHash 관례와 동일)가
   *  raw content를 슬라이스해 담당한다. */
  bodyStartByte: number | null;
  /** [startByte, endByte) 전체(선언+body)의 해시 — signature_hash와 짝을
   *  이루는 "content" 절반. extractFile() 시점엔 ''(placeholder), 원본
   *  content를 쥔 hash-bundle.ts의 hashFactBundle()이 채운다. */
  contentHash: string;
  /** [startByte, bodyStartByte ?? endByte) 구간의 해시 — 이름/kind/arity/
   *  visibility/파라미터·반환타입/heritage를 raw source 텍스트로 뭉뚱그려
   *  담는다(개별 필드로 구조화하는 대신 — rust-analyzer ItemTree와 같은
   *  "body와 분리된 선언부 요약" 발상, DESIGN.md 축 4). extractFile()
   *  시점엔 ''(placeholder), hashFactBundle()이 채운다. */
  signatureHash: string;
}

/** 미해소 참조 — 이름 + 한정자 + 호출형태만. 어떤 심볼을 가리키는지는 이
 *  파일 혼자서는 알 수 없다(크로스파일 정보 없음) — 3/7 리졸버가 워크스페이스
 *  전체 심볼 테이블에 대해 해소한다. */
export interface RefFact {
  name: string;
  /** `obj.name` 형태였다면 `obj` 부분(한정자). 없으면 null. */
  qualifier: string | null;
  callShape: 'call' | 'new' | 'type' | 'value';
  startLine: number;
  endLine: number;
}

export interface ImportFact {
  /** import된 로컬 바인딩 이름(별칭 포함) — 없으면(예: `import './x'`) null. */
  localName: string | null;
  /** 원본 export 이름 — namespace/default import면 'default'/'*'. */
  importedName: string;
  /** `from '...'` 리터럴 그대로 — 상대경로 해석은 하지 않는다(크로스파일). */
  source: string;
  isTypeOnly: boolean;
  startLine: number;
}

export interface ExportFact {
  localName: string;
  exportedName: string;
  /** re-export(`export { X } from './y'`)면 원본 source, 아니면 null. */
  reExportSource: string | null;
  startLine: number;
}

export interface HeritageFact {
  /** heritage를 갖는 def의 qualifiedName(같은 파일 내). */
  ofQualifiedName: string;
  relation: 'extends' | 'implements';
  /** 상위 타입의 이름(문자열) — 해소되지 않음. */
  targetName: string;
  startLine: number;
}

export interface DocstringFact {
  /** 이 docstring이 붙은 def의 qualifiedName, 없으면(파일 헤더 코멘트) null. */
  ofQualifiedName: string | null;
  text: string;
  startLine: number;
}

export interface FactBundle {
  path: string;
  lang: ExtractionLang;
  defs: DefFact[];
  refs: RefFact[];
  imports: ImportFact[];
  exports: ExportFact[];
  heritage: HeritageFact[];
  docstrings: DocstringFact[];
  /** XXH3 (64-bit, 16진수 문자열) — 증분 갱신(ticket #4)의 파일 단위
   *  early-cutoff 키. */
  fileHash: string;
  extractorVersion: string;
  /** 파싱 중 신택스 에러가 있었는지(research-extraction.md §1: AWB 자체
   *  코퍼스에서 771개 중 8개, 1.0%가 파싱 에러였음 — 드문 일이 아니라
   *  예상된 정상 상태). true여도 부분 결과는 최대한 반환한다. */
  hasParseError: boolean;
  /** 파일 크기 초과 등으로 스킵됐으면 사유, 아니면 null. */
  skippedReason: string | null;
}

/** 워커 풀 태스크 입력 — 순수 문자열/원시값만(구조화 복제 경계를 넘어야 하므로
 *  tree-sitter Node/Tree 객체는 절대 여기 담기지 않는다 — trap #2). */
export interface ExtractionTask {
  path: string;
  content: string;
  lang: ExtractionLang;
}

export interface ExtractionTaskResult {
  path: string;
  bundle: FactBundle | null;
  // DecoratorFact[]를 FactBundle 안에 넣지 않는다 — DESIGN.md 축 1이 고정한
  // fact bundle 필드 목록(defs/refs/imports/exports/heritage/docstrings/
  // file_hash/extractor_version)에 없고, ast-grep 룰셋은 그 자체로
  // optional/non-blocking한 별도 패스(축 1 Integration points)라 태스크
  // 결과 레벨의 형제 필드로 붙인다. import type이라 순환 임포트가 런타임에
  // 남지 않는다.
  decoratorFacts: import('./decorator-rules').DecoratorFact[];
  error: string | null;
}

export const EXTRACTOR_VERSION = '1.0.0';

// 확장자(점 없이) → 언어. tree-sitter-wasms 36개 번들 전체를 커버한다 —
// 다중 확장자를 갖는 언어만 위 langForPath의 특별 분기로 처리(tsx/ts류/js류).
const EXTENSION_LANG_MAP: Record<string, ExtractionLang> = {
  sh: 'bash', bash: 'bash',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  cs: 'c_sharp',
  css: 'css',
  dart: 'dart',
  el: 'elisp',
  ex: 'elixir', exs: 'elixir',
  elm: 'elm',
  ejs: 'embedded_template', erb: 'embedded_template',
  go: 'go',
  html: 'html', htm: 'html',
  java: 'java',
  json: 'json',
  kt: 'kotlin', kts: 'kotlin',
  lua: 'lua',
  m: 'objc', mm: 'objc',
  ml: 'ocaml', mli: 'ocaml',
  php: 'php',
  py: 'python', pyi: 'python',
  ql: 'ql', qll: 'ql',
  res: 'rescript', resi: 'rescript',
  rb: 'ruby',
  rs: 'rust',
  scala: 'scala',
  sol: 'solidity',
  swift: 'swift',
  rdl: 'systemrdl',
  tla: 'tlaplus',
  toml: 'toml',
  vue: 'vue',
  yaml: 'yaml', yml: 'yaml',
  zig: 'zig',
};

/** 확장자 → 언어. tree-sitter-wasms가 typescript/tsx 문법을 분리해서
 *  번들하므로(문법 자체가 다름) 확장자로 미리 갈라야 한다. */
export function langForPath(filePath: string): ExtractionLang | null {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.tsx')) return 'tsx';
  if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts')) return 'typescript';
  if (lower.endsWith('.js') || lower.endsWith('.jsx') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'javascript';
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return null;
  return EXTENSION_LANG_MAP[lower.slice(dot + 1)] ?? null;
}
