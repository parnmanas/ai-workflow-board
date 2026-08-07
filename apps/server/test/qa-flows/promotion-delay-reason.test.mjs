// QA flow: promotion-delay alert exposes its skip reason (ticket bb5b9aed).
//
// What this proves
// ─────────────────
//
// Before this fix, the promotion-delay chat alert only ever said
// `Cause: promotion-delay · waiting in intake for Xh` — even though the
// server already knows EXACTLY why (BacklogPromotionService's
// `backlog_promotion_skipped_role_unfilled` / `_focus_held` audit rows), so
// every recipient had to go dig through activity logs, and easily misread
// "still waiting" as "the 9df6c348 promotion deadlock is back". This proves
// `_resolvePromotionDelayReasonSuffix` surfaces the real cause, worded
// differently per cause since the operator action differs:
//
//   1. role_unfilled + board HAS a default for that slug → "will self-heal"
//      wording (no human action implied).
//   2. role_unfilled + board has NO default for that slug → explicit
//      "board 기본 담당자 미설정, 자동 복구 불가" — a human must staff it.
//   3. focus_held → holder display name + occupied ticket id, worded as a
//      normal wait ("조치 불필요일 수 있음") — never confused with #2.
//   4. no skip audit row at all → message text is UNCHANGED from the
//      pre-bb5b9aed wording (no fabricated "사유:" clause).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  createWorkspace, createAgent, createBoard, createColumn, createTicket,
} from '../helpers/fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', '..', 'dist');

process.env.PORT = process.env.QA_PROMOTION_DELAY_REASON_PORT || '7925';

function systemMsgs(messages) {
  return messages.filter(m => m.sender_type === 'system');
}

test('StuckTicketDetector promotion-delay alert surfaces the skip reason', async (t) => {
  step('Boot NestJS app on test port');
  process.env.STUCK_DETECTOR_ENABLED = 'true';
  process.env.STUCK_DETECTOR_SWEEP_MS = '900000';
  process.env.STUCK_DETECTOR_MIN_AGE_MS = String(2 * 60 * 60_000); // 2h grace
  process.env.STUCK_DETECTOR_PROMOTION_DELAY_MS = String(2 * 60 * 60_000); // 2h threshold
  process.env.STUCK_DETECTOR_REALERT_MS = String(24 * 60 * 60_000);

  const { app, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());

  const detectorModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'stuck-ticket-detector.service.js')
  );
  const detector = app.get(detectorModule.StuckTicketDetectorService);

  step('Seed workspace + alert room + holder agent');
  const ws = await createWorkspace(app, getDataSourceToken, 'promo-delay-reason');
  const bobAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'bob' });

  const roomRepo = ds.getRepository('ChatRoom');
  const messageRepo = ds.getRepository('ChatRoomMessage');
  const ticketRepo = ds.getRepository('Ticket');
  const boardRepo = ds.getRepository('Board');
  const activityRepo = ds.getRepository('ActivityLog');
  const room = await roomRepo.save(roomRepo.create({ workspace_id: ws.id, type: 'group', name: 'qa-alerts' }));

  const now = new Date();
  const HOUR = 3_600_000;

  async function makeBoard(name) {
    const board = await createBoard(app, getDataSourceToken, ws.id, { name });
    const intake = await createColumn(app, getDataSourceToken, board.id, {
      name: 'Backlog', position: 0, workspaceId: ws.id, kind: 'intake', roleRouting: [],
    });
    const active = await createColumn(app, getDataSourceToken, board.id, {
      name: 'To Do', position: 1, workspaceId: ws.id, kind: 'active', roleRouting: ['assignee'],
    });
    return { board, intake, active };
  }

  async function makeStaleCandidate(intakeColId, title) {
    const ticket = await createTicket(app, getDataSourceToken, {
      columnId: intakeColId, workspaceId: ws.id, title, priority: 'high',
    });
    await ticketRepo.update(ticket.id, {
      created_at: new Date(now.getTime() - 3 * HOUR),
    });
    return ticket;
  }

  async function seedSkipAudit(ticket, action, extra) {
    await activityRepo.save(activityRepo.create({
      workspace_id: ws.id, entity_type: 'ticket', entity_id: ticket.id, ticket_id: ticket.id,
      actor_id: 'system', actor_name: 'BacklogPromotionService', action, role: 'assignee',
      new_value: extra,
      trigger_source: 'backlog_promotion',
    }));
  }

  function alertFor(msgs, ticketId) {
    return msgs.find(m => m.content.includes(ticketId) && /Promotion-delay detected/.test(m.content));
  }

  // ────────────────────────────────────────────────────────────────────
  // Case 1 — role_unfilled + board HAS a default for the vacant slug.
  // ────────────────────────────────────────────────────────────────────
  step('Case 1 — role_unfilled, board default configured → self-heal wording');
  const c1 = await makeBoard('promo-reason-case1');
  await boardRepo.update(c1.board.id, {
    default_role_assignments: JSON.stringify({ assignee: [{ agent_id: bobAgent.id }] }),
  });
  const t1 = await makeStaleCandidate(c1.intake.id, 'role-unfilled-with-default');
  await seedSkipAudit(t1, 'backlog_promotion_skipped_role_unfilled',
    `board=${c1.board.id} role=assignee dest_column_id=${c1.active.id}`);

  // ────────────────────────────────────────────────────────────────────
  // Case 2 — role_unfilled + board has NO default for the vacant slug.
  // ────────────────────────────────────────────────────────────────────
  step('Case 2 — role_unfilled, no board default → explicit "needs a human" wording');
  const c2 = await makeBoard('promo-reason-case2');
  const t2 = await makeStaleCandidate(c2.intake.id, 'role-unfilled-no-default');
  await seedSkipAudit(t2, 'backlog_promotion_skipped_role_unfilled',
    `board=${c2.board.id} role=assignee dest_column_id=${c2.active.id}`);

  // ────────────────────────────────────────────────────────────────────
  // Case 3 — focus_held (self-resolving wait, distinct wording).
  // ────────────────────────────────────────────────────────────────────
  step('Case 3 — focus_held → holder name + occupied ticket, "wait is normal" wording');
  const c3 = await makeBoard('promo-reason-case3');
  const t3 = await makeStaleCandidate(c3.intake.id, 'focus-held candidate');
  const occupiedTicketId = 'ffffffff-0000-4000-8000-000000000000';
  await seedSkipAudit(t3, 'backlog_promotion_skipped_focus_held',
    `board=${c3.board.id} role=assignee holder=${bobAgent.id} focus_ticket_id=${occupiedTicketId}`);

  // ────────────────────────────────────────────────────────────────────
  // Case 4 — no skip audit row at all → wording unchanged (cause unknown).
  // ────────────────────────────────────────────────────────────────────
  step('Case 4 — no audit row → base message text unchanged, no fabricated 사유');
  const c4 = await makeBoard('promo-reason-case4');
  const t4 = await makeStaleCandidate(c4.intake.id, 'no-audit-row candidate');

  step('Sweep once — evaluate all four candidates in one pass');
  await detector.sweep(now);

  const msgs = systemMsgs(await messageRepo.find({ where: { room_id: room.id } }));

  const a1 = alertFor(msgs, t1.id);
  assert.ok(a1, 'case 1 must post a promotion-delay alert');
  assert.ok(a1.content.includes('Cause: promotion-delay · waiting in intake for'),
    'base cause line must still be present');
  assert.ok(a1.content.includes('사유: assignee 역할 공석'),
    `case 1 must name the vacant slug (got: ${a1.content})`);
  assert.ok(a1.content.includes('보드 기본 담당자로 자동 복구 대기 중'),
    `case 1 (default configured) must use self-heal wording, not the no-default wording (got: ${a1.content})`);
  assert.ok(!a1.content.includes('자동 복구 불가'),
    'case 1 must NOT claim auto-recovery is impossible — a default IS configured');

  const a2 = alertFor(msgs, t2.id);
  assert.ok(a2, 'case 2 must post a promotion-delay alert');
  assert.ok(a2.content.includes('사유: assignee 역할 공석'),
    `case 2 must name the vacant slug (got: ${a2.content})`);
  assert.ok(a2.content.includes('보드 기본 담당자 미설정') && a2.content.includes('자동 복구 불가'),
    `case 2 (no default) must explicitly say auto-recovery is impossible (got: ${a2.content})`);
  assert.ok(!a2.content.includes('자동 복구 대기 중'),
    'case 2 must NOT use the self-heal wording — there is no default to backfill from');

  const a3 = alertFor(msgs, t3.id);
  assert.ok(a3, 'case 3 must post a promotion-delay alert');
  assert.ok(a3.content.includes(bobAgent.name),
    `case 3 must name the holder occupying the focus window (got: ${a3.content})`);
  assert.ok(a3.content.includes(`focus window 포화`) && a3.content.includes(occupiedTicketId),
    `case 3 must name the occupied ticket id (got: ${a3.content})`);
  assert.ok(a3.content.includes('조치 불필요일 수 있음'),
    `case 3 must read as a normal wait, distinct from the role-unfilled human-action wording (got: ${a3.content})`);
  assert.ok(!a3.content.includes('역할 공석'),
    'case 3 must not be confused with the role-unfilled cause');

  const a4 = alertFor(msgs, t4.id);
  assert.ok(a4, 'case 4 must still post a promotion-delay alert (the base detector is unaffected)');
  assert.ok(a4.content.includes('Cause: promotion-delay · waiting in intake for'),
    'case 4 base cause line must be present, unchanged');
  assert.ok(!a4.content.includes('사유:'),
    `case 4 (no audit row) must NOT fabricate a reason clause — wording stays exactly as before bb5b9aed (got: ${a4.content})`);

  exitAfterTests(0);
});
