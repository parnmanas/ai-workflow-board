// 한 Runtime Host 의 작업이 **다른 호스트를 잠그지 않는다** (실측 2026-10-01).
//
// 증상: 한 매니저의 CLI 를 올리는 동안 다른 매니저의 CLI 를 올릴 수 없었다.
//
// 원인: Runtime Hosts 화면의 `InstanceDetail` 은 **선택된 호스트 하나만** 그리는 패널이고,
// 호스트를 바꿔도 React 가 같은 컴포넌트 인스턴스를 재사용한다(`<InstanceDetail inst={selected}>`
// 에 key 가 없다). 진행 플래그가 `useState` 였기 때문에 호스트 A 에서 시작한 작업의 "진행 중" 이
// **호스트 B 화면으로 그대로 넘어가 B 를 잠갔다.** 서버·매니저에는 호스트 간 락이 없으므로 이
// 차단은 순전히 화면의 착시였다. 같은 병이 CLI 업데이트만이 아니라 restart / restart_all /
// update_manager / refresh_models 까지 6개 플래그에 다 있었다.
//
// key 를 다는 것은 답이 아니다 — A 를 떠나는 순간 언마운트되어 추적을 잃고, A 로 돌아왔을 때
// **아직 진행 중인** A 의 버튼이 다시 열려 같은 작업을 두 번 보낼 수 있게 된다. 그래서 상태를
// 호스트 id 로 키잉한 스토어(instanceOps.ts)에 둔다.
//
// 이 테스트는 화면이 실제로 하는 그대로 — **같은 InstanceDetail 에 호스트만 바꿔 rerender** — 한다.
// 실행: node --import tsx --test apps/client/test/instance-ops-per-host.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import { api } from '../src/api.ts';
import { React, act, click, mount, setupDom } from './helpers/jsdom.mjs';
import { ToastProvider } from '../src/contexts/ToastContext.tsx';
import { ConfirmProvider } from '../src/contexts/ConfirmContext.tsx';
import {
  INSTANCE_OP,
  finishInstanceOp,
  pendingInstallKeys,
  resetInstanceOpsStore,
  startInstanceOp,
} from '../src/components/admin/instanceOps.ts';

const { InstanceDetail } = await import('../src/components/admin/AgentManagerPage.tsx');

function host(id, hostname) {
  return {
    instance_id: id,
    agent_id: `mgr-${id}`,
    account_id: 'ws-1',
    mode: 'manager',
    hostname,
    plugin_version: '1.0.0',
    cli: 'mixed',
    cli_adapters: ['claude'],
    pid: 1,
    started_at: '2026-10-01T00:00:00.000Z',
    last_seen_at: '2026-10-01T00:00:10.000Z',
    agent_ids: [],
    // 두 호스트가 **같은 경로**에 같은 CLI 를 둔다 — 설치본 키가 호스트 사이에서 충돌하는 경우.
    cli_installs: [
      {
        cli: 'claude', path: '/usr/local/bin/claude', version: '2.0.0', method: 'npm --prefix /usr/local',
        updatable: true, needs_sudo: false, latest_version: '2.1.0', active: true,
      },
    ],
  };
}

const A = host('inst-a', 'rolf');
const B = host('inst-b', 'ralf');

function render(inst) {
  return React.createElement(
    ToastProvider,
    null,
    React.createElement(ConfirmProvider, null, React.createElement(InstanceDetail, { inst, workspaceAgents: [] })),
  );
}

const cliRowButton = (container) =>
  [...container.querySelectorAll('button')].find((b) => /^(Update|업데이트 중…)$/.test(b.textContent.trim()));

function silenceAudio(t) {
  const previous = globalThis.Audio;
  globalThis.Audio = class { play() { return Promise.resolve(); } pause() {} };
  t.after(() => { globalThis.Audio = previous; });
}

test('호스트 A 의 CLI 업데이트가 진행 중이어도, 같은 패널을 B 로 바꾸면 B 는 잠기지 않는다', async (t) => {
  const dom = setupDom();
  t.after(() => dom.cleanup());
  silenceAudio(t);
  resetInstanceOpsStore();
  t.after(() => resetInstanceOpsStore());

  // A 의 update_cli 를 붙들어 둔다 — 실제로는 ack 대기가 최대 4분이다.
  let releaseA;
  const sent = [];
  const originals = { send: api.sendAgentManagerCommand, outcome: api.getAgentManagerCommandOutcome, list: api.listAgentManagerInstances };
  api.sendAgentManagerCommand = async (instanceId, body) => {
    sent.push(instanceId);
    if (instanceId === A.instance_id) await new Promise((r) => { releaseA = r; });
    return { command_id: `cmd-${instanceId}`, ok: true };
  };
  api.getAgentManagerCommandOutcome = async () => ({ state: 'ok', detail: 'done' });
  api.listAgentManagerInstances = async () => [A, B];
  t.after(() => {
    api.sendAgentManagerCommand = originals.send;
    api.getAgentManagerCommandOutcome = originals.outcome;
    api.listAgentManagerInstances = originals.list;
  });

  const view = mount(render(A));
  t.after(() => view.unmount());
  await act(async () => {});

  click(cliRowButton(view.container));
  await act(async () => {});
  assert.equal(cliRowButton(view.container).textContent.trim(), '업데이트 중…', 'A 는 진행 중으로 보인다');
  assert.equal(cliRowButton(view.container).disabled, true);

  // **같은 컴포넌트에 호스트만 바꾼다** — Runtime Hosts 화면이 실제로 하는 일이다.
  view.rerender(render(B));
  await act(async () => {});
  const bButton = cliRowButton(view.container);
  assert.equal(bButton.textContent.trim(), 'Update', 'B 는 A 의 진행 상태를 물려받지 않는다');
  assert.equal(bButton.disabled, false, 'B 의 CLI 는 A 와 동시에 올릴 수 있어야 한다');

  // 그리고 실제로 B 를 올릴 수 있다 — A 가 끝나기 전에.
  click(bButton);
  await act(async () => {});
  assert.deepEqual(sent, [A.instance_id, B.instance_id], 'A 가 진행 중인데도 B 로 명령이 나갔다');

  // A 로 돌아오면 A 는 **여전히 진행 중**이다 — key 로 재생성했다면 여기서 추적을 잃었다.
  view.rerender(render(A));
  await act(async () => {});
  assert.equal(cliRowButton(view.container).textContent.trim(), '업데이트 중…', 'A 의 진행 상태는 화면 전환 뒤에도 남는다');
  assert.equal(cliRowButton(view.container).disabled, true, '진행 중인 A 를 다시 보낼 수 없다');

  releaseA();
  await act(async () => { await new Promise((r) => setTimeout(r, 2100)); });
});

test('스토어: 호스트끼리 독립이고, 같은 호스트의 같은 작업만 중복을 막는다', () => {
  resetInstanceOpsStore();
  assert.equal(startInstanceOp('a', INSTANCE_OP.updateAllClis), true);
  assert.equal(startInstanceOp('a', INSTANCE_OP.updateAllClis), false, '같은 호스트의 같은 작업은 한 번만');
  assert.equal(startInstanceOp('b', INSTANCE_OP.updateAllClis), true, '다른 호스트는 막지 않는다');
  assert.equal(startInstanceOp('a', INSTANCE_OP.updateCli('/x/claude')), true);
  assert.equal(startInstanceOp('a', INSTANCE_OP.updateCli('/x/codex')), true, '같은 호스트의 다른 설치본도 동시에');
  finishInstanceOp('a', INSTANCE_OP.updateAllClis);
  assert.equal(startInstanceOp('a', INSTANCE_OP.updateAllClis), true, '끝나면 다시 시작할 수 있다');
  resetInstanceOpsStore();
});

test('pendingInstallKeys 는 그 호스트의 설치본 키만 뽑는다', () => {
  const keys = pendingInstallKeys(new Set([INSTANCE_OP.updateCli('/a/claude'), INSTANCE_OP.restart, INSTANCE_OP.updateCli('/b/codex')]));
  assert.deepEqual([...keys].sort(), ['/a/claude', '/b/codex']);
});
