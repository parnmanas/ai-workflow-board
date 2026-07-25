import type { ChatMessageTicketRef } from '../../../common/types/stream-events';

/**
 * Successful ticket mutations waiting to be attached to this MCP session's
 * final chat reply. A ToolContext is created per MCP transport session, so the
 * accumulator cannot leak refs between agents or reconnects.
 */
export class PendingTicketRefAccumulator {
  private refs: ChatMessageTicketRef[] = [];

  record(ref: ChatMessageTicketRef): void {
    if (!ref.ticket_id || (ref.action !== 'create' && ref.action !== 'update')) return;

    const existing = this.refs.findIndex((item) => item.ticket_id === ref.ticket_id);
    if (existing < 0) {
      this.refs.push({ ...ref });
      return;
    }

    // A ticket created and then edited in one turn is still one "created"
    // artifact. Preserve its stable position while refreshing the title.
    const current = this.refs[existing];
    if (current.action === 'create' || ref.action === 'create') {
      this.refs[existing] = {
        ...current,
        ...ref,
        action: 'create',
        title: ref.title || current.title,
      };
    } else if (ref.title && !current.title) {
      this.refs[existing] = { ...current, title: ref.title };
    }
  }

  drain(): ChatMessageTicketRef[] {
    const drained = this.refs;
    this.refs = [];
    return drained;
  }

  restore(refs: ChatMessageTicketRef[]): void {
    for (const ref of refs) this.record(ref);
  }
}
