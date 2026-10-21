// OpenCode 메모리 위치 — docs/cli-memory.md.
//
//   - 전역 지침  `$XDG_CONFIG_HOME/opencode/AGENTS.md` (기본 `~/.config/opencode/AGENTS.md`)
//   - 프로젝트   `<P>/AGENTS.md`
//
// OpenCode 는 AGENTS.md 가 없으면 Claude Code 의 파일(`~/.claude/CLAUDE.md`, `<P>/CLAUDE.md`)을
// 대신 읽는다(`OPENCODE_DISABLE_CLAUDE_CODE` 로 끈다) — 그 파일들은 Claude 쪽에서 보인다.

import { homedir } from 'node:os';
import { join } from 'node:path';

import type { CliMemoryFileDecl, CliMemorySpec } from '../cli-module.js';

function opencodeConfigDir(env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return join(xdg || join(homedir(), '.config'), 'opencode');
}

export const opencodeMemory: CliMemorySpec = {
  summary: 'OpenCode loads AGENTS.md from its config directory and from the project into every session. '
    + 'Without an AGENTS.md it falls back to Claude Code\'s CLAUDE.md files.',
  root: opencodeConfigDir,
  async locate({ home, projectDirs }) {
    const files: CliMemoryFileDecl[] = [{
      path: join(home.path, 'AGENTS.md'), scope: 'global', kind: 'instructions', format: 'markdown',
      label: 'Global instructions', group: 'global', projectDir: null, loaded: 'always', slot: true,
    }];
    for (const dir of home.kind === 'operator' ? projectDirs : []) {
      files.push({
        path: join(dir, 'AGENTS.md'), scope: 'project', kind: 'instructions', format: 'markdown',
        label: 'Project instructions', group: `project:${dir}`, projectDir: dir, loaded: 'always', slot: true,
      });
    }
    return { files, dirs: [] };
  },
};
