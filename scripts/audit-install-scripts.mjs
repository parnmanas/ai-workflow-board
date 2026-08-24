#!/usr/bin/env node
/**
 * audit-install-scripts.mjs
 *
 * 공급망 가드 — package-lock.json 에서 **install script 를 실행하는 패키지**의
 * 집합이 허용목록을 벗어나면 실패한다.
 *
 * 왜 필요한가: ci.yml 의 모든 잡은 `npm ci` 로 서드파티 의존성의 preinstall/
 * install/postinstall 스크립트를 실행한다. 그 스크립트는 러너에서 임의 코드로
 * 돌고 체크아웃 트리와 같은 프로세스 트리에 있다. ci.yml 주석은 이 사실을 알고
 * 허용목록(esbuild/fsevents/@scarf/scarf)을 문서로 적어 뒀지만 **강제하는 곳이
 * 없었다** — 새 의존성(또는 탈취된 기존 의존성의 새 버전)이 postinstall 을 달고
 * 들어와도 lockfile diff 를 사람이 눈으로 잡아야만 보였다.
 *
 * 이 가드는 그 문서를 실행 가능한 검사로 바꾼다. 새 패키지가 정당하게 install
 * script 를 필요로 한다면 ALLOWED 에 이름을 추가하는 것이 리뷰 포인트가 된다 —
 * 조용히 통과하지 않는다.
 *
 * 이름 단위 허용(버전 무관)인 이유: 버전까지 묶으면 정상 패치 범프마다 CI 가
 * 깨져서 가드가 무시당한다. 잡으려는 건 "install script 를 도는 패키지가 새로
 * 생겼다" 이며, 기존 패키지의 탈취는 npm audit / provenance 쪽 책임이다.
 *
 * ── 두 번째 축: 그 스크립트가 **어디서** 도는가 (2026-08-24 추가) ──
 *
 * 위 허용목록은 "어떤 패키지가 install script 를 갖는가" 만 판정한다. 그런데
 * 같은 스크립트라도 도는 자리에 따라 결과가 전혀 다르다:
 *
 *   - CI 러너에서 돈다        → 시크릿 없음, `contents: read`, 잡이 끝나면 사라진다.
 *   - **배포 이미지 빌드에서 돈다** → root 권한으로, 최종 레이어에 무엇이든 남길 수
 *     있다. 그 레이어는 NAS 에 pull 돼 계속 떠 있다.
 *
 * 허용목록은 후자를 정당화하지 못한다 — `esbuild` 의 postinstall 이 빌드 체인에
 * 필요하다는 사실은 배포 이미지 안에서 서드파티 코드가 root 로 도는 것을 승인한
 * 적이 없다. 실제로 2026-08-24 감사 시점의 runner 스테이지(`npm ci --omit=dev
 * --workspace=server`, 247 패키지)에는 `@scarf/scarf` 의 postinstall 이 있었다 —
 * child_process.exec + scarf.sh HTTPS 전송을 하는 순수 텔레메트리이고, 루트
 * package.json 의 `scarfSettings.enabled:false` 는 **그 스크립트 자신이 읽는
 * 옵트아웃**이라 실행을 넘겨준 뒤의 선의에 기대는 방어였다.
 *
 * 이 축은 2026-08-23 이 agent-manager self-update(`npm i -g`)에 대해 세운 것과
 * 같은 판단을 **다른 라이브 호스트**(NAS 의 서버 이미지)에 적용한 것이다. 그래서
 * Dockerfile 의 모든 로컬 설치가 `--ignore-scripts` 를 쓰는지 여기서 강제한다.
 *
 * lockfile 축과 달리 "결합 강제"(2026-08-23 published-deps 가드)는 두지 않는다:
 * 발행 트리 쪽은 허용목록에 이름을 넣어놓고 `--ignore-scripts` 를 두면 **조용히
 * 깨진 트리**가 호스트에 깔리지만, 여기서는 스크립트가 정말 필요해지는 순간
 * Docker 빌드가 그 자리에서 실패한다 — 침묵하는 실패 모드가 아니다.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ALLOWED = new Set([
  'esbuild',      // 네이티브 바이너리 선택 (vite/tsx 빌드 체인)
  'fsevents',     // macOS 파일 감시 — optional, 리눅스 러너에선 미설치
  '@scarf/scarf', // nestjs 계열이 끌고 오는 텔레메트리 (SCARF_ANALYTICS=false 로 무력화 가능)
]);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** node_modules 경로에서 패키지 이름만 뽑는다 (중첩/스코프 모두 처리). */
function packageName(path) {
  const idx = path.lastIndexOf('node_modules/');
  return idx === -1 ? null : path.slice(idx + 'node_modules/'.length);
}

function auditLockfile() {
  const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));

  const found = new Map(); // name -> [lock paths]
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!entry?.hasInstallScript) continue;
    const name = packageName(path);
    if (!name) continue;
    if (!found.has(name)) found.set(name, []);
    found.get(name).push(`${path}@${entry.version}`);
  }

  const unexpected = [...found.keys()].filter((name) => !ALLOWED.has(name)).sort();

  for (const name of [...found.keys()].sort()) {
    console.log(`${ALLOWED.has(name) ? 'ok  ' : 'FAIL'} ${name}`);
  }

  if (unexpected.length > 0) {
    console.error(
      `\n허용목록에 없는 install-script 패키지 ${unexpected.length}개:\n` +
        unexpected.map((n) => `  - ${n}\n      ${found.get(n).join('\n      ')}`).join('\n') +
        `\n\n정당한 의존성이면 scripts/audit-install-scripts.mjs 의 ALLOWED 에 추가하고,` +
        ` 왜 install script 가 필요한지 커밋 메시지에 남길 것.`,
    );
    process.exit(1);
  }

  console.log(`\ninstall-script 패키지 ${found.size}개 — 전부 허용목록 내.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 축 2 — Dockerfile 의 로컬 설치는 서드파티 스크립트를 실행하지 않아야 한다
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dockerfile 에서 **로컬 트리를 설치하는** npm 호출 줄을 뽑는다.
 * `npm install -g <tool>` 같은 전역 설치는 lockfile 트리와 무관하므로 제외한다
 * (전역 설치 쪽 방어는 agent-manager self-update + supply-chain 가드 담당).
 */
export function dockerfileInstallLines(dockerfile) {
  const out = [];
  dockerfile.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (line.startsWith('#')) return;
    if (!/\bnpm\s+(?:ci|install|i)\b/.test(line)) return;
    if (/\bnpm\s+(?:install|i)\b[^\n]*\s(?:-g|--global)\b/.test(line)) return;
    out.push({ line: i + 1, text: line });
  });
  return out;
}

/** `--ignore-scripts` 가 빠진 설치 줄. */
export function missingIgnoreScripts(lines) {
  return lines.filter(({ text }) => !/\s--ignore-scripts\b/.test(text));
}

// 이 파일은 CLI 가드이면서 동시에 파서를 export 한다(apps/server/test/
// supply-chain-integrity-guard.test.mjs 가 직접 단언한다). import 만으로 검사가
// 돌면 안 된다 — 검사 실패의 `process.exit(1)` 이 테스트 러너 전체를 죽여서
// "이 가드가 FAIL 했다" 가 아니라 "스위트가 통째로 죽었다" 로 보이게 된다.
// (audit-ci-branch-coverage.mjs 와 같은 규약.)
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  auditLockfile();
  auditDockerfile();
}

function auditDockerfile() {
  const dockerfile = readFileSync(resolve(root, 'Dockerfile'), 'utf8');
  const installs = dockerfileInstallLines(dockerfile);

  // fail-closed: 한 줄도 못 찾으면 "검사 대상 0개" 로 조용히 통과해 버린다.
  // Dockerfile 이 반드시 의존성을 설치한다는 사실 자체를 여기서 붙잡아 둔다.
  if (installs.length === 0) {
    console.error(
      '\nFAIL Dockerfile 에서 npm 설치 줄을 하나도 찾지 못했다 —' +
        ' 파서가 깨졌거나 설치 방식이 바뀌었다. 어느 쪽이든 조용히 통과시키지 않는다.',
    );
    process.exit(1);
  }

  const missing = missingIgnoreScripts(installs);
  for (const { line, text } of installs) {
    const ok = !missing.some((m) => m.line === line);
    console.log(`${ok ? 'ok  ' : 'FAIL'} Dockerfile:${line} ${text}`);
  }

  if (missing.length > 0) {
    console.error(
      `\nDockerfile 에서 서드파티 install script 를 실행하는 설치 ${missing.length}건:\n` +
        missing.map((m) => `  - Dockerfile:${m.line} — ${m.text}`).join('\n') +
        `\n\n이 스크립트들은 **root 권한으로 배포 이미지 안에서** 돈다. lockfile 축` +
        ` 허용목록(ALLOWED)은 CI 러너를 위한 승인이지 배포 레이어를 위한 승인이 아니다.` +
        ` \`--ignore-scripts\` 를 붙일 것 — 자세한 근거는 이 파일 상단과` +
        ` docs/audit/2026-08-dependency-security-audit.md 의 2026-08-24 절 참고.`,
    );
    process.exit(1);
  }

  console.log(`\nDockerfile npm 설치 ${installs.length}건 — 전부 --ignore-scripts.`);
}
