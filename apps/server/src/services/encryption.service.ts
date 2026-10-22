import { randomBytes, createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

let _encryptionKey: Buffer | null = null;

function resolveDataDir(): string {
  if (process.env.AWB_DATA_DIR) return process.env.AWB_DATA_DIR;
  return path.join(__dirname, '..', '..', '..', '..', 'database');
}

function getKeyPath(): string {
  return path.join(resolveDataDir(), '.encryption_key');
}

function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

// Encryption key resolution order:
//   1. ENCRYPTION_KEY env var (recommended for prod — operator owns key persistence)
//   2. <data-dir>/.encryption_key file (auto-generated on first use; needs writable dir)
// In Docker the default <repo>/database is /app/database — root-owned and not
// writable by the `node` user. Operators must either set ENCRYPTION_KEY or
// point AWB_DATA_DIR at a mounted writable volume; otherwise saving any
// credential surfaces an EACCES on mkdir.
function getEncryptionKey(): Buffer {
  if (_encryptionKey) return _encryptionKey;

  const envKey = process.env.ENCRYPTION_KEY;
  if (envKey) {
    _encryptionKey = deriveKey(envKey);
    return _encryptionKey;
  }

  const keyPath = getKeyPath();
  const dataDir = path.dirname(keyPath);
  try {
    if (fs.existsSync(keyPath)) {
      const stored = fs.readFileSync(keyPath, 'utf-8').trim();
      _encryptionKey = Buffer.from(stored, 'hex');
      return _encryptionKey;
    }
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const generated = randomBytes(32);
    fs.writeFileSync(keyPath, generated.toString('hex'), { mode: 0o600 });
    _encryptionKey = generated;
    return _encryptionKey;
  } catch (err: any) {
    if (err && (err.code === 'EACCES' || err.code === 'EROFS' || err.code === 'EPERM')) {
      throw new Error(
        `Encryption key store is not writable at ${dataDir} (${err.code}). ` +
        `Set the ENCRYPTION_KEY environment variable, or set AWB_DATA_DIR to a writable path ` +
        `(e.g. mount a volume in Docker). The credential was NOT saved.`
      );
    }
    throw err;
  }
}

export function encrypt(plaintext: string): string {
  if (!plaintext) return '';
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, authTag, encrypted]);
  return 'enc:' + combined.toString('base64');
}

export function decryptStrict(ciphertext: string): string {
  if (!ciphertext) return '';
  if (!ciphertext.startsWith('enc:')) return ciphertext;

  const key = getEncryptionKey();
  const combined = Buffer.from(ciphertext.slice(4), 'base64');
  if (combined.length <= IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Encrypted credential payload is truncated or corrupted');
  }
  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    throw new Error(
      'Credential cannot be decrypted with the current encryption key. ' +
      'Restore the original ENCRYPTION_KEY/AWB_DATA_DIR key or re-enter this credential.',
    );
  }
}

export function decrypt(ciphertext: string): string {
  try {
    return decryptStrict(ciphertext);
  } catch {
    console.error('[Encryption] Failed to decrypt — key mismatch or corrupted data');
    return '';
  }
}

/**
 * 비밀 값에서 만든, 밖에 보여도 되는 지문 — HMAC-SHA256(hex). 키 없이는 거꾸로 풀거나 맞혀 볼 수 없다.
 * HMAC 키는 암호화 키를 그대로 쓰지 않고 `purpose` 마다 HKDF 로 따로 끌어낸다 — 한 키를 AES-GCM 과 HMAC 에 함께 쓰지 않고,
 * 용도가 다른 지문끼리 섞이지 않게. 키 자체는 이 파일 밖으로 나가지 않는다.
 */
export function keyedDigest(purpose: string, text: string): string {
  const subkey = Buffer.from(hkdfSync('sha256', getEncryptionKey(), Buffer.alloc(0), `awb-keyed-digest:${purpose}`, 32));
  return createHmac('sha256', subkey).update(text, 'utf8').digest('hex');
}

export function isEncrypted(value: string): boolean {
  return value.startsWith('enc:');
}
