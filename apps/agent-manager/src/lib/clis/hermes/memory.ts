// Hermes 메모리 위치 — docs/cli-memory.md.
//
//   - `<HERMES_HOME>/memories/MEMORY.md` — 에이전트 자신의 메모(환경·관례·요령)
//   - `<HERMES_HOME>/memories/USER.md`   — 사용자에 대해 아는 것(선호·습관)
//     둘 다 항목이 `\n§\n` 로 나뉜 목록이고, 세션 시작 때 고정 스냅샷으로 시스템 프롬프트에
//     들어간다. 글자 수 상한이 있다(config.yaml `memory.memory_char_limit` / `user_char_limit`).
//     Hermes 는 그 형식으로 되돌아가지 않는 내용을 보면 쓰기를 거부한다(drift guard) — 그래서
//     화면은 항목 단위로만 고치고 같은 구분자로 다시 쓴다.
//   - `<HERMES_HOME>/SOUL.md` — 정체성 프롬프트
//   - 프로젝트 `<P>/.hermes.md`, `<P>/AGENTS.md`
//
// 런타임 프로필(`<HERMES_HOME>/profiles/<name>`)은 각자 HERMES_HOME 이라 메모리도 따로다.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { CliMemoryFileDecl, CliMemorySpec } from '../cli-module.js';
import { listSubdirs, matchBool, matchInt } from '../memory-common.js';

/** hermes-agent 의 기본 상한(tools/memory_tool.py · config.yaml 예시). */
export const HERMES_MEMORY_CHAR_LIMIT = 2200;
export const HERMES_USER_CHAR_LIMIT = 1375;

function hermesRoot(env: NodeJS.ProcessEnv): string {
  const override = env.HERMES_HOME?.trim();
  if (override) return override;
  if (process.platform === 'win32') {
    return join(env.LOCALAPPDATA?.trim() || join(homedir(), 'AppData', 'Local'), 'hermes');
  }
  return join(homedir(), '.hermes');
}

async function readLimits(homePath: string): Promise<{ memory: number; user: number; text: string }> {
  let text = '';
  try {
    text = await readFile(join(homePath, 'config.yaml'), 'utf8');
  } catch {
    /* 기본값 */
  }
  return {
    memory: matchInt(text, 'memory_char_limit') ?? HERMES_MEMORY_CHAR_LIMIT,
    user: matchInt(text, 'user_char_limit') ?? HERMES_USER_CHAR_LIMIT,
    text,
  };
}

export const hermesMemory: CliMemorySpec = {
  summary: 'Hermes keeps two bounded, §-separated lists — MEMORY.md (its own notes) and USER.md (what it knows about you) — '
    + 'and injects both into the system prompt as a frozen snapshot at session start. Each has a character cap.',
  root: hermesRoot,
  async extraHomes({ env }) {
    const root = hermesRoot(env);
    const names = await listSubdirs(join(root, 'profiles'));
    return names.map((name) => ({
      id: `profile:${name}`, kind: 'profile' as const, path: join(root, 'profiles', name), credentialId: null, profile: name,
    }));
  },

  async locate({ home, projectDirs }) {
    const limits = await readLimits(home.path);
    const files: CliMemoryFileDecl[] = [
      {
        path: join(home.path, 'memories', 'MEMORY.md'), scope: 'global', kind: 'entries', format: 'section_entries',
        label: 'Agent notes', group: 'global', projectDir: null, loaded: 'always', charLimit: limits.memory, slot: true,
      },
      {
        path: join(home.path, 'memories', 'USER.md'), scope: 'global', kind: 'entries', format: 'section_entries',
        label: 'User profile', group: 'global', projectDir: null, loaded: 'always', charLimit: limits.user, slot: true,
      },
      {
        path: join(home.path, 'SOUL.md'), scope: 'global', kind: 'persona', format: 'markdown',
        label: 'Persona (SOUL.md)', group: 'global', projectDir: null, loaded: 'always',
      },
    ];
    for (const dir of home.kind === 'operator' ? projectDirs : []) {
      const group = `project:${dir}`;
      files.push({
        path: join(dir, '.hermes.md'), scope: 'project', kind: 'instructions', format: 'markdown',
        label: 'Project instructions (.hermes.md)', group, projectDir: dir, loaded: 'always',
      });
      files.push({
        path: join(dir, 'AGENTS.md'), scope: 'project', kind: 'instructions', format: 'markdown',
        label: 'Project instructions', group, projectDir: dir, loaded: 'always',
      });
    }
    return { files, dirs: [] };
  },

  async settings(home) {
    const limits = await readLimits(home.path);
    const out: Record<string, string | number | boolean | null> = {
      memory_char_limit: limits.memory,
      user_char_limit: limits.user,
    };
    const enabled = matchBool(limits.text, 'memory_enabled');
    if (enabled !== undefined) out.memory_enabled = enabled;
    const profile = matchBool(limits.text, 'user_profile_enabled');
    if (profile !== undefined) out.user_profile_enabled = profile;
    return out;
  },
};
