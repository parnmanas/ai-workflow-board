import { DataSource } from 'typeorm';
import { ClaudeBackendProfile } from '../entities/ClaudeBackendProfile';
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
 * Claude backend profile 은 인스턴스 전역 단일 스코프다 — 계정 배정
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
 * 같은 fail-closed 검사다. `null`/undefined/default 는 Anthropic 기본값이다,
 * CLI_RUNTIME_NONE 은 명시적 옵트아웃 sentinel 이라 목록 조회 없이 통과하며,
 * 그 외 값은 전역 프로필 id 와 일치해야 하고 아니면 쓰기를 거부한다.
 */
export async function validateCliRuntimeProfileSelection(
  dataSource: DataSource,
  raw: unknown,
): Promise<{ ok: true; value: string | null } | { ok: false; error: string }> {
  const selected = raw == null || raw === 'default' ? null : String(raw);
  if (selected && selected !== CLI_RUNTIME_NONE) {
    const profiles = await globalRuntimeProfiles(dataSource);
    if (!profiles.some(profile => profile.id === selected)) {
      return { ok: false, error: `cli_runtime_profile "${selected}" does not exist` };
    }
  }
  return { ok: true, value: selected };
}

/** Resolve only an explicit execution selection. Legacy global defaults must
 * not redirect an unselected Claude runtime away from Anthropic. */
export async function resolveClaudeBackendProfileForDispatch(
  dataSource: DataSource,
  selectors: Array<{ source: string; value: string | null | undefined }>,
) {
  const selected = selectors.find(({ value }) => value !== null && value !== undefined);
  if (!selected || !selected.value || selected.value === 'default' || selected.value === CLI_RUNTIME_NONE) return null;
  return resolveCliRuntimeProfile(await globalRuntimeProfiles(dataSource), [selected]);
}
