// 서비스 밖에서 돌고 있는 매니저를 서비스로 되돌린다.
//
// 예전 업데이트·재기동은 새 매니저를 분리(detached) 자식으로 띄웠다. 그 프로세스는 이 홈의
// 서비스(launchd 작업 · 예약 작업) 밖이라
//   - 서비스가 따로 띄운 프로세스가 그 락에 막혀 exit 2 를 반복했고(MacBook.VX 10초마다,
//     PC.VX 1분마다 — 서버 오류 로그가 하루 수천 건),
//   - 그 프로세스가 죽으면 다음 로그온까지 아무도 다시 띄우지 않는다(PC.VX kakaovx 매니저).
// 재기동 경로는 이제 서비스로 띄우지만(self-update.ts reExecManager), 고친 빌드로 처음 올라가는
// 업데이트는 **옛 빌드의** 재기동 경로를 탄다 — 그래서 첫 업데이트 뒤의 프로세스는 여전히 서비스
// 밖이다. 그 프로세스가 스스로 알아차리고 서비스로 한 번 넘겨 준다.
//
// 넘기는 판정은 "이 홈의 서비스가 있고, 그 서비스의 프로세스가 내가 아니라고 **확인됐다**" 일 때만
// 한다(판별하지 못하면 넘기지 않는다). 판정이 틀려도 재시작이 반복되지 않도록 한 번 넘긴 뒤
// HANDBACK_MIN_INTERVAL_MS 동안은 다시 넘기지 않는다.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { AGENT_MANAGER_HOME } from './constants.js';
import { detectServiceSupervision, type ServiceSupervision } from './service-supervision.js';

export const HANDBACK_MIN_INTERVAL_MS = 6 * 60 * 60_000;
const HANDBACK_FILE = 'service-handback.json';

export type HandbackDecision =
  | { action: 'none'; reason: 'no_service' | 'service_process' | 'unknown' }
  | { action: 'wait'; reason: 'recent'; detail: string }
  | { action: 'handback'; detail: string };

export function decideServiceHandback(input: {
  supervision: ServiceSupervision | null;
  lastHandbackAtMs: number | null;
  nowMs: number;
  minIntervalMs?: number;
}): HandbackDecision {
  const sup = input.supervision;
  if (!sup) return { action: 'none', reason: 'no_service' };
  if (sup.isServiceProcess === true) return { action: 'none', reason: 'service_process' };
  if (sup.isServiceProcess === null) return { action: 'none', reason: 'unknown' };
  const what = `${sup.kind === 'task' ? 'scheduled task' : 'launchd job'} ${sup.name}`;
  const min = input.minIntervalMs ?? HANDBACK_MIN_INTERVAL_MS;
  if (input.lastHandbackAtMs !== null && input.nowMs - input.lastHandbackAtMs < min) {
    return {
      action: 'wait',
      reason: 'recent',
      detail:
        `this manager runs outside its ${what}, but it was already handed back ` +
        `${Math.round((input.nowMs - input.lastHandbackAtMs) / 60_000)}min ago — not bouncing again`,
    };
  }
  return {
    action: 'handback',
    detail:
      `this manager runs outside its ${what} (started by an updater or by hand), so the service keeps ` +
      `failing to start its own copy — restarting through the service so it stays supervised`,
  };
}

function handbackPath(home: string): string {
  return join(home, HANDBACK_FILE);
}

export function readLastHandbackAt(home: string): number | null {
  try {
    const raw = JSON.parse(readFileSync(handbackPath(home), 'utf8'));
    return Number.isFinite(Number(raw?.at_ms)) ? Number(raw.at_ms) : null;
  } catch {
    return null;
  }
}

/** 서비스 밖이면 서비스로 넘긴다. 무엇을 했는지 돌려준다. */
export async function runServiceHandbackIfStray(opts: {
  log: (msg: string) => void;
  restart: () => Promise<{ summary: string }>;
  home?: string;
  nowMs?: number;
  supervision?: ServiceSupervision | null;
}): Promise<HandbackDecision> {
  const home = opts.home ?? AGENT_MANAGER_HOME;
  const nowMs = opts.nowMs ?? Date.now();
  const supervision = opts.supervision !== undefined ? opts.supervision : detectServiceSupervision();
  const decision = decideServiceHandback({ supervision, lastHandbackAtMs: readLastHandbackAt(home), nowMs });
  if (decision.action === 'none') return decision;
  opts.log(`Service: ${decision.detail}`);
  if (decision.action !== 'handback') return decision;
  try {
    writeFileSync(handbackPath(home), `${JSON.stringify({ at_ms: nowMs, pid: process.pid })}\n`, 'utf8');
  } catch {
    // 기록을 못 남기면 반복을 막을 수 없다 — 넘기지 않는다.
    opts.log('Service: could not record the hand-back — staying outside the service rather than risk a restart loop');
    return { action: 'none', reason: 'unknown' };
  }
  const result = await opts.restart();
  opts.log(`Service: ${result.summary}`);
  return decision;
}
