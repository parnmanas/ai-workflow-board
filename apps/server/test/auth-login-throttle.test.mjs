// 로그인 브루트포스 방어(M2) 회귀 테스트 — 티켓 f177aeb3.
// AuthService.login()이 이메일/IP 조합으로 실패 횟수를 추적해 임계치(5회/15분)를
// 넘기면 잠그는지, 성공 시 카운터가 리셋되는지, 잠금 중에는 올바른 비밀번호를
// 넣어도 여전히 거부되는지(자격증명 검증 자체를 건너뛰는지) 확인한다.
// workflow-functions.test.mjs와 동일하게 컴파일된 dist/ 를 sqljs DataSource와
// 함께 직접 인스턴스화하는 경량 패턴을 사용한다 (전체 Nest 앱 부트 불필요).
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { DataSource } from 'typeorm';
import bcrypt from 'bcryptjs';
import { User } from '../dist/entities/User.js';
import { AuthService } from '../dist/services/auth.service.js';
import { MemoryMetricsRegistry } from '../dist/services/memory-metrics.registry.js';
import { LogService } from '../dist/services/log.service.js';

describe('Auth login throttle (M2)', () => {
  let dataSource;
  let authService;
  let userRepo;
  const PASSWORD = 'correct-horse-battery-staple';

  before(async () => {
    dataSource = new DataSource({
      type: 'sqljs',
      entities: [User],
      synchronize: true,
      logging: false,
    });
    await dataSource.initialize();
    userRepo = dataSource.getRepository(User);
  });

  after(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    // 매 테스트마다 새 AuthService 인스턴스 — 실패 카운터 Map이 테스트 간에
    // 새지 않도록 한다. 생성자가 등록하는 5분 청소 setInterval은 unref()되어
    // 있어(auth.service.ts) 인스턴스를 몇 개를 만들든 프로세스 종료를 막지 않는다.
    authService = new AuthService(userRepo, new MemoryMetricsRegistry(), new LogService());
    await userRepo.clear();
    await userRepo.save(userRepo.create({
      name: 'Throttle Target',
      email: 'throttle@example.com',
      role: 'user',
      status: 'active',
      password_hash: await bcrypt.hash(PASSWORD, 10),
    }));
  });

  it('locks out after 5 failed attempts from the same email+IP and rejects further attempts (even correct password)', async () => {
    for (let i = 0; i < 5; i++) {
      const result = await authService.login('throttle@example.com', 'wrong-password', '203.0.113.1');
      assert.equal(result, null, `attempt ${i + 1} should be a plain invalid-credentials rejection, not yet locked`);
    }

    // 6번째 시도 — 비밀번호가 맞아도 잠금 상태이므로 거부되어야 한다.
    const locked = await authService.login('throttle@example.com', PASSWORD, '203.0.113.1');
    assert.ok(locked && 'error' in locked, 'expected a lockout error object');
    assert.equal(locked.status, 429);
    assert.match(locked.error, /too many failed login attempts/i);
  });

  it('a successful login resets the failure counter for that email+IP', async () => {
    for (let i = 0; i < 4; i++) {
      await authService.login('throttle@example.com', 'wrong-password', '203.0.113.2');
    }
    // 4회 실패 후 정답 — 임계치(5) 미만이므로 아직 잠기지 않아 로그인 성공해야 한다.
    const success = await authService.login('throttle@example.com', PASSWORD, '203.0.113.2');
    assert.ok(success && 'token' in success, 'expected a successful login before lockout threshold');

    // 리셋됐으므로 다시 4회 실패해도 잠기지 않아야 한다.
    for (let i = 0; i < 4; i++) {
      const result = await authService.login('throttle@example.com', 'wrong-password', '203.0.113.2');
      assert.equal(result, null);
    }
    const stillOpen = await authService.login('throttle@example.com', PASSWORD, '203.0.113.2');
    assert.ok(stillOpen && 'token' in stillOpen, 'counter should have reset after the earlier success');
  });

  it('locks out by IP alone across different target emails (credential-stuffing protection)', async () => {
    await userRepo.save(userRepo.create({
      name: 'Second User',
      email: 'second@example.com',
      role: 'user',
      status: 'active',
      password_hash: await bcrypt.hash(PASSWORD, 10),
    }));

    const emails = ['throttle@example.com', 'second@example.com', 'nobody1@example.com', 'nobody2@example.com', 'nobody3@example.com'];
    for (const email of emails) {
      const result = await authService.login(email, 'wrong-password', '198.51.100.9');
      assert.equal(result, null);
    }

    // 같은 IP에서 6번째 시도(대상 이메일은 또 다름) — IP 카운터가 잠겨 있어야 한다.
    const locked = await authService.login('nobody4@example.com', 'wrong-password', '198.51.100.9');
    assert.ok(locked && 'error' in locked);
    assert.equal(locked.status, 429);
  });

  it('does not lock out an unrelated email/IP combination that never failed', async () => {
    await userRepo.save(userRepo.create({
      name: 'Unrelated User',
      email: 'unrelated@example.com',
      role: 'user',
      status: 'active',
      password_hash: await bcrypt.hash(PASSWORD, 10),
    }));

    for (let i = 0; i < 5; i++) {
      await authService.login('throttle@example.com', 'wrong-password', '203.0.113.3');
    }
    // 이메일도, IP도 겹치지 않는 조합 — 완전히 별개의 카운터이므로 정상 로그인되어야 한다.
    const success = await authService.login('unrelated@example.com', PASSWORD, '203.0.113.4');
    assert.ok(success && 'token' in success);
  });
});
