// Codex 메모리 위치 — docs/cli-memory.md.
//
//   - 전역 지침   `<CODEX_HOME>/AGENTS.md` (`AGENTS.override.md` 가 있으면 그것이 대신한다)
//   - 프로젝트    `<P>/AGENTS.md`, `<P>/AGENTS.override.md`
//   - memories   `<CODEX_HOME>/memories/` — Codex 가 지난 대화에서 뽑아 정리하는 메모리.
//                `memory_summary.md` 는 매 세션에 들어가고, `MEMORY.md` · `raw_memories.md` ·
//                `rollout_summaries/*.md` 는 필요할 때 읽는다. 전부 Codex 가 다시 만드는 파일이다.
//
// 지침 파일(전역 + 프로젝트)을 합친 크기가 `project_doc_max_bytes`(기본 32KiB)를 넘으면 Codex 는
// 뒷부분을 버린다 — 분석이 그 값을 쓰도록 settings 로 싣는다.
// AWB 세션 전용 홈(credential 별)은 그 자체가 CODEX_HOME 이라 전역 지침과 memories 가 홈마다 따로다.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { CliMemoryFileDecl, CliMemorySpec } from '../cli-module.js';
import { isFile, listMarkdown, matchBool, matchInt, sessionHomesUnder, stem } from '../memory-common.js';

/** Codex 의 `project_doc_max_bytes` 기본값. */
export const CODEX_PROJECT_DOC_MAX_BYTES = 32 * 1024;

export const codexMemory: CliMemorySpec = {
  summary: 'Codex loads AGENTS.md from CODEX_HOME and from the project into every session (combined cap: project_doc_max_bytes, 32 KiB by default). '
    + 'With the memories feature on, Codex distills past sessions into memories/ — memory_summary.md is loaded every session, the rest on demand.',
  // codex/index.ts 의 resolveCodexHome 과 같은 규칙(그 파일이 이 파일을 import 하므로 되부르지 않는다).
  root: (env) => env.CODEX_HOME?.trim() || join(homedir(), '.codex'),
  extraHomes: ({ sessionHomesDir }) => sessionHomesUnder(sessionHomesDir, 'codex'),

  async locate({ home, projectDirs }) {
    const files: CliMemoryFileDecl[] = [];
    const override = join(home.path, 'AGENTS.override.md');
    const hasOverride = await isFile(override);
    files.push({
      path: join(home.path, 'AGENTS.md'), scope: 'global', kind: 'instructions', format: 'markdown',
      label: hasOverride ? 'Global instructions (overridden)' : 'Global instructions', group: 'global', projectDir: null,
      loaded: hasOverride ? 'on_demand' : 'always', slot: !hasOverride,
    });
    files.push({
      path: override, scope: 'global', kind: 'instructions', format: 'markdown',
      label: 'Global instructions override', group: 'global', projectDir: null, loaded: 'always',
    });

    for (const dir of home.kind === 'operator' ? projectDirs : []) {
      const group = `project:${dir}`;
      const projectOverride = join(dir, 'AGENTS.override.md');
      const overridden = await isFile(projectOverride);
      files.push({
        path: join(dir, 'AGENTS.md'), scope: 'project', kind: 'instructions', format: 'markdown',
        label: overridden ? 'Project instructions (overridden)' : 'Project instructions', group, projectDir: dir,
        loaded: overridden ? 'on_demand' : 'always', slot: !overridden,
      });
      files.push({
        path: projectOverride, scope: 'project', kind: 'instructions', format: 'markdown',
        label: 'Project instructions override', group, projectDir: dir, loaded: 'always',
      });
    }

    const memories = join(home.path, 'memories');
    const fixed: Array<[string, string, 'always' | 'on_demand']> = [
      ['memory_summary.md', 'Memory summary', 'always'],
      ['MEMORY.md', 'Memory handbook', 'on_demand'],
      ['raw_memories.md', 'Raw memories', 'on_demand'],
    ];
    const fixedPaths = new Set<string>();
    for (const [name, label, loaded] of fixed) {
      const path = join(memories, name);
      fixedPaths.add(path);
      files.push({ path, scope: 'global', kind: 'generated', format: 'markdown', label, group: 'memories', projectDir: null, loaded });
    }
    for (const path of await listMarkdown(memories, 2)) {
      if (fixedPaths.has(path)) continue;
      const inSummaries = path.includes(`${join(memories, 'rollout_summaries')}`);
      files.push({
        path, scope: 'global', kind: 'generated', format: 'markdown',
        label: inSummaries ? `Rollout summary · ${stem(path)}` : `Memory · ${stem(path)}`,
        group: 'memories', projectDir: null, loaded: 'on_demand',
      });
    }
    return { files, dirs: [] };
  },

  async settings(home) {
    let text = '';
    try {
      text = await readFile(join(home.path, 'config.toml'), 'utf8');
    } catch {
      return { project_doc_max_bytes: CODEX_PROJECT_DOC_MAX_BYTES };
    }
    const out: Record<string, string | number | boolean | null> = {};
    const docMax = matchInt(text, 'project_doc_max_bytes');
    out.project_doc_max_bytes = docMax ?? CODEX_PROJECT_DOC_MAX_BYTES;
    // `[features] memories = true` 또는 `[memories]` 의 use/generate 플래그.
    const feature = matchBool(text, 'memories');
    if (feature !== undefined) out.memories_feature = feature;
    const use = matchBool(text, 'use_memories');
    if (use !== undefined) out.use_memories = use;
    const generate = matchBool(text, 'generate_memories');
    if (generate !== undefined) out.generate_memories = generate;
    return out;
  },
};
