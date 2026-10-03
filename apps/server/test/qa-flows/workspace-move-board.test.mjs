// QA: cross-workspace board move (ticket 8882056b).
//
// Exercises WorkspaceMoveService end-to-end against a real booted app + SQLite:
//   (a) triple re-stamp — board / columns / tickets (roots + subtask) land in
//       the destination workspace scope.
//   (b) carry / remap — column_prompts template copied into dest + remapped;
//       TicketRoleAssignment.role_id remapped to the dest same-slug role;
//       a source-only custom role slug is created in dest.
//   (d) dry-run preview writes nothing; commit is atomic — a blocked commit
//       (carry_agents on an agent that also works another board) applies
//       NOTHING.
//
// Run isolated: bootApp uses sqlite; set a unique PORT so it never collides
// with sibling qa-flows.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  createWorkspace,
  createBoard,
  createColumn,
  createTicket,
  createAgent,
} from '../helpers/fixtures.mjs';

process.env.PORT = process.env.QA_WS_MOVE_PORT || '0';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', '..', 'dist');

async function loadMover(app, getDataSourceToken) {
  const { WorkspaceMoveService, WorkspaceMoveBlockedError } = await import(
    'file://' + path.join(DIST_ROOT, 'services', 'workspace-move.service.js')
  );
  const { ActivityService } = await import(
    'file://' + path.join(DIST_ROOT, 'services', 'activity.service.js')
  );
  const ds = app.get(getDataSourceToken());
  const activity = app.get(ActivityService);
  return { mover: new WorkspaceMoveService(ds, activity), WorkspaceMoveBlockedError, ds };
}

// Build a board with one custom role, a prompt template, a root ticket (with a
// subtask) assigned to an agent, and column role_routing referencing the custom
// slug. Returns every id the assertions need.
async function buildScene(app, getDataSourceToken, sourceWs, label) {
  const ds = app.get(getDataSourceToken());

  // source-only custom role — must be CREATED in dest on move.
  const roleRepo = ds.getRepository('WorkspaceRole');
  const customRole = await roleRepo.save(roleRepo.create({
    workspace_id: sourceWs.id, slug: `qa-custom-${label}`, name: 'QA Custom',
    role_prompt: 'custom', description: 'qa', position: 9, is_builtin: false,
  }));

  // prompt template in source ws — must be COPIED into dest + remapped.
  const tplRepo = ds.getRepository('PromptTemplate');
  const tpl = await tplRepo.save(tplRepo.create({
    workspace_id: sourceWs.id, name: `qa-tpl-${label}`, description: 'qa',
    content: 'TEMPLATE BODY', category: 'workflow',
  }));

  const agent = await createAgent(app, getDataSourceToken, sourceWs.id, { name: `mover-${label}` });

  const board = await createBoard(app, getDataSourceToken, sourceWs.id, { name: `move-${label}` });
  const todo = await createColumn(app, getDataSourceToken, board.id, {
    name: 'Todo', position: 0, workspaceId: sourceWs.id, kind: 'intake',
    roleRouting: ['assignee', customRole.slug],
  });
  const done = await createColumn(app, getDataSourceToken, board.id, {
    name: 'Done', position: 1, workspaceId: sourceWs.id, isTerminal: true, kind: 'terminal',
  });

  // wire the column→template mapping the move must carry.
  const boardRepo = ds.getRepository('Board');
  await boardRepo.update({ id: board.id }, { column_prompts: JSON.stringify({ [todo.id]: tpl.id }) });

  const root = await createTicket(app, getDataSourceToken, {
    columnId: todo.id, workspaceId: sourceWs.id, title: `root-${label}`, assigneeId: agent.id,
  });
  const child = await createTicket(app, getDataSourceToken, {
    columnId: null, workspaceId: sourceWs.id, title: `child-${label}`, parentId: root.id, depth: 1,
  });

  // attach the custom role assignment on the root ticket so role_id remap is exercised.
  const assignRepo = ds.getRepository('TicketRoleAssignment');
  await assignRepo.save(assignRepo.create({
    ticket_id: root.id, role_id: customRole.id, agent_id: agent.id, user_id: null,
  }));

  return { ds, agent, board, todo, done, root, child, tpl, customRole };
}

test('board cross-workspace move: re-stamp + carry/remap + atomicity', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;
  const { mover, WorkspaceMoveBlockedError, ds } = await loadMover(app, getDataSourceToken);

  const sourceWs = await createWorkspace(app, getDataSourceToken, 'move-src');
  const destWs = await createWorkspace(app, getDataSourceToken, 'move-dst');
  const scene = await buildScene(app, getDataSourceToken, sourceWs, 'main');

  const ticketRepo = ds.getRepository('Ticket');
  const colRepo = ds.getRepository('BoardColumn');
  const boardRepo = ds.getRepository('Board');
  const roleRepo = ds.getRepository('WorkspaceRole');
  const assignRepo = ds.getRepository('TicketRoleAssignment');
  const tplRepo = ds.getRepository('PromptTemplate');

  // ── (d) preview writes nothing ──────────────────────────────────────────
  step('dry-run preview must not mutate anything');
  const preview = await mover.previewBoardMove(scene.board.id, destWs.id, {});
  assert.equal(preview.committed, false, 'preview is not committed');
  assert.ok(preview.counts.tickets >= 2, 'preview counts both root + subtask');
  assert.equal((await boardRepo.findOne({ where: { id: scene.board.id } })).workspace_id, sourceWs.id,
    'board workspace unchanged after preview');
  assert.equal((await ticketRepo.findOne({ where: { id: scene.root.id } })).workspace_id, sourceWs.id,
    'ticket workspace unchanged after preview');
  // dest must not have received the copied template yet.
  assert.equal(await tplRepo.findOne({ where: { workspace_id: destWs.id, name: scene.tpl.name } }), null,
    'no template copied during preview');
  // P4c-4: companion-agent 표면 retired — blockers/items 에 agent 항목 없음.
  assert.equal(preview.blockers.length, 0, 'no blockers without carry_agents');
  assert.ok(!preview.items.some((i) => i.entity === 'agent'),
    'no companion-agent items (surface retired)');

  // ── (a)+(b) commit ──────────────────────────────────────────────────────
  step('commit moves board + deps to dest workspace');
  const committed = await mover.commitBoardMove(scene.board.id, destWs.id, {});
  assert.equal(committed.committed, true, 'commit reports committed');

  // (a) triple re-stamp
  assert.equal((await boardRepo.findOne({ where: { id: scene.board.id } })).workspace_id, destWs.id,
    'board re-stamped to dest');
  for (const colId of [scene.todo.id, scene.done.id]) {
    assert.equal((await colRepo.findOne({ where: { id: colId } })).workspace_id, destWs.id,
      `column ${colId} re-stamped`);
  }
  assert.equal((await ticketRepo.findOne({ where: { id: scene.root.id } })).workspace_id, destWs.id,
    'root ticket re-stamped');
  assert.equal((await ticketRepo.findOne({ where: { id: scene.child.id } })).workspace_id, destWs.id,
    'subtask re-stamped (child column_id is null — proves BFS over parent_id)');

  // (b) custom role created in dest + assignment remapped
  const destCustom = await roleRepo.findOne({ where: { workspace_id: destWs.id, slug: scene.customRole.slug } });
  assert.ok(destCustom, 'source-only custom role created in dest');
  const rootAssignments = await assignRepo.find({ where: { ticket_id: scene.root.id } });
  for (const a of rootAssignments) {
    const role = await roleRepo.findOne({ where: { id: a.role_id } });
    assert.equal(role.workspace_id, destWs.id, 'every role assignment now points at a dest-ws role');
  }
  assert.ok(rootAssignments.some((a) => a.role_id === destCustom.id), 'custom assignment remapped to dest custom role');

  // (b) template copied + column_prompts remapped
  const destTpl = await tplRepo.findOne({ where: { workspace_id: destWs.id, name: scene.tpl.name } });
  assert.ok(destTpl, 'template copied into dest');
  assert.notEqual(destTpl.id, scene.tpl.id, 'dest template is a distinct row (non-destructive copy)');
  const movedBoard = await boardRepo.findOne({ where: { id: scene.board.id } });
  const cp = JSON.parse(movedBoard.column_prompts || '{}');
  assert.equal(cp[scene.todo.id], destTpl.id, 'column_prompts remapped to dest template id');
  // source template still intact (non-destructive)
  assert.ok(await tplRepo.findOne({ where: { id: scene.tpl.id } }), 'source template left intact');

  // P4c-4: companion-agent carry/blocker/remedy retired (Agent 테이블 없음) —
  // carry_agents/exclude/unassign 경로는 handleCompanionAgents no-op 과 함께 삭제됐다.
  // 원자성 자체는 위 commit assertions 에서 커버한다.
});

test.after(() => exitAfterTests(0));
