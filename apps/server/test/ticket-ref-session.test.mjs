import test from 'node:test';
import assert from 'node:assert/strict';
import { PendingTicketRefAccumulator } from '../dist/modules/mcp/tools/ticket-ref-session.js';

test('pending ticket refs are stable, deduplicated, and create wins over update', () => {
  const pending = new PendingTicketRefAccumulator();
  pending.record({ action: 'update', ticket_id: 'T-1', title: 'before' });
  pending.record({ action: 'create', ticket_id: 'T-1', title: 'created' });
  pending.record({ action: 'update', ticket_id: 'T-1', title: 'after' });
  pending.record({ action: 'create', ticket_id: 'T-2', title: 'second' });

  assert.deepEqual(pending.drain(), [
    { action: 'create', ticket_id: 'T-1', title: 'after' },
    { action: 'create', ticket_id: 'T-2', title: 'second' },
  ]);
  assert.deepEqual(pending.drain(), [], 'drain consumes refs exactly once');
});

test('restore retains refs after a failed message save', () => {
  const pending = new PendingTicketRefAccumulator();
  pending.record({ action: 'create', ticket_id: 'T-1' });
  const drained = pending.drain();
  pending.restore(drained);
  assert.deepEqual(pending.drain(), [{ action: 'create', ticket_id: 'T-1' }]);
});
