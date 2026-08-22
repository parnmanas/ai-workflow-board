// worker_threads 풀 — 메인 스레드에서 ExtractionTask[]를 분배하고
// ExtractionTaskResult[]를 모은다 (ticket e14ef1c9, DESIGN.md 축 1:
// "web-tree-sitter(WASM) worker_threads 풀"). worker.ts 자신은 항상
// **컴파일된 dist 출력**을 스폰한다 — `nest start --watch`(nest-cli.json에
// 커스텀 builder가 없어 기본 tsc watch)와 `node dist/main.js`(prod) 둘 다
// dist/를 실행하므로 __dirname 기준 상대 경로로 자연히 맞물린다. tsx로 직접
// 실행하는 standalone 진입점(mcp-server.ts)은 이 풀을 이 티켓 범위에서
// 소비하지 않는다 — 그래서 tsx의 워커 스레드 로더 전파 여부를 여기서
// 고민할 필요가 없다(테스트/벤치마크 스크립트도 1/7 선례를 따라 dist/를
// 대상으로 실행 — 각 파일 자신의 헤더 코멘트 참고).
import { Worker } from 'node:worker_threads';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExtractionTask, ExtractionTaskResult } from './types';

export interface ExtractionPoolOptions {
  /** 기본값: os.availableParallelism() (Node 18.4+) — 명시적으로 override 가능
   *  (예: 벤치마크 스크립트가 "1 thread" 대 "N workers" 비교를 재현하려 할 때). */
  poolSize?: number;
  /** 진행 콜백 — 완료될 때마다 1회, 순서 보장 없음(어느 워커가 먼저
   *  끝내느냐에 따라 달라짐). */
  onProgress?: (completed: number, total: number) => void;
  /** 테스트 전용 — 실제 worker.js 대신 다른 워커 스크립트를 스폰한다(예:
   *  비정상 종료를 흉내내는 픽스처). 프로덕션 호출부는 절대 설정하지
   *  않는다 — 생략하면 항상 resolveWorkerScriptPath()가 쓰인다. */
  workerScriptPath?: string;
}

function resolveWorkerScriptPath(): string {
  // pool.ts 자신이 컴파일된 위치(dist/modules/ontology/extraction/pool.js)
  // 기준 상대 경로 — worker.ts도 같은 디렉터리로 컴파일되므로 글롭 없이도
  // 항상 맞물린다.
  return path.join(__dirname, 'worker.js');
}

interface WorkerSlot {
  worker: Worker;
  busy: boolean;
}

/** ExtractionTask[]를 고정 크기 worker_threads 풀로 처리한다. 한 워커가
 *  죽어도(trap #1, research-extraction.md §6 — ABI 불일치/미리스팅된 C
 *  stdlib 호출은 런타임에 조용히 죽을 수 있다) 그 워커가 맡고 있던 태스크
 *  하나만 에러로 기록하고 교체 워커를 새로 띄워 나머지 배치를 계속
 *  진행한다 — 파일 하나의 결함이 771개 파일 전체 배치를 멈추게 두지 않는다.
 *  이 보장은 `error` 이벤트뿐 아니라(리뷰 지적 라운드 1) 메시지/에러 없이
 *  워커가 그냥 죽는 `exit`(예: OOM, 시그널로 강제 종료)까지 커버한다 — 그
 *  경우를 못 잡으면 그 태스크를 기다리던 Promise가 영구 대기했다. */
export async function runExtractionPool(
  tasks: ExtractionTask[],
  opts: ExtractionPoolOptions = {},
): Promise<ExtractionTaskResult[]> {
  if (tasks.length === 0) return [];

  const poolSize = Math.max(1, Math.min(opts.poolSize ?? os.availableParallelism(), tasks.length));
  const workerScript = opts.workerScriptPath ?? resolveWorkerScriptPath();
  const results: ExtractionTaskResult[] = new Array(tasks.length);
  let nextIndex = 0;
  let completed = 0;

  return new Promise((resolvePool, rejectPool) => {
    const slots: WorkerSlot[] = [];
    let settled = false;

    function finishIfDone() {
      if (settled) return;
      if (completed >= tasks.length) {
        settled = true;
        for (const slot of slots) void slot.worker.terminate();
        resolvePool(results);
      }
    }

    function dispatchNext(slot: WorkerSlot) {
      if (nextIndex >= tasks.length) {
        slot.busy = false;
        return;
      }
      const idx = nextIndex++;
      slot.busy = true;
      // 이 특정 태스크 디스패치가 message/error/exit 중 하나로 이미
      // 처리됐는지 — 셋 다에 붙는 공유 가드. 워커 하나가 error 다음에
      // exit도 내보내는 게 정상 흐름(둘 다 발생)이라, 먼저 온 쪽만 결과로
      // 반영하고 나머지는 cleanup()이 이미 떼어낸 리스너라 무시된다.
      let taskSettled = false;
      const finalizeTask = (result: ExtractionTaskResult) => {
        if (taskSettled) return;
        taskSettled = true;
        cleanup();
        results[idx] = result;
        completed += 1;
        opts.onProgress?.(completed, tasks.length);
      };
      const onMessage = (result: ExtractionTaskResult) => {
        finalizeTask(result);
        finishIfDone();
        if (!settled) dispatchNext(slot);
      };
      const onError = (err: Error) => {
        finalizeTask({ path: tasks[idx].path, bundle: null, decoratorFacts: [], error: String(err?.message || err) });
        replaceWorker(slot);
        finishIfDone();
      };
      const onExit = (code: number) => {
        // taskSettled === true면 message/error가 이미 처리한 정상 흐름의
        // 뒤따르는 exit(또는 우리가 finishIfDone/replaceWorker에서 의도적으로
        // terminate()한 것) — 조용히 무시.
        if (taskSettled) return;
        finalizeTask({
          path: tasks[idx].path,
          bundle: null,
          decoratorFacts: [],
          error: `worker exited unexpectedly (code ${code}) with no message or error event`,
        });
        replaceWorker(slot);
        finishIfDone();
      };
      const cleanup = () => {
        slot.worker.off('message', onMessage);
        slot.worker.off('error', onError);
        slot.worker.off('exit', onExit);
      };
      slot.worker.on('message', onMessage);
      slot.worker.on('error', onError);
      slot.worker.on('exit', onExit);
      slot.worker.postMessage(tasks[idx]);
    }

    function replaceWorker(deadSlot: WorkerSlot) {
      if (settled) return;
      void deadSlot.worker.terminate().catch(() => {});
      const idx = slots.indexOf(deadSlot);
      if (idx < 0) return;
      const fresh = makeSlot();
      slots[idx] = fresh;
      dispatchNext(fresh);
    }

    function makeSlot(): WorkerSlot {
      const worker = new Worker(workerScript);
      const slot: WorkerSlot = { worker, busy: false };
      // 태스크 배정 전(워커 생성 직후) 죽는 경우 — dispatchNext가 아직
      // message/error/exit 리스너를 안 붙였을 수 있으므로 별도로 받는다.
      let startupSettled = false;
      const onStartupFailure = (reason: Error) => {
        if (slot.busy || settled || startupSettled) return;
        // 아직 아무 태스크도 못 받았는데 죽음 — 풀 자체가 기동 불가로
        // 본다(예: worker.js를 못 찾음/모듈 로드 실패) — 재시도로 무한
        // 루프가 되는 대신 즉시 실패시킨다.
        startupSettled = true;
        settled = true;
        for (const s of slots) void s.worker.terminate().catch(() => {});
        rejectPool(reason);
      };
      worker.once('error', onStartupFailure);
      worker.once('exit', (code) => {
        if (code !== 0) onStartupFailure(new Error(`ontology extraction worker exited with code ${code} before receiving any task`));
      });
      return slot;
    }

    try {
      for (let i = 0; i < poolSize; i++) slots.push(makeSlot());
    } catch (e) {
      rejectPool(e as Error);
      return;
    }
    for (const slot of slots) dispatchNext(slot);
  });
}
