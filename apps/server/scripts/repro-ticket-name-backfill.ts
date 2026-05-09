/**
 * Standalone repro for the ticket assignee/reporter name↔id backfill bug
 * tracked on ticket 198a43b2-e6e4-4acc-aca3-47e9819efe15.
 *
 * Spins up an in-memory sqlite DataSource via sql.js, seeds two Agent rows
 * + one Ticket row, then exercises the *exact* update-path logic from
 * `apps/server/src/modules/mcp/tools/ticket-crud-tools.ts` (call-site code
 * is duplicated verbatim — keep in sync if the call site changes).
 *
 *   npx tsx apps/server/scripts/repro-ticket-name-backfill.ts
 *
 * Output is the three review-comment cases plus a "PASS / FAIL" line so the
 * harness fails loud if the bug ever re-surfaces.
 */

import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Agent } from '../src/entities/Agent';
import { Ticket } from '../src/entities/Ticket';
import * as entitiesBarrel from '../src/entities';
import { resolveAgentIdAndName } from '../src/modules/mcp/shared/ticket-helpers';

type UpdateInput = { assignee?: string; assignee_id?: string };
type UpdateOutput = { assignee: string; assignee_id: string; changes: string[] };

/**
 * Mirrors the post-fix call site in
 *   apps/server/src/modules/mcp/tools/ticket-crud-tools.ts
 * around the `if (assignee !== undefined || assignee_id !== undefined)` block.
 * If you change that block, change this too.
 */
async function applyUpdate(ds: DataSource, ticket: Ticket, input: UpdateInput): Promise<UpdateOutput> {
  const oldAssignee = ticket.assignee;
  const changes: string[] = [];
  const { assignee, assignee_id } = input;

  if (assignee !== undefined || assignee_id !== undefined) {
    const resolved = await resolveAgentIdAndName(
      ds,
      assignee_id !== undefined ? assignee_id : '',
      assignee !== undefined ? assignee : '',
    );
    ticket.assignee_id = assignee_id !== undefined ? assignee_id : (resolved.id || ticket.assignee_id);
    ticket.assignee    = assignee    !== undefined ? assignee    : (resolved.name || ticket.assignee);
    if (ticket.assignee !== oldAssignee) changes.push('assignee');
  }

  await ds.getRepository(Ticket).save(ticket);
  return { assignee: ticket.assignee, assignee_id: ticket.assignee_id, changes };
}

async function main() {
  const ds = new DataSource({
    type: 'sqljs',
    autoSave: false,
    synchronize: true,
    entities: Object.values(entitiesBarrel),
    logging: false,
  });
  await ds.initialize();

  const agentRepo = ds.getRepository(Agent);
  const ticketRepo = ds.getRepository(Ticket);

  const alice = await agentRepo.save(agentRepo.create({ name: 'Alice', api_key: 'k-alice' }));
  const bob   = await agentRepo.save(agentRepo.create({ name: 'Bob',   api_key: 'k-bob' }));

  // Helper to (re)seed a ticket row at a known starting state.
  const seed = async (assignee: string, assignee_id: string): Promise<Ticket> => {
    await ticketRepo.clear();
    return ticketRepo.save(ticketRepo.create({
      title: 'repro', assignee, assignee_id, reporter: '', reporter_id: '', reviewer_id: '',
    }));
  };

  // ── Case 1: populated row, id-only update ─────────────────────────────
  // Old: Alice/<alice-id>. Call: update_ticket({ assignee_id: bob-id }).
  // Expected: assignee="Bob", assignee_id=bob-id, changes=["assignee"].
  let t = await seed('Alice', alice.id);
  const c1 = await applyUpdate(ds, t, { assignee_id: bob.id });
  const c1ok = c1.assignee === 'Bob' && c1.assignee_id === bob.id && c1.changes.includes('assignee');
  console.log(`Case 1: existing(Alice/<id>) + update_ticket({assignee_id:"<bob-id>"})`);
  console.log(`  saved row: ${JSON.stringify({ assignee: c1.assignee, assignee_id: shorten(c1.assignee_id) })}`);
  console.log(`  changes  : ${JSON.stringify(c1.changes)}`);
  console.log(`  expected : {"assignee":"Bob","assignee_id":"<bob-id>"} + ["assignee"]`);
  console.log(`  ${c1ok ? '✓ PASS' : '✗ FAIL'}\n`);

  // ── Case 2: populated row, name-only update ───────────────────────────
  // Old: Alice/<alice-id>. Call: update_ticket({ assignee: "Bob" }).
  // Expected: assignee="Bob", assignee_id=bob-id, changes=["assignee"].
  t = await seed('Alice', alice.id);
  const c2 = await applyUpdate(ds, t, { assignee: 'Bob' });
  const c2ok = c2.assignee === 'Bob' && c2.assignee_id === bob.id && c2.changes.includes('assignee');
  console.log(`Case 2: existing(Alice/<id>) + update_ticket({assignee:"Bob"})`);
  console.log(`  saved row: ${JSON.stringify({ assignee: c2.assignee, assignee_id: shorten(c2.assignee_id) })}`);
  console.log(`  changes  : ${JSON.stringify(c2.changes)}`);
  console.log(`  expected : {"assignee":"Bob","assignee_id":"<bob-id>"} + ["assignee"]`);
  console.log(`  ${c2ok ? '✓ PASS' : '✗ FAIL'}\n`);

  // ── Case 3: empty row, id-only update (sanity / regression) ───────────
  // Old: empty. Call: update_ticket({ assignee_id: bob-id }).
  // Expected: assignee="Bob", assignee_id=bob-id, changes=["assignee"].
  t = await seed('', '');
  const c3 = await applyUpdate(ds, t, { assignee_id: bob.id });
  const c3ok = c3.assignee === 'Bob' && c3.assignee_id === bob.id && c3.changes.includes('assignee');
  console.log(`Case 3: existing("","") + update_ticket({assignee_id:"<bob-id>"})  (empty row)`);
  console.log(`  saved row: ${JSON.stringify({ assignee: c3.assignee, assignee_id: shorten(c3.assignee_id) })}`);
  console.log(`  changes  : ${JSON.stringify(c3.changes)}`);
  console.log(`  expected : {"assignee":"Bob","assignee_id":"<bob-id>"} + ["assignee"]`);
  console.log(`  ${c3ok ? '✓ PASS' : '✗ FAIL'}\n`);

  // ── Case 4: lookup miss (id points at a non-existent agent) ───────────
  // Old: Alice/<alice-id>. Call: update_ticket({ assignee_id: "nope" }).
  // Expected (caller-keep semantics): assignee_id="nope" verbatim, assignee
  // falls back to the existing "Alice" so a User row / stale id doesn't
  // blank the column. No activity entry (assignee text didn't change).
  t = await seed('Alice', alice.id);
  const c4 = await applyUpdate(ds, t, { assignee_id: 'nope-not-an-agent' });
  const c4ok = c4.assignee === 'Alice' && c4.assignee_id === 'nope-not-an-agent' && c4.changes.length === 0;
  console.log(`Case 4: existing(Alice/<id>) + update_ticket({assignee_id:"nope"})  (lookup miss)`);
  console.log(`  saved row: ${JSON.stringify({ assignee: c4.assignee, assignee_id: c4.assignee_id })}`);
  console.log(`  changes  : ${JSON.stringify(c4.changes)}`);
  console.log(`  expected : {"assignee":"Alice","assignee_id":"nope-not-an-agent"} + []`);
  console.log(`  ${c4ok ? '✓ PASS' : '✗ FAIL'}\n`);

  await ds.destroy();
  const allOk = c1ok && c2ok && c3ok && c4ok;
  console.log(allOk ? 'ALL CASES PASS' : 'AT LEAST ONE CASE FAILED');
  process.exit(allOk ? 0 : 1);
}

function shorten(id: string): string {
  return id ? `<${id.slice(0, 8)}…>` : id;
}

main().catch(e => { console.error(e); process.exit(2); });
