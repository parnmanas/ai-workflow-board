/**
 * RuntimeSpec — Agent 없는 greenfield 실행 선언 (P0).
 *
 * `TeamAgentSpec` (orchestration-member-spec.ts)이 이미 "어느 Host, 어느 CLI,
 * 어느 model, 어느 폴더" 튜플을 선언하고 있었고, P0 결정에 따라 이것을 전역
 * 실행 단위로 승격시킨다. Board/Ticket/Chat/Mission/Action/QA/Security 어디서든
 * "누가 하느냐"는 앞으로 이 Spec 인라인 선언 하나다 — Agent 행 조회 없음.
 *
 * TeamAgentSpec 대비 추가 필드는 딱 2개:
 *  - `label`: 표시용 짧은 이름 (현 Agent.name 대체, `<Host>/<label>` 표시)
 *  - `role_prompt`: 실행 시 주입 프롬프트 (현 Agent.role_prompt 대체)
 *
 * 검증은 TeamAgentSpec 쪽에 위임한다 — shape 검증이 두 벌이 되면 drift 난다.
 * Referential 체크 (manager 존재, credential 가시성, profile 존재)는 호출자
 * (provisioner/dispatch)가 들고 있다 — 여기서는 shape만 본다.
 */

import { createHash } from 'crypto';
import {
  normalizeTeamAgentSpec,
  parseTeamAgentSpec,
  mergeTeamAgentSpec,
  workingDirLeaf,
  type TeamAgentSpec,
} from './orchestration-member-spec';

export type { TeamAgentSpec };

export interface RuntimeSpec extends TeamAgentSpec {
  /** 표시용 짧은 이름. '' 허용 — 표시 시점에 폴백한다. */
  label: string;
  /** 실행 시 주입 프롬프트. '' = 없음. */
  role_prompt: string;
}

export class RuntimeSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeSpecError';
  }
}

function str(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

function fail(label: string, message: string): never {
  throw new RuntimeSpecError(`${label}: ${message}`);
}

/**
 * 느슨한 REST/MCP 입력을 RuntimeSpec으로 검증+정규화.
 * TeamAgentSpec 검증 실패 시 RuntimeSpecError로 감싸서 올린다.
 */
export function normalizeRuntimeSpec(input: unknown, label: string): RuntimeSpec {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail(label, 'a runtime spec object is required (manager_agent_id, cli, working_dir)');
  }
  const raw = input as Record<string, unknown>;
  let base: TeamAgentSpec;
  try {
    base = normalizeTeamAgentSpec(raw, label);
  } catch (e) {
    fail(label, e instanceof Error ? e.message : String(e));
  }
  const workingDir = (base as TeamAgentSpec).working_dir;
  const cli = (base as TeamAgentSpec).cli;
  return {
    ...(base as TeamAgentSpec),
    label: str(raw.label) || `${workingDirLeaf(workingDir)}/${cli}`,
    role_prompt: str(raw.role_prompt),
  };
}

/**
 * 저장된 값을 읽기. 절대 throw하지 않는다 — 낡은 행/hand-edit은 "spec 없음"
 * 으로 degrade되어야 목록 전체가 깨지지 않는다.
 */
export function parseRuntimeSpec(value: unknown): RuntimeSpec | null {
  if (!value) return null;
  let candidate: unknown = value;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const raw = candidate as Record<string, unknown>;
  // 구형 TeamAgentSpec 행도 읽힌다 — label/role_prompt만 폴백.
  const base = parseTeamAgentSpec(raw);
  if (!base) return null;
  return {
    ...base,
    label: str(raw.label) || `${workingDirLeaf(base.working_dir)}/${base.cli}`,
    role_prompt: str(raw.role_prompt),
  };
}

/**
 * 부분 patch를 기존 spec 위에 병합. `runtime_config`는 통째로 병합된다
 * (mergeTeamAgentSpec과 동일 이유 — per-CLI shape이므로 key-by-key 병합 금지).
 */
export function mergeRuntimeSpec(
  current: RuntimeSpec | null,
  patch: unknown,
  label: string,
): RuntimeSpec {
  if (!current) return normalizeRuntimeSpec(patch, label);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return current;
  const raw = patch as Record<string, unknown>;
  const { label: _l, role_prompt: _r, ...teamPatch } = raw;
  const mergedBase = mergeTeamAgentSpec(current, teamPatch, label);
  const nextLabel = raw.label !== undefined ? str(raw.label) : current.label;
  const nextPrompt = raw.role_prompt !== undefined ? str(raw.role_prompt) : current.role_prompt;
  return {
    ...mergedBase,
    label:
      nextLabel ||
      `${workingDirLeaf(mergedBase.working_dir)}/${mergedBase.cli}`,
    role_prompt: nextPrompt,
  };
}

/**
 * P4c-2b: 튜플의 안정 온디스크 신원. `rt-` + sha256 hex16 of
 * `lower(cli)\0working_dir\0credential_id` — agent-manager의 runtimeIdentityKey와
 * 바이트 단위로 같은 계약이다 (model/label은 신원이 아님). 양쪽 중 한쪽만
 * 바꾸면 키가 어긋나 매니저가 딴 키로 발급하므로, 변경 시 양쪽 + 양쪽 테스트를
 * 함께 고칠 것.
 */
export function runtimeIdentityKey(
  spec: Pick<RuntimeSpec, 'cli' | 'working_dir' | 'credential_id'>,
): string {
  const norm = (v: string | null | undefined) => (v || '').trim();
  const digest = createHash('sha256')
    .update(`${norm(spec.cli).toLowerCase()}\0${norm(spec.working_dir)}\0${norm(spec.credential_id)}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
  return `rt-${digest}`;
}

export function isRuntimeIdentityKey(value: unknown): boolean {
  return typeof value === 'string' && /^rt-[0-9a-f]{16}$/.test(value);
}

/**
 * A single ticket-role holder identity — exactly one of agent_id / user_id /
 * runtime is set. `runtime` is a RuntimeSpec declaring execution without an
 * Agent row (P4c-2b); the row stores agent_id=null, the normalized spec
 * snapshot, and a `runtime:<identityKey>` holder_key.
 */
export interface HolderRef {
  agent_id?: string | null;
  user_id?: string | null;
  runtime?: unknown;
}

/**
 * Normalized holder identity written into `holder_key` — the third leg of the
 * `(ticket_id, role_id, holder_key)` unique key. Agents win when (illegally)
 * both are supplied; the empty string marks a vacant slot, which is never
 * persisted (vacant rows are deleted).
 *
 * P4c-2b: `runtime` normalizes to `runtime:<identityKey>`. Pure shape
 * normalization only (no DB) — throws RuntimeSpecError on bad shape.
 */
export function computeHolderKey(holder: HolderRef): string {
  const agent_id = holder.agent_id || null;
  const user_id = holder.user_id || null;
  if (agent_id) return `agent:${agent_id}`;
  if (user_id) return `user:${user_id}`;
  if (holder.runtime !== undefined && holder.runtime !== null) {
    return `runtime:${runtimeIdentityKey(normalizeRuntimeSpec(holder.runtime, 'holder.runtime'))}`;
  }
  return '';
}

/**
 * P4c-2b: assignment row → dispatchable holder id. Agent rows keep their
 * `agent:<uuid>` identity; spec-direct rows resolve from the holder_key
 * (`runtime:<key>`); user rows return null (humans receive no agent_trigger).
 */
export function holderAssigneeId(row: {
  agent_id?: string | null;
  user_id?: string | null;
  holder_key?: string | null;
}): string | null {
  if (row.agent_id) return row.agent_id;
  const key = (row.holder_key || '').trim();
  if (key.startsWith('runtime:')) {
    const id = key.slice('runtime:'.length).trim();
    return id || null;
  }
  return null;
}

/**
 * TicketRoleAssignment.holder_key용 안정 키.
 * `runtime:<hostId>:<cli>:<working_dir>` — 평문 경로가 들어가지만 holder_key는
 * 내부 식별자라 노출 표면이 아니다. 길이 상한을 두지 않는다 (varchar).
 */
export function holderKeyForRuntime(spec: Pick<RuntimeSpec, 'manager_agent_id' | 'cli' | 'working_dir'>): string {
  return `runtime:${spec.manager_agent_id}:${spec.cli}:${spec.working_dir}`;
}

/**
 * `<Host>/<label>` 표시용. hostName 해석은 호출자가 한다 — 여기는 조립만.
 */
export function displayNameForRuntime(hostName: string, spec: Pick<RuntimeSpec, 'label' | 'cli' | 'model' | 'working_dir'>): string {
  const leaf = spec.label || `${workingDirLeaf(spec.working_dir)}/${spec.cli}`;
  return `${hostName}/${leaf}`;
}
