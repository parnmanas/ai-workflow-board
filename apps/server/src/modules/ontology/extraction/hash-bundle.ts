// ticket 964014f5(증분 갱신, DESIGN.md 축 4) — FactBundle.fileHash +
// DefFact.contentHash/signatureHash를 원본 content로부터 채운다.
// extractFile()은 구조적 사실(byte 범위)만 만들고 해싱은 하지 않는다 —
// worker.ts가 이미 `bundle.fileHash = xxh3.xxh64(task.content)...`로
// 지켜온 "파싱과 해싱은 관심사가 분리된 단계" 관례(persist.ts 헤더
// 코멘트)를 def 단위 해시에도 그대로 확장한다. worker.ts(Tier 1 전체
// 추출 풀 경로)와 incremental/phase-a.ts(단일 파일 증분 경로) 양쪽이 이
// 함수를 공유해, 어느 경로로 만들어진 노드든 content_hash/signature_hash
// 계산 방식이 갈라지지 않는다.
import { xxh3 } from '@node-rs/xxhash';
import type { FactBundle } from './types';

export function hashText(text: string): string {
  return xxh3.xxh64(text).toString(16);
}

/** bundle.fileHash와 각 def의 contentHash/signatureHash를 in-place로
 *  채운다. `content`는 extractFile()에 넘겼던 것과 동일한 원본 소스여야
 *  한다(byte offset이 그 문자열 기준이므로). */
export function hashFactBundle(bundle: FactBundle, content: string): void {
  bundle.fileHash = hashText(content);
  for (const def of bundle.defs) {
    def.contentHash = hashText(content.slice(def.startByte, def.endByte));
    def.signatureHash = hashText(content.slice(def.startByte, def.bodyStartByte ?? def.endByte));
  }
}
