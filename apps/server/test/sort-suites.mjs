#!/usr/bin/env node
// test/sort-suites.mjs — test/suites/*.txt 를 정규 순서로 제자리 정렬한다. 티켓 ded30c43.
//
// 왜 필요한가: 매니페스트의 사전순은 병합 충돌을 막는 성질이라 가드
// (test/test-registration-completeness.test.mjs)가 강제하는데, 이 저장소는 PR 없이
// ticket 브랜치를 main 에 직접 병합하므로 그 가드는 **랜딩한 뒤** CI 에서만 돈다.
// 저작 시점에 순서를 확인할 수단이 없어 같은 실패가 반복됐다(47cb2e63 → 9afe89f5,
// 그 전에도 1bf50886·e3000afa). 줄을 어디에 넣을지 고민하는 대신 아무 데나 넣고
// 이 스크립트를 돌리면 된다.
//
//   npm run test:suites:sort              8개 매니페스트를 전부 제자리 정렬한다
//   npm run test:suites:sort -- test      test.txt 만 정렬한다
//   npm run test:suites:sort -- --check   쓰지 않고, 어긋난 파일을 찍고 exit 1
//
// 순서의 정의는 갖고 있지 않다 — suite-manifest.mjs 의 canonicalSteps() 를 부른다.
// 가드와 다른 비교 함수를 쓰는 순간 이 스크립트가 정규화한 파일을 가드가 거부하게
// 되고, 그건 손으로 고치는 것보다 더 나쁜 상태다.
//
// 하지 않는 일 — 순서만 정규화한다:
//   - 등록을 추가하거나 지우지 않는다. 무엇이 도는가는 바뀌지 않는다.
//   - 중복 step 을 합치지 않는다. 합치면 실행 횟수가 바뀌므로 거부하고 멈춘다.
//   - 첫 step 뒤에 있는 주석을 옮기지 않는다. 주석은 바로 아래 줄을 가리키는데,
//     그 줄이 정렬로 멀어지면 주석은 엉뚱한 곳을 설명하게 된다. 역시 거부한다.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SUITES_DIR,
  canonicalSteps,
  listSuiteNames,
  suiteManifestPath,
} from './helpers/suite-manifest.mjs';

export const SORT_COMMAND = 'apps/server 에서 `npm run test:suites:sort`';

function isStepLine(line) {
  const t = line.trim();
  return t.length > 0 && !t.startsWith('#');
}

// 파일을 헤더(첫 step 이전의 주석·빈 줄)와 step 목록으로 가른다. 헤더는 바이트
// 그대로 돌려준다 — 주석 문구·들여쓰기·줄끝을 스크립트가 손대면 정렬과 무관한
// diff 가 섞여 리뷰가 "무엇이 실제로 움직였나" 를 못 읽는다.
export function splitManifest(text) {
  const lines = text.split('\n');
  const firstStep = lines.findIndex(isStepLine);
  if (firstStep === -1) return { header: text, steps: [], problems: [] };

  // 헤더 = 첫 step 줄이 시작하기 직전까지의 원문. lines[0..firstStep-1] 각각에
  // 개행 하나씩을 되붙인 길이와 같다.
  const headerLength = lines
    .slice(0, firstStep)
    .reduce((n, line) => n + line.length + 1, 0);
  const header = text.slice(0, headerLength);

  const problems = [];
  const steps = [];
  const seen = new Set();
  for (let i = firstStep; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue; // step 도 주석도 아니다 — 버린다
    if (line.startsWith('#')) {
      problems.push(
        `${i + 1}번째 줄이 첫 step 뒤의 주석이다 ("${line}") — 이 주석이 어느 줄을 `
          + '가리키는지 스크립트는 모른다. 파일 맨 위 헤더로 옮기거나 지운 뒤 다시 돌려라',
      );
      continue;
    }
    if (seen.has(line)) {
      problems.push(
        `${i + 1}번째 줄이 중복 step 이다 ("${line}") — 지우면 그 테스트가 도는 횟수가 `
          + '바뀐다. 어느 쪽을 남길지 정해서 직접 지운 뒤 다시 돌려라',
      );
      continue;
    }
    seen.add(line);
    steps.push(line);
  }
  return { header, steps, problems };
}

// 정규화된 전체 내용. step 은 한 줄씩 LF, 끝 개행 하나.
export function sortManifestText(text) {
  const { header, steps, problems } = splitManifest(text);
  if (problems.length > 0) return { text: null, problems };
  if (steps.length === 0) return { text, problems: [] }; // 정렬할 것이 없다
  return { text: `${header}${canonicalSteps(steps).join('\n')}\n`, problems: [] };
}

// argv 를 해석하고 exit code 를 돌려준다. dir/log/err 은 테스트가 임시 디렉터리와
// 출력을 잡기 위한 주입구 — CLI 에서는 전부 기본값으로 돈다.
export function main(argv, { dir = SUITES_DIR, log = console.log, err = console.error } = {}) {
  const check = argv.includes('--check');
  const requested = argv.filter((a) => a !== '--check');

  const known = listSuiteNames(dir);
  const unknown = requested.filter((name) => !known.includes(name));
  if (unknown.length > 0) {
    err(`그런 매니페스트가 없다: ${unknown.join(', ')}`);
    err(`${dir} 에 있는 것: ${known.join(', ')}`);
    return 1;
  }
  const suites = requested.length > 0 ? requested : known;

  const refused = [];
  const changed = [];
  for (const suite of suites) {
    const file = suiteManifestPath(suite, dir);
    const before = fs.readFileSync(file, 'utf8');
    const { text: after, problems } = sortManifestText(before);

    if (problems.length > 0) {
      // 거부한 파일은 한 바이트도 쓰지 않는다 — 반만 정규화된 파일을 남기면
      // 사람이 무엇을 되돌려야 하는지 알 수 없다.
      refused.push(`${suite}.txt: ${problems.join(' | ')}`);
      continue;
    }
    if (after === before) continue;

    changed.push(`${suite}.txt`);
    if (!check) fs.writeFileSync(file, after);
  }

  for (const line of refused) err(line);

  if (check) {
    if (changed.length > 0) {
      err(`정규 순서가 아니다: ${changed.join(', ')} — 고치려면 ${SORT_COMMAND}`);
    }
    if (refused.length === 0 && changed.length === 0) log('매니페스트 전부 정규 순서다.');
    return refused.length > 0 || changed.length > 0 ? 1 : 0;
  }

  if (changed.length > 0) log(`정렬함: ${changed.join(', ')}`);
  else if (refused.length === 0) log('바꿀 것 없음 — 이미 정규 순서다.');
  return refused.length > 0 ? 1 : 0;
}

// import 로 불릴 때(테스트)는 아무것도 실행하지 않는다.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
