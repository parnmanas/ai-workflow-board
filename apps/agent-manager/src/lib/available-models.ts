// 설치된 CLI 별 모델 목록 열거 (ticket 40110b64).
//
// 원래 main.ts 부팅 블록 안에 인라인으로 있던 코드다. 매니저를 재시작하지 않고
// 모델 목록만 갱신하려면(`refresh_available_models` 커맨드) 같은 열거를 부팅 이후에도
// 다시 돌릴 수 있어야 해서 밖으로 꺼냈다. main.ts 는 자기 자신을 즉시 실행하는
// 진입점이라 테스트에서 import 할 수 없으므로, 여기 lib 모듈에 둔다.

import { KNOWN_ADAPTER_CLI_TYPES, createAdapter } from './cli-adapters/index.js';
import { log } from './logging.js';

/** 열거에 필요한 최소 어댑터 계약 — 테스트가 실제 CLI 바이너리 없이 이 함수의
 *  best-effort 동작을 검증할 수 있도록 좁게 잡았다. */
export interface ModelListingAdapter {
  listModels(): Promise<string[]>;
}

export interface GatherAvailableModelsDeps {
  /** 열거 대상 CLI 목록. 기본값은 이 빌드가 아는 전체 어댑터. */
  cliTypes?: readonly string[];
  /** cliType → 어댑터 해석기. 기본값은 실제 어댑터 팩토리. */
  adapterFor?: (cli: string) => ModelListingAdapter;
  /** 실패 로깅 훅 (테스트에서 로그를 가로채기 위한 seam). */
  logger?: (message: string) => void;
}

/**
 * 설치된 CLI 들이 받아들이는 모델 id 를 어댑터별 `listModels()` 로 열거한다
 * (cliType → 모델 id 목록).
 *
 * best-effort 계약이 이 함수의 핵심이다: 어댑터 하나의 열거가 실패해도(바이너리
 * 미설치, 스캔 타임아웃, 파싱 실패) 그 CLI 의 키가 결과에서 빠질 뿐, 나머지 결과는
 * 그대로 살아남고 이 함수는 절대 throw 하지 않는다. 호출자(부팅 경로 · refresh
 * 커맨드)는 둘 다 부분 결과를 정상으로 취급한다.
 *
 * 느린 바이너리 문자열 스캔이 나머지를 직렬화하지 않도록 병렬로 돈다.
 */
export async function gatherAvailableModels(
  deps: GatherAvailableModelsDeps = {},
): Promise<Record<string, string[]>> {
  const cliTypes = deps.cliTypes ?? KNOWN_ADAPTER_CLI_TYPES;
  const adapterFor = deps.adapterFor ?? ((cli: string) => createAdapter(cli));
  const logger = deps.logger ?? log;

  const availableModels: Record<string, string[]> = {};
  await Promise.all(
    cliTypes.map(async (cli) => {
      try {
        const models = await adapterFor(cli).listModels();
        if (Array.isArray(models) && models.length) availableModels[cli] = models;
      } catch (err: any) {
        logger(`listModels failed for cli=${cli}: ${err?.message ?? err}`);
      }
    }),
  );
  return availableModels;
}
