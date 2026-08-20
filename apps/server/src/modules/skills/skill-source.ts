import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { canonicalizeSkillContent, validateSkillPath, SkillValidationError } from './skill-validation';

/**
 * Reading a `SKILL.md` tree off disk — shared by the built-in pack seeder and
 * the git tap sync, because both consume the SAME on-disk layout:
 *
 *   <root>/<category>/<slug>/SKILL.md        ← the skill body
 *   <root>/<category>/<slug>/<anything>      ← support files (relative paths)
 *
 * That layout is the de-facto ecosystem convention (Claude Code
 * `.claude/skills/`, the Hermes hub, Warp's bundled skills all use it), which
 * is exactly why it is the interchange format here: a repository someone
 * already publishes for another agent runtime can be tapped unchanged.
 */

export interface ParsedSkillFrontmatter {
  name: string;
  description: string;
  version: string;
  author: string;
  license: string;
}

export interface LoadedSkill {
  /** Directory name — the AWB slug. Validated against the slug charset. */
  slug: string;
  /** POSIX path of the SKILL.md relative to the tree root; the sync key. */
  sourcePath: string;
  frontmatter: ParsedSkillFrontmatter;
  body: string;
  supportFiles: Array<{ path: string; content: string }>;
  digest: string;
}

export interface LoadReport {
  skills: LoadedSkill[];
  /** Non-fatal per-skill problems. A bad skill is skipped, never fatal — one
   *  malformed file in a 100-skill tap must not block the other 99. */
  skipped: Array<{ path: string; reason: string }>;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_DEPTH = 4;
const MAX_SUPPORT_FILES = 32;
const MAX_SUPPORT_FILE_BYTES = 64 * 1024;

/**
 * Minimal YAML frontmatter reader.
 *
 * Deliberately NOT a YAML parser: the fields AWB consumes are five scalars, and
 * pulling a full YAML engine in would mean executing arbitrary upstream YAML
 * (aliases, merge keys, custom tags) from a third-party repository just to read
 * a description string. Unknown keys, nested blocks, and lists are ignored
 * rather than rejected — the Hermes hub's `metadata:`/`platforms:` blocks are
 * common and harmless.
 */
export function parseFrontmatter(text: string): { frontmatter: ParsedSkillFrontmatter; body: string } {
  const normalized = text.replace(/\r\n?/g, '\n');
  const empty: ParsedSkillFrontmatter = { name: '', description: '', version: '', author: '', license: '' };
  if (!normalized.startsWith('---\n')) return { frontmatter: empty, body: normalized };
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: empty, body: normalized };
  const head = normalized.slice(4, end);
  const body = normalized.slice(normalized.indexOf('\n', end + 1) + 1);
  const out = { ...empty };
  for (const line of head.split('\n')) {
    // Top-level scalars only: an indented line belongs to a nested block.
    if (/^\s/.test(line)) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    if (!(key in out)) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1)
      || (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    (out as any)[key] = value.slice(0, 500);
  }
  return { frontmatter: out, body: body || normalized };
}

/** Absolute-path containment check — the guard against a `..` or symlink escape. */
function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(`..${sep}`) && !resolve(candidate).startsWith('..');
}

async function collectSkillDirs(root: string, dir: string, depth: number, out: string[]): Promise<void> {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
    out.push(dir);
    return; // A skill directory is a leaf — nested skills are not a thing.
  }
  for (const entry of entries) {
    // `isDirectory()` is false for a symlink (readdir does not follow), so a
    // symlinked directory is skipped rather than followed out of the tree.
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const child = join(dir, entry.name);
    if (!isInside(root, child)) continue;
    await collectSkillDirs(root, child, depth + 1, out);
  }
}

async function readSupportFiles(root: string, skillDir: string): Promise<Array<{ path: string; content: string }>> {
  const files: Array<{ path: string; content: string }> = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || files.length >= MAX_SUPPORT_FILES) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= MAX_SUPPORT_FILES) return;
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (!isInside(root, full)) continue;
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      // Regular files only — a symlink reports isFile() false here, so it is
      // dropped instead of being inlined by following it.
      if (!entry.isFile() || entry.name === 'SKILL.md') continue;
      const info = await stat(full);
      if (info.size > MAX_SUPPORT_FILE_BYTES) continue;
      const rel = relative(skillDir, full).split(sep).join('/');
      try {
        validateSkillPath(rel);
      } catch {
        continue;
      }
      files.push({ path: rel, content: await readFile(full, 'utf8') });
    }
  };
  await walk(skillDir, 0);
  return files;
}

/**
 * Load every skill under `root`.
 *
 * `licenseFilter` — when non-empty, a skill whose `license:` frontmatter is not
 * listed is skipped and reported. This is what lets AWB tap a repository that
 * mixes permissive and proprietary skills (the Hermes hub carries MIT,
 * Apache-2.0 AND proprietary entries side by side) without redistributing the
 * parts it may not. A skill with NO license frontmatter counts as unknown and
 * is skipped whenever a filter is active.
 */
export async function loadSkillTree(
  root: string,
  opts: { licenseFilter?: string[] } = {},
): Promise<LoadReport> {
  const skills: LoadedSkill[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const absRoot = resolve(root);
  if (!existsSync(absRoot)) return { skills, skipped };

  const dirs: string[] = [];
  await collectSkillDirs(absRoot, absRoot, 0, dirs);
  dirs.sort();

  const filter = (opts.licenseFilter ?? []).map((l) => l.trim().toLowerCase()).filter(Boolean);

  for (const dir of dirs) {
    const sourcePath = `${relative(absRoot, dir).split(sep).join('/')}/SKILL.md`;
    const slug = dir.split(sep).pop() ?? '';
    try {
      if (!SLUG_RE.test(slug)) {
        skipped.push({ path: sourcePath, reason: `directory name is not a valid slug: ${slug}` });
        continue;
      }
      const raw = await readFile(join(dir, 'SKILL.md'), 'utf8');
      const { frontmatter, body } = parseFrontmatter(raw);
      if (filter.length > 0) {
        const license = frontmatter.license.trim().toLowerCase();
        if (!license) {
          skipped.push({ path: sourcePath, reason: 'no license in frontmatter' });
          continue;
        }
        if (!filter.includes(license)) {
          skipped.push({ path: sourcePath, reason: `license not allowed: ${frontmatter.license}` });
          continue;
        }
      }
      const supportFiles = await readSupportFiles(absRoot, dir);
      // Canonicalize through the SAME validator the REST/MCP write paths use,
      // so a tapped skill cannot bypass the size caps or the secret scan.
      const canonical = canonicalizeSkillContent(body, supportFiles);
      skills.push({
        slug,
        sourcePath,
        frontmatter,
        body: canonical.body,
        supportFiles: canonical.supportFiles,
        digest: canonical.digest,
      });
    } catch (error: any) {
      skipped.push({
        path: sourcePath,
        reason: error instanceof SkillValidationError
          ? `${error.code}: ${error.message}`
          : (error?.message ?? String(error)),
      });
    }
  }
  return { skills, skipped };
}
