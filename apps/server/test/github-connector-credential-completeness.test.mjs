// Regression guard — 티켓 5ba957b0.
//
// "credential 인자를 안 넘기고 GitHubConnectorService 메서드를 호출" 버그가 이미
// 4번 났다: (1) REST/ls-remote(c90653d9), (2) worktree-manager clone/push
// (agent-manager), (3) environment-provisioner clone(6c107743), (4)
// ci-wait-resume.service.ts:287의 getWorkflowRun(9bbe9146). 3번 직후 보드 레슨
// (a3e5b406)이 "agent-manager git-네트워크 경로"로 좁게 적혀 있던 탓에 4번째가
// 서버측 REST 경로로 그대로 새어나갔다 — 산문 규약은 스코프가 반 발짝만 어긋나도
// 못 막는다는 뜻이므로, 이 파일은 기계적으로 거절한다.
//
// 순수 정적 소스텍스트 스캔이다(test-registration-completeness.test.mjs /
// drift-registry-completeness.test.mjs와 같은 장르) — app 부팅도, dist 빌드도
// 필요 없다:
//   1) apps/server/src 전체에서 `<식별자>: GitHubConnectorService` 타입 선언과
//      `new GitHubConnectorService(...)` 대입을 스캔해 실제로 쓰이는 receiver
//      식별자 집합을 "발견"한다 (하드코딩하지 않는다 — 새 파일이 새 변수명으로
//      인스턴스를 만들어도 놓치지 않기 위함).
//   2) 그 receiver들에 대해 credential-스코프 메서드(isEnabled 등 10개) 호출부를
//      전수 스캔하고, 괄호 중첩을 추적해 호출 인자 텍스트를 그대로 추출한다.
//   3) 인자 텍스트에 "credential"이 없는 호출은 화이트리스트(의도적 예외, 사유
//      필수)에 없는 한 실패시킨다 — 화이트리스트 방식(새 호출은 기본 거절).
//
// 비공허성: 아래 non-vacuous regression 블록은 스캐너가 실제로 쓰는 것과 동일한
// findCallSites/hasCredentialArg 함수를 리터럴 fixture에 돌려, credential-blind
// 호출을 놓치지 않는지 직접 증명한다(mcp-tool-authz.test.mjs의 ONE_LINE_FIXTURE /
// MULTI_LINE_FIXTURE 패턴과 동일).

import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(SERVER_ROOT, 'src');

// GitHubConnectorService의 public 메서드 중 credentialId(또는 opts.credential_id)를
// 받아 내부적으로 githubFetch/resolveToken을 타는 전체 목록(github-connector.service.ts
// 기준, private 헬퍼인 githubFetch/resolveToken/getTokenForCredential 자체는 제외 —
// 외부에서 직접 호출되는 곳이 없음을 grep으로 확인했다).
const CREDENTIAL_SCOPED_METHODS = [
  'isEnabled',
  'fetchBranchTipSha',
  'listWorkflows',
  'listWorkflowRuns',
  'getWorkflowRun',
  'listRunFailedJobs',
  'fetchRepoInfo',
  'searchRepos',
  'searchCode',
  'searchIssues',
];

// 의도적으로 credential 없이 호출해도 되는 것으로 "확인된" 호출만 여기에 등록한다.
// 이 목록은 새 위반의 우회 통로가 아니라 "아직 못 고친 known bug"를 추적하는
// 용도다 — 각 항목은 반드시 티켓 참조와 사유를 달고, argsText는 실제 호출부와
// 정확히 일치해야 한다(그래야 진짜로 고쳐지면 "stale entry" 테스트가 잡아내
// 청소를 강제한다).
const WHITELIST = [
  {
    file: 'modules/agents/ci-wait-resume.service.ts',
    method: 'getWorkflowRun',
    argsText: 'ctx.owner, ctx.repo, ctx.run_id',
    reason:
      '티켓 9bbe9146(CiWaitResumeService가 종료된 run을 재개시키지 않는 버그, board 환경 ' +
      '저장소 폴백 포함)이 이 호출부를 이미 손대는 중이라 이 티켓(5ba957b0)의 스코프 밖으로 ' +
      '명시적으로 제외했다. 9bbe9146이 origin/main에 랜딩되면 이 호출부에 credential 인자가 ' +
      '붙어 argsText가 더 이상 매치되지 않을 것이고, 그 순간 아래 "stale entry" 테스트가 ' +
      '실패하며 이 항목을 지우라고 알려준다 — 랜딩 여부를 사람이 따로 추적할 필요가 없다.',
  },
];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// openParenIndex가 가리키는 '('부터 시작해 괄호/중괄호/대괄호 중첩 깊이를 추적하고
// 문자열·템플릿 리터럴 내부는 건너뛰어, 짝이 맞는 ')'까지의 인자 텍스트를 그대로
// 잘라낸다. 여러 줄에 걸친 호출(listWorkflowRuns의 실제 호출부처럼)도 그대로
// 처리된다 — 개행에서 멈추지 않는다.
function extractBalancedArgs(src, openParenIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openParenIndex; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '(' || c === '{' || c === '[') { depth++; continue; }
    if (c === ')' || c === '}' || c === ']') {
      depth--;
      if (depth === 0 && c === ')') {
        return src.slice(openParenIndex + 1, i);
      }
    }
  }
  throw new Error(`unbalanced parens starting at index ${openParenIndex}`);
}

// fileContent 안에서 `[this.]<receiver>.<method>(` 형태의 호출부를 전부 찾아
// { file, line, receiver, method, argsText }로 반환한다. receiverNames/methodNames를
// 인자로 받는 순수 함수라, 실제 소스뿐 아니라 아래 non-vacuous regression의 리터럴
// fixture에도 그대로 재사용한다 — 스캐너 로직 자체를 fixture로 검증하기 위함.
function findCallSites(fileContent, relPath, receiverNames, methodNames) {
  const sites = [];
  for (const receiver of receiverNames) {
    for (const method of methodNames) {
      const pattern = new RegExp(
        `(?:\\bthis\\.)?\\b${escapeRegExp(receiver)}\\.${escapeRegExp(method)}\\s*\\(`,
        'g',
      );
      let m;
      while ((m = pattern.exec(fileContent))) {
        const openParenIndex = m.index + m[0].length - 1;
        const argsText = extractBalancedArgs(fileContent, openParenIndex).replace(/\s+/g, ' ').trim();
        const line = fileContent.slice(0, m.index).split('\n').length;
        sites.push({ file: relPath, line, receiver, method, argsText });
      }
    }
  }
  return sites;
}

// credentialId/credential_id 어느 표기든(포지셔널 인자든 opts 객체 프로퍼티든)
// 인자 텍스트 안에 "credential"이라는 토큰이 있으면 통과로 본다 — 이 저장소의
// 다른 정적 완전성 가드들과 같은 수준의 실용적 텍스트 매칭이다(완전한 타입
// 분석이 아님).
function hasCredentialArg(argsText) {
  return /credential/i.test(argsText);
}

function listTsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

// GitHubConnectorService 인스턴스가 실제로 바인딩되는 식별자 집합을 하드코딩
// 없이 "발견"한다 — 필드 타입 선언(`x: GitHubConnectorService`), 지역변수 대입
// (`const x = new GitHubConnectorService(...)`), `this.x = new
// GitHubConnectorService(...)` 세 가지 패턴을 모두 훑는다. 새 파일이 새 변수명을
// 쓰더라도 이 발견 단계가 못 잡으면 아래 sanity 테스트(receiverNames 최소 집합)가
// 먼저 실패하도록 만들어 스캐너 자체의 조용한 퇴화를 막는다.
function discoverReceiverNames(srcDir) {
  const names = new Set();
  const fieldPattern = /\b(\w+)\s*:\s*GitHubConnectorService\b/g;
  const localAssignPattern = /\b(?:const|let|var)\s+(\w+)\s*=\s*new\s+GitHubConnectorService\s*\(/g;
  const thisAssignPattern = /\bthis\.(\w+)\s*=\s*new\s+GitHubConnectorService\s*\(/g;
  for (const fp of listTsFiles(srcDir)) {
    const content = fs.readFileSync(fp, 'utf8');
    for (const m of content.matchAll(fieldPattern)) names.add(m[1]);
    for (const m of content.matchAll(localAssignPattern)) names.add(m[1]);
    for (const m of content.matchAll(thisAssignPattern)) names.add(m[1]);
  }
  return names;
}

function scanLiveCallSites() {
  const receiverNames = discoverReceiverNames(SRC_DIR);
  const sites = [];
  for (const fp of listTsFiles(SRC_DIR)) {
    const relPath = path.relative(SRC_DIR, fp).replace(/\\/g, '/');
    const content = fs.readFileSync(fp, 'utf8');
    sites.push(...findCallSites(content, relPath, receiverNames, CREDENTIAL_SCOPED_METHODS));
  }
  return { receiverNames, sites };
}

function isWhitelisted(site) {
  return WHITELIST.some(
    (w) => w.file === site.file && w.method === site.method && w.argsText === site.argsText,
  );
}

// ─── sanity: 스캐너 자체가 조용히 아무것도 못 찾는 상태(=늘 vacuously green)로
// 퇴화하지 않았는지 확인 ───

test('sanity: GitHubConnectorService receiver 식별자를 실제로 발견한다', () => {
  const { receiverNames } = scanLiveCallSites();
  assert.ok(receiverNames.has('github'), 'receiver "github"(필드/지역변수)를 발견하지 못했다 — 발견 정규식이 깨졌는가?');
  assert.ok(receiverNames.has('githubService'), 'receiver "githubService"를 발견하지 못했다 — 발견 정규식이 깨졌는가?');
});

test('sanity: 감사 기준선(14곳) 이상의 credential-스코프 호출부를 발견한다', () => {
  const { sites } = scanLiveCallSites();
  assert.ok(
    sites.length >= 14,
    `credential-스코프 호출부를 ${sites.length}곳만 발견했다(기대: 14곳 이상) — ` +
      '스캔 자체가 깨져 완전성 검사가 공허해졌을 수 있다.',
  );
});

// ─── 본 가드 ───

test('credential-스코프 GitHubConnectorService 호출부는 전부 credential 인자를 넘긴다(또는 추적된 화이트리스트에 있다)', () => {
  const { sites } = scanLiveCallSites();
  const violations = sites.filter((s) => !hasCredentialArg(s.argsText) && !isWhitelisted(s));
  assert.deepEqual(
    violations.map((v) => `${v.file}:${v.line} ${v.receiver}.${v.method}(${v.argsText})`),
    [],
    'credential 인자 없이 GitHubConnectorService의 credential-스코프 메서드를 호출하는 곳이 ' +
      '있다 — 반복되는 버그 클래스다(티켓 c90653d9 / 6c107743 / 9bbe9146 / 5ba957b0 참고). ' +
      'credential_id/credentialId를 호출부에 명시적으로 넘기거나, 정말로 credential이 필요 ' +
      '없는 의도된 호출이면 이 파일 상단 WHITELIST에 사유와 함께 등록하라.',
  );
});

test('WHITELIST에 낡은 항목이 없다(고쳐졌으면 등록을 지워야 한다)', () => {
  const { sites } = scanLiveCallSites();
  const stale = WHITELIST.filter(
    (w) => !sites.some((s) => s.file === w.file && s.method === w.method && s.argsText === w.argsText),
  );
  assert.deepEqual(
    stale.map((w) => `${w.file} ${w.method}(${w.argsText})`),
    [],
    '더 이상 실제 호출부와 매치되지 않는 WHITELIST 항목이 있다(이미 credential 인자가 붙어 ' +
      '고쳐졌다는 뜻) — 이 파일 상단 WHITELIST에서 해당 항목을 지워라.',
  );
});

// ─── non-vacuous regression: 스캐너가 실제로 쓰는 findCallSites/hasCredentialArg를
// 리터럴 fixture에 그대로 돌려, credential-blind 호출을 정말로 잡아내는지 증명한다
// (mcp-tool-authz.test.mjs의 ONE_LINE_FIXTURE/MULTI_LINE_FIXTURE와 같은 패턴) ───

describe('non-vacuous regression — 스캐너가 credential-blind 호출을 실제로 잡아내는가', () => {
  const CREDENTIAL_BLIND_FIXTURE =
    'class Foo {\n' +
    '  async bar(ctx) {\n' +
    '    const run = await this.github.getWorkflowRun(ctx.owner, ctx.repo, ctx.run_id);\n' +
    '  }\n' +
    '}\n';

  const CREDENTIAL_OK_FIXTURE =
    'class Foo {\n' +
    '  async bar(ctx) {\n' +
    '    const run = await this.github.getWorkflowRun(ctx.owner, ctx.repo, ctx.run_id, ctx.credentialId);\n' +
    '  }\n' +
    '}\n';

  // ci-health-monitor.service.ts의 실제 listWorkflowRuns 호출부를 그대로 재현한
  // 여러 줄짜리 fixture — 개행에서 인자 추출이 끊기지 않는지 확인한다.
  const MULTI_LINE_FIXTURE =
    'runsCache.set(\n' +
    '  runsKey,\n' +
    '  this.github.listWorkflowRuns(target.owner, target.repo, workflow.id, target.branch, target.credentialId),\n' +
    ');\n';

  // searchCode/searchRepos/searchIssues 스타일 — credential이 opts 객체 프로퍼티로
  // 넘어가는 경우도 인식하는지 확인한다.
  const OBJECT_OPTS_FIXTURE =
    'const results = await githubService.searchCode(query, { per_page: limit, credential_id });\n';

  it('credential 없는 단일행 호출을 잡아낸다(ci-wait-resume.service.ts:287의 실제 버그를 그대로 재현)', () => {
    const sites = findCallSites(CREDENTIAL_BLIND_FIXTURE, 'fixture.ts', new Set(['github']), CREDENTIAL_SCOPED_METHODS);
    assert.equal(sites.length, 1);
    assert.equal(hasCredentialArg(sites[0].argsText), false);
  });

  it('같은 호출에 credential 인자를 붙이면 더 이상 잡히지 않는다', () => {
    const sites = findCallSites(CREDENTIAL_OK_FIXTURE, 'fixture.ts', new Set(['github']), CREDENTIAL_SCOPED_METHODS);
    assert.equal(sites.length, 1);
    assert.equal(hasCredentialArg(sites[0].argsText), true);
  });

  it('여러 줄에 걸친 호출도 인자를 끝까지 정확히 추출한다', () => {
    const sites = findCallSites(MULTI_LINE_FIXTURE, 'fixture.ts', new Set(['github']), CREDENTIAL_SCOPED_METHODS);
    assert.equal(sites.length, 1);
    assert.equal(hasCredentialArg(sites[0].argsText), true);
  });

  it('opts 객체 프로퍼티로 넘어가는 credential_id도 인식한다', () => {
    const sites = findCallSites(OBJECT_OPTS_FIXTURE, 'fixture.ts', new Set(['githubService']), CREDENTIAL_SCOPED_METHODS);
    assert.equal(sites.length, 1);
    assert.equal(hasCredentialArg(sites[0].argsText), true);
  });
});
