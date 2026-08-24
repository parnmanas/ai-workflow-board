// migration-credential-reencrypt.test.mjs 전용 헬퍼 — 자식 프로세스로
// 실행되어 ENCRYPTION_KEY env var 하나를 그 프로세스의 유일한 키로 고정한다.
// apps/server/src/services/encryption.service.ts는 키를 모듈-스코프
// 싱글턴으로 캐시하므로, 같은 프로세스 안에서 "다른 키"를 흉내낼 방법이
// 없다 — 진짜 다른 프로세스여야 진짜 다른 키가 된다(소스 서버/도착지 서버가
// 실제로 그런 것처럼).
//
// Usage: node migration-crypto-cli.mjs <mode> <payloadJson>
//   mode: encrypt | decrypt-strict | decrypt-export | reencrypt-import
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', '..', 'dist');

const { encrypt, decryptStrict } = await import('file://' + path.join(DIST, 'services', 'encryption.service.js'));
const { decryptRowForExport, reencryptRowForImport } = await import(
  'file://' + path.join(DIST, 'modules', 'migration', 'migration-crypto.js')
);

const [, , mode, payloadJson] = process.argv;
const payload = JSON.parse(payloadJson || '{}');

let result;
switch (mode) {
  case 'encrypt':
    result = encrypt(payload.value);
    break;
  case 'decrypt-strict':
    result = decryptStrict(payload.value);
    break;
  case 'decrypt-export':
    result = decryptRowForExport(payload.entity, payload.row);
    break;
  case 'reencrypt-import':
    result = reencryptRowForImport(payload.entity, payload.row);
    break;
  default:
    throw new Error(`unknown mode: ${mode}`);
}

process.stdout.write(JSON.stringify(result));
