// Pi 메모리 위치 — docs/cli-memory.md.
//
//   - 전역 지침  `~/.pi/agent/AGENTS.md` (`PI_CODING_AGENT_DIR` 가 있으면 그 아래)
//   - 시스템 프롬프트 교체 `~/.pi/agent/SYSTEM.md`
//   - 프로젝트   `<P>/AGENTS.md`

import { homedir } from 'node:os';
import { join } from 'node:path';

import type { CliMemoryFileDecl, CliMemorySpec } from '../cli-module.js';

export const piMemory: CliMemorySpec = {
  summary: 'Pi loads ~/.pi/agent/AGENTS.md and the project AGENTS.md into every session; SYSTEM.md replaces its system prompt.',
  root: (env) => env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent'),
  async locate({ home, projectDirs }) {
    const files: CliMemoryFileDecl[] = [
      {
        path: join(home.path, 'AGENTS.md'), scope: 'global', kind: 'instructions', format: 'markdown',
        label: 'Global instructions', group: 'global', projectDir: null, loaded: 'always', slot: true,
      },
      {
        path: join(home.path, 'SYSTEM.md'), scope: 'global', kind: 'persona', format: 'markdown',
        label: 'System prompt (SYSTEM.md)', group: 'global', projectDir: null, loaded: 'always',
      },
    ];
    for (const dir of home.kind === 'operator' ? projectDirs : []) {
      files.push({
        path: join(dir, 'AGENTS.md'), scope: 'project', kind: 'instructions', format: 'markdown',
        label: 'Project instructions', group: `project:${dir}`, projectDir: dir, loaded: 'always', slot: true,
      });
    }
    return { files, dirs: [] };
  },
};
