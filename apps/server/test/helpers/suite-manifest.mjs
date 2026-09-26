// test/helpers/suite-manifest.mjs — 스위트 실행 목록(매니페스트) 읽기. 티켓 5dc241d8.
//
// 왜 파일로 빼는가: 예전에는 실행 목록이 package.json 의 `scripts.test` 한 줄
// (1만 자대) 안에 전부 들어 있었다. 서로 무관한 테스트 두 개를 각자 브랜치에서
// 추가해도 **같은 한 줄**을 고치게 되므로 병합이 항상 충돌했고, 수동 union +
// JSON 파싱 + 중복/누락 재검증이 매번 필요했다. 줄 단위 매니페스트로 옮기면
// 서로 다른 줄을 건드리므로 git 이 3-way 병합으로 알아서 합친다.
//
// 형식 — 한 줄에 step 하나:
//   test/....test.mjs   그 파일을 한 step 으로 실행한다
//   npm run <script>    그 npm 스크립트를 한 step 으로 위임한다
//   # ...               주석. 빈 줄과 함께 무시된다
//
// 순서 규약: 테스트 경로는 사전순으로, `npm run` 위임은 그 뒤에 둔다. 사전순이라야
// 새 항목의 삽입 위치가 파일 이름으로 정해져, 독립적인 추가 두 개가 서로 다른
// hunk 에 떨어진다 — 끝에 몰아 붙이면 매니페스트로 옮긴 의미가 없어진다.
// 이 규약은 test/test-registration-completeness.test.mjs 가 강제하고, 아래
// canonicalSteps() 가 유일한 정의다. 자리를 손으로 고르지 말고 아무 데나 넣은 뒤
// apps/server 에서 `npm run test:suites:sort` 를 돌려라 — 가드는 이 저장소의
// 랜딩 방식상 main 에 들어간 뒤에야 도는데, 그때는 이미 main 이 빨갛다.
//
// 매니페스트 이름은 npm 스크립트 이름에서 `:` 를 `-` 로 바꾼 것이다
// (`test:qa:pg` → `test-qa-pg.txt`). 다른 매핑 규칙은 없다.
//
// 새 매니페스트를 만들 때: 이 디렉터리에 파일을 두는 것만으로는 등록이 아니다.
// 어떤 진입점에서도 `--suite` 로 도달하지 않는 목록은 영영 돌지 않으므로,
// test/helpers/registration-audit.mjs 의 도달 가능성 검사가 이를 결함으로 잡는다.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPERS_DIR = path.dirname(fileURLToPath(import.meta.url));

// 호출자의 cwd 와 무관하게 해석한다 — run-suite 는 apps/server 에서, 테스트는
// 저장소 루트에서 실행될 수 있다.
export const SUITES_DIR = path.join(HELPERS_DIR, '..', 'suites');

export function suiteNameFromScript(script) {
  return script.replace(/:/g, '-');
}

// dir 인자는 기본값 하나뿐인 저장소 경로를 테스트가 임시 디렉터리로 바꿔 끼우기
// 위한 것이다 — "무엇이 매니페스트 파일인가" 의 판정은 한 벌로 유지한다.
export function suiteManifestPath(suite, dir = SUITES_DIR) {
  return path.join(dir, `${suite}.txt`);
}

export function listSuiteNames(dir = SUITES_DIR) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.txt'))
    .map((f) => f.slice(0, -'.txt'.length))
    .sort();
}

// 주석과 빈 줄을 걷어낸 step 목록. 줄 전체가 하나의 step 이므로 셸 인용이 필요
// 없다 — package.json 시절 `'npm run test:qa'` 를 감싸던 따옴표와 그 Windows
// 쪼개짐 문제가 여기서는 아예 생기지 않는다.
export function parseSuiteManifest(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

// package.json 스크립트 커맨드가 어떤 매니페스트를 쓰는지 되짚는다. 목록이
// package.json 을 떠났으므로, "이 스크립트가 실제로 뭘 도는가" 를 물으려면
// 커맨드에서 `--suite <name>` 을 한 번 더 따라가야 한다.
export function suiteFromScriptCommand(command) {
  const tokens = String(command ?? '').split(/\s+/);
  const at = tokens.indexOf('--suite');
  if (at === -1) return null;
  return tokens[at + 1] ?? null;
}

// 정규 순서 = 테스트 경로 사전순, 그 뒤에 `npm run` 위임 사전순. 위 "순서 규약"
// 을 계산으로 옮긴 것이고, 이 함수가 그 규약의 유일한 정의다 — 정렬 가드
// (test/test-registration-completeness.test.mjs)와 제자리 정렬 스크립트
// (test/sort-suites.mjs)가 둘 다 여기를 부른다. 두 벌이 되면 스크립트가 정규화한
// 파일을 가드가 거부하는, 고치는 쪽이 더 헷갈리는 상태가 만들어진다.
//
// 비교는 JS 기본 `.sort()`(UTF-16 코드 단위)로 고정한다. 셸 `sort` 는 로케일에
// 따라 구두점을 무시해 다른 답을 낸다 — 예컨대 `credentials-scope-switch...` 와
// `credentials-scope...` 의 앞뒤가 뒤집힌다(`-` 0x2D < `.` 0x2E). 눈으로도 셸
// `sort` 로도 틀리는 자리라, 어느 쪽 순서가 맞는지는 이 함수에게만 물어야 한다.
export function canonicalSteps(steps) {
  return [
    ...steps.filter((s) => s.startsWith('test/')).sort(),
    ...steps.filter((s) => !s.startsWith('test/')).sort(),
  ];
}

export function readSuiteSteps(suite) {
  const file = suiteManifestPath(suite);
  const steps = parseSuiteManifest(fs.readFileSync(file, 'utf8'));
  if (steps.length === 0) {
    throw new Error(`빈 매니페스트다 — step 이 한 줄도 없다: ${file}`);
  }
  return steps;
}
