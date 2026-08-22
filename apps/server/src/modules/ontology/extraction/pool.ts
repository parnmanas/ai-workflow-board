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
 *  진행한다 — 파일 하나의 결함이 771개 파일 전체 배치를 멈추게 두지 않는다. */
export async function runExtractionPool(
  tasks: ExtractionTask[],
  opts: ExtractionPoolOptions = {},
): Promise<ExtractionTaskResult[]> {
  if (tasks.length === 0) return [];

  const poolSize = Math.max(1, Math.min(opts.poolSize ?? os.availableParallelism(), tasks.length));
  const workerScript = resolveWorkerScriptPath();
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
      // idx를 클로저로 들고 있다가 해당 태스크의 응답이 오면 결과 슬롯에
      // 정확히 그 위치로 기록한다 — 워커 간 처리 순서는 뒤섞여도 results
      // 배열은 tasks와 같은 인덱스로 정렬된 채 유지된다.
      const onMessage = (result: ExtractionTaskResult) => {
        results[idx] = result;
        completed += 1;
        opts.onProgress?.(completed, tasks.length);
        cleanup();
        finishIfDone();
        if (!settled) dispatchNext(slot);
      };
      const onError = (err: Error) => {
        results[idx] = { path: tasks[idx].path, bundle: null, decoratorFacts: [], error: String(err?.message || err) };
        completed += 1;
        opts.onProgress?.(completed, tasks.length);
        cleanup();
        replaceWorker(slot);
        finishIfDone();
      };
      const cleanup = () => {
        slot.worker.off('message', onMessage);
        slot.worker.off('error', onError);
      };
      slot.worker.on('message', onMessage);
      slot.worker.on('error', onError);
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
      // message/error 리스너를 안 붙였을 수 있으므로 별도로 한 번 더 받는다.
      worker.once('error', (err) => {
        if (!slot.busy && !settled) {
          // 아직 아무 태스크도 못 받았는데 죽음 — 풀 자체가 기동 불가로
          // 본다(예: worker.js를 못 찾음/모듈 로드 실패) — 재시도로 무한
          // 루프가 되는 대신 즉시 실패시킨다.
          settled = true;
          for (const s of slots) void s.worker.terminate().catch(() => {});
          rejectPool(err);
        }
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
