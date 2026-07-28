import { createHash } from 'node:crypto';
import { posix } from 'node:path';

export interface SkillSupportFile {
  path: string;
  content: string;
}

const MAX_BODY_BYTES = 128 * 1024;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;
const MAX_FILES = 64;
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*['"]?[A-Za-z0-9_\-./+=]{16,}/i,
];

export class SkillValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SkillValidationError';
    this.code = code;
  }
}

function normalizedText(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

export function validateSkillPath(input: string): string {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0')) {
    throw new SkillValidationError('skill_path_invalid', 'Skill file path is invalid');
  }
  const raw = input.replace(/\\/g, '/');
  const normalized = posix.normalize(raw);
  if (
    raw.startsWith('/')
    || /^[A-Za-z]:\//.test(raw)
    || normalized === '..'
    || normalized.startsWith('../')
    || normalized.split('/').includes('.git')
    || normalized !== raw
  ) {
    throw new SkillValidationError('skill_path_invalid', `Unsafe skill file path: ${input}`);
  }
  return normalized;
}

function rejectSecrets(content: string): void {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(content))) {
    throw new SkillValidationError(
      'skill_secret_detected',
      'Skill content appears to contain a credential or private key',
    );
  }
}

export function canonicalizeSkillContent(
  bodyValue: unknown,
  filesValue: unknown,
): { body: string; supportFiles: SkillSupportFile[]; digest: string } {
  if (typeof bodyValue !== 'string' || !bodyValue.trim()) {
    throw new SkillValidationError('skill_body_invalid', 'Skill body is required');
  }
  const body = normalizedText(bodyValue);
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
    throw new SkillValidationError('skill_too_large', 'Skill body exceeds 128 KiB');
  }
  rejectSecrets(body);

  if (filesValue !== undefined && !Array.isArray(filesValue)) {
    throw new SkillValidationError('skill_files_invalid', 'support_files must be an array');
  }
  const values = (filesValue ?? []) as unknown[];
  if (values.length > MAX_FILES) {
    throw new SkillValidationError('skill_too_large', `Skill has more than ${MAX_FILES} files`);
  }
  const seen = new Set<string>();
  const supportFiles = values.map((value) => {
    if (!value || typeof value !== 'object' || (value as any).type === 'symlink') {
      throw new SkillValidationError('skill_files_invalid', 'Symlinks and non-file entries are forbidden');
    }
    const path = validateSkillPath((value as any).path);
    if (seen.has(path)) {
      throw new SkillValidationError('skill_files_invalid', `Duplicate skill path: ${path}`);
    }
    seen.add(path);
    if (typeof (value as any).content !== 'string') {
      throw new SkillValidationError('skill_files_invalid', `Content is required for ${path}`);
    }
    const content = normalizedText((value as any).content);
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) {
      throw new SkillValidationError('skill_too_large', `Skill file exceeds 64 KiB: ${path}`);
    }
    rejectSecrets(content);
    return { path, content };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const total = Buffer.byteLength(body)
    + supportFiles.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
  if (total > MAX_TOTAL_BYTES) {
    throw new SkillValidationError('skill_too_large', 'Skill bundle exceeds 512 KiB');
  }
  const digest = createHash('sha256')
    .update(JSON.stringify({ body, support_files: supportFiles }))
    .digest('hex');
  return { body, supportFiles, digest };
}

