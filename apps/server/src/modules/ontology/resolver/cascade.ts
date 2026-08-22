// Codebase-Memory 신뢰도 캐스케이드(ticket e52e7f64, DESIGN.md 축 1) —
// import-map(0.95) -> same-module(0.90) -> import-suffix(0.85) ->
// unique-name(0.75) -> suffix(0.55) -> fuzzy(0.35). 각 tier는 앞 tier가
// 실패했을 때만 시도되고, 성공한 tier의 confidence+이름이 그대로 엣지에
// provenance로 기록된다(resolve.ts).
//
// import-map/import-suffix tier는 `export ... from` 재수출 체인을 종단
// 정의 파일까지 추적한다(REVIEW-NOTES.md I7 — "첫 hop에서 멈추지 않는다").
// 이 문서가 반복 인용하는 AWB 자신의 apps/server/src/entities/index.ts가
// 정확히 이 패턴(배럴이 각 엔티티 파일을 재수출)이라 이 저장소 자체가
// 회귀 테스트 픽스처의 근거다.
import type { DefNodeInfo, FileNodeInfo, GraphSymbolIndex } from './symbol-index';
import { findSuffixMatchingPaths, resolveRelativeImportCandidates } from './path-resolution';
import type { ImportFact } from '../extraction/types';

export type CascadeResolver = 'import-map' | 'same-module' | 'import-suffix' | 'unique-name' | 'suffix' | 'fuzzy';

export interface CascadeResult {
  nodeId: string;
  symbolId: string;
  confidence: number;
  resolver: CascadeResolver;
}

const FUZZY_MAX_DISTANCE = 2;
const MAX_REEXPORT_HOPS = 8;

/** 파일 안에서 이름이 top-level def와 일치하는 것을 찾는다 — 최상위(부모
 *  없음, qualifiedName===name) 매치를 우선한다. same-module tier와
 *  재수출 체인의 "여기가 종단 정의"판정 양쪽이 공유하는 로직. */
function findDefInFileByName(index: GraphSymbolIndex, filePath: string, name: string): DefNodeInfo | null {
  const byFile = index.defsByFilePath.get(filePath) ?? [];
  const topLevel = byFile.find((d) => d.name === name && d.qualifiedName === d.name);
  return topLevel ?? byFile.find((d) => d.name === name) ?? null;
}

/** export...from 체인을 종단 정의 파일까지 추적한다(REVIEW-NOTES.md I7).
 *  visited는 그래프 안 순환 재수출 방어 + hop 수 상한. */
function followReexportChain(
  index: GraphSymbolIndex,
  file: FileNodeInfo,
  name: string,
  visited: Set<string>,
): DefNodeInfo | null {
  if (visited.has(file.path) || visited.size >= MAX_REEXPORT_HOPS) return null;
  visited.add(file.path);

  const reexport = file.facts.exports.find((exp) => exp.exportedName === name && exp.reExportSource);
  if (reexport && reexport.reExportSource) {
    for (const candidatePath of resolveRelativeImportCandidates(file.path, reexport.reExportSource)) {
      const nextFile = index.filesByPath.get(candidatePath);
      if (!nextFile) continue;
      const next = followReexportChain(index, nextFile, reexport.localName, visited);
      if (next) return next;
    }
    return null; // 재수출을 선언했지만 다음 hop 파일이 그래프에 없음 — 해소 실패(추측하지 않는다)
  }

  // 재수출 fact가 없으면 이 파일이 직접 정의한다(예: `export class Foo {}`
  // 형태의 inline export는 태그 쿼리의 export_clause 캡처 대상이 아니라
  // exports[]에 안 잡히지만, defs[]에는 항상 잡힌다 — extract-file.ts).
  return findDefInFileByName(index, file.path, name);
}

// imports[] 항목을 직접 순회할 때(resolve.ts의 IMPORTS 엣지 생성) 쓰는
// by-fact 진입점 — 아래 by-name 진입점이 매 호출마다 다시 find()하는 걸
// 피한다.
export function resolveImportFactExact(index: GraphSymbolIndex, fromFile: FileNodeInfo, imp: ImportFact): CascadeResult | null {
  for (const candidatePath of resolveRelativeImportCandidates(fromFile.path, imp.source)) {
    const target = index.filesByPath.get(candidatePath);
    if (!target) continue;
    const resolved = followReexportChain(index, target, imp.importedName, new Set());
    if (resolved) return { nodeId: resolved.id, symbolId: resolved.symbolId, confidence: 0.95, resolver: 'import-map' };
  }
  return null;
}

export function resolveImportFactSuffix(index: GraphSymbolIndex, fromFile: FileNodeInfo, imp: ImportFact): CascadeResult | null {
  for (const candidatePath of findSuffixMatchingPaths(imp.source, index.allFilePaths)) {
    const target = index.filesByPath.get(candidatePath);
    if (!target) continue;
    const resolved = followReexportChain(index, target, imp.importedName, new Set());
    if (resolved) return { nodeId: resolved.id, symbolId: resolved.symbolId, confidence: 0.85, resolver: 'import-suffix' };
  }
  return null;
}

function findImportBinding(fromFile: FileNodeInfo, name: string): ImportFact | undefined {
  return fromFile.facts.imports.find((imp) => (imp.localName ?? imp.importedName) === name);
}

function resolveImportMapByName(index: GraphSymbolIndex, fromFile: FileNodeInfo, name: string): CascadeResult | null {
  const imp = findImportBinding(fromFile, name);
  return imp ? resolveImportFactExact(index, fromFile, imp) : null;
}

function resolveImportSuffixByName(index: GraphSymbolIndex, fromFile: FileNodeInfo, name: string): CascadeResult | null {
  const imp = findImportBinding(fromFile, name);
  return imp ? resolveImportFactSuffix(index, fromFile, imp) : null;
}

function resolveSameModule(index: GraphSymbolIndex, fromFile: FileNodeInfo, name: string): CascadeResult | null {
  const own = findDefInFileByName(index, fromFile.path, name);
  return own ? { nodeId: own.id, symbolId: own.symbolId, confidence: 0.9, resolver: 'same-module' } : null;
}

function resolveUniqueName(index: GraphSymbolIndex, name: string): CascadeResult | null {
  const candidates = index.defsByName.get(name);
  if (!candidates || candidates.length !== 1) return null;
  const c = candidates[0];
  return { nodeId: c.id, symbolId: c.symbolId, confidence: 0.75, resolver: 'unique-name' };
}

/** unique-name이 실패(0개 또는 2개 이상 후보)했을 때, 참조에 qualifier가
 *  있으면 그 qualifier가 후보의 qualifiedName 상위 세그먼트와 일치하는지로
 *  좁힌다 — DESIGN.md는 이 tier의 알고리즘을 문자 단위로 명시하지 않아,
 *  "이름만으로는 애매하지만 qualifier 텍스트로 좁힐 수 있는 경우"로
 *  해석했다(정확한 대상보다 미해소를 택하는 이 파일 전체의 원칙과 동일하게,
 *  narrowed.length !== 1이면 절대 추측하지 않는다). */
function resolveSuffix(index: GraphSymbolIndex, name: string, qualifier: string | null): CascadeResult | null {
  if (!qualifier) return null;
  const candidates = index.defsByName.get(name);
  if (!candidates || candidates.length < 2) return null;
  const narrowed = candidates.filter((c) => c.qualifiedName.split('.').slice(0, -1).includes(qualifier));
  if (narrowed.length !== 1) return null;
  const c = narrowed[0];
  return { nodeId: c.id, symbolId: c.symbolId, confidence: 0.55, resolver: 'suffix' };
}

function resolveFuzzy(index: GraphSymbolIndex, name: string): CascadeResult | null {
  const matches = index.bkTree.query(name, FUZZY_MAX_DISTANCE);
  if (matches.length === 0) return null;
  const best = matches[0];
  if (matches.length > 1 && matches[1].distance === best.distance) return null; // 동률 — 애매해서 추측하지 않는다
  const candidates = index.defsByName.get(best.word);
  if (!candidates || candidates.length !== 1) return null; // 이름은 하나로 좁혔지만 그 이름의 def가 여럿이면 여전히 애매
  const c = candidates[0];
  return { nodeId: c.id, symbolId: c.symbolId, confidence: 0.35, resolver: 'fuzzy' };
}

/** qualifier 없는(또는 heritage target 같은) 바닥 이름 하나를 6-tier
 *  캐스케이드로 해소한다. */
export function resolveName(index: GraphSymbolIndex, fromFile: FileNodeInfo, name: string, qualifier: string | null): CascadeResult | null {
  return (
    resolveImportMapByName(index, fromFile, name) ??
    resolveSameModule(index, fromFile, name) ??
    resolveImportSuffixByName(index, fromFile, name) ??
    resolveUniqueName(index, name) ??
    resolveSuffix(index, name, qualifier) ??
    resolveFuzzy(index, name)
  );
}

/** ref[](call/new) 전용 진입점 — qualifier가 있으면(`Foo.doSomething()`)
 *  먼저 qualifier 자체를 컨테이너로 해소하고(import-map/same-module/
 *  import-suffix tier만 — fuzzy로 컨테이너까지 추측하면 불확실성이
 *  두 배로 겹친다) 그 컨테이너의 DECLARES 멤버 중 이름이 일치하는 것을
 *  찾는다. 컨테이너는 해소됐는데 그 이름의 멤버가 없으면 — 잘못된
 *  대상보다는 미해소를 택한다(persist.ts DECORATES의 동일 원칙) — 전역
 *  이름 검색으로 폴백하지 않는다. */
export function resolveRef(index: GraphSymbolIndex, fromFile: FileNodeInfo, ref: { name: string; qualifier: string | null }): CascadeResult | null {
  if (ref.qualifier && ref.qualifier !== 'this' && ref.qualifier !== 'super') {
    const container =
      resolveImportMapByName(index, fromFile, ref.qualifier) ??
      resolveSameModule(index, fromFile, ref.qualifier) ??
      resolveImportSuffixByName(index, fromFile, ref.qualifier);
    if (!container) return null; // qualifier 자체를 모름(예: 지역 변수) — 타입을 모르니 멤버를 추측하지 않는다
    const containerNode = index.nodeById.get(container.nodeId);
    if (!containerNode || (containerNode as DefNodeInfo).type !== 'Type') return null;
    const members = index.membersByContainerId.get(container.nodeId) ?? [];
    const member = members.find((m) => m.name === ref.name);
    if (!member) return null;
    return { nodeId: member.id, symbolId: member.symbolId, confidence: container.confidence, resolver: container.resolver };
  }
  return resolveName(index, fromFile, ref.name, ref.qualifier);
}
