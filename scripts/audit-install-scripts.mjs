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
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));

/** node_modules 경로에서 패키지 이름만 뽑는다 (중첩/스코프 모두 처리). */
function packageName(path) {
  const idx = path.lastIndexOf('node_modules/');
  return idx === -1 ? null : path.slice(idx + 'node_modules/'.length);
}

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
