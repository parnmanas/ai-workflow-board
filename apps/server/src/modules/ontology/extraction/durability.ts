// ticket 964014f5(증분 갱신, DESIGN.md 축 4, research-incremental.md §4.3) —
// File 노드의 durability tier 휴리스틱. `stable`(lockfile-pinned
// ExternalPackage)은 이 코드베이스에 아직 외부 패키지 추출기가 없어
// 이 분류기가 내지 않는다 — 열거값만 열어두고, 실제로 채우는 것은
// 미래 티켓(DESIGN.md 축 1 "ExternalPackage" 확장) 몫이다. 여기서는
// 워크스페이스 소스(`volatile`)와 vendored/generated 산출물(`frozen`)만
// 경로 패턴으로 구분한다 — 실제 콘텐츠를 파싱하지 않는 값싼 사전 필터.
import type { OntologyDurability } from '../../../entities/OntologyNode';

// 대소문자 무시, path separator는 항상 '/'로 정규화된 relPath를 가정
// (bundle.path — git-repo-cache 등 이 코드베이스의 다른 곳과 동일한 관례).
const FROZEN_PATH_MARKERS = [
  /(^|\/)node_modules\//,
  /(^|\/)vendor\//,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)\.next\//,
  /(^|\/)__generated__\//,
  /(^|\/)generated\//,
];
const FROZEN_FILENAME_MARKERS = [
  /\.min\.[jt]sx?$/,
  /\.generated\.[jt]sx?$/,
  /\.g\.[jt]sx?$/,
  /-lock\.(json|yaml|yml)$/,
];

export function classifyDurability(relPath: string): OntologyDurability {
  const p = relPath.replace(/\\/g, '/');
  if (FROZEN_PATH_MARKERS.some((re) => re.test(p)) || FROZEN_FILENAME_MARKERS.some((re) => re.test(p))) {
    return 'frozen';
  }
  return 'volatile';
}
