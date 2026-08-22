// import source 문자열을 그래프 안 실제 File 노드 경로 후보로 해석하는
// 순수 함수(DB 접근 없음, path 문자열 연산만) — ticket e52e7f64, DESIGN.md
// 축 1 "Tier 1.5" import-map/import-suffix tier의 기반. Node.js 모듈
// 해석의 아주 좁은 서브셋만 흉내낸다 — bare specifier(패키지 임포트, 예:
// 'react')는 의도적으로 처리하지 않는다: 리포 밖 파일이라 그래프에 File
// 노드가 없고, 호출자의 캐스케이드가 자연히 하위 tier로 떨어진다.
//
// 그래프에 저장된 파일 경로는 git-repo-cache(listTree)가 만든 POSIX 스타일
// ('/' 구분자) 상대경로라고 가정한다 — extraction 파이프라인 전체의 관례.
import * as posixPath from 'node:path/posix';

const CANDIDATE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];
const INDEX_BASENAMES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx'];
const SOURCE_EXTENSION_RE = /\.(tsx?|jsx?|mjs|cjs|mts|cts)$/;

/** fromFilePath 기준으로 상대 import source를 해석해, 그래프에 있을 법한
 *  파일 경로 후보를 우선순위 순으로 반환한다 — 첫 매치를 쓰는 건 호출자
 *  책임, 이 함수는 순수하게 후보 목록만 만든다. */
export function resolveRelativeImportCandidates(fromFilePath: string, source: string): string[] {
  if (!source.startsWith('.')) return []; // bare specifier — repo 밖, 그래프에 없음(캐스케이드가 하위 tier로 폴백)
  const fromDir = posixPath.dirname(fromFilePath);
  const joined = posixPath.normalize(posixPath.join(fromDir, source));
  const candidates: string[] = [];
  for (const ext of CANDIDATE_EXTENSIONS) candidates.push(joined + ext);
  for (const idx of INDEX_BASENAMES) candidates.push(posixPath.join(joined, idx));
  return candidates;
}

/** 정확한 상대경로 해석이 실패했을 때(예: tsconfig path alias, 모노레포
 *  패키지 import)의 느슨한 폴백 — source의 마지막 세그먼트가 그래프 파일
 *  경로의 suffix와 일치하는지 본다(import-suffix tier, 0.85). */
export function findSuffixMatchingPaths(source: string, allFilePaths: Iterable<string>): string[] {
  const stripped = source.replace(/^\.*\/+/, '').replace(SOURCE_EXTENSION_RE, '');
  if (!stripped) return [];
  const suffix = '/' + stripped;
  const out: string[] = [];
  for (const p of allFilePaths) {
    const noExt = p.replace(SOURCE_EXTENSION_RE, '');
    if (noExt === stripped || noExt.endsWith(suffix)) out.push(p);
  }
  return out;
}
