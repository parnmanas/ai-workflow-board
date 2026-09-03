/**
 * 랜딩 lease MCP 도구 (ticket e630b530) — Merging 의 "CI 검증 시작 → 랜딩"
 * 구간을 저장소별로 직렬화하는 표면.
 *
 * 도구:
 *   - await_merge_lease   — lease 를 획득하거나 FIFO 큐에 등록한다. 큐에 걸리면
 *                           `pending_merge_lease=true` 로 파킹되고, 차례가 오면
 *                           MergeLeaseSweepService 가 현재 컬럼 role holder 를
 *                           자동 재디스패치한다(턴을 끝내면 된다).
 *   - release_merge_lease — 명시적 해제. 정상 경로(Done 이동 / 바운스 / pend)는
 *                           서버가 컬럼 이동 트랜잭션에서 자동 해제하므로 보통
 *                           부를 필요가 없다 — 랜딩을 포기하고 lease 만 놓아줄
 *                           때 쓰는 탈출구다.
 *
 * `await_ci_run`(외부 CI run 대기) / `add_ticket_prerequisites`(다른 티켓 대기)
 * / `pend_ticket`(사람 대기) 와 구분되는 네 번째 대기 종류다.
 *
 * 파일명 컨벤션으로 `tools/index.ts` 의 로더가 자동 등록한다.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, err } from '../shared/helpers';
import { loadTicketFull } from '../shared/ticket-parsing';
import { getCallerAgent } from '../shared/session-auth';
import { MergeLeaseService } from '../../tickets/merge-lease.service';
import type { ToolContext } from './context';

export function registerMergeLeaseTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, activityService } = ctx;
  // 통합 서버에서는 DI 싱글턴을 재사용하고, standalone 모드에서는 얇은 인스턴스를
  // 만든다(서비스가 dataSource + activity 위에서 상태를 갖지 않는다) —
  // ci-wait-tools.ts 와 같은 폴백 모양.
  const svc = (ctx as any).mergeLeaseService || new MergeLeaseService(dataSource as any, activityService);

  server.tool(
    'await_merge_lease',
    'Acquire (or queue for) the repo-scoped LANDING LEASE before rebasing + dispatching pre-landing CI in the Merging workflow. ' +
      'While one ticket holds the lease for a (repo, base branch), no other AWB ticket lands on that branch — so the base cannot advance under your CI run and invalidate the SHA you just verified. ' +
      'Call this ONCE at the top of Merging step 2, every time you enter step 2 (a re-entry means the fast-forward failed and you are re-verifying, which spends one attempt of the bounded budget). ' +
      'Returns `outcome`: "granted" (proceed), "queued" (you are parked — do NOT poll or sleep, just end your turn; the server re-dispatches this ticket the moment the lease is yours), or "degraded" (proceed WITHOUT a lease — the board disabled it, the repo could not be resolved, or the service errored). ' +
      'It NEVER hard-blocks: a degraded result is always safe to proceed on, it just means you may hit the ordinary rebase/CI re-verification loop. ' +
      'Also returns `budget`: "exhausted" means the bounded re-verification budget is spent — stop retrying, comment what happened, and bounce or pend explicitly rather than looping. ' +
      'Any authenticated agent caller may take the lease for any non-archived ticket (same posture as await_ci_run — no ticket-ownership check); the holder identity recorded is the TICKET, not your session, so a resumed session re-acquiring the same lease is a no-op grant.',
    {
      ticket_id: z.string().describe('The Merging ticket that wants to land'),
    },
    async ({ ticket_id }, extra: { sessionId?: string }) => {
      const caller = getCallerAgent(extra);
      try {
        const result = await svc.acquire(ticket_id, {
          actorId: caller?.agentId,
          actorName: caller?.agentName,
        });
        const full = await loadTicketFull(dataSource, ticket_id);
        return ok({
          outcome: result.outcome,
          lease_id: result.lease_id || '',
          position: result.position,
          ahead_ticket_id: result.ahead_ticket_id || '',
          degrade_reason: result.degrade_reason || '',
          attempt: result.attempt,
          max_attempts: result.max_attempts,
          budget: result.budget,
          base_branch: result.scope?.baseBranch || '',
          ticket: full,
        });
      } catch (e: any) {
        // 여기까지 오면 안 되지만(서비스가 스스로 degrade 한다), 도구 표면에서도
        // 하드 블록을 만들지 않는다 — 랜딩을 막는 것보다 lease 없이 진행이 낫다.
        return ok({
          outcome: 'degraded',
          degrade_reason: `tool_error: ${e?.message || 'unknown'}`,
          lease_id: '',
        });
      }
    }
  );

  server.tool(
    'release_merge_lease',
    'Release this ticket\'s landing lease (or drop its place in the queue) immediately. ' +
      'You normally do NOT need this: leaving the Merging column — to Done after landing, bounced back to In Progress, or pended — releases the lease inside the very same column-move transaction, server-side. ' +
      'Use it only when you are abandoning the landing attempt but staying in Merging (e.g. you must wait on something long and do not want to hold the whole repo\'s landing window). ' +
      'Idempotent — releasing when nothing is held is a no-op (`released: false`). ' +
      'Any authenticated agent caller may release any non-archived ticket\'s lease (same posture as cancel_ci_wait).',
    {
      ticket_id: z.string().describe('The ticket whose lease should be released'),
      reason: z.string().optional().describe('Short audit reason recorded on the lease row (default "released_by_agent").'),
    },
    async ({ ticket_id, reason }, extra: { sessionId?: string }) => {
      const caller = getCallerAgent(extra);
      try {
        const result = await svc.release(ticket_id, reason || 'released_by_agent', {
          actorId: caller?.agentId,
          actorName: caller?.agentName,
        });
        const full = await loadTicketFull(dataSource, ticket_id);
        return ok({ released: result.released, reason: result.reason, ticket: full });
      } catch (e: any) {
        return err(e?.message || 'Failed to release merge lease');
      }
    }
  );
}
