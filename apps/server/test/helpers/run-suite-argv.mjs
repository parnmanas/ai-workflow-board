// test/helpers/run-suite-argv.mjs — run-suite 의 argv 판정부. 티켓 9647c1ef.
//
// fs 를 건드리지 않는 순수 함수만 둔다. 이유는 test/helpers/registration-audit.mjs
// 헤더와 같다 — 판정이 디스크에 붙어 있으면 "거부돼야 하는 커맨드" 를 합성
// fixture 로 만들어 볼 길이 없다. process.exit 도 부르지 않는다: 종료는 CLI
// (test/run-suite.mjs) 의 일이고, 여기는 판정만 돌려준다.
//
// 왜 갈라놓는가: `b0ccd0aa` 가 package.json 의 `test` 를
// `node test/run-suite.mjs --suite test test/manager-installed-version-heartbeat.test.mjs`
// 로 바꿨다. 러너는 이 argv 를 즉시 거부하는데(`--suite` 는 단독) 등록 감사는
// 커맨드 안의 bare test 경로를 등록으로 세므로 초록이었다 — 277 step 본 스위트가
// 한 step 도 안 돈 채 main CI 가 두 커밋 연속 red 였고, 어떤 가드도 그 축을 보지
// 않았다. 판정을 순수 함수로 꺼내면 가드
// (test/run-suite-argv-contract.test.mjs)가 package.json 의 커맨드를 러너와
// **같은 규칙**에 통과시켜 볼 수 있다.

// argv 만으로 결론이 나는 거부 사유들. 문구는 CLI 가 예전에 직접 찍던 것과
// 바이트 단위로 같아야 한다 — 러너의 사용자 표면이고, 자식 프로세스로 CLI 를
// 확인하는 기존 테스트가 이 출력을 본다.
export const SUITE_NAME_MISSING = 'usage: node test/run-suite.mjs --suite <name>';
export const NO_STEPS_USAGE = 'usage: node test/run-suite.mjs --suite <name> | <step> [step...]';
export const suiteNotAloneMessage = (extra) =>
  `[run-suite] --suite 는 단독으로 쓴다 — 남은 인자: ${extra.join(' ')}`;

export function normalizeSteps(rawSteps) {
  const normalized = [];
  for (let i = 0; i < rawSteps.length; i++) {
    // POSIX shells use single quotes for grouping, but cmd.exe treats them as
    // ordinary characters. npm therefore passes `'npm run test:qa'` as three
    // argv entries on Windows. Reassemble that package.json form so the same
    // suite definition works on both platforms.
    if (
      rawSteps[i].startsWith("'npm")
      && rawSteps[i + 1] === 'run'
      && rawSteps[i + 2]?.endsWith("'")
    ) {
      normalized.push(
        `${rawSteps[i].slice(1)} run ${rawSteps[i + 2].slice(0, -1)}`,
      );
      i += 2;
      continue;
    }
    normalized.push(rawSteps[i]);
  }
  return normalized;
}

// argv 하나에 대한 러너의 판정. 세 갈래다:
//   {kind:'suite', suite}  — 매니페스트에서 읽어야 한다 (읽기는 CLI 의 일)
//   {kind:'steps', steps}  — 위치 인자를 그대로 step 으로 쓴다
//   {kind:'error', message} — 러너가 이 argv 를 거부한다. 곧 0 step 이다.
//
// 인자가 아예 없으면 `--suite` 사용법(SUITE_NAME_MISSING)이 아니라
// NO_STEPS_USAGE 가 나온다 — `--suite` 로 시작하지 않으므로 위치 인자 갈래로
// 떨어지고 그 목록이 비어 있기 때문이다. 예전 CLI 의 동작이고 그대로 유지한다.
export function classifyRunSuiteArgv(argv) {
  if (argv[0] === '--suite') {
    const suite = argv[1];
    if (!suite) return { kind: 'error', message: SUITE_NAME_MISSING };
    if (argv.length > 2) {
      return { kind: 'error', message: suiteNotAloneMessage(argv.slice(2)) };
    }
    return { kind: 'suite', suite };
  }

  const steps = normalizeSteps(argv);
  if (steps.length === 0) return { kind: 'error', message: NO_STEPS_USAGE };
  return { kind: 'steps', steps };
}

// 러너 스크립트를 가리키는 토큰. 경로 앞부분(`test/`, `./test/`, 절대경로)은
// 호출자마다 다르므로 파일명으로만 판정한다.
const RUN_SUITE_TOKEN_RE = /(?:^|\/)run-suite\.mjs$/;

// package.json 의 커맨드 문자열에서 러너 호출의 argv 를 뽑는다. 커맨드는 셸에서
// 도므로 `&&` 로 이어진 구간마다 따로 본다 (`npm run build && node
// test/run-suite.mjs --suite pretest`). 러너를 부르지 않는 커맨드는 빈 배열이다.
//
// 토큰을 감싼 따옴표는 **벗기지 않는다**. normalizeSteps 의 Windows 재조립이
// `'npm` / `run` / `test:qa'` 형태를 입력으로 보므로, 여기서 벗기면 그 경로가
// 조용히 죽어 두 벌의 판정이 갈린다.
export function extractRunSuiteArgvs(command) {
  const out = [];
  for (const segment of String(command ?? '').split('&&')) {
    const tokens = segment.split(/\s+/).filter((tok) => tok.length > 0);
    const at = tokens.findIndex((tok) => RUN_SUITE_TOKEN_RE.test(tok));
    if (at !== -1) out.push(tokens.slice(at + 1));
  }
  return out;
}
