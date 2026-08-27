import { readFile, writeFile } from 'node:fs/promises';

const source = await readFile(new URL('../CLAUDE.md', import.meta.url), 'utf8');
const header = `<!-- scripts/sync-agent-instructions.mjs가 CLAUDE.md에서 생성했습니다. 수동으로 편집하지 마세요. -->\n\n`;
const provider = `## Codex-specific notes\n\nCodex discovers AGENTS.md from the repository root toward the current working directory. A nearer AGENTS.md may refine these instructions; system and AWB role policies remain authoritative.\n\n`;
const expected = header + provider + source;
const targetUrl = new URL('../AGENTS.md', import.meta.url);

if (process.argv.includes('--check')) {
  const current = await readFile(targetUrl, 'utf8').catch(() => '');
  if (current !== expected) {
    console.error('AGENTS.md가 CLAUDE.md 공통 원본과 일치하지 않습니다. npm run sync:agent-instructions를 실행하세요.');
    process.exitCode = 1;
  }
} else {
  await writeFile(targetUrl, expected);
}
