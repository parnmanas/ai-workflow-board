import { MigrationInterface, QueryRunner } from 'typeorm';
import { Workspace } from '../../entities/Workspace';
import { PromptTemplate } from '../../entities/PromptTemplate';
import { DEFAULT_PROMPT_TEMPLATES } from '../default-prompt-templates';

/**
 * ticket eb4f09b6 — refresh the To Do default workflow prompt template on
 * existing workspaces so already-installed boards pick up the prerequisite-
 * registration fix for the concurrent-work "Wait" branch:
 *   - todo_workflow: when the assignee decides to Wait on their own
 *     in-progress ticket (file/module overlap), the guide previously told
 *     them to leave a comment and explicitly do neither `move_ticket` nor
 *     `pend_ticket` — a bare-comment wait with no matching ticket-state
 *     change. That is the root cause ticket fec25d90 traced: DispatchReconciler
 *     / StuckTicketDetector have no way to read "assignee decided to wait" out
 *     of a comment, so the ticket looked idle and re-entered the
 *     redispatch/escalation loop. The Wait branch now also calls
 *     `mcp__awb__add_ticket_prerequisites`, naming the in-progress ticket as
 *     the blocker. That sets `pending_on_tickets=true`, which
 *     StuckTicketDetector's `_intentionalWaitReason` already reads as
 *     `open_prerequisite` (an intentional wait, same posture as
 *     `pend_ticket`'s `pending_user_action`) and agent-workload's focus
 *     selector already excludes from anchoring — both were shipped with the
 *     add_ticket_prerequisites tool itself (ticket 48d14fff), so no runtime
 *     code changes here, only the guide catching up to a tool the assignee
 *     wasn't yet told to use for this specific decision point. The section
 *     also now states the rule of thumb for choosing `add_ticket_prerequisites`
 *     over `pend_ticket` (human decision vs. another ticket finishing) and
 *     explains the auto-resume behavior (the block clears and this ticket's
 *     current-column holders are re-triggered the moment the named ticket
 *     lands on a terminal column — no `unpend_ticket` needed).
 *
 * Same operator-safety contract as every prior refresh migration
 * (1760000000022 / 30 / 31 / 36 / 42 / 44 / 46 / 49 / 52 / 72 / 73 / 76 / 79):
 *   - row.content must byte-exact match a PRIOR_PREREQUISITE_WAIT_CONTENTS
 *     literal to be touched at all.
 *   - Operator customizations / drift are left completely alone.
 *   - INSERT is never performed here (seed/backfill paths own that).
 *   - Idempotent: after a first successful run every row already holds
 *     `current` (read live from DEFAULT_PROMPT_TEMPLATES, never a frozen
 *     snapshot), so a re-run's `row.content === target` short-circuit
 *     leaves it untouched.
 *
 * PRIOR_PREREQUISITE_WAIT_CONTENTS captured via tsx + JSON.stringify from
 * `apps/server/src/database/default-prompt-templates.ts` at the commit just
 * before this ticket's edit (same extraction method 072/073/076/79 used).
 */

export const PRIOR_PREREQUISITE_WAIT_CONTENTS: Record<string, string[]> = {
  todo_workflow: ["# To Do — Start-or-Wait Decision (assignee)\n\n> 🔗 **AWB Artifact reference 규칙** — Ticket, Agent, Board, Action, Function, Schedule을 출력할 때\n> 반드시 `#[type:<full-uuid>|사람이 읽을 수 있는 이름]` 형식을 사용하라. 축약 ID만 단독으로 쓰지 마라.\n> `@[agent:...]`는 알림/소환이 필요할 때만 사용한다. 존재 또는 권한을 확인할 수 없는 대상은 가짜 ref를 만들지 말고\n> 이름, 전체 안정 ID, 연결 불가 사유를 평문으로 명시하라.\n> **Current-column boundary (mandatory)** — This guide defines the complete stage scope. Perform only the work and completion checks explicitly required here. Do not pre-run review, merge, deployment, release, cleanup, verification, or completion-audit work assigned to a later column. Do not add optional audits, refactors, documentation, or publishing. Inspect the ticket, repository, git history, and available AWB context first; proceed with safe reversible assumptions, and ask only when a concrete product decision, unavailable credential/permission, missing required input, or irreversible risk blocks this stage.\n> 🔎 **선(先) 조사 원칙** — 질문하거나 대기하기 전에 코드, git 이력(`git log`, `git blame`, `git show`), 티켓 코멘트로 먼저 스스로 답을 찾아라. 저장소 탐색·기존 패턴과 최근 이력 조사·구현 세부 결정·테스트와 검증은 이 역할이 자율적으로 수행한다. 코드와 이력으로 해결 가능한 내용을 다른 역할이나 사람에게 재질문하지 마라 — 진짜 설계 판단이나 사람만 답할 수 있는 정보가 남았을 때만 질문하라.\n> 🗂️ **작업 폴더 규약 (worktree 규약 ④)** — AWB 가 이 티켓에 배정한 작업 폴더는 `{{AWB_WORK_FOLDER}}` 이다.\n> git worktree · 브랜치 체크아웃 · 빌드 · 테스트 등 파일을 만지는 모든 작업은 **이 폴더 안에서만** 수행하라.\n> repo 트리 밖 · 홈 디렉터리 · `/tmp` · 다른 드라이브(예: `D:\\...`)에 worktree/체크아웃을 **새로 만들지 마라** — AWB 가 이미 폴더를 정해 배정했다.\n> 작업이 끝나면 이 폴더 안에서 정리하라.\n\nThis ticket is in the To Do column and you are its assignee. Decide whether to start now or wait.\n\n> **Environment**: assignee has a local repo and will do real development. No git commands yet — those begin in `in_progress_workflow`. This prompt is purely a decision step.\n\n## Steps\n\n1. **Read the ticket** — `mcp__awb__get_ticket` to load body, comments, assignee / reporter / reviewer, priority, and any attached context. If requirements are unclear, leave a question comment and stop (do not `move_ticket`).\n\n2. **List your in-progress work** — `mcp__awb__get_my_tickets` with `status=\"in_progress\"` to see everything you are currently working on.\n\n3. **Concurrent-work check**:\n   - **No active work** → safe to start immediately.\n   - **Active work exists** → for each in-progress ticket, evaluate:\n     - **File / module overlap** — will this ticket touch the same files, modules, or packages?\n     - **Dependency** — does this ticket need output (API, entity, migration, schema) from the in-progress ticket?\n     - **Shared resources** — DB migrations, CI pipelines, or shared config files that are hard to isolate.\n   - If *every* in-progress ticket is independent, parallel is OK. A single overlap means **wait**.\n\n4. **Decision**:\n   - **Start** → `add_comment` with:\n     - A one-line \"starting\" declaration.\n     - If running in parallel: list concurrent ticket ids and the independence rationale (e.g., `\"touching apps/client/src/components/chat/* only — no overlap with ticket 1f92d68\"`).\n     Then `move_ticket` to **In Progress** (if two or more distinct agents share the assignee role on this ticket, the move is consensus-gated — see **Multi-holder consensus gate** below).\n   - **Wait** → `add_comment` with the waiting reason and which ticket you are waiting on. Do **not** `move_ticket` and do **not** `pend_ticket` — this is a self-resolving sequencing choice (your own concurrent work), not a human blocker, so parking it would be pointless; you'll be re-triggered and re-check once something changes. Don't repeat the identical \"still waiting\" note on every re-trigger with nothing new to report — say so once and let the next real event (the other ticket finishing, a new comment) bring you back.\n\n5. **After In Progress** — `in_progress_workflow` takes over with the branch → work → push → Review hand-off flow.\n\n## Multi-holder consensus gate\n\nIf **two or more distinct holders** (agents or users, counted across this column's routing role(s) — the same party wearing several hats counts once) share the ticket here, the server gates **every move out of this column — forward or bounce-back —** on **unanimous explicit agreement**: a direct `move_ticket` is rejected with a `consensus_required` error naming the holders still pending, and no co-holder may advance the ticket unilaterally. **Single-holder tickets are unaffected: the gate never fires and you move exactly as before.**\n\nTo advance a co-held ticket:\n\n1. **Discuss** in normal comments (mention your co-holders so they're triggered). Plain notes are *not* votes.\n2. **Propose** — `mcp__awb__propose_move` to the target column. The proposal comment itself fans out to your co-holders (no extra mention needed); its id is the vote anchor, and a newer proposal supersedes it (votes on the old one go stale).\n3. **Vote** — every holder casts `mcp__awb__record_agreement` with `status=\"agree\"` (or `\"object\"`, rationale in `content`). `proposal_id` can be omitted — the latest open proposal is the anchor. Vote comments never re-trigger anyone (no echo loop). Silence ≠ consent; only your latest signal counts.\n4. **Server auto-moves** — the instant every required holder has agreed on the current proposal, the server performs the move itself (actor `Consensus`). Nobody calls `move_ticket`. Unanimous signals without an open proposal never auto-move — open the proposal first.\n\nThe reporter may `record_agreement(..., override=true)` to force-pass a deadlock — honored only while holding the reporter role, and audit-logged. `move_ticket(force=true)` also bypasses the gate (any caller — no reporter check — and it skips the terminal-reopen and review-approval guards too); it is a human/operator escape hatch, never an agent's way around consensus.\n\n## Actions — run a registered Action before you Pending\n\nBefore you `pend_ticket` for something an automated operation could do — a deploy, a publish, a merge-to-production, kicking a pipeline, running a scripted task — first check whether a registered **Action** already does it. The server enforces this: `pend_ticket` is **rejected while runnable Actions exist** unless you pass `no_action_reason` explaining why none apply.\n\nAn **Action** is a saved, named prompt pinned to a target agent; running one dispatches that work to the agent and returns a run you can watch. \"A deploy is needed\" is almost always a *run an Action* situation (this board already carries a `Merge To Production.Private and PUSH` deploy Action), not a *park for a human* one.\n\n1. **Discover** — `mcp__awb__list_actions(workspace_id)`, `search_actions` by keyword, `get_action` for the full prompt. Match names/descriptions against the blocker you hit.\n2. **Run an existing Action — linked to THIS ticket so it auto-resumes** — if one fits, `mcp__awb__run_action(action_id, source_ticket_id=\"<this ticket id>\")` → `{run_id, room_id}`. Passing `source_ticket_id` is what closes the loop: the target agent is told to report its outcome with `complete_action_run`, and **on success this ticket auto-resumes in place** (its role holders are re-dispatched) with the result posted to the audit trail. You do not have to poll — but you can watch progress with `list_action_runs(workspace_id, action_id)`. Do **not** park.\n3. **Register a new Action** — nothing fits but the operation is safe and well-defined? `mcp__awb__save_action(workspace_id, name, prompt, target_agent_id, …)`, then `run_action(action_id, source_ticket_id=\"<this ticket id>\")`. Same auto-resume applies. Keep the prompt idempotent and narrowly scoped.\n4. **Failure / retry is handled server-side** — the target agent reports `complete_action_run(status=\"failed\", …)`; the server retries the run automatically (bounded, fresh run per attempt). After the retry cap it surfaces the failure back to this ticket and resumes it so you can fix the inputs and re-run, or — only if it genuinely needs a human — `pend_ticket` with a specific `no_action_reason`. Every attempt and outcome is recorded on the ticket's audit trail.\n5. **High-impact Actions** (deploy / push-to-production / anything outward-facing) — the run lifecycle enforces the safety floor: the terminal `succeeded`/`failed` transition is **idempotent** (a re-invoked agent cannot double-fire a resume or double-count a retry) and the retry loop is **bounded**. On top of that, honour the Action's own approval + idempotency guards, never run one you cannot attribute, and let the auto-posted outcome comment stand as the audit record.\n\n**If you are the agent running an Action** (the target of a `run_action` dispatch), your prompt carries a completion contract: do the work, then call `complete_action_run(run_id, workspace_id, status, summary)` exactly once so the waiting ticket resumes.\n\n**Then, and only then, Pending** — reserve `pend_ticket` for what an Action cannot resolve: a human decision, a credential/secret you cannot obtain, an approval only a person can grant, or a missing requirement only the reporter can supply. When you pend past runnable Actions, pass `no_action_reason` with the *specific* reason none apply (e.g. `\"prod approval needs a human signer — no Action covers the sign-off\"`); it is recorded on the ticket's audit trail.\n\n## Notes\n\n- If you already have **3 or more in-progress tickets**, finish one before starting a new one. Context-switch cost outweighs concurrency.\n- Never start a ticket whose file / module scope overlaps with an active one. Sequential is the default.\n- When in doubt about a requirement, investigate the code and git history yourself first (see the 선(先) 조사 원칙 above); if a real question remains, ask the reviewer or reporter via `add_comment` and, if it's genuinely blocking, `pend_ticket` too — see the note below. Never start on a guess.\n- If a `priority: critical` ticket enters the queue, finish the current commit boundary (commit + push) on your non-critical work cleanly, then pick the critical. Never abandon mid-file.\n- If you are not the assignee, do not `move_ticket`. If this looks like a misassignment, leave a comment and stop.\n- **Don't bounce a ticket back to wait.** If a question to the reporter is the real blocker, leave the comment AND call `mcp__awb__pend_ticket` with a `reason`. This releases the focus so other tickets get worked on while this one waits, and the User tab on the ticket panel surfaces the ask. Bouncing through To Do ↔ another column without parking just re-triggers you in a loop.\n"],
};

export class RefreshDefaultPromptTemplatesPrerequisiteWait1760000000080
  implements MigrationInterface
{
  name = 'RefreshDefaultPromptTemplatesPrerequisiteWait1760000000080';

  private async apply(queryRunner: QueryRunner, direction: 'up' | 'down'): Promise<void> {
    const manager = queryRunner.manager;
    const wsRepo = manager.getRepository(Workspace);
    const tplRepo = manager.getRepository(PromptTemplate);

    const currentByName = new Map<string, string>();
    for (const def of DEFAULT_PROMPT_TEMPLATES) {
      if (def.name in PRIOR_PREREQUISITE_WAIT_CONTENTS) {
        currentByName.set(def.name, def.content);
      }
    }

    const workspaces = await wsRepo.find();
    let updated = 0;
    let customized = 0;
    let missing = 0;
    let alreadyMatchesTarget = 0;

    for (const ws of workspaces) {
      for (const name of Object.keys(PRIOR_PREREQUISITE_WAIT_CONTENTS)) {
        const row = await tplRepo.findOne({
          where: { workspace_id: ws.id, name },
        });
        if (!row) {
          missing++;
          continue;
        }
        const current = currentByName.get(name)!;
        // up: prior → current. down: current → prior (symmetric swap, same
        // exact-match discipline both directions — same shape as 072/073/076/79).
        const target = direction === 'up' ? current : PRIOR_PREREQUISITE_WAIT_CONTENTS[name][0];
        const sourceList = direction === 'up' ? PRIOR_PREREQUISITE_WAIT_CONTENTS[name] : [current];
        if (row.content === target) {
          alreadyMatchesTarget++;
          continue;
        }
        if (sourceList.includes(row.content)) {
          row.content = target;
          await tplRepo.save(row);
          updated++;
        } else {
          // Operator customization / independent drift — leave it alone.
          customized++;
        }
      }
    }

    console.log(
      `[eb4f09b6 migration] prompt template refresh (todo prerequisite wait) ${direction}: ` +
        `updated=${updated} alreadyMatchesTarget=${alreadyMatchesTarget} ` +
        `customized=${customized} missing=${missing} ` +
        `across ${workspaces.length} workspace(s)`,
    );
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.apply(queryRunner, 'up');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.apply(queryRunner, 'down');
  }
}
