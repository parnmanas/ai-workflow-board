// fetchCliLatestVersions — "이 CLI 의 최신 배포 버전은 몇인가".
//
// 이 값이 하트비트에 실려야만 UI 가 Update 버튼을 잠글 수 있다. 실제 npm
// 레지스트리를 칠 수는 없으므로 npmView 를 주입해, 이 모듈이 책임지는 것만
// 본다: 어떤 패키지를 묻는지, 같은 패키지를 공유하는 CLI 를 한 번에 처리하는지,
// 실패한 CLI 를 **조용히 "최신" 으로 만들지 않는지**.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { fetchCliLatestVersions, parseNpmViewVersion } = await import('../dist/lib/cli-latest.js');

test('어댑터가 알려 준 npm 패키지를 묻고 cliType → 버전으로 되돌려준다', async () => {
  const asked = [];
  const out = await fetchCliLatestVersions(['claude', 'codex', 'opencode'], {
    npmView: async (spec) => {
      asked.push(spec);
      return { ok: true, stdout: `${spec === '@openai/codex' ? '0.156.1' : '2.1.281'}\n`, stderr: '' };
    },
  });

  assert.deepEqual(asked.sort(), ['@anthropic-ai/claude-code', '@openai/codex', 'opencode-ai']);
  assert.equal(out.claude, '2.1.281');
  assert.equal(out.codex, '0.156.1');
  assert.equal(out.opencode, '2.1.281');
});

test('같은 바이너리를 공유하는 CLI 는 레지스트리를 한 번만 친다 (deepseek → claude)', async () => {
  let calls = 0;
  const out = await fetchCliLatestVersions(['claude', 'deepseek'], {
    npmView: async () => {
      calls++;
      return { ok: true, stdout: '2.1.281\n', stderr: '' };
    },
  });

  assert.equal(calls, 1, '설치본이 하나이므로 최신 기준도 하나다');
  assert.deepEqual(out, { claude: '2.1.281', deepseek: '2.1.281' });
});

test('업데이터가 없거나 npm 배포가 아닌 CLI 는 아예 묻지 않는다', async () => {
  const asked = [];
  const out = await fetchCliLatestVersions(['pi', 'gh', 'git', 'not-a-cli'], {
    npmView: async (spec) => {
      asked.push(spec);
      return { ok: true, stdout: '1.0.0\n', stderr: '' };
    },
  });
  assert.deepEqual(asked, []);
  assert.deepEqual(out, {});
});

test('조회 실패는 키가 빠질 뿐이다 — 나머지 CLI 는 그대로 채워진다', async () => {
  const logs = [];
  const out = await fetchCliLatestVersions(['claude', 'codex'], {
    log: (m) => logs.push(m),
    npmView: async (spec) =>
      spec === '@openai/codex'
        ? { ok: false, stdout: '', stderr: 'npm ERR! network timeout' }
        : { ok: true, stdout: '2.1.281\n', stderr: '' },
  });

  assert.deepEqual(out, { claude: '2.1.281' });
  assert.equal('codex' in out, false, '모르는 것을 "최신" 으로 둔갑시키지 않는다');
  assert.match(logs.join('\n'), /network timeout/);
});

test('npmView 가 throw 해도 나머지를 포기하지 않는다', async () => {
  const out = await fetchCliLatestVersions(['claude', 'codex'], {
    npmView: async (spec) => {
      if (spec === '@anthropic-ai/claude-code') throw new Error('boom');
      return { ok: true, stdout: '0.156.1\n', stderr: '' };
    },
  });
  assert.deepEqual(out, { codex: '0.156.1' });
});

test('버전 한 줄만 받아들인다 — 알아볼 수 없는 출력은 버린다', () => {
  assert.equal(parseNpmViewVersion('1.2.3\n'), '1.2.3');
  assert.equal(parseNpmViewVersion('npm warn something\n0.156.1\n'), '0.156.1');
  assert.equal(parseNpmViewVersion(''), null);
  assert.equal(parseNpmViewVersion('no version here\n'), null);
});
