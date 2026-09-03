// 자가 업데이트의 "설치 후 부팅 검증 → 실패 시 이전 버전 복귀·핀" 경로와
// 그 재시도 상한 (ticket 23753dc7 — 출처 정책 C·G).
//
// 여기까지 없던 것: 설치가 *실패*했을 때 디스크에 남은 이전 빌드가 되살아나는
// 경로는 이미 있었지만(self-update.ts 의 npm-global 헬퍼), **설치가 성공한 뒤
// 새 빌드가 부팅에서 죽는 경우**를 되돌릴 장치는 없었다. 그 조합은 나쁜 빌드
// 하나가 호스트를 통째로 정지시킬 수 있다는 뜻이다.
//
// ── 왜 상태를 파일에 적는가 (회피 가능한 구현 디테일이 아니다) ──────────────
// Windows 경로에서 `runNpmGlobalSelfUpdate` 는 분리(detached) 헬퍼를 띄우고
// 부모가 **먼저 종료한 뒤에** 헬퍼가 설치한다. 부모는 설치 결과를 볼 수 없고,
// 헬퍼는 결과와 무관하게 매니저를 재기동한 뒤 자신을 지운다. 되살아난 프로세스는
// 이전 시도가 있었다는 사실 자체를 모른다. 메모리 카운터로 상한을 세면 매번
// 0부터 다시 세게 되어, 상한은 코드에만 존재하고 실제 동작은 무한 재시도가 된다.
// (POSIX 경로는 설치를 인-프로세스로 돌아 결과를 직접 알지만, 재기동을 넘겨
//  세야 하는 것은 마찬가지다.)
//
// ── 왜 감시자가 "다음 부팅"인가 ────────────────────────────────────────────
// 외부 감시 프로세스를 쓸 수 없기 때문이다. systemd 유닛의 기본
// KillMode=control-group 때문에 매니저가 분리해 띄운 헬퍼는 부모가 죽을 때 같은
// cgroup teardown 에 휩쓸려 함께 죽는다(self-update.ts 의 reExecManager 주석에
// 실측 증상까지 적혀 있다). 즉 재기동을 넘어 살아남는 감시자를 systemd 위에서는
// 만들 수 없다. 그래서 판정은 "다음 부팅이 상태 파일을 읽고 스스로 내린다"는
// 형태여야 하고, 상태 파일이 곧 재시작을 건너 전달되는 유일한 채널이다.
//
// 판정을 전부 순수 함수로 뽑아둔 이유: 실제 복귀 경로는 "새 빌드가 부팅에서
// 죽는다"는 상황에서만 돌기 때문에, 파이프라인 전체를 태우는 통합 테스트로는
// 분기를 재현할 수 없다. 상태 전이와 상한 판정을 여기 모아 직접 단위 테스트하고,
// self-update.ts 는 배선만 한다.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AGENT_MANAGER_HOME } from './constants.js';

/** 부팅 검증 상태 파일 이름. 매니저 홈에 둔다(재기동을 넘어 살아남아야 한다). */
const BOOT_STATE_FILE = 'self-update-boot.json';
/** 복귀 핀 파일 이름. 같은 나쁜 버전을 즉시 다시 집지 않게 하는 하드 핀. */
const PIN_FILE = 'self-update-pin.json';

/**
 * 한 버전에 대해 허용하는 총 설치 시도 횟수 (최초 1회 + 추가 2회 = 3).
 * 정책 G: "한 버전에서 누적 3회 실패하면 그 버전을 실패로 표시하고 자동 시도를
 * 멈춘다."
 */
export const MAX_INSTALL_ATTEMPTS = 3;

/**
 * 설치 실패 후 다음 재시도까지의 백오프. 정책 G 가 지정한 5분 → 15분 그대로.
 * 배열 길이가 곧 "추가 시도" 횟수라 MAX_INSTALL_ATTEMPTS 와 함께 움직인다.
 */
export const INSTALL_RETRY_BACKOFFS_MS: readonly number[] = [5 * 60_000, 15 * 60_000];

/**
 * 새 빌드가 부팅해서 하트비트 1회 성공을 낼 때까지 기다리는 상한.
 * 하트비트는 30초 주기(HEARTBEAT_INTERVAL_MS)이므로 20회의 기회에 해당한다.
 *
 * 이 상한이 필요한 이유는 "죽지도 않고 하트비트도 못 내는" 빌드 때문이다.
 * 재기동 기반 판정(아래 evaluateBootVerification)만 두면 그런 프로세스의 상태
 * 기록이 영원히 남아, 며칠 뒤 운영자가 무관하게 재시작했을 때 그제서야 복귀가
 * 튀어나오는 지뢰가 된다. 상한을 두면 상태가 반드시 유한 시간 안에 종결된다.
 *
 * 알려진 대가: 새 버전 설치 직후 이 창 안에서 AWB 서버가 통째로 10분 이상
 * 안 보이면 멀쩡한 빌드도 부팅 실패로 판정돼 downgrade + 핀이 걸린다. 매니저
 * 쪽에서 "서버가 죽었다"와 "내 빌드가 고장났다"를 구분할 방법이 없어서 생기는
 * 비용이며, 정책 C 가 "하트비트 1회 성공"을 판정 기준으로 못박은 결과다.
 * 핀은 사람만 풀 수 있으므로 오탐이 나도 운영자가 반드시 보게 된다.
 */
export const BOOT_VERIFY_TIMEOUT_MS = 10 * 60_000;

/** 복귀 설치 자체를 몇 번까지 다시 시도할지. 정책 G: 무한 재시도는 없다. */
export const MAX_ROLLBACK_ATTEMPTS = 2;

/**
 * 상태 파일의 단계.
 *   - `installing`      설치를 개시했고 결과를 아직 모른다. 이 상태로 부팅하면서
 *                       *이전* 버전을 돌고 있으면 그것이 곧 설치 실패의 관측이다
 *                       (Windows 헬퍼 경로에서 부모는 결과를 볼 수 없다).
 *   - `install_failed`  설치 실패를 이미 한 번 세었다. 백오프 대기 중.
 *   - `install_blocked` 이 버전은 설치 실패 누적 상한을 넘겨 자동 시도를 멈췄다.
 *   - `awaiting_boot`   설치 성공. 새 빌드의 하트비트 1회 성공을 기다린다.
 *   - `rolling_back`    복귀 설치를 개시했다.
 */
export type BootVerificationPhase =
  | 'installing'
  | 'install_failed'
  | 'install_blocked'
  | 'awaiting_boot'
  | 'rolling_back';

export interface BootVerificationRecord {
  phase: BootVerificationPhase;
  /** 설치 전에 돌고 있던 버전 — 복귀 대상이다. */
  previousVersion: string;
  /** 설치하려던(또는 설치된) 새 버전. */
  targetVersion: string;
  /** 새 빌드로 부팅을 시도한 횟수. 첫 부팅에서 1이 된다. */
  bootAttempts: number;
  /** 이 targetVersion 에 대해 누적된 설치 실패 횟수. */
  installFailures: number;
  /** 마지막 설치 실패 시각(Unix ms). 아직 실패가 없으면 null. */
  lastInstallFailureAtMs: number | null;
  /** 복귀 설치를 시도한 횟수. */
  rollbackAttempts: number;
  /** 자동 시도를 멈춘 사유. 운영자가 왜 멈췄는지 알 수 있어야 한다. */
  reason: string;
  updatedAtMs: number;
}

/**
 * 복귀 핀. 이 파일이 있으면 자동 업데이트는 이 버전 밖으로 나가지 않는다.
 *
 * **해제는 사람만 한다** — 이 모듈은 핀을 쓰기만 하고 어디서도 지우지 않는다.
 * 자동 해제 경로를 만들면 "복귀 → 해제 → 같은 나쁜 버전 재설치 → 복귀" 루프가
 * 그대로 되살아나기 때문이다(정책 G). 운영자의 해제 수단은 파일 삭제다.
 */
export interface UpdatePinRecord {
  version: string;
  reason: string;
  pinnedAtMs: number;
}

/** 부팅 검증 상태 파일 경로. 테스트는 dir 을 직접 넘겨 격리한다. */
export function bootStatePath(dir: string = AGENT_MANAGER_HOME): string {
  return join(dir, BOOT_STATE_FILE);
}

/** 복귀 핀 파일 경로. 테스트는 dir 을 직접 넘겨 격리한다. */
export function updatePinPath(dir: string = AGENT_MANAGER_HOME): string {
  return join(dir, PIN_FILE);
}

function readJsonFile(path: string): any {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // 손상된 상태 파일은 "상태 없음"과 같이 다룬다. 여기서 던지면 부팅 자체가
    // 막혀, 나쁜 빌드를 되돌리려던 장치가 되레 매니저를 못 뜨게 만든다.
    return null;
  }
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const KNOWN_PHASES: readonly BootVerificationPhase[] = [
  'installing',
  'install_failed',
  'install_blocked',
  'awaiting_boot',
  'rolling_back',
];

/**
 * 상태 파일을 읽어 정규화한다. 모양이 조금이라도 어긋나면 null 을 돌려 "상태
 * 없음"으로 떨어뜨린다 — 알 수 없는 기록을 근거로 복귀를 실행하는 것보다
 * 아무것도 안 하는 쪽이 안전한 실패 방향이다.
 */
export function readBootVerificationRecord(
  dir: string = AGENT_MANAGER_HOME,
): BootVerificationRecord | null {
  const raw = readJsonFile(bootStatePath(dir));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const phase = String(raw.phase ?? '') as BootVerificationPhase;
  if (!KNOWN_PHASES.includes(phase)) return null;
  const previousVersion = typeof raw.previousVersion === 'string' ? raw.previousVersion : '';
  const targetVersion = typeof raw.targetVersion === 'string' ? raw.targetVersion : '';
  if (!previousVersion || !targetVersion) return null;
  const int = (v: unknown): number => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
  return {
    phase,
    previousVersion,
    targetVersion,
    bootAttempts: int(raw.bootAttempts),
    installFailures: int(raw.installFailures),
    lastInstallFailureAtMs:
      raw.lastInstallFailureAtMs === null || raw.lastInstallFailureAtMs === undefined
        ? null
        : int(raw.lastInstallFailureAtMs),
    rollbackAttempts: int(raw.rollbackAttempts),
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    updatedAtMs: int(raw.updatedAtMs),
  };
}

export function writeBootVerificationRecord(
  record: BootVerificationRecord,
  dir: string = AGENT_MANAGER_HOME,
): void {
  writeJsonFile(bootStatePath(dir), record);
}

/**
 * 상태 파일을 지운다. 부팅 검증이 성공했거나(하트비트 1회 성공) 판정이 종결된
 * 뒤에만 부른다. **핀은 건드리지 않는다** — 핀 해제는 사람 몫이다.
 */
export function clearBootVerificationRecord(dir: string = AGENT_MANAGER_HOME): void {
  const path = bootStatePath(dir);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* 이미 없거나 지울 수 없다 — 다음 판정이 stale 로 처리한다 */
  }
}

/** 설치 개시 직전의 초기 기록을 만든다. */
export function newInstallRecord(input: {
  previousVersion: string;
  targetVersion: string;
  nowMs: number;
  /** 같은 targetVersion 에 대한 이전 기록이 있으면 카운터를 이어받는다. */
  carryFrom?: BootVerificationRecord | null;
}): BootVerificationRecord {
  const carry =
    input.carryFrom && input.carryFrom.targetVersion === input.targetVersion
      ? input.carryFrom
      : null;
  return {
    phase: 'installing',
    previousVersion: input.previousVersion,
    targetVersion: input.targetVersion,
    // 새 설치 시도이므로 부팅 카운터는 항상 0에서 시작한다.
    bootAttempts: 0,
    installFailures: carry?.installFailures ?? 0,
    lastInstallFailureAtMs: carry?.lastInstallFailureAtMs ?? null,
    rollbackAttempts: carry?.rollbackAttempts ?? 0,
    reason: '',
    updatedAtMs: input.nowMs,
  };
}

/**
 * 설치 실패를 한 번 센 새 기록. 상한에 도달하면 `install_blocked` 로 전이해
 * 자동 시도를 멈추고 사유를 남긴다(정책 G: "그 버전을 실패로 표시").
 *
 * 순수 함수 — 호출부가 결과를 writeBootVerificationRecord 로 영속화한다. 상태
 * 전이와 파일 I/O 를 분리해 둬야 전이 규칙만 따로 단언할 수 있다.
 */
export function withInstallFailure(
  record: BootVerificationRecord,
  nowMs: number,
  detail: string,
  maxAttempts: number = MAX_INSTALL_ATTEMPTS,
): BootVerificationRecord {
  const installFailures = record.installFailures + 1;
  const blocked = installFailures >= maxAttempts;
  return {
    ...record,
    phase: blocked ? 'install_blocked' : 'install_failed',
    installFailures,
    lastInstallFailureAtMs: nowMs,
    reason: blocked
      ? `v${record.targetVersion} failed to install ${installFailures} time(s) — automatic attempts stopped: ${detail}`
      : `v${record.targetVersion} install attempt ${installFailures} failed: ${detail}`,
    updatedAtMs: nowMs,
  };
}

/** 설치 성공 — 하트비트 1회 성공을 기다리는 상태로 전이한다. */
export function withAwaitingBoot(
  record: BootVerificationRecord,
  nowMs: number,
): BootVerificationRecord {
  return { ...record, phase: 'awaiting_boot', bootAttempts: 0, updatedAtMs: nowMs };
}

/**
 * 새 빌드로 부팅을 한 번 더 시도했다고 표시한다.
 *
 * phase 를 `awaiting_boot` 로 **정규화**한다: 무장은 `installing` /
 * `install_failed` 기록에서도 일어날 수 있는데(설치가 뒤늦게 반영된 경우),
 * 그때 phase 를 그대로 두면 하트비트가 성공해도 markBootVerified 가 그 기록을
 * 자기 소관으로 보지 않아 상태 파일이 영원히 남는다. 그렇게 남은 기록은 며칠 뒤
 * 무관한 재시작에서 복귀가 튀어나오는 지뢰가 된다. 설치 실패 카운터는 그대로
 * 실려 가므로 상한은 영향을 받지 않는다.
 */
export function withBootAttempt(
  record: BootVerificationRecord,
  nowMs: number,
): BootVerificationRecord {
  return {
    ...record,
    phase: 'awaiting_boot',
    bootAttempts: record.bootAttempts + 1,
    updatedAtMs: nowMs,
  };
}

/** 복귀 설치를 개시했다고 표시한다. */
export function withRollbackAttempt(
  record: BootVerificationRecord,
  nowMs: number,
  detail: string,
): BootVerificationRecord {
  return {
    ...record,
    phase: 'rolling_back',
    rollbackAttempts: record.rollbackAttempts + 1,
    reason: detail,
    updatedAtMs: nowMs,
  };
}

/** 복귀 핀을 읽는다. 없거나 모양이 어긋나면 null. */
export function readUpdatePin(dir: string = AGENT_MANAGER_HOME): UpdatePinRecord | null {
  const raw = readJsonFile(updatePinPath(dir));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const version = typeof raw.version === 'string' ? raw.version.trim() : '';
  if (!/^\d+\.\d+\.\d+/.test(version)) return null;
  return {
    version,
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    pinnedAtMs: Number.isFinite(Number(raw.pinnedAtMs)) ? Math.trunc(Number(raw.pinnedAtMs)) : 0,
  };
}

/**
 * 복귀 핀을 기록한다. 이 모듈에 핀을 *지우는* 함수는 일부러 없다 — 정책 G 의
 * "핀 해제는 사람만 한다"를 코드 구조로 지킨다.
 */
export function writeUpdatePin(pin: UpdatePinRecord, dir: string = AGENT_MANAGER_HOME): void {
  writeJsonFile(updatePinPath(dir), pin);
}

/** 유지보수 창을 지정하는 환경변수. `HH:MM-HH:MM`(호스트 로컬 시각). */
export const UPDATE_WINDOW_ENV = 'AWB_AGENT_MANAGER_UPDATE_WINDOW';

export interface MaintenanceWindow {
  /** 자정 기준 시작 분(0-1439). */
  startMinute: number;
  /** 자정 기준 종료 분(0-1439). start 보다 작으면 자정을 넘는 창이다. */
  endMinute: number;
}

/**
 * `HH:MM-HH:MM` 를 파싱한다. 형식이 어긋나면 null — 그 경우 호출부는 "창 없음"
 * 으로 다루어 현행 동작(항상 창 안)을 유지한다. 잘못 적은 값 때문에 재시도가
 * 영영 막히는 쪽이 더 나쁘기 때문이다.
 */
export function parseMaintenanceWindow(raw?: string | null): MaintenanceWindow | null {
  const v = String(raw ?? '').trim();
  if (!v) return null;
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const toMinute = (h: string, min: string): number | null => {
    const hh = Number(h);
    const mm = Number(min);
    if (!Number.isInteger(hh) || !Number.isInteger(mm)) return null;
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
    return hh * 60 + mm;
  };
  const startMinute = toMinute(m[1], m[2]);
  const endMinute = toMinute(m[3], m[4]);
  if (startMinute === null || endMinute === null) return null;
  // 시작과 끝이 같으면 폭이 0인 창이다 — 아무 때도 열리지 않는 창을 만드는 것은
  // 오타일 가능성이 높으므로 "창 없음"으로 떨어뜨린다.
  if (startMinute === endMinute) return null;
  return { startMinute, endMinute };
}

/**
 * 지금이 창 안인가. 창이 null 이면 **항상 true** — 창을 설정하지 않은 호스트의
 * 동작이 이 기능 도입 전과 같아야 한다.
 *
 * 자정을 넘는 창(`22:00-02:00`)도 지원한다: end < start 이면 두 구간의 합집합.
 */
export function isWithinMaintenanceWindow(now: Date, window: MaintenanceWindow | null): boolean {
  if (!window) return true;
  const minute = now.getHours() * 60 + now.getMinutes();
  const { startMinute, endMinute } = window;
  return startMinute < endMinute
    ? minute >= startMinute && minute < endMinute
    : minute >= startMinute || minute < endMinute;
}

/**
 * 환경변수에서 창을 읽어 지금이 창 안인지 판정한다. 프로덕션 호출부가 쓰는
 * 진입점 — 순수 함수 두 개를 조합하기만 한다.
 */
export function withinMaintenanceWindowNow(
  now: Date = new Date(),
  raw: string | null | undefined = process.env[UPDATE_WINDOW_ENV],
): boolean {
  return isWithinMaintenanceWindow(now, parseMaintenanceWindow(raw));
}

/** evaluateBootVerification 이 내리는 판정의 종류. */
export type BootDecisionKind =
  /** 검증 대기 중인 업데이트가 없다 — 평소 부팅. */
  | 'none'
  /** 새 빌드의 첫 부팅 — 하트비트 1회 성공을 기다린다. */
  | 'arm'
  /** 설치가 반영되지 않은 채 이전 빌드가 되살아났다 — 설치 실패로 센다. */
  | 'install_failed'
  /** 부팅 실패 확정 — 이전 버전으로 되돌린다. */
  | 'rollback'
  /** 이미 이전 버전을 돌고 있다 — 재설치 없이 핀만 건다. */
  | 'pin_only'
  /** 복귀 설치가 반영됐다 — 핀을 확정하고 기록을 지운다. */
  | 'rollback_landed'
  /** 복귀 설치가 상한까지 반영되지 않았다 — 핀만 남기고 자동 시도를 멈춘다. */
  | 'rollback_failed'
  /** 기록이 현재 버전 어느 쪽과도 맞지 않는다 — 기록을 버린다. */
  | 'stale';

export interface BootDecision {
  kind: BootDecisionKind;
  /** 복귀·핀 대상 버전. 해당 없는 판정에서는 null. */
  rollbackToVersion: string | null;
  /** `Self-update:` 접두사를 붙여 남길 한 줄. 남길 것이 없으면 null. */
  summary: string | null;
}

function bootFailureDecision(record: BootVerificationRecord): BootDecision {
  return {
    kind: 'rollback',
    rollbackToVersion: record.previousVersion,
    summary:
      `boot verification failed for v${record.targetVersion} ` +
      `(${record.bootAttempts + 1} boot(s), no successful heartbeat) — ` +
      `rolling back to v${record.previousVersion} and pinning it`,
  };
}

function armDecision(record: BootVerificationRecord): BootDecision {
  return {
    kind: 'arm',
    rollbackToVersion: null,
    summary:
      `verifying boot of v${record.targetVersion} — waiting for one successful heartbeat ` +
      `(rollback target v${record.previousVersion})`,
  };
}

function staleDecision(record: BootVerificationRecord, currentVersion: string): BootDecision {
  return {
    kind: 'stale',
    rollbackToVersion: null,
    summary:
      `discarding stale boot-verification record ` +
      `(recorded v${record.previousVersion}→v${record.targetVersion}, running v${currentVersion})`,
  };
}

/**
 * 부팅 시점 판정 — 상태 파일과 "지금 실제로 돌고 있는 버전"만으로 결론을 낸다.
 *
 * 핵심 불변식: **부팅 실패에는 재시도가 없다.** 같은 targetVersion 으로 두 번째
 * 부팅이 관측되면(=첫 부팅이 하트비트 1회 성공에 도달하지 못하고 사라졌다는
 * 뜻) 그 자리에서 복귀로 간다. 여기에 재시도를 넣는 것은 곧 불량 버전을 다시
 * 설치하는 루프를 만드는 것과 같다(정책 G).
 */
export function evaluateBootVerification(input: {
  record: BootVerificationRecord | null;
  currentVersion: string;
  maxRollbackAttempts?: number;
}): BootDecision {
  const { record, currentVersion } = input;
  const maxRollbackAttempts = input.maxRollbackAttempts ?? MAX_ROLLBACK_ATTEMPTS;
  if (!record) return { kind: 'none', rollbackToVersion: null, summary: null };

  const onTarget = currentVersion === record.targetVersion;
  const onPrevious = currentVersion === record.previousVersion;

  switch (record.phase) {
    // 설치 실패 누적으로 이미 자동 시도를 멈춘 기록이다. 부팅 시점에 할 일은
    // 없고(설치 게이트가 읽는다) 기록도 지우지 않는다 — 지우면 카운터가 리셋돼
    // 상한이 무의미해진다.
    case 'install_blocked':
      return { kind: 'none', rollbackToVersion: null, summary: null };

    case 'install_failed':
      // 실패를 이미 세었는데 정작 새 버전이 돌고 있다면 설치는 사실 반영된
      // 것이다 — 부팅 검증 대상으로 넘긴다.
      if (onTarget) return record.bootAttempts >= 1 ? bootFailureDecision(record) : armDecision(record);
      // 이전 버전을 돌고 있다 = 예상대로다. 재시도 백오프는 설치 게이트가 본다.
      if (onPrevious) return { kind: 'none', rollbackToVersion: null, summary: null };
      return staleDecision(record, currentVersion);

    case 'installing':
      // 새 버전을 돌고 있다면 설치는 성공했고 awaiting_boot 로 표시하기 전에
      // 프로세스가 사라진 것이다 — 부팅 검증 대상으로 취급한다.
      if (onTarget) return record.bootAttempts >= 1 ? bootFailureDecision(record) : armDecision(record);
      // 설치를 개시했는데 이전 버전이 되살아나 있다 = 설치가 반영되지 않았다.
      // Windows 헬퍼 경로에서 부모는 결과를 볼 수 없으므로, 이 관측이 곧
      // 설치 실패를 세는 유일한 지점이다.
      if (onPrevious) {
        return {
          kind: 'install_failed',
          rollbackToVersion: null,
          summary:
            `install of v${record.targetVersion} did not take effect — ` +
            `still running v${record.previousVersion}; counting an install failure`,
        };
      }
      return staleDecision(record, currentVersion);

    case 'awaiting_boot':
      if (onTarget) return record.bootAttempts >= 1 ? bootFailureDecision(record) : armDecision(record);
      // 설치는 성공으로 보고됐는데 정작 이전 버전이 돌고 있다(글로벌 prefix 가
      // 다른 곳으로 설치됐다거나 재기동이 예전 트리를 다시 띄운 경우). 되돌릴
      // 것은 없고, 같은 버전을 다시 집지 않도록 핀만 건다.
      if (onPrevious) {
        return {
          kind: 'pin_only',
          rollbackToVersion: record.previousVersion,
          summary:
            `v${record.targetVersion} was installed but v${record.previousVersion} is running — ` +
            `pinning v${record.previousVersion} without a reinstall`,
        };
      }
      return staleDecision(record, currentVersion);

    case 'rolling_back':
    default:
      if (onPrevious) {
        return {
          kind: 'rollback_landed',
          rollbackToVersion: record.previousVersion,
          summary: `rollback to v${record.previousVersion} landed — channel stays pinned to it`,
        };
      }
      if (onTarget) {
        if (record.rollbackAttempts < maxRollbackAttempts) {
          return {
            kind: 'rollback',
            rollbackToVersion: record.previousVersion,
            summary:
              `rollback to v${record.previousVersion} did not land ` +
              `(attempt ${record.rollbackAttempts} of ${maxRollbackAttempts}) — retrying`,
          };
        }
        return {
          kind: 'rollback_failed',
          rollbackToVersion: record.previousVersion,
          summary:
            `rollback to v${record.previousVersion} failed ${record.rollbackAttempts} time(s) — ` +
            `giving up automatic recovery, still running v${record.targetVersion}; ` +
            `channel stays pinned to v${record.previousVersion} (operator action required)`,
        };
      }
      return staleDecision(record, currentVersion);
  }
}

/**
 * 무장(arm)된 부팅 검증의 진행 판정. 하트비트 1회 성공이 유일한 성공 기준이고,
 * 상한을 넘기면 실패다. 순수 함수라 타이머 없이 양 분기를 직접 단언할 수 있다.
 */
export function evaluateBootProbe(input: {
  heartbeatOk: boolean;
  elapsedMs: number;
  timeoutMs: number;
}): 'verified' | 'waiting' | 'failed' {
  if (input.heartbeatOk) return 'verified';
  return input.elapsedMs >= input.timeoutMs ? 'failed' : 'waiting';
}

export interface InstallRetryDecision {
  /** 지금 설치를 시도해도 되는가. */
  proceed: boolean;
  /** 자동 시도를 완전히 멈춰야 하는가(상한 소진 또는 창 밖). */
  stop: boolean;
  /** 아직 백오프 중일 때 남은 대기 시간(ms). 그 외에는 null. */
  waitMs: number | null;
  /** `Self-update:` 접두사를 붙여 남길 한 줄. 남길 것이 없으면 null. */
  summary: string | null;
}

/**
 * 설치 실패 재시도 게이트 (정책 G). 순수 함수 — evaluateNpmUpdateGate 과 같은
 * 자리에 두고 같은 방식으로 단위 테스트한다.
 *
 * `withinWindow` 는 유지보수 창 안인지 여부를 **입력으로** 받는다. 창 자체를
 * 정의하는 `AWB_AGENT_MANAGER_UPDATE_WINDOW` 는 형제 티켓 T1 의 범위라 여기서
 * 도입하지 않는다. 창이 없는 현행 동작은 호출부가 `true` 를 넘기는 것으로
 * 표현되며(= 항상 창 안), T1 이 실제 창 판정을 붙이면 이 함수는 그대로 쓰인다.
 * "창을 벗어나면 멈춘다"는 규칙 자체는 여기서 구현·테스트된다.
 */
export function evaluateInstallRetryGate(input: {
  installFailures: number;
  lastFailureAtMs: number | null;
  nowMs: number;
  withinWindow: boolean;
  maxAttempts?: number;
  backoffsMs?: readonly number[];
}): InstallRetryDecision {
  const maxAttempts = input.maxAttempts ?? MAX_INSTALL_ATTEMPTS;
  const backoffs = input.backoffsMs ?? INSTALL_RETRY_BACKOFFS_MS;
  const failures = Math.max(0, input.installFailures);

  // 첫 시도는 재시도가 아니다 — 창 판정도 재시도 상한도 걸지 않는다. 그래야
  // 정상 설치 경로의 동작이 그대로 유지된다(완료 기준 6).
  if (failures === 0) {
    return { proceed: true, stop: false, waitMs: null, summary: null };
  }

  if (failures >= maxAttempts) {
    return {
      proceed: false,
      stop: true,
      waitMs: null,
      summary:
        `install retry limit reached (${failures}/${maxAttempts} attempts failed) — ` +
        `this version is marked failed, automatic attempts stopped`,
    };
  }

  // 재시도는 유지보수 창 안에서만 한다. 창을 벗어났으면 남은 시도 횟수가
  // 있어도 멈춘다.
  if (!input.withinWindow) {
    return {
      proceed: false,
      stop: true,
      waitMs: null,
      summary:
        `install retry stopped: outside the maintenance window ` +
        `(${failures}/${maxAttempts} attempts used)`,
    };
  }

  const backoffMs = backoffs[failures - 1] ?? backoffs[backoffs.length - 1] ?? 0;
  const since = input.lastFailureAtMs;
  if (since !== null) {
    const elapsed = input.nowMs - since;
    if (elapsed < backoffMs) {
      const waitMs = backoffMs - elapsed;
      return {
        proceed: false,
        stop: false,
        waitMs,
        summary:
          `install retry backing off ${Math.round(waitMs / 1000)}s more ` +
          `(attempt ${failures + 1} of ${maxAttempts}, backoff ${Math.round(backoffMs / 60_000)}min)`,
      };
    }
  }

  return {
    proceed: true,
    stop: false,
    waitMs: null,
    summary: `install retry ${failures + 1} of ${maxAttempts} (previous attempt failed)`,
  };
}
