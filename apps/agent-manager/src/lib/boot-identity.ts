// 이 호스트의 "부팅 세대"를 식별하는 OS 사실만 다룬다 — lock 의미론은 모른다.
//
// 왜 필요한가: agent-manager 가 전원 차단·하드리셋·SIGKILL 로 죽으면 종료 훅이
// 못 돌아 agent.lock 이 이전 부팅의 pid 를 담은 채 남는다. 재부팅하면 pid 는 낮은
// 번호부터 다시 배분되므로, 부팅 직후 뜬 매니저가 적어 둔 낮은 pid 는 다음 부팅에서
// 거의 확실히 다른 프로세스(대개 root 소유 초기 데몬)가 차지한다 →
// `process.kill(pid, 0)` 이 EPERM 을 던지고, pid liveness 만 보는 판정은 그 유령을
// "살아있는 매니저"로 오인한다. 부팅 세대는 그 둘을 가르는 관측값이다.
//
// 두 층으로 제공한다.
//   1. `id`  — Linux `/proc/sys/kernel/random/boot_id`. 부팅마다 커널이 새로 만드는
//              UUID 라 **확정적 비교**가 가능하다. 다른 플랫폼에서는 null.
//   2. `approxBootTimeMs` — `Date.now() - os.uptime()*1000`. 모든 플랫폼에서 구해지지만
//              같은 부팅 안에서도 clock 조정 때문에 흔들릴 수 있어 tolerance 가 필요하다.

import { readFileSync } from 'node:fs';
import { uptime } from 'node:os';

/** `/proc/<pid>/stat` 의 시간 단위는 커널 CONFIG_HZ 가 아니라 USER_HZ 다. 리눅스는
 *  procfs 로 내보낼 때 USER_HZ 로 환산하며, 통용되는 ABI 에서 100 으로 고정돼 있다.
 *  이 값이 틀린 아키텍처(alpha 등)에서는 환산 결과가 sanity 범위를 벗어나므로
 *  `processStartTimeMs` 가 null 로 degrade 한다 — 틀린 값으로 단정하지 않는다. */
const USER_HZ = 100;

/** 환산한 프로세스 시작 시각이 "부팅 이후 ~ 지금" 을 이 폭 이상 벗어나면 신뢰하지 않는다. */
const PROCESS_START_SANITY_SLACK_MS = 60_000;

export interface BootIdentity {
  /** 부팅마다 재생성되는 커널 UUID. 읽을 수 없는 플랫폼에서는 null. */
  id: string | null;
  /** 부팅 시각(epoch ms) 근사치. 모든 플랫폼에서 구해진다. */
  approxBootTimeMs: number;
}

let cachedBootId: string | null | undefined;

/** Linux 부팅 UUID. 다른 플랫폼이거나 읽을 수 없으면 null.
 *  부팅 중에는 절대 바뀌지 않으므로 프로세스 수명 동안 캐시한다. */
export function readBootId(): string | null {
  if (cachedBootId !== undefined) return cachedBootId;
  try {
    const raw = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    cachedBootId = raw.length > 0 ? raw : null;
  } catch {
    cachedBootId = null;
  }
  return cachedBootId;
}

/** 부팅 시각 근사치. `os.uptime()` 은 리눅스/macOS/Windows 모두 suspend 를 포함한
 *  "시스템 기동 후 경과" 라 sleep 이 값을 흔들지 않는다. 흔드는 것은 부팅 이후의
 *  wall-clock 조정(NTP step)뿐이므로, 이 값을 비교할 때는 반드시 tolerance 를 둔다. */
export function approxBootTimeMs(): number {
  return Date.now() - Math.round(uptime() * 1000);
}

export function currentBootIdentity(): BootIdentity {
  return { id: readBootId(), approxBootTimeMs: approxBootTimeMs() };
}

/** `/proc/<pid>/stat` field 22(starttime) 원본 tick 값. Linux 전용, 그 외 null.
 *
 *  **부팅 기준 단조 값**이라 wall-clock 조정에 면역이다 — 그래서 lock 페이로드에
 *  그대로 적어 두면 "이 pid 가 아직 그때 그 프로세스인가"를 시각 환산 없이
 *  정확히 대조할 수 있다.
 *
 *  field 2(comm)는 괄호 안에 공백·괄호를 담을 수 있으므로 **마지막 ')'** 이후부터
 *  자른다. 그 뒤 첫 토큰이 field 3(state) 이므로 field 22 는 index 19 다. */
export function readProcessStartTicks(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  const tail = stat.slice(stat.lastIndexOf(')') + 1).trim();
  if (!tail) return null;
  const ticks = Number(tail.split(/\s+/)[19]);
  return Number.isFinite(ticks) && ticks >= 0 ? ticks : null;
}

/** starttime tick 을 epoch ms 로 환산한다. 결과가 "부팅 이후 ~ 지금" 범위를 크게
 *  벗어나면(= USER_HZ 가정이나 부팅 시각 근사가 이 호스트에서 안 맞는다는 뜻)
 *  추측하지 않고 null 을 돌려준다 — 틀린 시각으로 stale 을 단정하는 것보다
 *  "모른다"가 안전하다. */
export function processStartTimeMs(
  ticks: number | null,
  bootTimeMs: number,
  nowMs: number = Date.now(),
): number | null {
  if (ticks === null || !Number.isFinite(ticks)) return null;
  const startedAt = bootTimeMs + Math.round((ticks / USER_HZ) * 1000);
  if (startedAt < bootTimeMs - PROCESS_START_SANITY_SLACK_MS) return null;
  if (startedAt > nowMs + PROCESS_START_SANITY_SLACK_MS) return null;
  return startedAt;
}
