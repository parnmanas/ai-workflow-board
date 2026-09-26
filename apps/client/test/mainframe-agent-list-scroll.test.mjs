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
  // 두 탭이 스크롤을 다르게 다룬다는 사실까지 함께 고정한다:
  //   - Runtime Hosts: master/detail 이 **각자** 스크롤하므로 바깥은 잠근다. 여기를
  //     'auto' 로 열면 Mainframe 안쪽 스크롤과 바깥 스크롤이 겹쳐 두 번 스크롤된다.
  //   - Agents: 카드 그리드가 길어지므로 세로로 스크롤해야 한다.
  // 어느 쪽이든 컨테이너는 남은 높이를 그대로 받는다(flex:1, minHeight:0).
  assert.match(
    agentsPageSource,
    /id="agent-manager-runtime"[\s\S]*?flex:\s*1,\s*minHeight:\s*0,/,
  );
  assert.match(
    agentsPageSource,
    /overflowY:\s*tab === 'fleet' \? 'auto' : 'hidden'/,
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

test('Mainframe detail pane owns vertical scrolling without trapping the mobile Back button', () => {
  assert.match(
    agentManagerPageSource,
    /data-testid="mainframe-detail-scroll"[\s\S]*?flex:\s*1,[\s\S]*?minHeight:\s*0,[\s\S]*?overflowY:\s*'auto',[\s\S]*?overflowX:\s*'hidden'/,
  );
  assert.ok(
    agentManagerPageSource.indexOf('Back to agents') <
      agentManagerPageSource.indexOf('data-testid="mainframe-detail-scroll"'),
  );
  assert.match(
    agentManagerPageSource,
    /function InstanceDetail[\s\S]*?display:\s*'flex',\s*flexDirection:\s*'column',\s*gap:\s*16,\s*minHeight:\s*'100%'/,
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
