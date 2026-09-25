// effort preset → CLI 슬라이스 선택. 예전 `cli-adapters/base.ts` 의 selectEffortSlice
// 는 CLI 이름 6개를 직접 비교했다; 이제 모듈의 `effort` 슬라이스 선언으로 판정한다.

import type { EffortLevel, EffortSlice, ResolvedEffortPreset } from '../cli-adapters/base.js';
import { pickEffortSlice } from '../cli-adapters/base.js';
import { cliEffort, cliModulesWith } from './index.js';

export type { EffortLevel, EffortSlice, ResolvedEffortPreset };

/**
 * `cliType` 이 표현할 수 있는 preset 슬라이스를 `{ model?, effort?, ultracode? }` 로
 * 정규화한다. 선언이 없는 CLI(hermes, custom, 미지의 이름)나 null preset 은 null.
 */
export function selectEffortSlice(
  cliType: string,
  preset: ResolvedEffortPreset | null | undefined,
): EffortSlice | null {
  const spec = cliEffort(String(cliType || '').toLowerCase());
  if (!spec) return null;
  return pickEffortSlice(preset, spec.sliceKey ?? String(cliType).toLowerCase(), spec.keys);
}

/** preset 에 등장할 수 있는 슬라이스 키(자기 슬라이스를 가진 CLI 만; deepseek 처럼 빌려 쓰는 쪽 제외). */
export function effortSliceKeys(): string[] {
  const keys = new Set<string>();
  for (const m of cliModulesWith('effort')) keys.add(m.effort.sliceKey ?? m.id);
  return [...keys];
}

/** 슬라이스 키가 어떤 effort 키를 담을 수 있는가(파서가 낯선 키를 버리는 기준). */
export function effortKeysForSlice(sliceKey: string): ReadonlySet<string> {
  const out = new Set<string>();
  for (const m of cliModulesWith('effort')) {
    if ((m.effort.sliceKey ?? m.id) === sliceKey) for (const k of m.effort.keys) out.add(k);
  }
  return out;
}
