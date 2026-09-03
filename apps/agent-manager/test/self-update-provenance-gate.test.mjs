// npm-global self-update SLSA provenance gate (2026-08-15 dependency security audit).
//
// 배경: 2026-08-10 감사가 publish 쪽에 `--provenance` 를 붙여 tarball 마다 Sigstore
// SLSA 증명을 남기게 했다. 그러나 소비 쪽(self-update)은 그 증명을 확인하지 않고
// `npm install -g awb-agent-manager@latest` 를 그대로 실행했다 — publish 워크플로의
// NPM_TOKEN(Automation, 2FA bypass) 이 유출되면 공격자 tarball 이 self-update 를 타고
// 매니저 호스트 전체에서 실행된다. provenance 는 GitHub Actions OIDC 로만 만들어지므로
// 토큰만 쥔 공격자는 위조할 수 없다 → "증명 없는 버전은 설치 거부" 가 그 시나리오를 막는다.
//
// 이 파일은 게이트가 **실제로 무는지**를 증명한다: 공격자가 만들 수 있는 응답 모양
// (증명 필드 없음 / provenance 없음 / predicateType 위조 / JSON 아님)을 직접 먹인다.
// 순수 파서만 검증하므로 네트워크를 타지 않는다.
//
// 실행: npm run build && node --test test/self-update-provenance-gate.test.mjs
// (agent-manager 의 `test` 스크립트는 test/*.test.mjs 글롭이라 별도 등록 불필요.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseProvenanceView } from '../dist/lib/self-update.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF_UPDATE_SRC = join(HERE, '..', 'src', 'lib', 'self-update.ts');

/** 레지스트리가 실제로 돌려주는 정상 응답 (npm view … version dist.attestations --json). */
const GOOD = JSON.stringify({
  version: '1.6.115',
  'dist.attestations': {
    url: 'https://registry.npmjs.org/-/npm/v1/attestations/awb-agent-manager@1.6.115',
    provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
  },
});

test('accepts a version that carries an SLSA provenance attestation', () => {
  const v = parseProvenanceView(GOOD);
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.version, '1.6.115');
});

test('tolerates npm chatter before the JSON body', () => {
  // 셸 래퍼가 stderr 를 stdout 에 섞어 넘기는 환경에서도 판정이 흔들리면 안 된다.
  const v = parseProvenanceView(`npm warn Ignoring workspaces for specified package(s)\n${GOOD}`);
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.version, '1.6.115');
});

test('accepts the nested dist.attestations shape too', () => {
  const nested = JSON.stringify({
    version: '2.0.0',
    dist: {
      attestations: {
        url: 'https://registry.npmjs.org/-/npm/v1/attestations/x@2.0.0',
        provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
      },
    },
  });
  assert.equal(parseProvenanceView(nested).ok, true);
});

// --- 아래가 게이트의 본체: 전부 거부되어야 한다 ---------------------------------

test('REFUSES a publish with no attestations at all (the leaked-token scenario)', () => {
  // Automation 토큰만 쥔 공격자가 올릴 수 있는 정확한 모양: tarball 은 있고 증명은 없다.
  const v = parseProvenanceView(JSON.stringify({ version: '9.9.9' }));
  assert.equal(v.ok, false);
  assert.match(v.reason, /no npm attestations/);
});

test('REFUSES attestations that carry no provenance predicate', () => {
  const v = parseProvenanceView(JSON.stringify({
    version: '9.9.9',
    'dist.attestations': { url: 'https://registry.npmjs.org/whatever' },
  }));
  assert.equal(v.ok, false);
  assert.match(v.reason, /no provenance predicate/);
});

test('REFUSES a forged non-SLSA predicateType', () => {
  const v = parseProvenanceView(JSON.stringify({
    version: '9.9.9',
    'dist.attestations': {
      url: 'https://registry.npmjs.org/whatever',
      provenance: { predicateType: 'https://evil.example/provenance/v1' },
    },
  }));
  assert.equal(v.ok, false);
  assert.match(v.reason, /not SLSA/);
});

test('REFUSES an attestation bundle served over a non-https URL', () => {
  const v = parseProvenanceView(JSON.stringify({
    version: '9.9.9',
    'dist.attestations': {
      url: 'http://registry.example/attestations',
      provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
    },
  }));
  assert.equal(v.ok, false);
  assert.match(v.reason, /https/);
});

test('REFUSES unparseable / empty / non-object npm output (fail-closed)', () => {
  for (const bad of ['', '   ', 'E404 not found', '{not json', '[]', 'null']) {
    const v = parseProvenanceView(bad);
    assert.equal(v.ok, false, `expected refusal for ${JSON.stringify(bad)}`);
  }
  // 배열은 `{` 를 못 찾아 "no JSON object", 그 외는 파싱/모양 실패 — 어느 쪽이든 거부.
  assert.equal(parseProvenanceView(undefined).ok, false);
});

test('REFUSES a response whose version field is missing or bogus', () => {
  const withAttestation = {
    'dist.attestations': {
      url: 'https://registry.npmjs.org/x',
      provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
    },
  };
  for (const version of [undefined, '', 'latest', 'v1', 42]) {
    const v = parseProvenanceView(JSON.stringify({ ...withAttestation, version }));
    assert.equal(v.ok, false, `expected refusal for version=${JSON.stringify(version)}`);
  }
});

// --- 게이트가 설치 경로에 실제로 배선돼 있는지 (파서만 맞고 배선이 빠지면 무의미) ---

test('the npm-global install path is gated and pins the verified exact version', () => {
  const src = readFileSync(SELF_UPDATE_SRC, 'utf8');

  // 1. 설치 전에 증명을 검증한다. 검증 대상은 활성 채널(latest / next / 고정
  //    버전)이어야 한다 — 채널을 무시하고 항상 @latest 를 검증하면 실제로 설치할
  //    tarball 과 다른 것을 검증하게 되어 게이트가 헛돈다.
  // ticket 23753dc7: 이 호출은 주입 가능한 포트를 거치게 됐다(복귀 분기를 실제로
  // 태우는 테스트를 만들기 위해). 게이트의 의미는 그대로여야 하므로 두 가지를
  // 함께 본다 — 호출부가 **활성 채널**을 넘기는지, 그리고 그 포트의 기본 구현이
  // 진짜 provenance 검증인지. 앞만 보면 포트가 조용히 no-op 이 돼도 통과한다.
  // (이 소스 검사에 더해, self-update-boot-rollback.test.mjs 가 거부 판정을
  //  주입해 "설치가 실제로 일어나지 않는지"를 동적으로 단언한다.)
  assert.match(src, /await ports\.verifyProvenance\(channel\)/,
    'runNpmGlobalSelfUpdate must verify provenance for the ACTIVE channel before installing');
  assert.match(src, /verifyProvenance: p\.verifyProvenance \?\? \(\(channel\) => verifyNpmGlobalProvenance\(out, channel\)\)/,
    'the provenance port must default to the real verifier');
  assert.match(src, /\['view', npmChannelSpec\(channel\), 'version', 'dist\.attestations'/,
    'the provenance read must target the active channel spec');

  // 2. 검증 실패 시 fail-closed — 명시적 opt-in 없이는 설치하지 않는다.
  assert.match(src, /if \(!verdict\.ok\)/, 'a failed verdict must be handled');
  assert.match(src, /npm-global update refused:/,
    'a failed verdict must abort the update, not just warn');
  assert.match(src, /AWB_SELF_UPDATE_ALLOW_UNVERIFIED/,
    'the only bypass must be an explicit env opt-in');

  // 3. TOCTOU: `@latest` 를 검증하고 다시 `@latest` 를 설치하면 그 사이 태그가
  //    옮겨간 tarball 이 들어온다. 검증된 정확한 버전으로 고정해야 한다.
  assert.match(src, /const installSpec\s*=/, 'install spec must be pinned to the verified version');
  const installLines = src
    .split('\n')
    .filter((l) => /'install',\s*'-g'/.test(l) || /npm install -g/.test(l));
  assert.ok(installLines.length > 0, 'expected to find the global install invocation');
  for (const line of installLines) {
    assert.ok(
      !/npmChannelSpec\(/.test(line) && !/channelSpec/.test(line),
      `global install must use the pinned installSpec, not the moving channel tag: ${line.trim()}`,
    );
  }

  // 4. Windows 헬퍼도 같은 pinned spec 을 받아야 한다 (POSIX 만 막으면 반쪽).
  assert.match(src, /String\(process\.pid\),\s*\n\s*installSpec,/,
    'the Windows detached updater helper must receive the pinned spec too');

  // 5. 헬퍼의 **복귀** 설치도 같은 게이트를 타야 한다 (ticket 23753dc7 리뷰 2).
  //    헬퍼는 부모가 죽은 뒤 돌아 레지스트리 판정을 스스로 못 하므로, 복귀 대상은
  //    부모가 미리 검증한 spec 이어야 한다. 여기서 raw 템플릿(`@${current}` 등)이
  //    다시 들어오면 증명 없는 이전 버전이 설치될 수 있다.
  assert.match(src, /rollbackSpec = trackable\s*\n?\s*\? await resolveVerifiedRollbackSpec\(/,
    'the Windows helper rollback target must come from the verified-spec resolver');
  assert.doesNotMatch(
    src,
    /helperArgs = \[[\s\S]*?`\$\{MANAGER_PACKAGE_NAME\}@\$\{current\}`/,
    'the helper must not receive an unverified rollback spec built straight from the running version',
  );
});
