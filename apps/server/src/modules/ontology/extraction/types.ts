// Ontology Graph 추출 워커(ticket e14ef1c9, DESIGN.md 축 1 — Extraction pipeline,
// Tier 1). 파일별 fact bundle 계약 — research-extraction.md §5.1 / DESIGN.md
// §2.1이 명시한 필드 그대로: defs[]/refs[]/imports[]/exports[]/heritage[]/
// docstrings[] + file_hash(XXH3) + extractor_version. 파일 간 상태 공유 없음
// — 이 타입들은 순수하게 "이 파일 하나"의 사실만 담는다. 크로스파일 해소
// (refs[]→CALLS/REFERENCES, heritage[]→EXTENDS/IMPLEMENTS, imports[]→IMPORTS)는
// 3/7 리졸버(ticket 미배정) 몫 — 이 파일에서 만드는 어떤 타입도 다른 파일의
// 정보를 참조하지 않는다.

/** 이 배치(추출 실행)가 지원하는 언어. ast-grep의 `Lang`과 이름을 맞춘다
 *  (NestJS 룰셋이 같은 파일에 대해 두 엔진을 모두 돌리므로). */
export type ExtractionLang = 'typescript' | 'tsx' | 'javascript';

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

/** 확장자 → 언어. tree-sitter-wasms가 typescript/tsx 문법을 분리해서
 *  번들하므로(문법 자체가 다름) 확장자로 미리 갈라야 한다. */
export function langForPath(filePath: string): ExtractionLang | null {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.tsx')) return 'tsx';
  if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts')) return 'typescript';
  if (lower.endsWith('.js') || lower.endsWith('.jsx') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'javascript';
  return null;
}
