import { randomUUID } from 'crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DataSource, EntityManager } from 'typeorm';
import { Agent } from '../../../entities/Agent';
import { ClaudeBackendProfile } from '../../../entities/ClaudeBackendProfile';
import { Credential } from '../../../entities/Credential';
import {
  profileEntityToRuntime,
  publicProfile,
  runtimeToProfileEntity,
} from '../../../common/claude-backend-registry';
import { ClaudeBackendProfileSchema } from '../../../common/cli-runtime-profiles';
import { ok, err } from '../shared/helpers';
import { getCallerAgent, type McpAgentContext } from '../shared/session-auth';
import type { ToolContext } from './context';

const REGISTRY_GATE_ERROR =
  'Unauthorized: Claude backend profile registry tools require a DB-backed, full-scope MCP key bound to an Agent.';

const profileOperationTails = new Map<string, Promise<void>>();
const profileQueueBypassDataSources = new WeakSet<DataSource>();
let profileLockHook: ((operation: 'update', profileId: string) => Promise<void>) | undefined;
let profileLockAttemptHook: ((operation: 'update', profileId: string) => void) | undefined;

function isUniqueConstraintError(error: unknown): boolean {
  const value = error as {
    code?: string;
    errno?: number;
    message?: string;
    driverError?: { code?: string; errno?: number; message?: string };
  } | null;
  const driverError = value?.driverError;
  const code = driverError?.code ?? value?.code;
  const errno = driverError?.errno ?? value?.errno;
  const message = driverError?.message ?? value?.message ?? '';
  return code === '23505'
    || code === 'SQLITE_CONSTRAINT_UNIQUE'
    || code === 'ER_DUP_ENTRY'
    || errno === 1062
    || /unique constraint failed/i.test(message);
}

export function setProfileLockHookForTests(
  hook?: (operation: 'update', profileId: string) => Promise<void>,
): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('profile lock hook is test-only');
  profileLockHook = hook;
}

export function setProfileLockAttemptHookForTests(
  hook?: (operation: 'update', profileId: string) => void,
): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('profile lock hook is test-only');
  profileLockAttemptHook = hook;
}

export function setProfileQueueBypassForTests(dataSource: DataSource, enabled = true): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('profile queue bypass is test-only');
  if (enabled) profileQueueBypassDataSources.add(dataSource);
  else profileQueueBypassDataSources.delete(dataSource);
}

async function withProfileWriteLock<T>(
  dataSource: DataSource,
  profileId: string,
  operationName: 'update',
  operation: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  const bypassQueue = profileQueueBypassDataSources.has(dataSource);
  const previous = bypassQueue
    ? Promise.resolve()
    : profileOperationTails.get(profileId) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>(resolve => { release = resolve; });
  if (!bypassQueue) profileOperationTails.set(profileId, tail);
  profileLockAttemptHook?.(operationName, profileId);
  await previous;
  try {
    return await dataSource.transaction(async manager => {
      // 이 no-op UPDATE는 서버 DB에서 트랜잭션 동안 행 쓰기 잠금을 잡는다.
      // SELECT ... FOR UPDATE를 지원하지 않는 sql.js에서는 위 프로세스별
      // 큐가 같은 직렬화 역할을 한다.
      const locked = await manager.createQueryBuilder()
        .update('claude_backend_profiles')
        .set({ id: () => 'id' })
        .where('id = :profileId', { profileId })
        .execute();
      if ((locked.affected ?? 0) === 0) {
        throw new Error('Claude backend profile not found');
      }
      await profileLockHook?.(operationName, profileId);
      return operation(manager);
    });
  } finally {
    release();
    if (!bypassQueue && profileOperationTails.get(profileId) === tail) {
      profileOperationTails.delete(profileId);
    }
  }
}

export async function requireAgentRegistryAccess(
  dataSource: DataSource,
  caller: McpAgentContext | undefined,
): Promise<string | null> {
  if (
    !caller ||
    caller.source !== 'db' ||
    caller.scope !== 'full' ||
    !caller.agentId
  ) {
    return REGISTRY_GATE_ERROR;
  }
  const agent = await dataSource.getRepository(Agent).findOne({
    where: { id: caller.agentId },
  });
  return agent ? null : REGISTRY_GATE_ERROR;
}

export async function upsertClaudeBackendProfile(
  dataSource: DataSource,
  input: {
    name: string;
    base_url: string;
    model: string;
    protocol: 'anthropic-compatible' | 'openai-compatible';
    credential_ref?: string;
    config?: Record<string, unknown>;
  },
) {
  const name = input.name.trim();
  if (!name) throw new Error('name is required');

  const repo = dataSource.getRepository(ClaudeBackendProfile);
  const existing = await repo.findOne({ where: { name } });
  if (existing) {
    if (
      existing.base_url !== input.base_url ||
      existing.model !== input.model ||
      existing.protocol !== input.protocol
    ) {
      throw new Error(
        `Profile name "${name}" already exists with a different base_url, model, or protocol; refusing to overwrite it.`,
      );
    }
    return { created: false, profile: publicProfile(existing) };
  }

  if (input.credential_ref) {
    const credential = await dataSource.getRepository(Credential).findOne({
      where: { id: input.credential_ref },
    });
    if (!credential) throw new Error('credential_ref does not identify an existing Credential');
  }

  const runtime = ClaudeBackendProfileSchema.parse({
    ...(input.config ?? {}),
    id: randomUUID(),
    kind: 'claude-backend',
    protocol: input.protocol,
    base_url: input.base_url,
    model: input.model,
    ...(input.credential_ref ? { credential_ref: input.credential_ref } : {}),
  });

  try {
    const saved = await repo.save(repo.create(runtimeToProfileEntity(runtime, name)));
    return { created: true, profile: publicProfile(saved) };
  } catch (error) {
    // 동시 호출자가 이름 고유 삽입에 먼저 성공했을 수 있다. 다시 조회한 뒤
    // 같은 충돌 방어를 적용해 재시도가 정확히 한 번의 결과로 수렴하게 한다.
    const winner = await repo.findOne({ where: { name } });
    if (
      winner &&
      winner.base_url === input.base_url &&
      winner.model === input.model &&
      winner.protocol === input.protocol
    ) {
      return { created: false, profile: publicProfile(winner) };
    }
    throw error;
  }
}

export async function updateClaudeBackendProfile(
  dataSource: DataSource,
  profileId: string,
  input: {
    name?: string;
    base_url?: string;
    model?: string;
    protocol?: 'anthropic-compatible' | 'openai-compatible';
    credential_ref?: string | null;
    config?: Record<string, unknown>;
  },
) {
  return withProfileWriteLock(dataSource, profileId, 'update', async manager => {
  const repo = manager.getRepository(ClaudeBackendProfile);
  const current = await repo.findOne({ where: { id: profileId } });
  if (!current) throw new Error('Claude backend profile not found');

  const name = input.name === undefined ? current.name : input.name.trim();
  if (!name) throw new Error('name is required');
  const existingRuntime = profileEntityToRuntime(current);
  const runtime = ClaudeBackendProfileSchema.parse({
    ...existingRuntime,
    ...(input.config ?? {}),
    id: profileId,
    ...(input.base_url === undefined ? {} : { base_url: input.base_url }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.protocol === undefined ? {} : { protocol: input.protocol }),
    ...(input.credential_ref === undefined
      ? {}
      : input.credential_ref === null
        ? { credential_ref: undefined }
        : { credential_ref: input.credential_ref }),
  });

  // 프로필은 인스턴스 전역이라 "배정된 워크스페이스" 개념이 없다(티켓 e616dbfc).
  // 예전의 배정-소유권 대조는 대조할 대상 자체가 사라져 존재 검사만 남는다.
  if (runtime.credential_ref) {
    const credential = await manager.getRepository(Credential).findOne({
      where: { id: runtime.credential_ref },
    });
    if (!credential) throw new Error('credential_ref does not identify an existing Credential');
  }

  const next = runtimeToProfileEntity(runtime, name);
  const changed = (
    current.name !== next.name ||
    current.base_url !== next.base_url ||
    current.model !== next.model ||
    current.protocol !== next.protocol ||
    current.credential_ref !== next.credential_ref ||
    current.config !== next.config
  );
  if (!changed) return { changed: false, profile: publicProfile(current) };
  Object.assign(current, next);
  try {
    const saved = await repo.save(current);
    return { changed, profile: publicProfile(saved) };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new Error(`profile name already exists: ${error instanceof Error ? error.message : String(error)}`);
    }
    throw error;
  }
  });
}

export async function listClaudeBackendProfiles(dataSource: DataSource) {
  const rows = await dataSource.getRepository(ClaudeBackendProfile).find({
    order: { name: 'ASC' },
  });
  return { profiles: rows.map(publicProfile) };
}

export function registerClaudeBackendProfileTools(server: McpServer, ctx: ToolContext): void {
  const gated = async (
    extra: { sessionId?: string },
    operation: () => Promise<unknown>,
  ) => {
    const denied = await requireAgentRegistryAccess(
      ctx.dataSource,
      getCallerAgent(extra),
    );
    if (denied) return err(denied);
    try {
      return ok(await operation());
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error));
    }
  };

  server.tool(
    'update_claude_backend_profile',
    'Update selected fields of an existing instance-global Claude backend profile while preserving its UUID and assignments. Pass credential_ref=null to clear it. DB-backed, full-scope Agent MCP only.',
    {
      profile_id: z.string().uuid(),
      name: z.string().min(1).optional(),
      base_url: z.string().url().optional(),
      model: z.string().min(1).optional(),
      protocol: z.enum(['anthropic-compatible', 'openai-compatible']).optional(),
      credential_ref: z.string().uuid().nullable().optional(),
      config: z.record(z.string(), z.unknown()).optional(),
    },
    async ({ profile_id, ...input }, extra) => gated(
      extra,
      () => updateClaudeBackendProfile(ctx.dataSource, profile_id, input),
    ),
  );

  server.tool(
    'upsert_claude_backend_profile',
    'Idempotently create or reuse an instance-global Claude backend profile. Refuses to overwrite a same-name profile whose endpoint, model, or protocol differs. DB-backed, full-scope Agent MCP only.',
    {
      name: z.string().min(1),
      base_url: z.string().url(),
      model: z.string().min(1),
      protocol: z.enum(['anthropic-compatible', 'openai-compatible']),
      credential_ref: z.string().uuid().optional(),
      config: z.record(z.string(), z.unknown()).optional(),
    },
    async (args, extra) => gated(
      extra,
      () => upsertClaudeBackendProfile(ctx.dataSource, args),
    ),
  );

  server.tool(
    'list_claude_backend_profiles',
    'List safe Claude backend profile metadata. Profiles are instance-global — there is no per-workspace assignment or default. Credential references and secrets are omitted. DB-backed, full-scope Agent MCP only.',
    {},
    async (_args, extra) => gated(
      extra,
      () => listClaudeBackendProfiles(ctx.dataSource),
    ),
  );
}
