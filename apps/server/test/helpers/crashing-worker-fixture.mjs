// worker_threads 픽스처 — ticket e14ef1c9 pool.ts 회귀 테스트 전용.
// 실제 worker.js와 같은 메시지 프로토콜을 흉내내지만, 메시지를 받자마자
// message/error 이벤트 없이 곧장 process.exit(1)로 죽는다 — trap #1의
// 최악 케이스(OOM/시그널 등으로 워커가 그냥 사라지는 경우)를 재현해
// pool.ts의 `exit` 핸들러가 그 태스크를 영구 대기 없이 회수하는지 검증한다.
import { parentPort } from 'node:worker_threads';

parentPort.on('message', () => {
  process.exit(1);
});
