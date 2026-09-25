// Runtime Host 별 CLI 모델 목록 — 모델이 보이는 모든 화면이 쓰는 하나의 스토어.
//
// 원칙: 모델 dropdown 은 **항상 최신이거나, 그 자리에서 새로고침할 수 있다.**
//   - 읽기는 `GET /api/agent-manager/hosts/:id/models`(하트비트 스냅샷).
//   - 갱신은 `POST …/models/refresh` — 서버가 호스트에 재열거를 시키고 ack 까지 기다린
//     뒤 새 목록을 돌려주므로 브라우저는 폴링하지 않는다.
//   - 훅이 마운트될 때 목록이 비었거나(host×cli 당 한 번만 시도 — 모델 개념이 없는 CLI
//     를 매번 두드리지 않는다) 마지막 재열거가 STALE_MS 보다 오래됐으면 조용히 갱신한다.
//   - 명시적 새로고침 버튼은 같은 `refresh()` 를 부른다.
//
// 예전에는 Agent 다이얼로그 / 팀 슬롯 / 세션 설정이 각자 다른 경로로 읽고, 세션 설정은
// 세션을 한 번 열어야만 목록이 바뀌었다. 호스트에 provider 를 새로 로그인해도 어떤 화면은
// 알고 어떤 화면은 몰랐다.

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { AgentSessionConfigOption } from '../types';

export interface HostModelsView {
  manager_agent_id: string;
  manager_name: string;
  is_online: boolean;
  instance_id: string | null;
  refreshed_at: string | null;
  models: Record<string, string[]>;
}

/** 이보다 오래된 재열거 결과는 화면이 열릴 때 조용히 다시 받는다. */
export const HOST_MODELS_STALE_MS = 10 * 60 * 1000;

interface HostEntry {
  view: HostModelsView | null;
  loadedAt: number;
  loading: Promise<HostModelsView | null> | null;
  refreshing: Promise<HostModelsView | null> | null;
  /** 이 페이지 로드에서 빈 목록 자동 프로브를 이미 시도한 cli. */
  probed: Set<string>;
  /** 이 페이지 로드에서 마지막으로 재열거를 시킨 시각 — 시각을 안 싣는 구버전 매니저를 매 마운트마다 두드리지 않기 위한 하한. */
  lastRefreshAt: number;
  error: string | null;
}

const entries = new Map<string, HostEntry>();
const listeners = new Set<() => void>();
let version = 0;

function entry(id: string): HostEntry {
  let e = entries.get(id);
  if (!e) {
    e = { view: null, loadedAt: 0, loading: null, refreshing: null, probed: new Set(), lastRefreshAt: 0, error: null };
    entries.set(id, e);
  }
  return e;
}

function notify(): void {
  version += 1;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// `api.ts` 를 모듈 평가 시점에 끌어오지 않는다(catalog.ts 와 같은 이유 — 테스트가
// 스토어만 따로 쓸 수 있어야 한다).
async function apiModule() {
  return (await import('../api')).api;
}

/** 스냅샷을 (다시) 읽는다. 진행 중이면 그 약속을 공유한다. */
export function loadHostModels(managerAgentId: string): Promise<HostModelsView | null> {
  const e = entry(managerAgentId);
  if (e.loading) return e.loading;
  e.loading = apiModule()
    .then((api) => api.getHostModels(managerAgentId))
    .then((view) => {
      e.view = view;
      e.loadedAt = Date.now();
      e.error = null;
      return view;
    })
    .catch((err: any) => {
      e.error = err?.message || String(err);
      return e.view;
    })
    .finally(() => {
      e.loading = null;
      notify();
    });
  notify();
  return e.loading;
}

/** 호스트에 재열거를 시킨다. 진행 중이면 그 약속을 공유한다(버튼 연타·여러 화면 동시 마운트). */
export function refreshHostModels(managerAgentId: string): Promise<HostModelsView | null> {
  const e = entry(managerAgentId);
  if (e.refreshing) return e.refreshing;
  e.lastRefreshAt = Date.now();
  e.refreshing = apiModule()
    .then((api) => api.refreshHostModels(managerAgentId))
    .then((view) => {
      e.view = view;
      e.loadedAt = Date.now();
      e.error = null;
      return view;
    })
    .catch((err: any) => {
      e.error = err?.message || String(err);
      return e.view;
    })
    .finally(() => {
      e.refreshing = null;
      notify();
    });
  notify();
  return e.refreshing;
}

/** 스토어의 현재 값(동기). 모르는 호스트/CLI 는 빈 배열. */
export function hostModelsFor(managerAgentId: string | null | undefined, cli: string | null | undefined): string[] {
  if (!managerAgentId || !cli) return [];
  const list = entries.get(managerAgentId)?.view?.models[cli];
  return Array.isArray(list) ? list : [];
}

/** 하트비트가 남긴 재열거 시각 기준으로 오래됐는가. 시각이 없으면(구버전 매니저) 오래된 것으로 본다. */
export function isHostModelsStale(view: HostModelsView | null, now = Date.now()): boolean {
  if (!view) return true;
  if (!view.refreshed_at) return true;
  const at = Date.parse(view.refreshed_at);
  return !Number.isFinite(at) || now - at > HOST_MODELS_STALE_MS;
}

/** 테스트용 — 스토어를 비운다. */
export function resetHostModelsStore(): void {
  entries.clear();
  notify();
}

/** 다른 경로(예: 인스턴스 목록)에서 이미 받은 목록을 스토어에 밀어 넣는다 — 첫 렌더가 비지 않게. */
export function seedHostModels(managerAgentId: string, models: Record<string, string[]>, refreshedAt: string | null = null): void {
  const e = entry(managerAgentId);
  if (e.view) return;
  e.view = { manager_agent_id: managerAgentId, manager_name: '', is_online: true, instance_id: null, refreshed_at: refreshedAt, models };
  e.loadedAt = Date.now();
  notify();
}

export interface UseHostModelsResult {
  /** 이 host×cli 의 모델 id. 비었으면 자유 입력으로 떨어진다. */
  models: string[];
  view: HostModelsView | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refresh: () => Promise<HostModelsView | null>;
}

/**
 * 한 host×cli 의 모델 목록. `auto`(기본 true)면 마운트 시 스냅샷을 읽고, 목록이 비었거나
 * 오래됐으면 조용히 재열거까지 시킨다. 온라인이 아닌 호스트에는 재열거를 보내지 않는다.
 */
export function useHostModels(
  managerAgentId: string | null | undefined,
  cli: string | null | undefined,
  options: { auto?: boolean } = {},
): UseHostModelsResult {
  const auto = options.auto !== false;
  useSyncExternalStore(subscribe, () => version, () => version);
  const e = managerAgentId ? entries.get(managerAgentId) ?? null : null;
  const view = e?.view ?? null;
  const models = hostModelsFor(managerAgentId, cli);

  useEffect(() => {
    if (!auto || !managerAgentId) return;
    let cancelled = false;
    void (async () => {
      const current = entry(managerAgentId);
      const snapshot = current.view && Date.now() - current.loadedAt < HOST_MODELS_STALE_MS
        ? current.view
        : await loadHostModels(managerAgentId);
      if (cancelled || !snapshot || !snapshot.is_online) return;
      const empty = !!cli && (snapshot.models[cli] ?? []).length === 0;
      const stale = isHostModelsStale(snapshot) && Date.now() - current.lastRefreshAt > HOST_MODELS_STALE_MS;
      if (empty && cli && !current.probed.has(cli)) {
        current.probed.add(cli);
        void refreshHostModels(managerAgentId);
      } else if (stale) {
        void refreshHostModels(managerAgentId);
      }
    })();
    return () => { cancelled = true; };
  }, [auto, managerAgentId, cli]);

  const refresh = useCallback(
    () => (managerAgentId ? refreshHostModels(managerAgentId) : Promise.resolve(null)),
    [managerAgentId],
  );

  return {
    models,
    view,
    loading: !!e?.loading,
    refreshing: !!e?.refreshing,
    error: e?.error ?? null,
    refresh,
  };
}

/** cli → 모델 수 요약("claude=12, codex=8"). 토스트용. */
export function summarizeHostModels(view: HostModelsView | null): string {
  return Object.entries(view?.models ?? {})
    .map(([cli, list]) => `${cli}=${list.length}`)
    .sort()
    .join(', ');
}

/**
 * 세션 설정/새 세션의 선택지에 호스트 모델 목록을 합친다. ACP 가 보고한 `model` 옵션이
 * 있으면 그 표시 이름·현재값을 그대로 두고 호스트만 아는 id 를 덧붙이고, 없으면 옵션을
 * 합성한다(서버 `withModelFallback` 과 같은 규칙 — 클라이언트는 방금 새로고침한 값을 서버
 * 왕복 없이 바로 반영하기 위해 같은 병합을 한 번 더 한다).
 */
export function withHostModelOption(
  options: AgentSessionConfigOption[],
  models: string[],
): AgentSessionConfigOption[] {
  if (!models.length) return options;
  const idx = options.findIndex((o) => o.category === 'model');
  if (idx === -1) {
    return [
      ...options,
      {
        config_id: 'model',
        name: 'Model',
        description: 'Reported by this Runtime Host; the session may refine the list once it opens.',
        category: 'model',
        type: 'select',
        current_value: null,
        options: models.map((value) => ({ value, name: value })),
      },
    ];
  }
  const existing = options[idx];
  const known = new Set(existing.options.map((o) => o.value));
  const extra = models.filter((m) => !known.has(m)).map((value) => ({ value, name: value }));
  if (!extra.length) return options;
  return options.map((o, i) => (i === idx ? { ...o, options: [...o.options, ...extra] } : o));
}
