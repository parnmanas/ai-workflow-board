// 운영자에게 "이 매니저를 어떻게 재기동하라" 고 알려주는 문구의 단일 원천(supervisor.ts 의
// restartHint()).
//
// 배경: 이 문구는 exit 코드 + stderr/agent-manager.log 로만 남는 유일한 운영자 단서다.
// systemctl 은 linux 전용이라 win32/darwin 운영자에게 그 명령을 남기면 아무 경로도 주지 않은
// 것과 같다. 같은 결함이 세 곳에서 따로 발견됐다 — `--force` refuse 경로, 비-force
// EAGENTLOCKED 경로, 그리고 락 경로가 아니라 runRuntime() 진입부인 "세션 안에서 직접 띄웠다"
// 경고. 문구를 복제하는 한 다음 호출부에서 또 갈리므로, 아래 두 축으로 고정한다.
//   1. 헬퍼 자체의 플랫폼 분기 (linux restart / linux reload / win32 / darwin).
//   2. src/ 전체에서 systemctl 을 **코드로** 들고 있는 파일이 그 헬퍼와 설치기 둘뿐이라는 것.
//
// 이 파일은 스위트의 다른 테스트와 달리 축 2 에서 `dist/` 가 아니라 `src/` 를 읽는다 —
// 고정하려는 불변식이 "컴파일 결과가 무엇을 하는가" 가 아니라 "소스 어디에 문자열이 적혀
// 있는가" 라서다. src/ 를 직접 읽는 가드의 선례는 runtime-architecture-boundaries.test.mjs 등.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { restartHint } from '../dist/lib/supervisor.js';

const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));

// service-install.ts 는 systemd unit 설치기 **자체**다: 유닛 파일을 쓰고 systemctl 을
// 실제로 실행한다. 모든 호출이 which('systemctl') 게이트 뒤에 있어 그 명령이 없는
// 플랫폼에서는 아예 실행되지 않으므로, 이 가드가 막으려는 "실행 불가능한 지시를
// 운영자에게 남긴다" 와는 구조적으로 다른 종류다. 그래서 면제한다.
const INSTALLER = 'lib/service-install.ts';

function tsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? tsFiles(join(dir, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(dir, entry.name)]
        : [],
  );
}

/** 각 줄에서 주석을 제거한 사본. 블록 주석은 여러 줄에 걸치므로 상태를 들고 훑는다.
 *  줄 번호를 유지해야 위반을 지목할 수 있어서 줄 단위 배열로 돌려준다. */
function stripComments(source) {
  const out = [];
  let inBlock = false;
  for (const line of source.split('\n')) {
    let code = '';
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', i);
        if (end === -1) { i = line.length; break; }
        inBlock = false;
        i = end + 2;
        continue;
      }
      if (line.startsWith('//', i)) break;
      if (line.startsWith('/*', i)) { inBlock = true; i += 2; continue; }
      code += line[i];
      i += 1;
    }
    out.push(code);
  }
  return out;
}

test('restartHint: 플랫폼 축은 systemctl 실행 가능성(linux)이고 kind 는 linux 에서만 갈린다', () => {
  // linux — 두 모드가 서로 다른 systemctl 명령을 안내한다.
  assert.match(restartHint('linux'), /systemctl --user restart awb-agent-manager/, 'linux 기본(restart)은 서비스를 내렸다 올리는 명령이다');
  assert.match(restartHint('linux', 'restart'), /systemctl --user restart awb-agent-manager/, 'kind 를 명시해도 기본값과 같다');
  assert.match(restartHint('linux', 'reload'), /systemctl --user kill -s SIGUSR2 awb-agent-manager/, 'linux reload 는 제자리 재적재라 명령이 다르다');
  assert.notEqual(restartHint('linux', 'restart'), restartHint('linux', 'reload'), 'linux 에서만 두 모드가 갈린다');

  // 비-linux — 실제로 동작하는 경로가 하나뿐이라 모드와 무관하게 같은 문장이고,
  // systemctl 이 한 번도 나오지 않아야 한다.
  for (const platform of ['win32', 'darwin']) {
    for (const kind of ['restart', 'reload']) {
      const hint = restartHint(platform, kind);
      assert.doesNotMatch(hint, /systemctl/, `${platform}/${kind}: 없는 명령을 안내하면 유일한 단서가 실행 불가능한 지시가 된다`);
      assert.match(hint, /admin UI/, `${platform}/${kind}: 실제로 동작하는 경로를 안내한다`);
      assert.match(hint, /restart_manager/, `${platform}/${kind}: 원격 커맨드 경로도 남긴다`);
    }
    assert.equal(restartHint(platform, 'restart'), restartHint(platform, 'reload'), `${platform}: 모드와 무관하게 같은 문장`);
  }

  // darwin 을 win32 와 함께 고정하는 이유: 이 축은 `=== 'linux'` 이고 handoff 축
  // (agent-lockfile.ts 의 supportsRestartSignal)은 `!== 'win32'` 라, darwin 이 두 축이
  // 실제로 갈리는 유일한 플랫폼이다. win32 만 보면 그 차이가 드러나지 않는다.
  assert.equal(restartHint('darwin'), restartHint('win32'), 'darwin 도 비-linux 쪽이다 — SIGUSR2 가 있어도 systemctl 은 없다');
});

test('운영자 지시용 systemctl 문자열은 supervisor.ts 의 restartHint() 한 곳에만 있다', () => {
  const offenders = [];
  const holders = new Set();

  for (const file of tsFiles(srcRoot)) {
    const rel = relative(srcRoot, file).replaceAll('\\', '/');
    if (rel === INSTALLER) continue;
    const code = stripComments(readFileSync(file, 'utf8'));
    code.forEach((line, index) => {
      if (!line.includes('systemctl')) return;
      holders.add(rel);
      offenders.push(`${rel}:${index + 1}`);
    });
  }

  assert.deepEqual(
    [...holders].sort(),
    ['lib/supervisor.ts'],
    `systemctl 을 코드로 들고 있는 파일은 헬퍼 하나여야 한다 (설치기 ${INSTALLER} 는 면제). 발견: ${offenders.join(', ')}`,
  );

  // 그 파일 안에서도 restartHint() 본문 밖으로 새지 않아야 한다.
  const lines = readFileSync(join(srcRoot, 'lib/supervisor.ts'), 'utf8').split('\n');
  const start = lines.findIndex((line) => line.startsWith('export function restartHint('));
  assert.ok(start >= 0, 'supervisor.ts 에 restartHint() 가 있어야 한다');
  const end = lines.findIndex((line, index) => index > start && line === '}');
  assert.ok(end > start, 'restartHint() 의 닫는 괄호를 찾아야 한다');

  const code = stripComments(lines.join('\n'));
  code.forEach((line, index) => {
    if (!line.includes('systemctl')) return;
    assert.ok(
      index >= start && index <= end,
      `supervisor.ts:${index + 1} 의 systemctl 이 restartHint() 본문(${start + 1}-${end + 1}) 밖에 있다`,
    );
  });
});

test('systemctl 을 언급하는 주석은 설명문이지 운영자 지시가 아니다', () => {
  // 세 파일에는 systemctl 이 주석으로 남아 있다 — exit 코드 선택 근거(main.ts, self-update.ts)와
  // 두 축의 차이 서술(supervisor.ts). 설명문이라 가드 대상이 아니지만, 그 사실 자체를
  // 고정해 둔다: 누군가 그 자리에 운영자 지시 문자열을 넣으면 위 테스트가 잡도록.
  for (const rel of ['main.ts', 'lib/self-update.ts']) {
    const source = readFileSync(join(srcRoot, rel), 'utf8');
    assert.ok(source.includes('systemctl'), `${rel} 은 여전히 systemctl 을 주석으로 언급한다 (이 테스트의 전제)`);
    assert.ok(
      stripComments(source).every((line) => !line.includes('systemctl')),
      `${rel} 의 systemctl 언급은 전부 주석이어야 한다`,
    );
  }
});
