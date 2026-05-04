import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'crypto';
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

export function decrypt(ciphertext: string): string {
  if (!ciphertext) return '';
  if (!ciphertext.startsWith('enc:')) return ciphertext;

  try {
    const key = getEncryptionKey();
    const combined = Buffer.from(ciphertext.slice(4), 'base64');
    const iv = combined.subarray(0, IV_LENGTH);
    const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    console.error('[Encryption] Failed to decrypt — key mismatch or corrupted data');
    return '';
  }
}

export function isEncrypted(value: string): boolean {
  return value.startsWith('enc:');
}
