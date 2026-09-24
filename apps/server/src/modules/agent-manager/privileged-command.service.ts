import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { MemoryMetricsRegistry } from '../../services/memory-metrics.registry';

/**
 * 세션/채팅에서 agent 가 요청한 **권한 상승 명령 하나**의 승인 상태.
 *
 * ## 왜 "agent 가 sudo 를 쓴다" 가 아니라 "운영자가 매번 승인한다" 인가
 *
 * agent 에게 상시 sudo 권한을 주면 그 agent 는 root 다 — 프롬프트 인젝션 한 번이
 * 곧 루트 권한 탈취가 된다. 그래서 이 표면에는 저장된 비밀번호가 없고, **운영자가
 * 그때그때 화면에서 명령을 읽고 승인하면서 비밀번호를 친다**. 승인이 없으면 아무
 * 일도 일어나지 않고, 기본값은 거부다(TTL 만료 = 거부).
 *
 * ## 불변식
 *
 * - **운영자가 본 argv 가 곧 실행되는 argv 다.** 매니저는 SSE 페이로드의 복사본이
 *   아니라 이 서비스가 보관한 정본을 다시 받아 가서 실행한다(`claim`). 그래야
 *   "승인한 것" 과 "실행된 것" 이 갈라질 여지가 없다.
 * - **메모리에만** 산다. 승인 대기는 분 단위 상태이고, 프로세스가 죽으면 승인도
 *   같이 사라지는 것이 맞다 — 재기동 뒤에 되살아나는 승인은 운영자가 승인한 적
 *   없는 승인이다.
 * - **agent 당 동시 대기 수를 막는다.** 안 그러면 한 agent 가 운영자에게 승인
 *   요청을 무한히 쏟아 붓고, 그중 하나만 습관적으로 눌려도 끝이다.
 * - 이 서비스는 비밀번호를 **모른다**. 비밀번호는 SudoTicketService 의 일회용
 *   티켓에만 존재하고, 승인 시점에 그쪽으로 들어간다.
 */

export type PrivilegedCommandStatus =
  /** 운영자 승인 대기. */
  | 'pending'
  /** 운영자가 승인했고 매니저에게 디스패치됐다. */
  | 'approved'
  /** 매니저가 정본 argv 를 받아 갔다(실행 중). */
  | 'running'
  /** 실행이 끝났다(성공/실패는 `ok` 로 구분). */
  | 'done'
  /** 운영자가 거부했다. */
  | 'denied'
  /** 승인 없이 창이 지났다 — 기본값은 거부다. */
  | 'expired';

export interface PrivilegedCommandRequest {
  request_id: string;
  workspace_id: string | null;
  /** 요청한 agent. 결과를 받아 갈 수 있는 유일한 주체이기도 하다. */
  agent_id: string;
  agent_name: string;
  /** 그 agent 를 감독하는 매니저 인스턴스 — 실행이 일어날 곳. */
  instance_id: string;
  hostname: string;
  /** 운영자가 화면에서 읽는, 그리고 매니저가 그대로 실행할 정본. */
  command: string;
  args: string[];
  cwd: string | null;
  /** agent 가 밝힌 이유. 운영자가 승인 여부를 판단하는 근거다. */
  reason: string;
  status: PrivilegedCommandStatus;
  created_at: string;
  expires_at: number;
  decided_by: string | null;
  decided_at: string | null;
  /** 실행 결과 — status='done' 일 때만 의미가 있다. */
  ok: boolean | null;
  output: string;
  failure: string | null;
}

/** 운영자가 승인하지 않은 채 이만큼 지나면 거부로 굳는다. */
export const APPROVAL_TTL_MS = 10 * 60 * 1000;
/** 승인 후 매니저가 끝내지 못한 채 이만큼 지나면 포기한다. */
export const EXECUTION_TTL_MS = 15 * 60 * 1000;
/** agent 하나가 동시에 걸어 둘 수 있는 승인 대기 수. 운영자를 향한 스팸 방지. */
export const MAX_PENDING_PER_AGENT = 3;
/** 결과를 조회한 뒤 레코드를 보관하는 시간 — agent 가 폴링으로 집어갈 여유. */
export const RESULT_RETENTION_MS = 10 * 60 * 1000;
/** 출력 상한. 툴 결과로 그대로 나가므로 무한정 실을 수 없다. */
export const MAX_OUTPUT_CHARS = 20_000;

const SWEEP_INTERVAL_MS = 30 * 1000;

export type CreateResult =
  | { ok: true; request: PrivilegedCommandRequest }
  | { ok: false; reason: 'too_many_pending' };

@Injectable()
export class PrivilegedCommandService implements OnModuleDestroy {
  private readonly requests = new Map<string, PrivilegedCommandRequest>();
  /** request_id → 상태 변화를 기다리는 resolver 들(롱폴링). */
  private readonly waiters = new Map<string, Array<() => void>>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(metrics: MemoryMetricsRegistry) {
    metrics.register('agentManager.privilegedCommands', () => this.requests.size);
    this.timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    if (this.timer && typeof (this.timer as any).unref === 'function') {
      (this.timer as any).unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.requests.clear();
    this.waiters.clear();
  }

  create(input: {
    workspace_id: string | null;
    agent_id: string;
    agent_name: string;
    instance_id: string;
    hostname: string;
    command: string;
    args: string[];
    cwd: string | null;
    reason: string;
  }): CreateResult {
    const pending = [...this.requests.values()].filter(
      (r) => r.agent_id === input.agent_id && r.status === 'pending',
    );
    if (pending.length >= MAX_PENDING_PER_AGENT) return { ok: false, reason: 'too_many_pending' };

    const request: PrivilegedCommandRequest = {
      request_id: randomUUID(),
      ...input,
      status: 'pending',
      created_at: new Date().toISOString(),
      expires_at: Date.now() + APPROVAL_TTL_MS,
      decided_by: null,
      decided_at: null,
      ok: null,
      output: '',
      failure: null,
    };
    this.requests.set(request.request_id, request);
    return { ok: true, request };
  }

  get(request_id: string): PrivilegedCommandRequest | null {
    const req = this.requests.get(request_id);
    if (!req) return null;
    // 만료는 읽는 시점에 굳힌다 — sweep 을 기다리면 "이미 지났는데 아직 pending"
    // 인 창이 생기고, 그 창에서 승인이 통과해 버린다.
    if (req.status === 'pending' && Date.now() > req.expires_at) {
      this.transition(req, 'expired', { failure: 'no operator decision before the approval window closed' });
    }
    return req;
  }

  /** 운영자 화면이 읽는 목록. 워크스페이스로 좁힌다. */
  listPending(workspace_id: string | null): PrivilegedCommandRequest[] {
    const out: PrivilegedCommandRequest[] = [];
    for (const req of this.requests.values()) {
      const live = this.get(req.request_id);
      if (!live || live.status !== 'pending') continue;
      if (workspace_id && live.workspace_id && live.workspace_id !== workspace_id) continue;
      out.push(live);
    }
    return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  approve(request_id: string, userId: string): PrivilegedCommandRequest | null {
    const req = this.get(request_id);
    if (!req || req.status !== 'pending') return null;
    req.decided_by = userId;
    req.decided_at = new Date().toISOString();
    req.expires_at = Date.now() + EXECUTION_TTL_MS;
    this.transition(req, 'approved');
    return req;
  }

  deny(request_id: string, userId: string): PrivilegedCommandRequest | null {
    const req = this.get(request_id);
    if (!req || req.status !== 'pending') return null;
    req.decided_by = userId;
    req.decided_at = new Date().toISOString();
    this.transition(req, 'denied', { failure: 'the operator denied this command' });
    return req;
  }

  /**
   * 매니저가 **정본 argv** 를 받아 간다. SSE 페이로드의 복사본이 아니라 여기
   * 보관된 것을 주는 것이 요점이다 — 운영자가 승인한 것과 실행되는 것이 같아야 한다.
   *
   * 승인된 요청만, 그 요청을 만든 agent 를 감독하는 인스턴스만 집을 수 있다.
   */
  claim(
    request_id: string,
    instance_id: string,
  ): { ok: true; request: PrivilegedCommandRequest } | { ok: false; reason: 'unknown' | 'not_approved' | 'wrong_instance' } {
    const req = this.get(request_id);
    if (!req) return { ok: false, reason: 'unknown' };
    if (req.instance_id !== instance_id) return { ok: false, reason: 'wrong_instance' };
    if (req.status !== 'approved' && req.status !== 'running') return { ok: false, reason: 'not_approved' };
    this.transition(req, 'running');
    return { ok: true, request: req };
  }

  complete(
    request_id: string,
    instance_id: string,
    result: { ok: boolean; output: string; failure?: string | null },
  ): PrivilegedCommandRequest | null {
    const req = this.requests.get(request_id);
    if (!req || req.instance_id !== instance_id) return null;
    if (req.status !== 'approved' && req.status !== 'running') return null;
    req.ok = result.ok;
    req.output = (result.output || '').slice(0, MAX_OUTPUT_CHARS);
    req.failure = result.failure ?? null;
    req.expires_at = Date.now() + RESULT_RETENTION_MS;
    this.transition(req, 'done');
    return req;
  }

  /**
   * 상태가 바뀔 때까지(또는 `timeoutMs` 까지) 기다린다. MCP 툴이 짧은 롱폴링으로
   * 쓴다 — 이 저장소의 관례대로 **호출을 오래 붙잡지 않는다**. 호출자는 아직
   * pending 이면 다시 부르면 된다.
   */
  async waitForChange(request_id: string, timeoutMs: number): Promise<void> {
    const req = this.get(request_id);
    if (!req || (req.status !== 'pending' && req.status !== 'approved' && req.status !== 'running')) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const list = this.waiters.get(request_id);
        if (list) {
          const i = list.indexOf(finish);
          if (i >= 0) list.splice(i, 1);
          if (list.length === 0) this.waiters.delete(request_id);
        }
        resolve();
      };
      const timer = setTimeout(finish, Math.max(0, timeoutMs));
      if (typeof (timer as any).unref === 'function') (timer as any).unref();
      const list = this.waiters.get(request_id) ?? [];
      list.push(finish);
      this.waiters.set(request_id, list);
    });
  }

  private transition(
    req: PrivilegedCommandRequest,
    status: PrivilegedCommandStatus,
    extra: { failure?: string } = {},
  ): void {
    if (req.status === status && !extra.failure) return;
    req.status = status;
    if (extra.failure) req.failure = extra.failure;
    for (const notify of this.waiters.get(req.request_id) ?? []) notify();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, req] of this.requests) {
      if (now <= req.expires_at) continue;
      if (req.status === 'pending') {
        this.transition(req, 'expired', { failure: 'no operator decision before the approval window closed' });
        // 결과를 집어갈 여유를 준다 — 바로 지우면 agent 는 "모르는 id" 만 본다.
        req.expires_at = now + RESULT_RETENTION_MS;
        continue;
      }
      if (req.status === 'approved' || req.status === 'running') {
        this.transition(req, 'done', { failure: 'the manager did not report a result in time' });
        req.ok = false;
        req.expires_at = now + RESULT_RETENTION_MS;
        continue;
      }
      this.requests.delete(id);
      this.waiters.delete(id);
    }
  }
}
