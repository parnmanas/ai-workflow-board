// Antigravity 메모리 위치 — docs/cli-memory.md.
//
//   - 전역 규칙   `~/.gemini/GEMINI.md`
//   - 작업 규칙   `<P>/.agent/rules/*.md`
//   - knowledge  `~/.gemini/antigravity-cli/knowledge/**`, `~/.gemini/antigravity/knowledge/**` —
//                Antigravity 가 대화에서 모으는 지식 항목(필요할 때 읽는다)

import { homedir } from 'node:os';
import { join } from 'node:path';

import type { CliMemoryDirDecl, CliMemoryFileDecl, CliMemorySpec } from '../cli-module.js';
import { listMarkdown, stem } from '../memory-common.js';

export const antigravityMemory: CliMemorySpec = {
  summary: 'Antigravity applies ~/.gemini/GEMINI.md globally and .agent/rules in the workspace; '
    + 'it also collects knowledge items from past conversations and reads them on demand.',
  root: () => join(homedir(), '.gemini'),
  async locate({ home, projectDirs }) {
    const files: CliMemoryFileDecl[] = [{
      path: join(home.path, 'GEMINI.md'), scope: 'global', kind: 'instructions', format: 'markdown',
      label: 'Global rules', group: 'global', projectDir: null, loaded: 'always', slot: true,
    }];
    const dirs: CliMemoryDirDecl[] = [];
    for (const dir of home.kind === 'operator' ? projectDirs : []) {
      const group = `project:${dir}`;
      const rulesDir = join(dir, '.agent', 'rules');
      for (const path of await listMarkdown(rulesDir, 1)) {
        files.push({
          path, scope: 'project', kind: 'rules', format: 'markdown', label: `Workspace rule · ${stem(path)}`,
          group, projectDir: dir, loaded: 'always',
        });
      }
      dirs.push({ path: rulesDir, scope: 'project', kind: 'rules', label: 'Workspace rules', group, projectDir: dir });
    }
    for (const sub of ['antigravity-cli', 'antigravity']) {
      for (const path of await listMarkdown(join(home.path, sub, 'knowledge'), 3, 500)) {
        files.push({
          path, scope: 'global', kind: 'knowledge', format: 'markdown', label: `Knowledge · ${stem(path)}`,
          group: 'knowledge', projectDir: null, loaded: 'on_demand',
        });
      }
    }
    return { files, dirs };
  },
};
