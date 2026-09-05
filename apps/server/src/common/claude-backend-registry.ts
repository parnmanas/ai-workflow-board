import { DataSource } from 'typeorm';
import { ClaudeBackendProfile } from '../entities/ClaudeBackendProfile';
import { SystemSetting } from '../entities/SystemSetting';
import {
  CLI_RUNTIME_NONE, CliRuntimeProfile, ClaudeBackendProfileSchema, resolveCliRuntimeProfile,
} from './cli-runtime-profiles';

const CORE_KEYS = new Set(['id', 'name', 'protocol', 'base_url', 'model', 'credential_ref']);
export const CLAUDE_BACKEND_DEFAULT_KEY = 'claude_backend_profiles.default';

export function profileEntityToRuntime(row: ClaudeBackendProfile): CliRuntimeProfile {
  const config = JSON.parse(row.config || '{}');
  return ClaudeBackendProfileSchema.parse({
    ...config,
    id: row.id,
    protocol: row.protocol,
    base_url: row.base_url,
    model: row.model,
    ...(row.credential_ref ? { credential_ref: row.credential_ref } : {}),
  });
}

export function runtimeToProfileEntity(
  runtime: CliRuntimeProfile,
  name: string,
): Pick<ClaudeBackendProfile, 'id' | 'name' | 'protocol' | 'base_url' | 'model' | 'credential_ref' | 'config'> {
  const config = Object.fromEntries(
    Object.entries(runtime).filter(([key]) => !CORE_KEYS.has(key)),
  );
  return {
    id: runtime.id,
    name,
    protocol: runtime.protocol,
    base_url: runtime.base_url,
    model: runtime.model,
    credential_ref: runtime.credential_ref ?? null,
    config: JSON.stringify(config),
  };
}

export function publicProfile(row: ClaudeBackendProfile) {
  const runtime = profileEntityToRuntime(row);
  const { credential_ref: _credential, ...safe } = runtime;
  return {
    ...safe,
    name: row.name,
    credential_status: row.credential_ref ? 'configured' : 'missing',
  };
}

/**
 * Claude backend profile 은 인스턴스 전역 단일 스코프다 — 워크스페이스 배정
 * 계층은 존재하지 않는다(티켓 e616dbfc). 이 함수가 프로필 목록의 유일한
 * 소스이며, 검증·디스패치 해석 양쪽이 같은 목록을 본다.
 */
export async function globalRuntimeProfiles(dataSource: DataSource): Promise<CliRuntimeProfile[]> {
  const rows = await dataSource.getRepository(ClaudeBackendProfile).find();
  return rows.map(profileEntityToRuntime);
}

/**
 * `cli_runtime_profile` 쓰기를 전역 프로필 목록에 대해 검증한다 — REST PATCH
 * 핸들러(agents.controller.ts / boards.controller.ts)가 인라인으로 도는 것과
 * 같은 fail-closed 검사다. `null`/undefined 는 핀을 지운다(= 다시 상속),
 * CLI_RUNTIME_NONE 은 명시적 옵트아웃 sentinel 이라 목록 조회 없이 통과하며,
 * 그 외 값은 전역 프로필 id 와 일치해야 하고 아니면 쓰기를 거부한다.
 */
export async function validateCliRuntimeProfileSelection(
  dataSource: DataSource,
  raw: unknown,
): Promise<{ ok: true; value: string | null } | { ok: false; error: string }> {
  const selected = raw == null ? null : String(raw);
  if (selected && selected !== CLI_RUNTIME_NONE) {
    const profiles = await globalRuntimeProfiles(dataSource);
    if (!profiles.some(profile => profile.id === selected)) {
      return { ok: false, error: `cli_runtime_profile "${selected}" does not exist` };
    }
  }
  return { ok: true, value: selected };
}

/**
 * 디스패치 시점의 프로필 해석 — 체인은 **핀 → 전역 기본값** 2단계다.
 * 예전에 있던 워크스페이스 단계는 제거됐다(티켓 e616dbfc): 워크스페이스
 * 기본값이 그 워크스페이스의 무관한 claude 에이전트에게 새어나가던 경로가
 * 이 단계와 함께 사라진다.
 *
 * 상속 시맨틱은 그대로다 — `null`/undefined 핀은 다음 selector 로 넘어가고,
 * `'none'`(CLI_RUNTIME_NONE)은 명시적 옵트아웃이라 그 자리에서 null 로 끝난다.
 */
export async function resolveClaudeBackendProfileForDispatch(
  dataSource: DataSource,
  selectors: Array<{ source: string; value: string | null | undefined }>,
) {
  const profiles = await globalRuntimeProfiles(dataSource);
  const globalDefault = (await dataSource.getRepository(SystemSetting).findOne({
    where: { key: CLAUDE_BACKEND_DEFAULT_KEY },
  }))?.value || null;
  return resolveCliRuntimeProfile(profiles, [
    ...selectors,
    { source: 'global', value: globalDefault },
  ]);
}
