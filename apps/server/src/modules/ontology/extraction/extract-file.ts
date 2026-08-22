// 파일 하나 → FactBundle (ticket e14ef1c9, DESIGN.md 축 1, Tier 1). 순수
// 함수 — 워커 스레드 안에서 호출되지만 worker_threads API 자체에는 의존하지
// 않는다(worker.ts가 메시지 배선만 담당). Parser는 모듈 레벨에 캐시해
// 파일마다 재생성하지 않는다(grammars.ts의 getLangHandle 주석 — Language.load()가
// 비싼 쪽이지 Parser 자체는 아니다).
import type { Node as TsNode } from 'web-tree-sitter';
import { Parser, getLangHandle } from './grammars';
import {
  EXTRACTOR_VERSION,
  type DefFact,
  type DefKind,
  type DocstringFact,
  type ExportFact,
  type ExtractionLang,
  type FactBundle,
  type HeritageFact,
  type ImportFact,
  type RefFact,
} from './types';

// research-extraction.md 함정 #2 — 미니파이/생성 코드가 WASM 힙에서 최악의
// 동작을 보인다(원본 권고: 2MB 초과 스킵). git-repo-cache.getFileContent()는
// 자체적으로 512KB에서 이미 too_large를 반환하지만, 로컬 디스크를 직접 읽는
// 벤치마크 스크립트 등 getFileContent를 거치지 않는 호출부도 있으므로 이
// 함수 자신도 독립적으로 상한을 강제한다.
const MAX_EXTRACT_CHARS = 2_000_000;

const DEF_KIND_BY_CAPTURE: Record<string, DefKind> = {
  'def.class': 'class',
  'def.interface': 'interface',
  'def.function': 'function',
  'def.method': 'method',
  'def.type': 'type',
  'def.enum': 'enum',
  'def.field': 'field',
  // 변수에 바인딩된 화살표/함수 표현식(`const f = () => {}`)도 의미상
  // callable — 별도 DefKind를 두지 않고 'function'으로 합류시킨다.
  'def.arrow': 'function',
};

// 주석 종료 라인과 def 시작 라인 사이 허용 간격 — 데코레이터 한두 줄이 그
// 사이에 낄 수 있다(현재 태그 쿼리는 데코레이터를 캡처하지 않으므로 그
// 줄들은 그냥 "간격"으로 보인다).
const DOC_ATTACH_MAX_LINE_GAP = 3;

// export_statement까지 걸어 올라가는 동안 통과 가능한 "투명" 래퍼 노드 —
// `const x = ...`의 lexical_declaration이 유일하게 확인된 케이스
// (web-tree-sitter@0.25.10 + tree-sitter-wasms@0.1.13 조합에서 직접 파싱해
// 검증).
const EXPORT_BOUNDARY_STOP = new Set(['class_body', 'statement_block', 'program']);
const MAX_EXPORT_WALK_HOPS = 4;

function emptyBundle(path: string, lang: ExtractionLang, opts: { hasParseError?: boolean; skippedReason: string | null }): FactBundle {
  return {
    path,
    lang,
    defs: [],
    refs: [],
    imports: [],
    exports: [],
    heritage: [],
    docstrings: [],
    fileHash: '',
    extractorVersion: EXTRACTOR_VERSION,
    hasParseError: opts.hasParseError ?? false,
    skippedReason: opts.skippedReason,
  };
}

function computeExported(node: TsNode): boolean {
  let cur = node.parent;
  let hops = 0;
  while (cur && hops < MAX_EXPORT_WALK_HOPS) {
    if (cur.type === 'export_statement') return true;
    if (EXPORT_BOUNDARY_STOP.has(cur.type)) return false;
    cur = cur.parent;
    hops++;
  }
  return false;
}

function stripQuotes(text: string): string {
  return text.replace(/^['"`]|['"`]$/g, '');
}

/** 그래머 로드/setLanguage/parse 실패를 하나의 안정적인 skippedReason
 *  카테고리로 접는다 — 호출부(worker.ts, persist.ts, 테스트)가 정확한
 *  에러 문자열이 아니라 이 상수로 매칭할 수 있게. */
function grammarFailureReason(_e: unknown): string {
  return 'grammar_load_failed';
}

/** 캡처 노드에서 시작해 지정된 kind를 가진 가장 가까운 조상을 찾는다. */
function findAncestorOfKind(node: TsNode, kinds: Set<string>): TsNode | null {
  let cur: TsNode | null = node.parent;
  while (cur) {
    if (kinds.has(cur.type)) return cur;
    cur = cur.parent;
  }
  return null;
}

interface RawDef {
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
  kind: DefKind;
  name: string;
  node: TsNode;
}

interface RawDoc {
  text: string;
  startLine: number;
  endLine: number;
}

/** 파일 하나를 파싱해 FactBundle을 만든다 — 다른 파일의 상태를 절대 읽거나
 *  쓰지 않는다(Tier 1의 핵심 불변식, DESIGN.md 축 1). */
export async function extractFile(path: string, content: string, lang: ExtractionLang): Promise<FactBundle> {
  if (content.length > MAX_EXTRACT_CHARS) {
    return emptyBundle(path, lang, { skippedReason: 'file_too_large' });
  }

  let handle: Awaited<ReturnType<typeof getLangHandle>>;
  try {
    handle = await getLangHandle(lang);
  } catch (e) {
    return emptyBundle(path, lang, { skippedReason: grammarFailureReason(e) });
  }
  const { language, query } = handle;
  if (!query) {
    // 그래머는 로드 가능하지만(smokeTestGrammar가 별도로 검증) 이 언어의
    // 태그 쿼리는 아직 없다(types.ts의 TAG_QUERY_VERIFIED_LANGS 밖) — 조용히
    // 빈 결과를 내는 대신 정직하게 스킵 사유를 남긴다.
    return emptyBundle(path, lang, { skippedReason: 'no_tag_query_for_language' });
  }

  // trap #1(research-extraction.md §6) — ABI 불일치는 Language.load() 자체가
  // 아니라 setLanguage()나 parse() 시점에야 던질 수 있다(36개 중 실제로
  // 3개에서 직접 확인: elm/ql은 setLanguage()에서 "Incompatible language
  // version", yaml은 parse()에서 별개의 내부 에러 — grammars.ts의
  // smokeTestGrammar가 부팅 시점에 예측 가능하게 만드는 바로 그 부류).
  // 이 셋은 현재 전부 태그 쿼리도 없어 위 !query 분기로 먼저 스킵되지만,
  // 그건 우연이다 — 태그 쿼리가 검증된 언어의 그래머가 여기서 깨지는
  // 경우에도(TS/JS 자신은 아니지만 방어적으로) 태스크를 에러로 죽이는 대신
  // 같은 방식으로 정직하게 스킵한다.
  const parser = getSharedParser();
  let tree: ReturnType<typeof parser.parse>;
  try {
    parser.setLanguage(language);
    tree = parser.parse(content);
  } catch (e) {
    return emptyBundle(path, lang, { skippedReason: grammarFailureReason(e) });
  }
  if (!tree) {
    return emptyBundle(path, lang, { skippedReason: 'parse_returned_null' });
  }
  try {
    const hasParseError = tree.rootNode.hasError;
    const matches = query.matches(tree.rootNode);

    const rawDefs: RawDef[] = [];
    const refs: RefFact[] = [];
    const rawHeritage: Array<{ className: string; relation: 'extends' | 'implements'; targetName: string; startLine: number }> = [];
    const rawDocs: RawDoc[] = [];
    // import/export 이름 캡처는 자신을 감싸는 import_statement/export_statement의
    // startIndex로 source 캡처와 조인한다 — 같은 문의 이름 캡처와 source
    // 캡처가 서로 다른 매치로 나오기 때문(쿼리 패턴이 4개로 분리돼 있음).
    const importsByStmt = new Map<number, { localName: string | null; importedName: string; isTypeOnly: boolean; startLine: number }[]>();
    const importSourceByStmt = new Map<number, string>();
    const exportsByStmt = new Map<number, { localName: string; exportedName: string; startLine: number }[]>();
    const exportSourceByStmt = new Map<number, string>();

    const IMPORT_STMT_KIND = new Set(['import_statement']);
    const EXPORT_STMT_KIND = new Set(['export_statement']);

    for (const m of matches) {
      const caps = new Map<string, TsNode>();
      for (const c of m.captures) caps.set(c.name, c.node);

      const defCapName = [...caps.keys()].find((k) => k.startsWith('def.'));
      if (defCapName) {
        const primary = caps.get(defCapName)!;
        const nameNode = caps.get('def.name');
        rawDefs.push({
          startByte: primary.startIndex,
          endByte: primary.endIndex,
          startLine: primary.startPosition.row + 1,
          endLine: primary.endPosition.row + 1,
          kind: DEF_KIND_BY_CAPTURE[defCapName],
          name: nameNode ? nameNode.text : '<anonymous>',
          node: primary,
        });
        continue;
      }

      if (caps.has('heritage.class_name')) {
        const className = caps.get('heritage.class_name')!.text;
        const extendsTarget = caps.get('heritage.extends_target');
        const implementsTarget = caps.get('heritage.implements_target');
        const targetNode = extendsTarget ?? implementsTarget;
        if (targetNode) {
          rawHeritage.push({
            className,
            relation: extendsTarget ? 'extends' : 'implements',
            targetName: targetNode.text,
            startLine: targetNode.startPosition.row + 1,
          });
        }
        continue;
      }

      if (caps.has('ref.call_name')) {
        const nameNode = caps.get('ref.call_name')!;
        const qualifierNode = caps.get('ref.qualifier');
        refs.push({
          name: nameNode.text,
          qualifier: qualifierNode ? qualifierNode.text : null,
          callShape: 'call',
          startLine: nameNode.startPosition.row + 1,
          endLine: nameNode.endPosition.row + 1,
        });
        continue;
      }
      if (caps.has('ref.new_name')) {
        const nameNode = caps.get('ref.new_name')!;
        refs.push({
          name: nameNode.text,
          qualifier: null,
          callShape: 'new',
          startLine: nameNode.startPosition.row + 1,
          endLine: nameNode.endPosition.row + 1,
        });
        continue;
      }

      if (caps.has('import.name') || caps.has('import.default_name')) {
        const isDefault = caps.has('import.default_name');
        const nameNode = isDefault ? caps.get('import.default_name')! : caps.get('import.name')!;
        const aliasNode = caps.get('import.alias');
        const stmt = findAncestorOfKind(nameNode, IMPORT_STMT_KIND);
        if (!stmt) continue; // 문법적으로 있을 수 없지만 방어적으로 스킵
        const key = stmt.startIndex;
        const list = importsByStmt.get(key) ?? [];
        list.push({
          localName: aliasNode ? aliasNode.text : nameNode.text,
          importedName: isDefault ? 'default' : nameNode.text,
          isTypeOnly: /^import\s+type\s/.test(stmt.text),
          startLine: stmt.startPosition.row + 1,
        });
        importsByStmt.set(key, list);
        continue;
      }
      if (caps.has('import.source')) {
        const sourceNode = caps.get('import.source')!;
        const stmt = findAncestorOfKind(sourceNode, IMPORT_STMT_KIND);
        if (stmt) importSourceByStmt.set(stmt.startIndex, stripQuotes(sourceNode.text));
        continue;
      }

      if (caps.has('export.name')) {
        const nameNode = caps.get('export.name')!;
        const aliasNode = caps.get('export.alias');
        const stmt = findAncestorOfKind(nameNode, EXPORT_STMT_KIND);
        if (!stmt) continue;
        const key = stmt.startIndex;
        const list = exportsByStmt.get(key) ?? [];
        list.push({
          localName: nameNode.text,
          exportedName: aliasNode ? aliasNode.text : nameNode.text,
          startLine: stmt.startPosition.row + 1,
        });
        exportsByStmt.set(key, list);
        continue;
      }
      if (caps.has('export.source')) {
        const sourceNode = caps.get('export.source')!;
        const stmt = findAncestorOfKind(sourceNode, EXPORT_STMT_KIND);
        if (stmt) exportSourceByStmt.set(stmt.startIndex, stripQuotes(sourceNode.text));
        continue;
      }

      if (caps.has('doc')) {
        const node = caps.get('doc')!;
        rawDocs.push({ text: node.text, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 });
        continue;
      }
    }

    // ── defs: byte 순서로 정렬 후 스택 기반 중첩 계산 ──
    rawDefs.sort((a, b) => a.startByte - b.startByte || b.endByte - a.endByte);
    const stack: Array<{ endByte: number; qualifiedName: string }> = [];
    const defs: DefFact[] = [];
    for (const raw of rawDefs) {
      while (stack.length > 0 && raw.startByte >= stack[stack.length - 1].endByte) stack.pop();
      const parent = stack.length > 0 ? stack[stack.length - 1] : null;
      const qualifiedName = parent ? `${parent.qualifiedName}.${raw.name}` : raw.name;
      defs.push({
        qualifiedName,
        name: raw.name,
        kind: raw.kind,
        startLine: raw.startLine,
        endLine: raw.endLine,
        startByte: raw.startByte,
        endByte: raw.endByte,
        parentQualifiedName: parent ? parent.qualifiedName : null,
        exported: computeExported(raw.node),
        docstring: null,
      });
      stack.push({ endByte: raw.endByte, qualifiedName });
    }

    // ── heritage: bare class_name -> 실제 qualifiedName으로 교정 ──
    const heritage: HeritageFact[] = rawHeritage.map((h) => {
      let best: DefFact | null = null;
      for (const d of defs) {
        if (d.name !== h.className || (d.kind !== 'class' && d.kind !== 'interface')) continue;
        if (h.startLine < d.startLine || h.startLine > d.endLine) continue;
        if (!best || d.endLine - d.startLine < best.endLine - best.startLine) best = d;
      }
      return {
        ofQualifiedName: best ? best.qualifiedName : h.className,
        relation: h.relation,
        targetName: h.targetName,
        startLine: h.startLine,
      };
    });

    // ── docstrings: 가장 가까운 다음 def에 부착, 없으면 파일 헤더 취급 ──
    const sortedDocs = [...rawDocs].sort((a, b) => a.startLine - b.startLine);
    const defsByStartLine = [...defs].sort((a, b) => a.startLine - b.startLine);
    const docstrings: DocstringFact[] = [];
    for (const doc of sortedDocs) {
      let attached: DefFact | null = null;
      for (const d of defsByStartLine) {
        const gap = d.startLine - doc.endLine;
        if (gap >= 1 && gap <= DOC_ATTACH_MAX_LINE_GAP) {
          if (!attached || d.startLine < attached.startLine) attached = d;
        }
      }
      docstrings.push({ ofQualifiedName: attached ? attached.qualifiedName : null, text: doc.text, startLine: doc.startLine });
      if (attached && attached.docstring === null) attached.docstring = doc.text;
    }

    // ── imports/exports: 문 단위로 이름×source 조인 ──
    const imports: ImportFact[] = [];
    for (const [stmtKey, entries] of importsByStmt) {
      const source = importSourceByStmt.get(stmtKey) ?? '';
      for (const e of entries) {
        imports.push({ localName: e.localName, importedName: e.importedName, source, isTypeOnly: e.isTypeOnly, startLine: e.startLine });
      }
    }
    const exports: ExportFact[] = [];
    for (const [stmtKey, entries] of exportsByStmt) {
      const reExportSource = exportSourceByStmt.get(stmtKey) ?? null;
      for (const e of entries) {
        exports.push({ localName: e.localName, exportedName: e.exportedName, reExportSource, startLine: e.startLine });
      }
    }

    return {
      path,
      lang,
      defs,
      refs,
      imports,
      exports,
      heritage,
      docstrings,
      fileHash: '', // worker.ts가 XXH3로 채운다 — 파싱과 해싱은 관심사가 분리된 단계
      extractorVersion: EXTRACTOR_VERSION,
      hasParseError,
      skippedReason: null,
    };
  } finally {
    // trap #2 (research-extraction.md §6) — Tree는 WASM 힙 할당, delete() 누락 시
    // 100k 파일 루프에서 OOM. Query/Language는 grammars.ts 캐시가 소유(워커
    // 생애주기 동안 재사용) — 여기서 delete하지 않는다.
    tree.delete();
  }
}

let sharedParser: InstanceType<typeof Parser> | null = null;
function getSharedParser(): InstanceType<typeof Parser> {
  if (!sharedParser) sharedParser = new Parser();
  return sharedParser;
}
