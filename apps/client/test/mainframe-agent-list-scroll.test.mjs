import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [agentManagerPageSource] = await Promise.all([
  readFile(new URL('../src/components/admin/AgentManagerPage.tsx', import.meta.url), 'utf8'),
]);
// P4c-4: AgentsPage 삭제 — 첫 테스트(AI Agents 레이아웃)도 함께 제거.


test('desktop Mainframe keeps page and detail overflow outside the Host list', () => {
  assert.match(
    agentManagerPageSource,
    /display:\s*'flex',\s*gap:\s*16,\s*height:\s*'100%',\s*minHeight:\s*0,\s*overflow:\s*'hidden'/,
  );
  assert.match(
    agentManagerPageSource,
    /data-testid="runtime-hosts-list"[\s\S]*?flex:\s*1,\s*minHeight:\s*0,\s*overflowY:\s*'auto',\s*overflowX:\s*'hidden'/,
  );
});

test('Mainframe detail pane owns vertical scrolling without trapping the mobile Back button', () => {
  assert.match(
    agentManagerPageSource,
    /data-testid="mainframe-detail-scroll"[\s\S]*?flex:\s*1,[\s\S]*?minHeight:\s*0,[\s\S]*?overflowY:\s*'auto',[\s\S]*?overflowX:\s*'hidden'/,
  );
  assert.ok(
    agentManagerPageSource.indexOf('Host 목록') <
      agentManagerPageSource.indexOf('data-testid="mainframe-detail-scroll"'),
  );
  assert.match(
    agentManagerPageSource,
    /function InstanceDetail[\s\S]*?display:\s*'flex',\s*flexDirection:\s*'column',\s*gap:\s*16,\s*minHeight:\s*'100%'/,
  );
});

test('small viewport preserves the same independently scrollable Host list', () => {
  assert.match(agentManagerPageSource, /const isMobile = useMediaQuery\('\(max-width: 1100px\)'\)/);
  assert.match(
    agentManagerPageSource,
    /width:\s*isMobile \? '100%' : 320[\s\S]*?flexDirection:\s*'column',\s*minHeight:\s*0/,
  );
  assert.equal(
    (agentManagerPageSource.match(/data-testid="runtime-hosts-list"/g) ?? []).length,
    1,
  );
});
