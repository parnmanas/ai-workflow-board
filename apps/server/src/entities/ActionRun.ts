import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

// One row per dispatch of an Action. The chat conversation that the agent
// holds with the user lives in the linked ChatRoom (room_id) — ActionRun is
// just the metadata: who triggered it, when, with what rendered prompt, and
// the room where the back-and-forth happened.
@Entity('action_runs')
@Index(['action_id', 'created_at'])
// 배치 완료 판정(completeRun)과 이력의 배치 묶음 조회가 batch_id로 run을
// 훑으므로 인덱스를 둔다 (티켓 fc3906c5).
@Index(['batch_id'])
export class ActionRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  action_id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  // 이 run을 수행하는 대상 에이전트 (티켓 fc3906c5). fan-out 이전에는 run에
  // 에이전트 식별자가 아예 없어서 방 참여자로만 역추적할 수 있었고, 한 Action의
  // 대상이 하나뿐이라 그래도 됐다. 이제는 같은 Action의 run들이 서로 다른
  // 에이전트에 속하므로 실행 이력을 에이전트별로 구분·감사하려면 run 자체에
  // 필요하다.
  //
  // 이 컬럼이 생기기 전 행은 ''로 남는다 — 그 시점의 Action 대상으로 소급
  // 백필하지 **않는다**. Action의 대상은 그 뒤로 편집됐을 수 있어서 현재 값을
  // 과거 run에 적어 넣으면 감사 기록을 지어내는 셈이 되기 때문이다. UI는 빈
  // 값을 "기록 없음"으로 정직하게 표시한다.
  @Column({ type: 'varchar', default: '' })
  agent_id: string;

  // 같은 트리거 1회에서 fan-out된 run들을 묶는 배치 키 (티켓 fc3906c5).
  // 디스패치마다 새로 발급되며, 대상이 1개뿐인 Action도 크기 1짜리 배치를
  // 받는다(경로를 하나로 유지). 실패한 run의 재시도는 **같은 batch_id를
  // 승계**하므로, 재시도가 떠 있는 동안 배치는 아직 미완으로 취급된다.
  //
  // 쓰임새 두 가지:
  //   1. source_ticket_id가 있는 배치는 **모든 run이 종료된 뒤 한 번만** 티켓을
  //      재개한다(ActionsService.completeRun).
  //   2. 실행 이력을 배치 단위로 묶어 전체 성공 / 부분 실패 / 전체 실패를
  //      구분해 보여준다.
  // 이 컬럼이 생기기 전 행은 ''이고, 그 경우 completeRun은 배치 로직을 타지
  // 않고 종전과 완전히 동일한 단일 run 경로로 동작한다.
  @Column({ type: 'varchar', default: '' })
  batch_id: string;

  // 배치 재개 1회성 클레임 (티켓 fc3906c5). source_ticket_id가 있는 fan-out
  // 배치는 **모든 run이 종료된 뒤 한 번만** 티켓을 재개해야 하는데, "내가
  // 마지막인가" 판정은 내 종료 전이(原子적)와 별개의 읽기라 경합이 난다:
  // run A와 B가 각자 종료를 커밋한 뒤 둘 다 "남은 running 0"을 보면 둘 다
  // 재개해 티켓이 두 번 디스패치된다.
  //
  // 그래서 재개 직전에 `batch_id = ? AND batch_resume_claimed = false` 를
  // 가드로 한 UPDATE를 배치 전체에 날리고, affected > 0 인 쪽만 재개한다
  // (기존 종료 전이와 같은 guarded-UPDATE 기법). 클레임은 남은 running이
  // 0일 때만 시도하므로, 클레임 이후 새 재시도 run이 배치에 합류하는 일은
  // 없다 — 합류하려면 그 시점에 실패할 run이 남아 있어야 한다.
  //
  // 크기 1짜리 배치(단일 대상)는 완료 호출 자체가 한 번뿐이라 경합이 없어
  // 클레임을 아예 건너뛴다 — 그 경로는 fan-out 이전과 동일하게 유지된다.
  @Column({ type: 'boolean', default: false })
  batch_resume_claimed: boolean;

  // The ChatRoom hosting the agent ↔ user conversation for this Run.
  @Column({ type: 'varchar' })
  room_id: string;

  // 'user' | 'system' (scheduler) | 'agent' (future: agent-triggered runs)
  @Column({ type: 'varchar', default: 'user' })
  triggered_by_type: string;

  // user_id when triggered_by_type='user'; '' for 'system'.
  @Column({ type: 'varchar', default: '' })
  triggered_by_id: string;

  // The actual prompt sent to the agent after `{{var}}` interpolation.
  // Stored verbatim so the history view can show what the agent received,
  // even after the Action's prompt template has been edited.
  @Column({ type: 'text', default: '' })
  prompt_rendered: string;

  // ── Auto-resume linkage (ticket 524bb434) ────────────────────────────────
  // The ticket that dispatched this run because it hit an Action-resolvable
  // blocker (a deploy, a publish, …) instead of parking for a human. '' when
  // the run came from cron / manual / on-ticket-done and has no ticket to
  // resume. On completion, `complete_action_run` uses this to re-dispatch the
  // source ticket's current-column role holders — the "동일 티켓에서 계속"
  // completion criterion. Kept as a plain id (no FK) to mirror the other
  // denormalized id columns on this table and survive source-ticket deletion.
  @Column({ type: 'varchar', default: '' })
  source_ticket_id: string;

  // `dispatch()`가 행을 생성하는 시점에 무조건 true로 세팅한다(티켓 2fa5312b,
  // b273d603 후속) — 이제 모든 run의 프롬프트는 source_ticket_id 유무와
  // 무관하게 완료 계약(renderCompletionContract 또는
  // renderStandaloneCompletionContract)을 싣기 때문에, 이 컬럼은 "그 코드로
  // 생성됐는지"를 표시한다. 덕분에 ActionRunReaperService의 스윕이
  // source_ticket_id 없는 run 중에서도 complete_action_run을 호출할 수 있는
  // run(이 컬럼이 생긴 이후 디스패치됨)과, 완료 계약을 못 받아 스스로 완료할
  // 방법이 아예 없는 pre-fix orphan을 구분할 수 있다 — 후자를 TTL로 reap하면
  // 정상일 수도 있는 run을 거짓 'failed'로 만들어버린다. 이 컬럼이 생기기
  // 전 행은 기본값 false(reap 불가 쪽)로 남으므로 pre-fix orphan이 자연히
  // 제외된다.
  @Column({ type: 'boolean', default: false })
  completion_contract_injected: boolean;

  // Run lifecycle: 'running' (dispatched, agent working) → 'succeeded' |
  // 'failed', set once by `complete_action_run`. The terminal transition is
  // idempotent — a second completion is a no-op so a re-invoked agent can't
  // double-resume the source ticket or double-count a retry. Legacy rows
  // predating this column read as 'running'; they are never auto-completed,
  // so the default is inert for historical data.
  @Column({ type: 'varchar', default: 'running' })
  status: string;

  // Free-text result the completing agent hands back: a success summary or a
  // failure reason. Mirrored into the source ticket's audit comment so the
  // outcome is reconstructable from the ticket alone.
  @Column({ type: 'text', default: '' })
  result_summary: string;

  // 1-based attempt counter. A failed run under the retry cap re-dispatches a
  // fresh run with attempt+1; the cap (ActionsService.MAX_RUN_ATTEMPTS) bounds
  // the loop so a persistently-failing high-impact Action can't retry forever.
  @Column({ type: 'int', default: 1 })
  attempt: number;

  // Run-level idempotency key (ticket 524bb434, scope 5). Minted once at the
  // first ticket-driven dispatch and carried VERBATIM across every bounded
  // retry re-dispatch of the same source-ticket→action chain, so the target
  // operation can dedupe repeated external effects (a redelivered deploy under
  // the same key is a no-op on the target side). Surfaced in the completion
  // contract appended to the run prompt. '' for cron / manual / on-ticket-done
  // runs that carry no ticket linkage.
  @Column({ type: 'varchar', default: '' })
  idempotency_key: string;

  // Human approval evidence for a high-impact run (ticket 524bb434, scope 5).
  // A high-impact Action dispatched by an agent to clear a ticket blocker only
  // runs when a real workspace admin approved it; `approved_by` is that user id
  // and `approved_at` the approval time, recorded on the run so who/when is
  // reconstructable. '' / NULL for low-impact runs and for human-initiated
  // (UI) or scheduler/hook runs that never pass through the approval gate.
  @Column({ type: 'varchar', default: '' })
  approved_by: string;

  @Column({ type: Date, nullable: true, default: null })
  approved_at: Date | null;

  // Set when status leaves 'running'. NULL while the run is still in flight.
  @Column({ type: Date, nullable: true, default: null })
  completed_at: Date | null;

  @CreateDateColumn()
  created_at: Date;
}
