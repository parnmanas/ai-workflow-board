import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

export interface RuntimeSkillSnapshotEntry {
  slug: string;
  version: number;
  digest: string;
  body: string;
  support_files: Array<{ path: string; content: string }>;
}

export interface RuntimeSkillSnapshot {
  digest: string;
  manifest: RuntimeSkillSnapshotEntry[];
}

export class SkillMaterializationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SkillMaterializationError';
    this.code = code;
  }
}

function safeSegment(value: string, label: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) {
    throw new SkillMaterializationError('skill_path_invalid', `Unsafe ${label}: ${value}`);
  }
  return value;
}

function childPath(root: string, relative: string): string {
  const normalized = relative.replace(/\\/g, '/');
  if (
    !normalized
    || normalized.startsWith('/')
    || normalized.split('/').some((part) => part === '..' || !part)
  ) {
    throw new SkillMaterializationError('skill_path_invalid', `Unsafe skill path: ${relative}`);
  }
  const target = resolve(root, ...normalized.split('/'));
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!target.startsWith(prefix)) {
    throw new SkillMaterializationError('skill_path_invalid', `Skill path escapes root: ${relative}`);
  }
  return target;
}

export class SkillMaterializer {
  readonly #rootDir: string;
  constructor(rootDir: string) {
    this.#rootDir = resolve(rootDir);
  }

  async materialize(runId: string, snapshot: RuntimeSkillSnapshot): Promise<string> {
    safeSegment(runId, 'run id');
    const manifest = [...snapshot.manifest].sort((a, b) => a.slug.localeCompare(b.slug));
    const snapshotDigest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
    if (snapshotDigest !== snapshot.digest) {
      throw new SkillMaterializationError('skill_digest_mismatch', 'Run skill snapshot digest does not match its manifest');
    }
    const finalDir = join(this.#rootDir, runId, 'skills');
    const tempDir = join(this.#rootDir, runId, `skills.tmp-${process.pid}-${Date.now()}`);
    await fsp.mkdir(tempDir, { recursive: true, mode: 0o700 });
    try {
      for (const entry of manifest) {
        const slug = safeSegment(entry.slug, 'skill slug');
        const skillDir = join(tempDir, slug);
        await fsp.mkdir(skillDir, { recursive: true, mode: 0o700 });
        const contentDigest = createHash('sha256')
          .update(JSON.stringify({
            body: entry.body.replace(/\r\n?/g, '\n'),
            support_files: [...entry.support_files]
              .map((file) => ({ path: file.path, content: file.content.replace(/\r\n?/g, '\n') }))
              .sort((a, b) => a.path.localeCompare(b.path)),
          }))
          .digest('hex');
        if (contentDigest !== entry.digest) {
          throw new SkillMaterializationError('skill_digest_mismatch', `Digest mismatch for skill ${slug}`);
        }
        await fsp.writeFile(join(skillDir, 'SKILL.md'), entry.body, { mode: 0o600 });
        for (const file of entry.support_files) {
          const target = childPath(skillDir, file.path);
          await fsp.mkdir(dirname(target), { recursive: true, mode: 0o700 });
          await fsp.writeFile(target, file.content, { mode: 0o600 });
        }
      }
      await fsp.mkdir(dirname(finalDir), { recursive: true, mode: 0o700 });
      await fsp.rm(finalDir, { recursive: true, force: true });
      await fsp.rename(tempDir, finalDir);
      await fsp.writeFile(
        join(dirname(finalDir), 'skill-snapshot.json'),
        JSON.stringify({ digest: snapshot.digest, skills: manifest.map(({ slug, version, digest }) => ({ slug, version, digest })) }, null, 2),
        { mode: 0o600 },
      );
      return finalDir;
    } catch (error) {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }
}

