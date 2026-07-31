import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [agentsPageSource, agentManagerPageSource] = await Promise.all([
  readFile(new URL('../src/components/AgentsPage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/admin/AgentManagerPage.tsx', import.meta.url), 'utf8'),
]);

test('AI Agents propagates its available height into the Mainframe', () => {
  assert.match(
    agentsPageSource,
    /flexDirection:\s*'column',\s*height:\s*'100%',\s*minHeight:\s*0,\s*overflow:\s*'hidden'/,
  );
  assert.match(
    agentsPageSource,
    /id="agent-manager-runtime"[\s\S]*?flex:\s*1,\s*minHeight:\s*0,[\s\S]*?overflow:\s*'hidden'/,
  );
});

test('desktop Mainframe keeps page and detail overflow outside the Agents list', () => {
  assert.match(
    agentManagerPageSource,
    /display:\s*'flex',\s*gap:\s*16,\s*height:\s*'100%',\s*minHeight:\s*0,\s*overflow:\s*'hidden'/,
  );
  assert.match(
    agentManagerPageSource,
    /data-testid="mainframe-agents-list"[\s\S]*?flex:\s*1,\s*minHeight:\s*0,\s*overflowY:\s*'auto',\s*overflowX:\s*'hidden'/,
  );
});

test('small viewport preserves the same independently scrollable Agents list', () => {
  assert.match(agentManagerPageSource, /const isMobile = useMediaQuery\('\(max-width: 767px\)'\)/);
  assert.match(
    agentManagerPageSource,
    /width:\s*isMobile \? '100%' : 320[\s\S]*?flexDirection:\s*'column',\s*minHeight:\s*0/,
  );
  assert.equal(
    (agentManagerPageSource.match(/data-testid="mainframe-agents-list"/g) ?? []).length,
    1,
  );
});
