import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(
  os.tmpdir(),
  `awb-claude-profile-mcp-${process.pid}-${Date.now()}.db`,
);
process.env.NODE_ENV = 'test';

let ds;
let tools;
let managerAgent;
let workspace;

function withTimeout(promise, message, timeoutMs = 1_000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

before(async () => {
  const { DataSource } = await import('typeorm');
  const { buildDataSourceOptions } = await import('../dist/db.js');
  tools = await import('../dist/modules/mcp/tools/claude-backend-profile-tools.js');
  ds = new DataSource(buildDataSourceOptions());
  await ds.initialize();

  managerAgent = await ds.getRepository('Agent').save(ds.getRepository('Agent').create({
    name: 'Profile manager',
    type: 'manager',
    workspace_id: null,
  }));
  workspace = await ds.getRepository('Workspace').save(ds.getRepository('Workspace').create({
    name: 'Profile MCP workspace',
  }));
});

after(async () => {
  if (ds?.isInitialized) await ds.destroy();
});

describe('Claude backend profile MCP operations', () => {
  it('allows DB-backed full-scope keys bound to any existing Agent', async () => {
    const managerCaller = {
      agentId: managerAgent.id,
      source: 'db',
      scope: 'full',
    };
    assert.equal(
      await tools.requireAgentRegistryAccess(ds, managerCaller),
      null,
    );

    const ordinary = await ds.getRepository('Agent').save(
      ds.getRepository('Agent').create({
        name: 'Ordinary profile operator',
        type: 'claude',
        workspace_id: workspace.id,
      }),
    );
    assert.equal(
      await tools.requireAgentRegistryAccess(ds, {
        agentId: ordinary.id,
        source: 'db',
        scope: 'full',
        workspaceId: '00000000-0000-0000-0000-000000000000',
      }),
      null,
    );
  });

  it('rejects callers without a DB-backed full-scope existing-Agent identity', async () => {
    const valid = {
      agentId: managerAgent.id,
      source: 'db',
      scope: 'full',
    };
    const unauthorized = /DB-backed, full-scope MCP key bound to an Agent/;
    assert.match(
      await tools.requireAgentRegistryAccess(ds, { ...valid, source: 'env' }),
      unauthorized,
    );
    assert.match(
      await tools.requireAgentRegistryAccess(ds, { ...valid, source: 'dev-mode' }),
      unauthorized,
    );
    assert.match(
      await tools.requireAgentRegistryAccess(ds, { ...valid, scope: 'write' }),
      unauthorized,
    );
    assert.match(
      await tools.requireAgentRegistryAccess(ds, { source: 'db', scope: 'full' }),
      unauthorized,
    );
    assert.match(
      await tools.requireAgentRegistryAccess(ds, {
        ...valid,
        agentId: '00000000-0000-0000-0000-000000000000',
      }),
      unauthorized,
    );
  });

  it('upserts once, reuses on retry, and refuses a same-name overwrite', async () => {
    const input = {
      name: 'Local vLLM - qwen3-coder-next',
      base_url: 'http://192.168.0.6:8000',
      model: 'qwen3-coder-next',
      protocol: 'anthropic-compatible',
    };
    const first = await tools.upsertClaudeBackendProfile(ds, input);
    const retry = await tools.upsertClaudeBackendProfile(ds, input);
    assert.equal(first.created, true);
    assert.equal(retry.created, false);
    assert.equal(retry.profile.id, first.profile.id);
    assert.equal(
      await ds.getRepository('ClaudeBackendProfile').count({
        where: { name: input.name },
      }),
      1,
    );
    await assert.rejects(
      tools.upsertClaudeBackendProfile(ds, {
        ...input,
        base_url: 'http://127.0.0.1:8000',
      }),
      /refusing to overwrite/,
    );
  });

  it('updates an existing profile without changing its UUID', async () => {
    const current = await ds.getRepository('ClaudeBackendProfile').findOneByOrFail({
      name: 'Local vLLM - qwen3-coder-next',
    });

    const result = await tools.updateClaudeBackendProfile(ds, current.id, {
      base_url: 'http://127.0.0.1:8000',
      protocol: 'openai-compatible',
      config: {
        adapter: {
          module: 'claude_openai_adapter',
          base_url: 'http://127.0.0.1:18080',
        },
      },
    });

    assert.equal(result.changed, true);
    assert.equal(result.profile.id, current.id);
    assert.equal(result.profile.base_url, 'http://127.0.0.1:8000');
    assert.equal(result.profile.protocol, 'openai-compatible');
    assert.equal(result.profile.model, 'qwen3-coder-next');
    const retry = await tools.updateClaudeBackendProfile(ds, current.id, {
      base_url: 'http://127.0.0.1:8000',
      protocol: 'openai-compatible',
      config: {
        adapter: {
          module: 'claude_openai_adapter',
          base_url: 'http://127.0.0.1:18080',
        },
      },
    });
    assert.equal(retry.changed, false);
    // 프로필은 인스턴스 전역이라 목록에 워크스페이스 인자가 없다(티켓 e616dbfc).
    const listed = await tools.listClaudeBackendProfiles(ds);
    assert.equal(listed.profiles.some(item => item.id === current.id), true);
    assert.equal('allowed_profile_ids' in listed, false, '워크스페이스 allow-set 은 응답에 없어야 합니다.');
  });

  it('rejects an invalid update without changing the stored profile', async () => {
    const current = await ds.getRepository('ClaudeBackendProfile').findOneByOrFail({
      name: 'Local vLLM - qwen3-coder-next',
    });

    await assert.rejects(
      tools.updateClaudeBackendProfile(ds, current.id, {
        credential_ref: '00000000-0000-0000-0000-000000000000',
      }),
      /credential_ref does not identify an existing Credential/,
    );
    const stored = await ds.getRepository('ClaudeBackendProfile').findOneByOrFail({
      id: current.id,
    });
    assert.equal(stored.credential_ref, current.credential_ref);
  });

  it('preserves a non-unique save failure during profile update', async () => {
    const { Repository } = await import('typeorm');
    const current = await ds.getRepository('ClaudeBackendProfile').findOneByOrFail({
      name: 'Local vLLM - qwen3-coder-next',
    });
    const originalSave = Repository.prototype.save;
    const injected = new Error('database connection lost during save');
    Repository.prototype.save = async function (...args) {
      if (this.metadata.name === 'ClaudeBackendProfile') throw injected;
      return originalSave.apply(this, args);
    };

    try {
      await assert.rejects(
        tools.updateClaudeBackendProfile(ds, current.id, {
          model: 'qwen3-coder-next-save-failure',
        }),
        error => error === injected,
      );
    } finally {
      Repository.prototype.save = originalSave;
    }
  });

  it('maps only a unique-name save failure to the duplicate-name message', async () => {
    const existing = await tools.upsertClaudeBackendProfile(ds, {
      name: 'Existing unique profile name',
      base_url: 'http://existing-name.invalid',
      model: 'existing-name-model',
      protocol: 'anthropic-compatible',
    });
    const renamed = await tools.upsertClaudeBackendProfile(ds, {
      name: 'Profile to rename',
      base_url: 'http://rename.invalid',
      model: 'rename-model',
      protocol: 'anthropic-compatible',
    });

    await assert.rejects(
      tools.updateClaudeBackendProfile(ds, renamed.profile.id, {
        name: existing.profile.name,
      }),
      /profile name already exists/,
    );
  });

  // 티켓 e616dbfc 로 시맨틱이 뒤집힌 자리다. 예전에는 프로필이 여러 워크스페이스에
  // 배정될 수 있어서, 특정 워크스페이스 소유 credential 을 붙이면 "모든 배정
  // 워크스페이스가 소유하지는 않는다"며 거부했다. 배정 개념이 사라진 지금은
  // 대조할 대상이 없으므로, 존재하는 credential 이면 그대로 저장된다.
  it('워크스페이스 소유 credential 도 전역 프로필에 그대로 붙는다', async () => {
    const ownerWorkspace = await ds.getRepository('Workspace').save(
      ds.getRepository('Workspace').create({ name: 'Credential owner workspace' }),
    );
    const profile = await tools.upsertClaudeBackendProfile(ds, {
      name: 'Shared assigned profile',
      base_url: 'http://shared.invalid',
      model: 'shared-model',
      protocol: 'anthropic-compatible',
    });
    const credential = await ds.getRepository('Credential').save(
      ds.getRepository('Credential').create({
        workspace_id: ownerWorkspace.id,
        name: 'First workspace credential',
        provider: 'anthropic',
        encrypted_data: 'test-only',
      }),
    );

    const result = await tools.updateClaudeBackendProfile(ds, profile.profile.id, {
      base_url: 'http://now-saved.invalid',
      credential_ref: credential.id,
    });
    assert.equal(result.changed, true);
    const stored = await ds.getRepository('ClaudeBackendProfile').findOneByOrFail({
      id: profile.profile.id,
    });
    assert.equal(stored.base_url, 'http://now-saved.invalid');
    assert.equal(stored.credential_ref, credential.id);
    // 자격증명 참조는 응답 DTO 에 절대 실리지 않는다.
    assert.equal('credential_ref' in result.profile, false);
    assert.equal(result.profile.credential_status, 'configured');

    // 존재하지 않는 credential 은 여전히 fail-closed.
    await assert.rejects(
      tools.updateClaudeBackendProfile(ds, profile.profile.id, {
        credential_ref: '00000000-0000-0000-0000-000000000000',
      }),
      /credential_ref does not identify an existing Credential/,
    );
  });

  // 프로필별 쓰기 임계 구역은 assign 경로가 사라진 뒤에도 지켜져야 한다.
  // 겹치는 두 update 가 순차로만 진입하는지를 happens-before 로 관찰한다 — 고정
  // 지연 없이 첫 번째가 락을 잡은 사실과 두 번째의 진입 시도를 각각 이벤트로
  // 기다리고, timeout 은 hang 진단용 상한으로만 둔다.
  it('같은 프로필에 대한 겹친 update 두 건을 직렬화한다', async () => {
    const profile = await tools.upsertClaudeBackendProfile(ds, {
      name: 'Contended profile',
      base_url: 'http://contended.invalid',
      model: 'contended-model',
      protocol: 'anthropic-compatible',
    });

    let releaseFirst;
    const firstBlocked = new Promise(resolve => { releaseFirst = resolve; });
    let firstHasLock;
    const lockObserved = new Promise(resolve => { firstHasLock = resolve; });
    let secondAttempted;
    const secondAttemptObserved = new Promise(resolve => { secondAttempted = resolve; });
    let attempts = 0;
    let entered = 0;
    tools.setProfileLockAttemptHookForTests((_operation, profileId) => {
      if (profileId !== profile.profile.id) return;
      attempts += 1;
      if (attempts === 2) secondAttempted();
    });
    tools.setProfileLockHookForTests(async (_operation, profileId) => {
      if (profileId !== profile.profile.id) return;
      entered += 1;
      if (entered === 1) {
        firstHasLock();
        await firstBlocked;
      }
    });

    try {
      const first = tools.updateClaudeBackendProfile(ds, profile.profile.id, {
        base_url: 'http://contended.invalid:8001',
      });
      await withTimeout(lockObserved, 'timed out waiting for the first update lock');

      let secondSettled = false;
      const second = tools.updateClaudeBackendProfile(ds, profile.profile.id, {
        model: 'contended-model-v2',
      }).finally(() => { secondSettled = true; });
      await withTimeout(secondAttemptObserved, 'timed out waiting for the second update lock attempt');
      assert.equal(entered, 1, '두 번째 update 는 첫 번째가 락을 놓기 전에 진입하면 안 됩니다.');
      assert.equal(secondSettled, false, '두 번째 update 는 첫 번째가 끝나기 전에 완료되면 안 됩니다.');

      releaseFirst();
      await withTimeout(first, 'timed out waiting for the first update');
      await withTimeout(second, 'timed out waiting for the second update');
      assert.equal(entered, 2);

      // 두 쓰기가 모두 반영돼야 한다 — 뒤엣것이 앞엣것을 덮어써 유실되면 안 된다.
      const stored = await ds.getRepository('ClaudeBackendProfile').findOneByOrFail({
        id: profile.profile.id,
      });
      assert.equal(stored.base_url, 'http://contended.invalid:8001');
      assert.equal(stored.model, 'contended-model-v2');
    } finally {
      releaseFirst?.();
      tools.setProfileLockAttemptHookForTests();
      tools.setProfileLockHookForTests();
    }
  });
});
