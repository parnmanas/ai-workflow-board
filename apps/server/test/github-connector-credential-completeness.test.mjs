// 회귀 방지 가드 — 티켓 5ba957b0.
//
// "credential 인자를 안 넘기고 GitHubConnectorService 메서드를 호출" 버그가 이미
// 4번 났다: (1) REST/ls-remote(c90653d9), (2) worktree-manager clone/push
// (agent-manager), (3) environment-provisioner clone(6c107743), (4)
// ci-wait-resume.service.ts:287의 getWorkflowRun(9bbe9146 — 이 가드를 만드는
// 동안 origin/main에 랜딩되어 4번째 사례는 이미 고쳐진 상태다). 3번 직후 보드
// 레슨(a3e5b406)이 "agent-manager git-네트워크 경로"로 좁게 적혀 있던 탓에
// 4번째가 서버측 REST 경로로 그대로 새어나갔다 — 산문 규약은 스코프가 반 발짝만
// 어긋나도 못 막는다는 뜻이므로, 이 파일은 기계적으로 거절한다.
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
//      이 10개 목록(CREDENTIAL_SCOPED_METHODS) 자체도 하드코딩 방치가 아니다 —
//      github-connector.service.ts의 클래스 바디를 파싱해 실제로 githubFetch/
//      resolveToken을 경유하는 public 메서드 집합을 독립적으로 "발견"하고, 그
//      집합이 이 상수와 정확히 일치하는지 별도 테스트로 비교한다(리뷰 라운드1
//      지적 — 새 credential 경유 public 메서드가 추가돼도 상수에 안 넣으면
//      조용히 통과하던 구멍을 막는다).
//   3) 인자 텍스트에 "credential"이 없는 호출은 화이트리스트(의도적 예외, 사유
//      필수)에 없는 한 실패시킨다 — 화이트리스트 방식(새 호출은 기본 거절).
//      화이트리스트는 오직 "정말로 credential이 필요 없는 의도된 호출"만을
//      위한 등록소다 — 아직 못 고친 실제 버그를 여기 등록해 가드를 green으로
//      우회하는 용도가 아니다(리뷰 라운드1 지적 — 9bbe9146이 랜딩되기 전에 그
//      호출부를 임시 등록했던 것을 반려당했다). 그래서 지금은 비어 있다.
//
// 비공허성: 아래 non-vacuous regression 블록은 스캐너가 실제로 쓰는 것과 동일한
// findCallSites/hasCredentialArg/discoverCredentialRoutedPublicMethods 함수를
// 리터럴 fixture에 돌려, credential-blind 호출과 상수-목록 drift를 놓치지 않는지
// 직접 증명한다(mcp-tool-authz.test.mjs의 ONE_LINE_FIXTURE/MULTI_LINE_FIXTURE
// 패턴과 동일).

import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(SERVER_ROOT, 'src');
const GITHUB_CONNECTOR_SERVICE_FILE = path.join(SRC_DIR, 'services', 'github-connector.service.ts');

// GitHubConnectorService의 public 메서드 중 credentialId(또는 opts.credential_id)를
// 받아 내부적으로 githubFetch/resolveToken을 타는 전체 목록(github-connector.service.ts
// 기준, private 헬퍼인 githubFetch/resolveToken/getTokenForCredential 자체는 제외 —
// 외부에서 직접 호출되는 곳이 없음을 grep으로 확인했다). 이 목록은 손으로만 유지되는
// blind spot이 아니다 — 아래 "CREDENTIAL_SCOPED_METHODS 완전성" 테스트가
// discoverCredentialRoutedPublicMethods()로 github-connector.service.ts에서 실제
// credential-경유 public 메서드 집합을 독립적으로 재발견해 이 배열과 정확히
// 일치하는지 매번 비교한다 — 새 메서드가 추가되고 여기 등록을 빠뜨리면 그 비교
// 테스트가 실패한다.
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
// 각 항목은 반드시 티켓 참조와 사유를 달고, argsText는 실제 호출부와 정확히
// 일치해야 한다(그래야 진짜로 고쳐지면 "stale entry" 테스트가 잡아내 청소를
// 강제한다). **이 목록은 "아직 못 고친 known bug"를 임시로 숨기는 용도가
// 아니다** — 리뷰 라운드1에서 ci-wait-resume.service.ts:287(9bbe9146이 고치기
// 전의 실제 credential-blind 회귀)를 "진행 중인 다른 티켓 스코프"라는 이유로
// 여기 등록했다가 반려됐다: 화이트리스트는 오직 credential이 구조적으로 필요
// 없는 호출(예: 공개 endpoint를 캐시-워밍 목적으로만 두드리는 경우 등)만을
// 위한 것이고, 실제 회귀는 반드시 코드를 고치거나(가능하면 즉시) 그 수정이
// 랜딩될 때까지 이 가드 자체를 티켓 prerequisite로 막아야 한다 — 알려진
// credential 결함을 green 상태로 은폐한 채 이 가드를 병합할 수 없다. 지금은
// 등록된 예외가 없다(9bbe9146이 랜딩되어 유일한 known gap이 해소됐다).
const WHITELIST = [];

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

// github-connector.service.ts의 클래스 멤버는 이 파일 전체에서 일관되게 2-space
// 들여쓰기로 선언된다(`  async foo(...)`, `  private bar(...)` 등 — 프로젝트
// 컨벤션인 2-space indent를 그대로 따름). 그 들여쓰기 위치에서 시작하는 멤버
// 선언부를 순서대로 찾아, "이 선언부터 다음 멤버 선언 직전까지"를 그 멤버의
// 소스 슬라이스로 본다 — 메서드 바디의 중괄호를 직접 균형 추적하지 않아도
// 되므로 opts 객체 타입 인자(searchRepos 등)처럼 중첩된 `{}`가 껴 있어도
// 흔들리지 않는다. constructor는 credential을 다루지 않으므로 제외한다.
function discoverCredentialRoutedPublicMethods(fileContent) {
  const memberPattern = /^ {2}(private\s+)?(async\s+)?(\w+)\s*\(/gm;
  const members = [];
  let m;
  while ((m = memberPattern.exec(fileContent))) {
    members.push({ name: m[3], isPrivate: !!m[1], start: m.index });
  }
  const discovered = new Set();
  for (let i = 0; i < members.length; i++) {
    const { name, isPrivate, start } = members[i];
    // constructor는 경계 마커로는 그대로 참여시키되(그래야 바로 앞/뒤 멤버의
    // 슬라이스가 constructor 위치와 상관없이 정확하다) discovered 후보에서는
    // 제외한다 — credential을 다루지 않는다.
    if (name === 'constructor') continue;
    const end = i + 1 < members.length ? members[i + 1].start : fileContent.length;
    const body = fileContent.slice(start, end);
    const routesCredential = /\bthis\.(githubFetch|resolveToken)\s*\(/.test(body);
    if (!isPrivate && routesCredential) discovered.add(name);
  }
  return discovered;
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

test('sanity: github-connector.service.ts에서 credential-경유 public 메서드를 실제로 발견한다', () => {
  const content = fs.readFileSync(GITHUB_CONNECTOR_SERVICE_FILE, 'utf8');
  const discovered = discoverCredentialRoutedPublicMethods(content);
  assert.ok(
    discovered.size >= 10,
    `credential-경유 public 메서드를 ${discovered.size}개만 발견했다(기대: 10개 이상) — ` +
      '발견 로직(2-space 멤버 들여쓰기 파싱)이 깨졌을 수 있다.',
  );
});

// ─── CREDENTIAL_SCOPED_METHODS 완전성: 리뷰 라운드1 지적 — 하드코딩된 목록이
// 실제 서비스 구현과 독립적으로 계속 일치하는지 비교한다. github-connector.
// service.ts에 credential을 githubFetch/resolveToken으로 경유하는 새 public
// 메서드가 추가되고 이 상수에 등록을 빠뜨리면(=위 CREDENTIAL_SCOPED_METHODS
// 기반 스캔에서 조용히 빠짐) 아래 테스트가 그 drift를 잡아낸다. ───

test('CREDENTIAL_SCOPED_METHODS 상수가 github-connector.service.ts의 실제 credential-경유 public 메서드 집합과 정확히 일치한다', () => {
  const content = fs.readFileSync(GITHUB_CONNECTOR_SERVICE_FILE, 'utf8');
  const discovered = discoverCredentialRoutedPublicMethods(content);
  const declared = new Set(CREDENTIAL_SCOPED_METHODS);
  const missing = [...discovered].filter((n) => !declared.has(n)).sort();
  const stale = [...declared].filter((n) => !discovered.has(n)).sort();
  assert.deepEqual(
    missing,
    [],
    'github-connector.service.ts에 credential을 githubFetch/resolveToken으로 경유하는 새 ' +
      'public 메서드가 추가됐는데 CREDENTIAL_SCOPED_METHODS에는 없다 — 이 파일 상단 상수에 ' +
      '추가해 스캔 대상에 포함시켜라(빠뜨리면 그 메서드의 credential-blind 호출부가 조용히 ' +
      '통과한다).',
  );
  assert.deepEqual(
    stale,
    [],
    'CREDENTIAL_SCOPED_METHODS에 github-connector.service.ts에서 더 이상 credential을 ' +
      '경유하지 않거나(리팩터) 삭제된 메서드가 남아있다 — 상수에서 제거하라.',
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

describe('non-vacuous regression — CREDENTIAL_SCOPED_METHODS 완전성 비교가 실제로 drift를 잡아내는가', () => {
  // github-connector.service.ts의 실제 형태를 축약 재현: constructor·private
  // 헬퍼(githubFetch 포함)·credential을 안 쓰는 public 메서드·resolveToken을
  // 경유하는 public 메서드·opts 객체 타입(중첩 `{}`)을 받는 public 메서드를
  // 모두 담아, 발견 로직이 각각을 올바르게 분류하는지 한 번에 검증한다.
  const SERVICE_CLASS_FIXTURE =
    'export class FakeGitHubConnectorService {\n' +
    '  constructor(private readonly dataSource) {}\n' +
    '\n' +
    '  private getEnvToken() {\n' +
    '    return process.env.GITHUB_TOKEN || "";\n' +
    '  }\n' +
    '\n' +
    '  async resolveToken(credentialId) {\n' +
    '    return credentialId ? "tok" : this.getEnvToken();\n' +
    '  }\n' +
    '\n' +
    '  async isEnabled(credentialId) {\n' +
    '    return !!(await this.resolveToken(credentialId));\n' +
    '  }\n' +
    '\n' +
    '  private async githubFetch(path, credentialId) {\n' +
    '    const token = await this.resolveToken(credentialId);\n' +
    '    return { path, token };\n' +
    '  }\n' +
    '\n' +
    '  async searchRepos(query, opts) {\n' +
    '    const perPage = opts?.per_page ?? 10;\n' +
    '    return this.githubFetch(`/search/repositories?q=${query}`, opts?.credential_id);\n' +
    '  }\n' +
    '\n' +
    '  buildSyncContent(info) {\n' +
    '    return `# ${info.full_name}`;\n' +
    '  }\n' +
    '}\n';

  it('credential을 경유하는 public 메서드만 발견하고, constructor·private 헬퍼·credential-미경유 메서드는 제외한다', () => {
    const discovered = discoverCredentialRoutedPublicMethods(SERVICE_CLASS_FIXTURE);
    assert.deepEqual([...discovered].sort(), ['isEnabled', 'searchRepos']);
  });

  it('CREDENTIAL_SCOPED_METHODS에 새 메서드 등록을 빠뜨리면 완전성 비교가 실패로 잡아낸다', () => {
    const discovered = discoverCredentialRoutedPublicMethods(SERVICE_CLASS_FIXTURE);
    const declaredWithoutSearchRepos = new Set(['isEnabled']); // searchRepos 등록 누락을 시뮬레이션
    const missing = [...discovered].filter((n) => !declaredWithoutSearchRepos.has(n));
    assert.deepEqual(missing, ['searchRepos']);
  });

  it('CREDENTIAL_SCOPED_METHODS에 실제로 존재하지 않는 낡은 항목이 남으면 완전성 비교가 실패로 잡아낸다', () => {
    const discovered = discoverCredentialRoutedPublicMethods(SERVICE_CLASS_FIXTURE);
    const declaredWithStaleEntry = new Set(['isEnabled', 'searchRepos', 'removedMethod']); // 삭제된 메서드가 남아있는 상황을 시뮬레이션
    const stale = [...declaredWithStaleEntry].filter((n) => !discovered.has(n));
    assert.deepEqual(stale, ['removedMethod']);
  });
});
