#!/usr/bin/env node
// Ontology Graph 추출 워커 처리량 벤치마크 (ticket e14ef1c9, DESIGN.md 축 1,
// 완료조건 1: "AWB 자체 저장소에서 실측 처리량이 research-extraction.md §1
// 수치(WASM 81.7k lines/s 근방)와 부합"). git-repo-cache를 거치지 않고
// 로컬 디스크를 직접 읽는다 — research-extraction.md §1 자신의 측정
// 방법론과 동일하게(그 문서도 로컬 체크아웃을 직접 읽어 쟀다) git fetch/
// cat-file 서브프로세스 오버헤드를 순수 파싱+쿼리+추출 시간과 섞지 않기
// 위해서다(ontology-extraction.service.ts의 end-to-end 수치와는 별개 —
// 그쪽은 git I/O를 포함한 종단간 수치라 이 비교 대상이 아니라고 그 파일
// 자신의 주석에 명시돼 있다).
//
// 저장소가 research-extraction.md 측정 이후(771파일/197.5kLOC) 계속
// 자라왔으므로 이 스크립트가 보는 파일 수/줄 수는 그때와 다르다 — 완료조건이
// 요구하는 건 파일 수 일치가 아니라 처리량(lines/s)이 같은 자릿수 대에
// 부합하는지이므로 오히려 더 큰 표본이 더 견고한 검증이다.
//
// 사용법:
//   (cd apps/server && npm run build)
//   node apps/server/scripts/benchmark-ontology-extraction.mjs [--pool-size N] [--repeat 1]

import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');
const REPO_ROOT = path.join(__dirname, '..', '..', '..');

function parseArgs(argv) {
  const out = { poolSize: undefined, repeat: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pool-size') out.poolSize = Number(argv[++i]);
    else if (a === '--repeat') out.repeat = Number(argv[++i]);
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));

const { runExtractionPool } = await import('file://' + path.join(DIST, 'modules/ontology/extraction/pool.js'));
const { langForPath } = await import('file://' + path.join(DIST, 'modules/ontology/extraction/types.js'));
const { extractFile } = await import('file://' + path.join(DIST, 'modules/ontology/extraction/extract-file.js'));

function listRepoFiles() {
  // git-repo-cache와 같은 "git이 추적하는 파일만" 경계 — node_modules/dist는
  // 보통 .gitignore돼 있어 git ls-files 자체가 이미 걸러준다(연구 문서
  // 함정 #2가 우려하는 vendored/생성 코드 대부분이 여기 해당).
  const out = execSync('git ls-files', { cwd: REPO_ROOT, maxBuffer: 32 * 1024 * 1024 }).toString('utf8');
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((f) => langForPath(f) !== null);
}

async function main() {
  const files = listRepoFiles();
  console.log(`Discovered ${files.length} TS/TSX/JS files under ${REPO_ROOT} (git-tracked only)`);

  const tasks = [];
  let totalBytes = 0;
  let totalLines = 0;
  for (const relPath of files) {
    const abs = path.join(REPO_ROOT, relPath);
    let content;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      continue; // race with a concurrent build/checkout — skip, not fatal
    }
    const lang = langForPath(relPath);
    tasks.push({ path: relPath, content, lang });
    totalBytes += Buffer.byteLength(content, 'utf8');
    totalLines += content.length === 0 ? 0 : content.split('\n').length;
  }

  console.log(`kLOC: ${(totalLines / 1000).toFixed(1)}   MB: ${(totalBytes / 1024 / 1024).toFixed(2)}`);
  console.log(`Pool size: ${args.poolSize ?? '(default: os.availableParallelism())'}`);

  // ── pass A: 순수 tree-sitter, 단일 스레드, main thread에서 직접 호출 ──
  // research-extraction.md §1과 정확히 같은 측정 대상(파싱+쿼리+추출, WASM,
  // 단일 스레드) — ast-grep 데코레이터 패스도, worker_threads
  // 오버헤드/병렬성도 섞이지 않는다. 완료조건 1이 인용하는 "81.7k lines/s"는
  // 바로 이 숫자와 비교해야 정직한 비교다.
  const tsOnlyStart = Date.now();
  for (const t of tasks) await extractFile(t.path, t.content, t.lang);
  const tsOnlyMs = Date.now() - tsOnlyStart;
  const tsOnlyLinesPerSec = tsOnlyMs > 0 ? Math.round((totalLines / tsOnlyMs) * 1000) : 0;
  console.log(`\n=== pass A: pure tree-sitter, single-threaded, main thread (직접 §1 비교 대상) ===`);
  console.log(`wall: ${(tsOnlyMs / 1000).toFixed(2)}s -> ${tsOnlyLinesPerSec.toLocaleString()} lines/s`);
  console.log(`research-extraction.md §1: 81,727 lines/s (WASM, single-threaded, parse+query+extract)`);

  // ── pass B: 실제 프로덕션 파이프라인(worker_threads 풀 + ast-grep 데코레이터
  // 패스 포함) — OntologyExtractionService가 실제로 쓰는 경로 그대로. §1과
  // 직접 비교 대상은 아니다(ast-grep 패스가 §1엔 없는 추가 비용이라 워커
  // 풀 병렬성으로 상쇄되지만, 그 상쇄 자체가 비교를 오염시킨다) — 참고용
  // "실제 이 정도로 빠르다"는 수치로 별도 보고한다.
  console.log(`\n=== pass B: production pipeline (worker_threads pool + ast-grep DECORATES ruleset) ===`);
  for (let run = 1; run <= args.repeat; run++) {
    const startedAt = Date.now();
    const results = await runExtractionPool(tasks, { poolSize: args.poolSize });
    const wallMs = Date.now() - startedAt;

    let defs = 0, refs = 0, imports = 0, exportsCount = 0, heritage = 0, docstrings = 0;
    let parseErrors = 0, taskErrors = 0;
    for (const r of results) {
      if (r.error) { taskErrors += 1; continue; }
      const b = r.bundle;
      if (b.skippedReason) continue;
      if (b.hasParseError) parseErrors += 1;
      defs += b.defs.length;
      refs += b.refs.length;
      imports += b.imports.length;
      exportsCount += b.exports.length;
      heritage += b.heritage.length;
      docstrings += b.docstrings.length;
    }

    const linesPerSec = wallMs > 0 ? Math.round((totalLines / wallMs) * 1000) : 0;
    console.log(`\n=== run ${run}/${args.repeat} ===`);
    console.log(`wall: ${(wallMs / 1000).toFixed(2)}s -> ${linesPerSec.toLocaleString()} lines/s`);
    console.log(`defs: ${defs}  refs: ${refs}  imports: ${imports}  exports: ${exportsCount}  heritage: ${heritage}  docstrings: ${docstrings}`);
    console.log(`defs/kLOC: ${(defs / (totalLines / 1000)).toFixed(1)}   refs/kLOC: ${(refs / (totalLines / 1000)).toFixed(1)}`);
    console.log(`parse errors: ${parseErrors}/${tasks.length} (${((parseErrors / tasks.length) * 100).toFixed(1)}%)   task errors: ${taskErrors}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
