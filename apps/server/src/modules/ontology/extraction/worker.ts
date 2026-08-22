// worker_threads 엔트리포인트 (ticket e14ef1c9, DESIGN.md 축 1). 이 파일
// 자체가 워커 스레드 진입점이라 부모 스레드에서 절대 직접 import하지 않는다
// — pool.ts가 `new Worker(경로)`로 별도 스레드에 이 파일을 로드한다.
//
// 순수 문자열/원시값만 postMessage로 오간다(구조화 복제 경계 — trap #2,
// research-extraction.md §6): tree-sitter Node/Tree/Query는 절대 워커
// 경계를 넘지 않는다. extractFile()이 이미 tree.delete()를 보장하므로 이
// 파일은 그 계약을 신뢰하고 값만 직렬화해 돌려보낸다.
import { parentPort } from 'node:worker_threads';
import { extractFile } from './extract-file';
import { extractDecoratorFacts } from './decorator-rules';
import { hashFactBundle } from './hash-bundle';
import type { ExtractionTask, ExtractionTaskResult } from './types';

if (!parentPort) {
  throw new Error('ontology extraction worker.ts must be run as a worker_thread (parentPort is null)');
}

const port = parentPort;

async function handleTask(task: ExtractionTask): Promise<ExtractionTaskResult> {
  try {
    const bundle = await extractFile(task.path, task.content, task.lang);
    // XXH3(64비트) → 16진수 문자열, FactBundle.fileHash 계약(types.ts) 그대로.
    // ticket 964014f5부터 파일 해시뿐 아니라 각 def의 contentHash/
    // signatureHash도 여기서 함께 채운다(hash-bundle.ts).
    hashFactBundle(bundle, task.content);
    // extractDecoratorFacts는 javascript를 자체적으로 걸러낸다(decorator-rules.ts) —
    // 여기서 다시 분기하지 않는다.
    const decoratorFacts = extractDecoratorFacts(task.path, task.content, task.lang);
    return { path: task.path, bundle, decoratorFacts, error: null };
  } catch (e) {
    return { path: task.path, bundle: null, decoratorFacts: [], error: String((e as Error)?.message || e) };
  }
}

port.on('message', (task: ExtractionTask) => {
  handleTask(task)
    .then((result) => port.postMessage(result))
    .catch((e) => {
      port.postMessage({ path: task.path, bundle: null, decoratorFacts: [], error: String((e as Error)?.message || e) } satisfies ExtractionTaskResult);
    });
});
