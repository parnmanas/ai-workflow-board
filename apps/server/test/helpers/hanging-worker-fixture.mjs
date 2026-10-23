// worker_threads 픽스처 — pool.ts 의 파일별 시간 상한(ticket 461d210a) 회귀 테스트 전용.
// 경로에 'hang' 이 든 태스크를 받으면 답도 error 도 exit 도 없이 영원히 돈다(멈춘 파서 ·
// 무한 루프). 그 밖의 태스크에는 실제 worker.js 처럼 결과 하나로 답한다 — 풀은 bundle 의
// 내용을 보지 않으므로 빈 껍데기면 된다.
import { parentPort } from 'node:worker_threads';

parentPort.on('message', (task) => {
  if (task.path.includes('hang')) {
    for (;;) { /* 이벤트 루프를 놓지 않는다 — terminate() 만 멈출 수 있다 */ }
  }
  parentPort.postMessage({ path: task.path, bundle: { path: task.path, defs: [], refs: [] }, decoratorFacts: [], error: null });
});
