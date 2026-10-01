// Runtime Host(매니저 인스턴스)별 **진행 중인 작업** — 호스트끼리 독립이다.
//
// 왜 컴포넌트 상태가 아닌가: Runtime Hosts 화면의 `InstanceDetail` 은 **선택된 호스트 하나만**
// 그리는 패널이고, 호스트를 바꿔도 React 가 같은 컴포넌트 인스턴스를 재사용한다(key 가 없다).
// 그래서 진행 플래그를 `useState` 로 두면 호스트 A 에서 시작한 작업의 "진행 중" 이 **호스트 B
// 화면으로 그대로 넘어가 B 를 잠갔다** — A 의 CLI 를 올리는 동안 B 의 CLI 를 못 올린 원인이다.
// 서버·매니저에는 호스트 간 락이 없으므로 이 차단은 순전히 화면의 착시였다.
//
// key 를 다는 것도 답이 아니다: 그러면 A 를 떠나는 순간 언마운트되어 추적을 잃고, A 로
// 돌아왔을 때 **아직 진행 중인** A 의 버튼이 다시 열려 같은 작업을 두 번 보낼 수 있게 된다.
//
// 그래서 상태를 컴포넌트 밖, **호스트 id 로 키잉한 스토어**에 둔다(hostModels.ts 와 같은
// useSyncExternalStore 모양). 호스트끼리 독립이고, 화면 전환과 무관하게 살아남는다.
//
// 시작/종료는 **호출 시점의 호스트 id 를 명시로** 받는다 — 현재 선택된 호스트가 아니라.
// 작업이 끝나는 시점에는 사용자가 이미 다른 호스트를 보고 있을 수 있기 때문이다.

import { useSyncExternalStore } from 'react';

const ops = new Map<string, Set<string>>();
const listeners = new Set<() => void>();
let version = 0;
const EMPTY: ReadonlySet<string> = new Set();

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 호스트 `instanceId` 에서 작업 `op` 를 시작한다. **이미 진행 중이면 false** — 같은 작업을
 * 두 번 보내는 것(버튼 연타, 화면 전환 후 재클릭)을 원자적으로 막는다. 다른 호스트의 같은
 * 작업은 막지 않는다.
 */
export function startInstanceOp(instanceId: string, op: string): boolean {
  const set = ops.get(instanceId) ?? new Set<string>();
  if (set.has(op)) return false;
  set.add(op);
  ops.set(instanceId, set);
  notify();
  return true;
}

/** 작업 종료. 시작할 때 쓴 호스트 id 를 그대로 넘긴다(지금 보고 있는 호스트가 아니라). */
export function finishInstanceOp(instanceId: string, op: string): void {
  const set = ops.get(instanceId);
  if (!set || !set.delete(op)) return;
  if (set.size === 0) ops.delete(instanceId);
  notify();
}

/** 이 호스트에서 진행 중인 작업들. 다른 호스트의 작업은 절대 섞이지 않는다. */
export function useInstanceOps(instanceId: string): ReadonlySet<string> {
  useSyncExternalStore(subscribe, () => version, () => version);
  return ops.get(instanceId) ?? EMPTY;
}

/** 작업 키 — 화면 곳곳에서 같은 문자열을 쓰도록 한 곳에 둔다. */
export const INSTANCE_OP = {
  restart: 'restart_manager',
  restartAll: 'restart_all_agents',
  updateManager: 'update_manager',
  refreshModels: 'refresh_available_models',
  updateAllClis: 'update_all_clis',
  /** 설치본 단위. 같은 호스트의 다른 설치본은 동시에 올릴 수 있다. */
  updateCli: (installKey: string) => `update_cli:${installKey}`,
  /** ACP 어댑터 단위(cli). */
  updateAdapter: (cli: string) => `update_acp_adapter:${cli}`,
} as const;

const UPDATE_CLI_PREFIX = 'update_cli:';

/** 진행 중인 설치본 키 집합(`InstalledCliVersions` 의 `pending`). */
export function pendingInstallKeys(active: ReadonlySet<string>): ReadonlySet<string> {
  const out = new Set<string>();
  for (const op of active) {
    if (op.startsWith(UPDATE_CLI_PREFIX)) out.add(op.slice(UPDATE_CLI_PREFIX.length));
  }
  return out;
}

const UPDATE_ADAPTER_PREFIX = 'update_acp_adapter:';

/** 올리는 중인 ACP 어댑터(cli) 집합. */
export function pendingAdapterClis(active: ReadonlySet<string>): ReadonlySet<string> {
  const out = new Set<string>();
  for (const op of active) {
    if (op.startsWith(UPDATE_ADAPTER_PREFIX)) out.add(op.slice(UPDATE_ADAPTER_PREFIX.length));
  }
  return out;
}

/** 테스트용 — 스토어를 비운다. */
export function resetInstanceOpsStore(): void {
  ops.clear();
  notify();
}
