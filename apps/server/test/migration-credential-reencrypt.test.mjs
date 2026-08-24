// Regression / feature proof: live pull import credential re-encryption
// (ticket 0f638509, 완료 기준 4).
//
// 클레임: 이관된 크리덴셜이 도착지의 "새" 암호화 키로 복호화되어야 한다 —
// 소스의 .encryption_key/ENCRYPTION_KEY를 옮기지 않은 채로. 이 테스트는 그
// 정확한 시나리오를 진짜 두 개의 별도 Node 프로세스(각각 다른
// ENCRYPTION_KEY)로 재현한다 — encryption.service.ts가 키를 모듈-스코프
// 싱글턴으로 캐싱하므로 한 프로세스 안에서는 "다른 키"를 흉내낼 수 없다.
//
// 1. 소스 프로세스(키 A)가 크리덴셜을 암호화해서 저장했다고 가정 — 그 암호문을
//    소스 프로세스(키 A) 자신의 decryptRowForExport로 평문을 복원한다(export
//    엔드포인트가 실제로 하는 일).
// 2. 도착지 프로세스(키 B, A와 다름)는 그 암호문을 "옮겨 받았다면" 절대
//    복호화할 수 없다는 것을 증명한다 — 이게 이 기능이 없으면 겪는 정확한
//    실패 모드(암호화 키 이관 문제)다.
// 3. 도착지 프로세스(키 B)가 "전송받은 평문"(1단계 결과)을 reencryptRowForImport로
//    자기 키로 재암호화하면, 그 결과는 같은 도착지 프로세스(키 B)에서 정상
//    복호화된다 — 소스의 .encryption_key를 옮기지 않고도 성공.
//
// SystemSetting.value(is_secret=1인 행 — 예: embedding.api_key)도 같은 버그
// 클래스에 속하므로 같은 계약으로 커버한다.
//
// Runs against compiled dist/ (requires `npm run build`, satisfied by the
// test script's `pretest`/build step) — 자식 프로세스가 dist/를 직접 로드한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, 'helpers', 'migration-crypto-cli.mjs');

function run(encryptionKey, mode, payload) {
  // stderr는 pipe로 잡아둔다 — 실패 케이스(다른 키로 decrypt-strict)가
  // 의도적으로 던지는 uncaught exception이 테스트 출력에 그대로 새지 않게.
  const out = execFileSync('node', [CLI, mode, JSON.stringify(payload)], {
    env: { ...process.env, ENCRYPTION_KEY: encryptionKey, DB_TYPE: 'sqlite' },
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out);
}

const SOURCE_KEY = 'source-process-key-AAAA-0f638509';
const DEST_KEY = 'destination-process-key-BBBB-0f638509';

test('Credential.encrypted_data: source-key ciphertext is unreadable under a different destination key, but re-encryption under the destination key fixes it', () => {
  const plaintext = 'ghp_realGitHubPersonalAccessToken1234567890';

  // 1. 소스가 이미 저장해 둔 암호문(소스 자신의 키로 암호화된 것으로 가정).
  const sourceCiphertext = run(SOURCE_KEY, 'encrypt', { value: plaintext });
  assert.ok(sourceCiphertext.startsWith('enc:'), 'encrypt() must produce the enc: prefix');

  // 소스 export 경로: 소스 자신의 키로는 당연히 복호화된다.
  const exported = run(SOURCE_KEY, 'decrypt-export', { entity: 'Credential', row: { encrypted_data: sourceCiphertext } });
  assert.equal(exported.encrypted_data, plaintext, 'source-side decryptRowForExport must recover the original plaintext');

  // 2. 암호화 키를 옮기지 않았다면: 도착지(다른 키)는 소스의 암호문을 절대
  // 복호화할 수 없다 — 이게 이 티켓이 해결하려는 정확한 실패 모드.
  assert.throws(
    () => run(DEST_KEY, 'decrypt-strict', { value: sourceCiphertext }),
    'a different destination key must NOT be able to decrypt the source-key ciphertext',
  );

  // 3. 도착지 import 경로: "전송받은 평문"(위 1단계 결과, TLS 구간에서만
  // 평문)을 도착지 자신의 키로 재암호화 → 같은 도착지 키로 정상 복호화된다.
  const reencrypted = run(DEST_KEY, 'reencrypt-import', { entity: 'Credential', row: { encrypted_data: exported.encrypted_data } });
  assert.ok(reencrypted.encrypted_data.startsWith('enc:'));
  assert.notEqual(reencrypted.encrypted_data, sourceCiphertext, 'destination re-encryption must produce a fresh ciphertext (new IV), not reuse the source one');

  const roundtrip = run(DEST_KEY, 'decrypt-strict', { value: reencrypted.encrypted_data });
  assert.equal(roundtrip, plaintext, 'the destination must decrypt its own re-encrypted credential with its own key — no source .encryption_key needed');
});

test('SystemSetting.value: is_secret=1 rows follow the same decrypt/re-encrypt contract; is_secret=0 rows are left untouched', () => {
  const secretValue = 'sk-embeddingProviderApiKeyExample';

  const sourceCiphertext = run(SOURCE_KEY, 'encrypt', { value: secretValue });
  const exported = run(SOURCE_KEY, 'decrypt-export', {
    entity: 'SystemSetting',
    row: { key: 'embedding.api_key', value: sourceCiphertext, is_secret: 1 },
  });
  assert.equal(exported.value, secretValue);

  const reencrypted = run(DEST_KEY, 'reencrypt-import', {
    entity: 'SystemSetting',
    row: { key: 'embedding.api_key', value: exported.value, is_secret: 1 },
  });
  const roundtrip = run(DEST_KEY, 'decrypt-strict', { value: reencrypted.value });
  assert.equal(roundtrip, secretValue, 'is_secret=1 SystemSetting rows must round-trip through the same source-decrypt/dest-reencrypt contract as Credential');

  // is_secret=0인 평문 설정(예: embedding.provider='openai')은 손대면 안 된다 —
  // decrypt/reencrypt 둘 다 no-op이어야 한다.
  const plainRow = { key: 'embedding.provider', value: 'openai', is_secret: 0 };
  const exportedPlain = run(SOURCE_KEY, 'decrypt-export', { entity: 'SystemSetting', row: plainRow });
  assert.equal(exportedPlain.value, 'openai', 'is_secret=0 rows must pass through decryptRowForExport unchanged');
  const reimportedPlain = run(DEST_KEY, 'reencrypt-import', { entity: 'SystemSetting', row: plainRow });
  assert.equal(reimportedPlain.value, 'openai', 'is_secret=0 rows must pass through reencryptRowForImport unchanged');
});

test('non-credential entities are never touched by the decrypt/re-encrypt transform', () => {
  const row = { id: 'ticket-1', title: 'hello' };
  assert.deepEqual(run(SOURCE_KEY, 'decrypt-export', { entity: 'Ticket', row }), row);
  assert.deepEqual(run(DEST_KEY, 'reencrypt-import', { entity: 'Ticket', row }), row);
});
