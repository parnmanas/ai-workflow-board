#!/usr/bin/env node
/**
 * audit-action-pins.mjs
 *
 * 공급망 가드 — `.github/workflows/*.yml` 의 모든 `uses:` 가 **40자 커밋 SHA** 로
 * 고정돼 있는지 검사한다.
 *
 * 왜 필요한가: `actions/checkout@v4` 같은 태그 참조는 **가변**이다. 업스트림
 * 저장소(또는 그 저장소를 탈취한 쪽)가 `v4` 태그를 다른 커밋으로 옮기면, 우리
 * 워크플로는 다음 run 부터 아무 변경 없이 새 코드를 실행한다. 2025 년
 * tj-actions/changed-files 사건이 정확히 이 경로였다 — 태그가 재지정되면서
 * 러너 메모리의 시크릿이 로그로 덤프됐다.
 *
 * 이 저장소에서 그게 왜 특히 위험한가:
 *   - publish-agent-manager.yml 은 `contents: write` + `id-token: write` 로 돌고
 *     `secrets.NPM_TOKEN` 으로 fleet 이 설치하는 패키지를 발행한다. 이 잡에서
 *     임의 코드가 돌면 곧바로 fleet 전체로 번진다.
 *   - checkout 은 기본적으로 GITHUB_TOKEN 을 `.git/config` 의 extraheader 에
 *     남기므로(persist-credentials), 같은 잡의 어떤 스텝이든 그 토큰을 읽을 수 있다.
 *
 * SHA 고정은 이 경로를 닫는다 — 업스트림이 태그를 어디로 옮기든 우리가 실행하는
 * 바이트는 고정이고, 올릴 때는 lockfile 처럼 diff 로 드러난다.
 *
 * 업그레이드 방법:
 *   1) 올릴 버전의 커밋 SHA 를 확인한다
 *      (`gh api repos/actions/checkout/git/ref/tags/v4.5.0 --jq .object.sha`).
 *   2) 워크플로의 SHA 를 교체하고 뒤의 `# vX.Y.Z` 주석도 같이 갱신한다.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, '.github', 'workflows');

// `uses: owner/repo@ref` — 로컬 액션(`./…`)과 docker 액션(`docker://…`)은 제외한다.
// 이 둘은 업스트림 태그 재지정 위험이 없다(전자는 이 저장소 트리, 후자는 별도 검사 대상).
const USES = /^\s*(?:-\s*)?uses:\s*(\S+)/;
const SHA_PINNED = /@[0-9a-f]{40}$/;

const violations = [];
let checked = 0;

for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
  const lines = readFileSync(join(dir, file), 'utf8').split('\n');
  lines.forEach((line, i) => {
    const m = USES.exec(line);
    if (!m) return;
    const ref = m[1].replace(/^['"]|['"]$/g, '');
    if (ref.startsWith('./') || ref.startsWith('docker://')) return;
    checked += 1;
    if (SHA_PINNED.test(ref)) {
      console.log(`ok   ${file}:${i + 1} ${ref}`);
    } else {
      console.log(`FAIL ${file}:${i + 1} ${ref}`);
      violations.push(`${file}:${i + 1} — ${ref}`);
    }
  });
}

if (violations.length > 0) {
  console.error(
    `\nSHA 로 고정되지 않은 액션 참조 ${violations.length}개:\n` +
      violations.map((v) => `  - ${v}`).join('\n') +
      `\n\n가변 태그(@v4, @main 등)는 업스트림이 태그를 옮기면 우리 워크플로가` +
      ` 조용히 새 코드를 실행한다. 40자 커밋 SHA 로 고정하고 뒤에 \`# vX.Y.Z\`` +
      ` 주석을 남길 것 — 자세한 이유는 scripts/audit-action-pins.mjs 상단 참고.`,
  );
  process.exit(1);
}

console.log(`\n액션 참조 ${checked}개 — 전부 커밋 SHA 고정.`);
