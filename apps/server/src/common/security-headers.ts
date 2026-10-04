/**
 * 배포 응답에 실제로 붙는 Content-Security-Policy 지시어.
 *
 * **main.ts 안에 인라인으로 두지 않는 이유**: 이 값이 틀리면 기능이 서버 로그에
 * 아무것도 남기지 않고 브라우저에서만 조용히 죽는다. 2026-09-26 에 실제로 그랬다 —
 * helmet 기본값의 `img-src 'self' data:` 가 `blob:` 을 빼고 있어서 미션 증거
 * 스크린샷 6장이 전부 화면에서 차단됐고(콘솔에만 CSP 위반), 원인을 "업로드된 파일이
 * 잘렸다"로 두 번 오진했다. 값을 모듈로 빼면 테스트가 **배포되는 그 값**을 직접
 * 단언할 수 있다(`security-headers.test.mjs`).
 *
 * `useDefaults: true` 위에 얹히므로 여기 적지 않은 지시어(default-src, script-src,
 * style-src 등)는 helmet 기본값 그대로다.
 */
export const CSP_DIRECTIVES: Record<string, string[]> = {
  /*
   * `'wasm-unsafe-eval'` — 브라우저가 WebAssembly 를 컴파일하도록 허락한다. 음성 대화 모드·이름 부르기의
   * 말소리 감지(Silero VAD, onnxruntime-web)가 WASM 이다. helmet 기본값 `script-src 'self'` 만 두면
   * `WebAssembly.instantiate()` 가 CSP 위반으로 막혀 VAD 가 아예 뜨지 않는다(2026-10-04 실측: "no available
   * backend found … violates … script-src 'self'") — 개발 서버(Vite)에는 CSP 가 없어 거기서는 멀쩡했다.
   *
   * `'unsafe-eval'` 이 아니다: 이 키워드는 **WASM 컴파일만** 연다. JS 의 eval()·new Function() 은 그대로
   * 막혀 있고, 실행할 수 있는 코드의 출처도 여전히 'self' 뿐이다(모델·런타임은 `/vad/` 에서 같은 오리진으로
   * 받는다 — scripts/copy-vad-assets.mjs).
   */
  scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
  objectSrc: ["'none'"],
  frameAncestors: ["'none'"],
  /*
   * `blob:` 은 선택이 아니라 첨부 렌더 방식의 전제다. 첨부 바이트는 base64 로 받아
   * `URL.createObjectURL(blob)` 로 그린다 — base64 를 `<img src>` 에 직접 넣으면
   * 렌더마다 수 MB 문자열이 diff 되고 브라우저가 디코드 결과를 캐시하지 못한다
   * (chat/MessageList 의 같은 결정 참고).
   *
   * 보안 면에서 blob: 은 `data:` 보다 **좁다**: 같은 오리진의 스크립트가 만든 객체만
   * 가리키고 외부에서 문자열로 주입할 수 없다. 실행 가능한 자원(script-src,
   * object-src)에는 그대로 주지 않는다 — 그 구분이 이 완화의 안전선이다.
   */
  imgSrc: ["'self'", 'data:', 'blob:'],
  mediaSrc: ["'self'", 'data:', 'blob:'],
};
