import { readFile, writeFile } from 'node:fs/promises';

const source = await readFile(new URL('../CLAUDE.md', import.meta.url), 'utf8');
const header = `<!-- scripts/sync-agent-instructions.mjs가 CLAUDE.md에서 생성했습니다. 수동으로 편집하지 마세요. -->\n\n`;
const provider = `## Codex 전용 참고 사항\n\nCodex는 저장소 루트부터 현재 작업 디렉터리까지 AGENTS.md를 탐색합니다. 더 가까운 AGENTS.md에서 이 지침을 구체화할 수 있지만, 시스템 정책과 AWB 역할 정책이 항상 우선합니다.\n\n`;
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
