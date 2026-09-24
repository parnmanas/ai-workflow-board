import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { randomBytes, timingSafeEqual } from 'crypto';
import { MemoryMetricsRegistry } from '../../services/memory-metrics.registry';

/**
 * 일회용 sudo 티켓 — Runtime Host 에서 권한 상승이 필요한 명령 하나를 위해
 * 운영자가 방금 입력한 비밀번호를, 저장하지 않고 매니저에게 한 번만 건네는 장치.
 *
 * ## 왜 이 모양인가
 *
 * 비밀번호를 `agent_manager_command` 의 args 에 실어 SSE 로 보내면 안 된다. 그
 * 페이로드는 이벤트 레지스트리를 통과하고, 디스패치 기록·활동 로그로 이어지며,
 * 재전송 경로가 있다. 대신 SSE 에는 **티켓 id 만** 싣고, 매니저가 권한 상승이
 * 실제로 필요한 순간에 HTTPS + `X-Agent-Key` 로 직접 당겨 간다 — Agent Session 이
 * credential 원문을 받는 `GET /api/agent/sessions/credential/:id` 와 같은 모양이고,
 * 같은 이유다.
 *
 * ## 불변식
 *
 * - **메모리에만** 산다. 디스크·DB·로그 어디에도 쓰지 않는다. 프로세스가 죽으면
 *   같이 사라지는 것이 맞다 — 재기동 뒤에도 쓸 수 있는 root 비밀번호는 그 자체로
 *   "저장된 비밀번호" 이고, 운영자가 고른 것은 일회용이다.
 * - **1회용.** `consume()` 은 값을 돌려주는 즉시 지운다. 매니저가 재시도하려면
 *   운영자가 다시 눌러야 한다.
 * - **짧다.** TTL 120초. 운영자가 누른 시점과 매니저가 집는 시점 사이의 왕복
 *   한 번을 덮을 만큼만이고, 그 이상 살아 있을 이유가 없다.
 * - **대상에 묶인다.** 티켓은 발급 시점의 `instance_id`/`agent_id`/`scope` 를 함께
 *   기억한다. 티켓 id 가 새더라도 다른 매니저가, 혹은 같은 매니저가 다른 대상에
 *   대해 쓸 수 없다.
 * - **id 는 상수시간으로 비교한다.** 조회는 Map 이지만 소유권 확인은 값 비교라
 *   타이밍 차이가 새지 않게 한다.
 */

/** 이 티켓으로 무엇을 할 수 있는지. 발급 시점에 고정되고 매니저가 대조한다. */
export type SudoTicketScope =
  /** CLI 설치본 하나를 올린다. `bin` 은 매니저가 스스로 열거한 설치본이어야 한다. */
  | { kind: 'cli_update'; cli: string; bin: string }
  /** 운영자가 승인한 권한 상승 명령 하나(세션/채팅 경로). */
  | { kind: 'privileged_command'; request_id: string };

interface SudoTicket {
  ticket_id: string;
  instance_id: string;
  /** 이 티켓을 집어 갈 수 있는 매니저 Agent identity. */
  agent_id: string;
  scope: SudoTicketScope;
  /** 운영자가 방금 입력한 값. 이 필드는 어떤 경로로도 밖으로 나가지 않는다 —
   *  오직 `consume()` 의 반환값으로만. */
  password: string;
  issued_by: string;
  expires_at: number;
}

/** 운영자가 누른 시점과 매니저가 집는 시점 사이의 왕복 한 번을 덮는 길이. */
export const SUDO_TICKET_TTL_MS = 120 * 1000;
const SWEEP_INTERVAL_MS = 30 * 1000;

export interface SudoTicketMint {
  ticket_id: string;
  expires_at: string;
}

/** `consume()` 의 결과. 실패 사유를 구분해야 매니저가 운영자에게 정확히 알린다. */
export type SudoTicketConsume =
  | { ok: true; password: string; scope: SudoTicketScope }
  | { ok: false; reason: 'unknown' | 'expired' | 'wrong_manager' };

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

@Injectable()
export class SudoTicketService implements OnModuleDestroy {
  private readonly tickets = new Map<string, SudoTicket>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(metrics: MemoryMetricsRegistry) {
    // 개수만 노출한다. 내용은 메트릭에도 싣지 않는다.
    metrics.register('agentManager.sudoTickets', () => this.tickets.size);
    this.timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    if (this.timer && typeof (this.timer as any).unref === 'function') {
      (this.timer as any).unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.wipeAll();
  }

  mint(input: {
    instance_id: string;
    agent_id: string;
    scope: SudoTicketScope;
    password: string;
    issued_by: string;
  }): SudoTicketMint {
    const ticket_id = randomBytes(24).toString('hex');
    const expires_at = Date.now() + SUDO_TICKET_TTL_MS;
    this.tickets.set(ticket_id, { ticket_id, ...input, expires_at });
    return { ticket_id, expires_at: new Date(expires_at).toISOString() };
  }

  /**
   * 티켓을 **소비한다** — 성공하든 실패하든 돌아간 뒤에는 그 id 로 다시 집을 수
   * 없다. 잘못된 매니저가 집으려 한 경우에도 지운다: 그 시점에서 이미 티켓 id 가
   * 샜다는 뜻이므로, 정당한 매니저에게 남겨 두는 것보다 태워 버리는 쪽이 맞다
   * (운영자는 다시 누르면 된다).
   */
  consume(ticket_id: string, requestingAgentId: string): SudoTicketConsume {
    const ticket = this.tickets.get(ticket_id);
    if (!ticket) return { ok: false, reason: 'unknown' };
    this.tickets.delete(ticket_id);
    if (Date.now() > ticket.expires_at) {
      this.wipe(ticket);
      return { ok: false, reason: 'expired' };
    }
    if (!constantTimeEquals(ticket.agent_id, requestingAgentId)) {
      this.wipe(ticket);
      return { ok: false, reason: 'wrong_manager' };
    }
    const password = ticket.password;
    this.wipe(ticket);
    return { ok: true, password, scope: ticket.scope };
  }

  /** 발급만 하고 쓰이지 않은 티켓을 운영자가 취소할 때(모달을 닫는 등). */
  revoke(ticket_id: string): void {
    const ticket = this.tickets.get(ticket_id);
    if (!ticket) return;
    this.tickets.delete(ticket_id);
    this.wipe(ticket);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, ticket] of this.tickets) {
      if (now > ticket.expires_at) {
        this.tickets.delete(id);
        this.wipe(ticket);
      }
    }
  }

  private wipeAll(): void {
    for (const ticket of this.tickets.values()) this.wipe(ticket);
    this.tickets.clear();
  }

  /** 객체에서 비밀번호 참조를 끊는다. V8 힙의 문자열 자체는 GC 전까지 지울 수
   *  없으므로 이건 "완전 삭제" 가 아니라 **참조 수명을 최소화**하는 것이다 —
   *  그 한계를 알고 쓰라고 여기 적어 둔다. */
  private wipe(ticket: SudoTicket): void {
    (ticket as { password: string }).password = '';
  }
}
