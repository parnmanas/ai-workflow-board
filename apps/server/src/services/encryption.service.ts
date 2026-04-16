import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

let _encryptionKey: Buffer | null = null;

function getKeyPath(): string {
  const dbDir = path.join(__dirname, '..', '..', '..', '..', 'database');
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  return path.join(dbDir, '.encryption_key');
}

function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

function getEncryptionKey(): Buffer {
  if (_encryptionKey) return _encryptionKey;

  const envKey = process.env.ENCRYPTION_KEY;
  if (envKey) {
    _encryptionKey = deriveKey(envKey);
    return _encryptionKey;
  }

  const keyPath = getKeyPath();
  if (fs.existsSync(keyPath)) {
    const stored = fs.readFileSync(keyPath, 'utf-8').trim();
    _encryptionKey = Buffer.from(stored, 'hex');
    return _encryptionKey;
  }

  const generated = randomBytes(32);
  fs.writeFileSync(keyPath, generated.toString('hex'), { mode: 0o600 });
  _encryptionKey = generated;
  return _encryptionKey;
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
