// Claude Code 메모리 위치 — docs/cli-memory.md.
//
//   - 사용자 지침  `<home>/CLAUDE.md`, 사용자 rules `<home>/rules/*.md`
//   - 프로젝트     `<P>/CLAUDE.md`, `<P>/.claude/CLAUDE.md`, `<P>/CLAUDE.local.md`, `<P>/.claude/rules/*.md`
//   - auto memory `<home>/projects/<key>/memory/MEMORY.md`(색인, 앞 200줄이 매 세션에 들어간다) +
//                 같은 디렉터리의 주제 파일(필요할 때 읽는다). `<key>` 는 작업 폴더 경로의
//                 영숫자가 아닌 글자를 `-` 로 바꾼 것이다.
//
// rules 파일에 `paths:` frontmatter 가 있으면 그 경로를 만질 때만 들어간다(conditional).
// AWB 세션 전용 홈(credential 별)은 `projects` 만 운영자 홈으로 링크한다 — 그래서 auto memory 는
// 공유되지만 사용자 지침(`CLAUDE.md`)과 rules 는 그 홈에 따로 있어야 보인다.

import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { CliMemoryDirDecl, CliMemoryFileDecl, CliMemorySpec } from '../cli-module.js';
import { frontmatterHasKey, isDir, isFile, listMarkdown, listSubdirs, readHead, sessionHomesUnder, stem } from '../memory-common.js';

/** Claude Code 가 auto memory 색인에서 세션 시작 때 읽는 줄 수. */
export const CLAUDE_AUTO_INDEX_LINES = 200;

/** 작업 폴더 → `~/.claude/projects/<key>` 의 key. */
export function claudeProjectKey(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * key 디렉터리의 실제 작업 폴더. key 는 손실 변환이라 되돌릴 수 없으므로 (1) 알려진 프로젝트
 * 폴더를 같은 규칙으로 바꿔 대조하고, (2) 없으면 그 디렉터리의 가장 최근 세션 기록에 적힌
 * `cwd` 를 읽는다.
 */
async function projectDirForKey(projectsDir: string, key: string, known: readonly string[]): Promise<string | null> {
  const hit = known.find((dir) => claudeProjectKey(dir) === key);
  if (hit) return hit;
  let newest: { path: string; mtime: number } | null = null;
  try {
    for (const name of await readdir(join(projectsDir, key))) {
      if (!name.endsWith('.jsonl')) continue;
      const full = join(projectsDir, key, name);
      const mtime = (await stat(full)).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { path: full, mtime };
    }
  } catch {
    return null;
  }
  if (!newest) return null;
  const head = await readHead(newest.path, 64 * 1024);
  const m = /"cwd":("(?:[^"\\]|\\.)*")/.exec(head);
  if (!m) return null;
  try {
    const cwd = JSON.parse(m[1]);
    return typeof cwd === 'string' && cwd ? cwd : null;
  } catch {
    return null;
  }
}

async function rulesIn(dir: string, scope: 'global' | 'project', group: string, projectDir: string | null, prefix: string): Promise<CliMemoryFileDecl[]> {
  const out: CliMemoryFileDecl[] = [];
  for (const path of await listMarkdown(dir, 2)) {
    const conditional = await frontmatterHasKey(path, 'paths');
    out.push({
      path, scope, kind: 'rules', format: 'markdown', label: `${prefix} · ${stem(path)}`, group, projectDir,
      loaded: conditional ? 'conditional' : 'always',
    });
  }
  return out;
}

export const claudeMemory: CliMemorySpec = {
  summary: 'Claude Code loads CLAUDE.md (user, project, local) and .claude/rules into every session. '
    + 'Auto memory keeps a MEMORY.md index per project — only its first 200 lines are loaded; topic files are read on demand.',
  // claude/index.ts 의 resolveClaudeHome 과 같은 규칙(그 파일이 이 파일을 import 하므로 되부르지 않는다).
  root: (env) => env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude'),
  extraHomes: ({ sessionHomesDir }) => sessionHomesUnder(sessionHomesDir, 'claude'),

  async locate({ home, projectDirs }) {
    const files: CliMemoryFileDecl[] = [];
    const dirs: CliMemoryDirDecl[] = [];

    files.push({
      path: join(home.path, 'CLAUDE.md'), scope: 'global', kind: 'instructions', format: 'markdown',
      label: 'User instructions', group: 'global', projectDir: null, loaded: 'always', slot: true,
    });
    files.push(...await rulesIn(join(home.path, 'rules'), 'global', 'global', null, 'User rule'));
    dirs.push({ path: join(home.path, 'rules'), scope: 'global', kind: 'rules', label: 'User rules', group: 'global', projectDir: null });

    // 프로젝트 파일은 홈과 무관하다 — 운영자 홈에서 한 번만 낸다.
    for (const dir of home.kind === 'operator' ? projectDirs : []) {
      const group = `project:${dir}`;
      const dotClaude = join(dir, '.claude', 'CLAUDE.md');
      const hasDotClaude = await isFile(dotClaude);
      files.push({
        path: join(dir, 'CLAUDE.md'), scope: 'project', kind: 'instructions', format: 'markdown',
        label: 'Project instructions', group, projectDir: dir, loaded: 'always', slot: !hasDotClaude,
      });
      files.push({
        path: dotClaude, scope: 'project', kind: 'instructions', format: 'markdown',
        label: 'Project instructions (.claude)', group, projectDir: dir, loaded: 'always',
      });
      files.push({
        path: join(dir, 'CLAUDE.local.md'), scope: 'project', kind: 'instructions', format: 'markdown',
        label: 'Local project instructions', group, projectDir: dir, loaded: 'always',
      });
      files.push(...await rulesIn(join(dir, '.claude', 'rules'), 'project', group, dir, 'Project rule'));
      dirs.push({ path: join(dir, '.claude', 'rules'), scope: 'project', kind: 'rules', label: 'Project rules', group, projectDir: dir });
    }

    // auto memory — 운영자 홈에서도 세션 홈에서도 같은 자리(`projects` 링크). 같은 실제 파일은
    // 러너가 realpath 로 한 번만 싣는다.
    const projectsDir = join(home.path, 'projects');
    const seenKeys = new Set<string>();
    for (const key of await listSubdirs(projectsDir)) {
      const memoryDir = join(projectsDir, key, 'memory');
      if (!(await isDir(memoryDir))) continue;
      seenKeys.add(key);
      const projectDir = await projectDirForKey(projectsDir, key, projectDirs);
      const group = `auto:${key}`;
      const index = join(memoryDir, 'MEMORY.md');
      files.push({
        path: index, scope: 'project', kind: 'auto_index', format: 'markdown', label: 'Auto memory index',
        group, projectDir, loaded: 'index_head', loadLimitLines: CLAUDE_AUTO_INDEX_LINES, slot: true,
      });
      for (const path of await listMarkdown(memoryDir, 0)) {
        if (path === index) continue;
        files.push({
          path, scope: 'project', kind: 'auto_topic', format: 'markdown', label: `Auto memory · ${stem(path)}`,
          group, projectDir, loaded: 'on_demand',
        });
      }
      dirs.push({ path: memoryDir, scope: 'project', kind: 'auto_topic', label: 'Auto memory', group, projectDir });
    }
    // 아직 auto memory 가 없는 프로젝트도 만들 수 있는 자리로 낸다(운영자 홈만 — 세션 홈은 같은 링크다).
    if (home.kind === 'operator') {
      for (const dir of projectDirs) {
        const key = claudeProjectKey(dir);
        if (seenKeys.has(key)) continue;
        dirs.push({
          path: join(projectsDir, key, 'memory'), scope: 'project', kind: 'auto_topic', label: 'Auto memory',
          group: `auto:${key}`, projectDir: dir,
        });
      }
    }
    return { files, dirs };
  },
};
