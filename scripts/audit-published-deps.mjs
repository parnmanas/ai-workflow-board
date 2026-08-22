#!/usr/bin/env node
/**
 * audit-published-deps.mjs
 *
 * **호스트에 실제로 깔리는 트리**를 감사한다 — lockfile 이 아니라.
 *
 * 왜 필요한가(2026-08-21 감사에서 기록만 하고 닫지 않은 구멍): 이 저장소의 의존성
 * 게이트는 전부 `package-lock.json` 을 본다. 그런데 agent-manager 는 라이브 호스트에
 * `npm i -g awb-agent-manager` 로 깔린다 — 그 경로는 **우리 lockfile 을 읽지 않는다.**
 * npm 이 그 시점 레지스트리에서 `^` 범위를 새로 해석한다. 즉 CI 가 판정한 트리와
 * 호스트가 돌리는 트리는 애초에 다른 객체다.
 *
 * 이건 가설이 아니라 이미 관측된 사실이다 — 2026-08-21 감사 기준 `smol-toml` 이
 * lockfile 1.7.1 / 신규 설치 1.8.0 이었다. 그날은 양쪽 다 깨끗해서 기록만 남겼는데,
 * 그 상태로 두면 실패 모드가 이렇게 된다:
 *
 *   `^` 로만 닿는 버전에 advisory 가 붙는다 → lockfile 은 그 버전을 안 가리키므로
 *   `npm audit` 은 계속 0건 → **CI 는 영원히 초록인데 모든 라이브 호스트는 취약하다.**
 *
 * 어떤 기존 게이트도 이걸 못 본다. lockfile 감사(main), 배포 브랜치 lockfile 재감사,
 * install-script 허용목록, 액션 SHA 고정 — 전부 lockfile 축이거나 워크플로 축이다.
 * 발행 워크플로(publish-agent-manager.yml)도 `npm ci`(=lockfile)로 빌드할 뿐,
 * 소비자가 무엇을 해석하게 될지는 보지 않는다.
 *
 * 두 가지를 서로 다른 질문으로 나눠 본다:
 *
 *   1) **live**  — 지금 `npm i -g awb-agent-manager` 하면 뭐가 깔리는가.
 *      레지스트리의 `latest` 를 그대로 해석한다. = 지금 이 순간 호스트에 떠 있는 트리.
 *   2) **next**  — 워크스페이스 매니페스트가 선언한 범위는 뭘로 해석되는가.
 *      = 다음 publish 가 호스트에 넘길 트리. PR 시점에 미리 잡으라고 있는 축이다.
 *
 * 둘은 갈릴 수 있다. `latest` 는 과거 커밋에서 발행됐으므로 그때의 범위를 들고 있고,
 * 워크스페이스는 지금의 범위를 들고 있다. "오늘 호스트가 안전한가" 와 "다음 배포가
 * 안전한가" 는 다른 질문이라 둘 다 답해야 한다.
 *
 * 설계 선택:
 *   - **설치하지 않는다.** `npm install --package-lock-only --ignore-scripts` 로 해석만
 *     하고 그 lockfile 에 `npm audit` 을 돌린다. 취약점을 찾는 잡이 그 취약점의
 *     install script 를 먼저 실행하는 순서 문제가 원천적으로 사라진다
 *     (ci.yml dependency-audit / audit-deploy-branch-deps.mjs 와 같은 원칙).
 *   - **fail-closed.** 네트워크·해석·audit 어느 단계가 실패해도 통과시키지 않는다.
 *     "확인 못 했다" 를 "문제 없다" 로 바꿔 읽는 게 이 계열 가드의 가장 위험한
 *     실패 모드다(이 저장소의 다른 감사 스크립트와 동일한 규약).
 *   - **드리프트를 침묵시키지 않는다.** lockfile 해석 버전과 레지스트리 해석 버전이
 *     갈리면 통과하더라도 로그에 남긴다. 위 smol-toml 처럼 "오늘은 둘 다 깨끗" 인
 *     상태가 조용히 지나가면 다음 사람이 이 구멍의 존재를 모른다.
 *
 * ── 두 층으로 나눈 이유 ──
 *
 * `--offline` 모드는 네트워크 없이 **선언 범위의 모양**만 본다(무한 상한 금지).
 * 전체 모드는 레지스트리를 때리므로 ci.yml 에서 schedule 전용이다 — 매 PR 마다
 * 외부 레지스트리에 의존하면 CI 가 비-hermetic 해지고 레지스트리 blip 이 곧 red 다.
 * 그런데 그렇게만 두면 "범위를 넓히는 PR"(`^1.7.0` → `*`)은 최대 24시간 방치된다.
 * 범위 확장은 이 구멍의 폭을 직접 키우는 변경이라 PR 시점에 막아야 하고, 그 검사는
 * 순수 문자열 판정이라 오프라인으로 가능하다. 그래서 싼 층은 항상, 비싼 층은 cron.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AUDIT_LEVEL = 'moderate';

/** 발행되는 패키지의 매니페스트 경로. 이게 소비자가 해석하게 될 범위의 출처다. */
export const PUBLISHED_MANIFEST = 'apps/agent-manager/package.json';

/**
 * 발행 패키지 매니페스트를 읽는다. 읽지 못하면 throw — 이 파일을 못 읽는다는 건
 * 감사 대상 자체를 못 찾았다는 뜻이라 조용히 스킵하면 안 된다.
 */
export function publishedManifest(manifestPath = join(root, PUBLISHED_MANIFEST)) {
  if (!existsSync(manifestPath)) {
    throw new Error(`발행 패키지 매니페스트를 찾지 못했다: ${manifestPath}`);
  }
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

/**
 * 소비자가 해석하게 될 런타임 의존성 범위. devDependencies 는 발행 tarball 의
 * 소비자에게 설치되지 않으므로 제외한다.
 */
export function declaredRanges(manifest) {
  return { ...(manifest?.dependencies ?? {}) };
}

/**
 * 상한이 없는(=미래의 아무 버전이나 끌어올 수 있는) 범위를 골라낸다.
 *
 * 여기서 걸러야 하는 건 "npm 이 오늘 뭘 고르는가" 가 아니라 "내일 무엇을 고를 수
 * 있는가" 다. 상한이 없으면 업스트림의 임의 메이저가 우리 승인 없이 호스트에
 * 들어올 수 있고, 그 트리는 어떤 lockfile 게이트에도 잡히지 않는다.
 *
 * semver 패키지에 의존하지 않는다 — 이 스크립트는 `npm ci` 이전에도 돌아야 하고
 * (dependency-audit 잡은 의도적으로 설치를 하지 않는다), 판정 규칙 자체는 단순하다.
 */
export function unboundedRanges(ranges) {
  const bad = [];
  for (const [name, raw] of Object.entries(ranges)) {
    const reason = rangeProblem(raw);
    if (reason) bad.push({ name, range: raw, reason });
  }
  return bad;
}

/** 범위 하나를 판정한다. 문제없으면 null, 있으면 사람이 읽을 이유 문자열. */
export function rangeProblem(raw) {
  const range = String(raw ?? '').trim();

  if (range === '') return '빈 범위 — 아무 버전이나 해석된다';
  if (range === '*' || range === 'x' || range === 'X') return `와일드카드(${range}) — 상한 없음`;
  if (range === 'latest' || range === '*.*.*') return `${range} — 상한 없음`;

  // 레지스트리 밖에서 끌어오는 스펙. 소비자 호스트가 우리 감사 범위 밖의 코드를
  // 직접 받아오게 되고, integrity 해시도 붙지 않는다.
  if (/^(git|git\+|github:|https?:|file:|link:)/i.test(range)) {
    return `비-레지스트리 스펙(${range}) — 감사·integrity 대상 밖`;
  }

  // `||` 로 이어진 각 절이 모두 상한을 가져야 한다. 한 절이라도 열려 있으면
  // 그 절을 통해 임의 버전이 들어온다.
  const clauses = range.split('||').map((c) => c.trim()).filter(Boolean);
  if (clauses.length === 0) return '빈 범위 — 아무 버전이나 해석된다';

  for (const clause of clauses) {
    if (!clauseHasUpperBound(clause)) {
      return `상한 없는 절 "${clause}" — 임의의 상위 메이저가 들어올 수 있다`;
    }
  }
  return null;
}

/**
 * 한 절(공백으로 이어진 comparator 들)이 상한을 갖는지.
 *
 * 상한을 만드는 형태: `^x`, `~x`, 정확한 버전, `<`/`<=`, 하이픈 범위(`1.0.0 - 2.0.0`),
 * 그리고 부분 버전(`1`, `1.2`, `1.x`)처럼 메이저가 고정된 형태.
 * 상한을 만들지 않는 형태: `>`/`>=` 단독, `*`.
 */
export function clauseHasUpperBound(clause) {
  const parts = clause.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;

  // 하이픈 범위: `1.0.0 - 2.0.0` — 오른쪽 끝이 상한이다.
  if (parts.includes('-')) return true;

  return parts.some((p) => {
    if (/^[<]=?/.test(p)) return true; // 명시적 상한
    if (/^\^/.test(p) || /^~/.test(p)) return true; // 캐럿/틸드는 메이저(또는 마이너) 고정
    if (/^[>]=?/.test(p)) return false; // 하한만 — 상한 아님
    if (p === '*' || p === 'x' || p === 'X') return false;
    if (/^=?\d/.test(p)) return true; // `1`, `1.2`, `1.2.3`, `=1.2.3` — 메이저 고정
    return false;
  });
}

/** lockfile 에서 패키지 이름 → 해석된 버전 맵. */
export function lockfileVersions(lock) {
  const out = new Map();
  for (const [path, entry] of Object.entries(lock?.packages ?? {})) {
    if (!path || entry?.link) continue;
    const idx = path.lastIndexOf('node_modules/');
    if (idx === -1) continue;
    const name = path.slice(idx + 'node_modules/'.length);
    if (entry?.version && !out.has(name)) out.set(name, entry.version);
  }
  return out;
}

/**
 * lockfile 해석 결과와 레지스트리 재해석 결과의 차이.
 * 양쪽에 다 있는 이름만 비교한다 — 한쪽에만 있는 건 트리 모양 차이라 별개 축이다.
 */
export function driftRows(lockVersions, resolvedVersions) {
  const rows = [];
  for (const [name, resolvedVersion] of resolvedVersions) {
    const lockVersion = lockVersions.get(name);
    if (lockVersion && lockVersion !== resolvedVersion) {
      rows.push({ name, lock: lockVersion, resolved: resolvedVersion });
    }
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 임시 디렉터리에서 매니페스트를 해석해 lockfile 을 만들고 audit 한다.
 * 설치는 하지 않는다(`--package-lock-only`), install script 도 막는다.
 *
 * 반환: { versions: Map<name, version>, packageCount }
 * 실패하면 throw — 호출부가 fail-closed 로 처리한다.
 */
export function resolveAndAudit(label, manifest) {
  const dir = mkdtempSync(join(tmpdir(), `awb-published-${label}-`));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2));

    execFileSync(
      'npm',
      ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
      { cwd: dir, stdio: 'pipe', encoding: 'utf8' },
    );

    const lockPath = join(dir, 'package-lock.json');
    if (!existsSync(lockPath)) {
      throw new Error('해석은 끝났는데 package-lock.json 이 생기지 않았다');
    }
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    const versions = lockfileVersions(lock);

    try {
      execFileSync('npm', ['audit', `--audit-level=${AUDIT_LEVEL}`], {
        cwd: dir,
        stdio: 'pipe',
        encoding: 'utf8',
      });
    } catch (e) {
      const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim();
      const err = new Error(`npm audit 에서 ${AUDIT_LEVEL} 이상 취약점`);
      err.auditOutput = out;
      throw err;
    }

    return { versions, packageCount: versions.size };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();

function main() {
  const offlineOnly = process.argv.includes('--offline');
  const failures = [];

  // ── 층 1 (항상, 오프라인): 선언 범위의 모양 ──────────────────────────────
  let ranges;
  try {
    ranges = declaredRanges(publishedManifest());
  } catch (e) {
    console.error(`FAIL 발행 매니페스트를 읽지 못했다 — ${e.message}`);
    process.exit(1);
  }

  const names = Object.keys(ranges);
  if (names.length === 0) {
    // 런타임 의존성이 0개면 검사 대상이 없어 **조용히 통과**한다 — 파서가 망가진
    // 경우와 구분되지 않는 상태다. 이 패키지는 실제로 런타임 의존성을 갖는다.
    console.error(
      `FAIL ${PUBLISHED_MANIFEST} 에서 런타임 의존성을 하나도 읽지 못했다.` +
        ` 매니페스트 구조가 바뀌었거나 파서가 깨졌다 — 검사 대상 0개를 통과로 읽지 않는다.`,
    );
    process.exit(1);
  }

  const bad = unboundedRanges(ranges);
  for (const name of names) {
    const hit = bad.find((b) => b.name === name);
    if (hit) console.log(`FAIL ${name}@${ranges[name]} — ${hit.reason}`);
    else console.log(`ok   ${name}@${ranges[name]} — 상한 있음`);
  }
  for (const b of bad) {
    failures.push(`${b.name}: ${b.reason}`);
  }

  if (offlineOnly) {
    finish(failures, `선언 범위 ${names.length}개 — 전부 상한 있음 (오프라인 검사만 수행).`);
    return;
  }

  // ── 층 2 (cron, 네트워크): 실제 해석 결과 감사 ───────────────────────────
  let lockVersions = new Map();
  const rootLockPath = join(root, 'package-lock.json');
  if (existsSync(rootLockPath)) {
    try {
      lockVersions = lockfileVersions(JSON.parse(readFileSync(rootLockPath, 'utf8')));
    } catch {
      /* 드리프트 리포트는 부가 정보 — 여기 실패로 감사를 막지 않는다 */
    }
  }

  // (1) live — 지금 `npm i -g awb-agent-manager` 가 깔 트리.
  const pkgName = publishedManifest().name;
  const targets = [
    {
      label: 'live',
      what: `레지스트리 latest (\`npm i -g ${pkgName}\` 가 지금 깔 트리)`,
      manifest: {
        name: 'awb-published-audit-live',
        version: '0.0.0',
        private: true,
        dependencies: { [pkgName]: 'latest' },
      },
    },
    // (2) next — 워크스페이스가 선언한 범위 = 다음 publish 가 넘길 트리.
    {
      label: 'next',
      what: `${PUBLISHED_MANIFEST} 선언 범위 (다음 publish 가 호스트에 넘길 트리)`,
      manifest: {
        name: 'awb-published-audit-next',
        version: '0.0.0',
        private: true,
        dependencies: ranges,
      },
    },
  ];

  for (const t of targets) {
    let res;
    try {
      res = resolveAndAudit(t.label, t.manifest);
    } catch (e) {
      console.log(`FAIL ${t.label} — ${e.message}`);
      console.log(`     대상: ${t.what}`);
      if (e.auditOutput) console.log(e.auditOutput);
      // 해석 실패(네트워크·레지스트리)도 감사 실패로 취급한다 — fail-closed.
      failures.push(`${t.label}: ${e.message}`);
      continue;
    }

    console.log(`ok   ${t.label} — ${res.packageCount} 패키지, ${AUDIT_LEVEL} 이상 0건`);
    console.log(`     대상: ${t.what}`);

    const drift = driftRows(lockVersions, res.versions);
    if (drift.length > 0) {
      // 통과시키되 반드시 보이게 남긴다. 이 목록이 곧 "CI 가 판정한 적 없는 버전" 이다.
      console.log(
        `     드리프트 ${drift.length}건 (lockfile → 실제 해석) — 오늘은 둘 다 깨끗하지만` +
          ` 이 버전들은 lockfile 감사가 본 적 없다:`,
      );
      for (const d of drift) console.log(`       ${d.name}: ${d.lock} → ${d.resolved}`);
    } else {
      console.log('     드리프트 없음 — 해석 결과가 lockfile 과 일치.');
    }
  }

  finish(
    failures,
    `발행 트리 감사 완료 — live/next 양쪽 모두 ${AUDIT_LEVEL} 이상 0건, 선언 범위 ${names.length}개 전부 상한 있음.`,
  );
}

function finish(failures, okMessage) {
  if (failures.length > 0) {
    console.error(
      `\n발행 트리 감사 문제 ${failures.length}건:\n` +
        failures.map((f) => `  - ${f}`).join('\n') +
        `\n\n이건 lockfile 이 아니라 **호스트가 실제로 받는 트리** 다 —` +
        ` \`npm i -g awb-agent-manager\` 는 우리 lockfile 을 읽지 않는다.` +
        `\n\`npm audit fix\` 는 금지(루트 overrides 를 날린다).` +
        ` ${PUBLISHED_MANIFEST} 의 선언 범위를 좁히거나, 안전한 버전이 나올 때까지` +
        ` 루트 \`overrides\` 로 고정할 것.`,
    );
    process.exit(1);
  }
  console.log(`\n${okMessage}`);
}
