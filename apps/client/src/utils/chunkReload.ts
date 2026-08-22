// 배포 후 stale 탭에서 사라진 라우트 청크를 lazy-import 할 때의 복구 판단 로직
// (ticket 2cae7314). 순수 함수로 추출해 브라우저 없이 node:test 로 검증한다.

// vite:preloadError / 렌더 예외로 들어오는 청크 로드 실패를 감지하기 위한 메시지
// 패턴 — Chrome("Failed to fetch dynamically imported module"), Firefox("error
// loading dynamically imported module"), Safari("Importing a module script
// failed") 및 과거 webpack 스타일 메시지까지 최대한 폭넓게 잡는다. 매칭에 실패해도
// ChunkLoadErrorBoundary 는 일반 오류 안내로 폴백하므로 안전하다.
const CHUNK_ERROR_PATTERNS = [
  /dynamically imported module/i,
  /importing a module script failed/i,
  /loading chunk/i,
  /loading css chunk/i,
];

export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return CHUNK_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

// sessionStorage 에 남기는 가드 키. 새로고침에도 살아남아야 하므로(탭 내
// 인메모리 변수는 reload 자체로 초기화돼 가드 역할을 못 한다) sessionStorage 를
// 쓴다 — 탭을 닫으면 자동으로 사라져 다음 세션엔 다시 1회 자동복구를 시도한다.
export const CHUNK_RELOAD_GUARD_KEY = 'awb:chunk-reload-attempted';

export interface ChunkReloadGuardStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

// 이번 세션에서 아직 자동 새로고침을 시도하지 않았으면 가드를 세우고 true(=지금
// reload 해라)를 반환한다. 이미 한 번 시도했는데도 또 실패했다면(무한 루프 방지)
// false 를 반환 — 호출자는 reload 대신 오류를 그대로 표면화해야 한다.
export function shouldReloadForChunkError(storage: ChunkReloadGuardStorage): boolean {
  if (storage.getItem(CHUNK_RELOAD_GUARD_KEY) === '1') {
    return false;
  }
  storage.setItem(CHUNK_RELOAD_GUARD_KEY, '1');
  return true;
}
