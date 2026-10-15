import type { AgentSessionEventInput, AgentSessionStatePatch } from './rest.js';

// Stay below the server's 200-event limit. The byte budget bounds aggregation;
// an individual event is already bounded by the runner before enqueueing.
const MAX_BATCH_EVENTS = 128;
const MAX_BATCH_BYTES = 512 * 1024;

interface Batch {
  events: AgentSessionEventInput[];
  state?: AgentSessionStatePatch;
  bytes: number;
}

/** Ordered delivery with backpressure: combine output waiting behind a slow
 * request, but never combine across a state transition (approval, finish, etc.). */
export class AgentSessionDelivery {
  readonly #pending: Batch[] = [];
  #draining = false;
  #completion: Promise<void> = Promise.resolve();

  constructor(private readonly send: (events: AgentSessionEventInput[], state?: AgentSessionStatePatch) => Promise<unknown>) {}

  enqueue(events: AgentSessionEventInput[], state?: AgentSessionStatePatch): Promise<void> {
    if (!events.length && !state) return this.#completion;
    const bytes = Buffer.byteLength(JSON.stringify(events));
    const tail = this.#pending.at(-1);
    if (tail && !tail.state && !state
      && tail.events.length + events.length <= MAX_BATCH_EVENTS
      && tail.bytes + bytes <= MAX_BATCH_BYTES) {
      tail.events.push(...events);
      tail.bytes += bytes;
    } else {
      this.#pending.push({ events: [...events], state, bytes });
    }
    if (!this.#draining) {
      this.#draining = true;
      this.#completion = Promise.resolve().then(async () => {
        try {
          while (this.#pending.length) {
            const batch = this.#pending.shift()!;
            // The REST sender logs failed deliveries. Preserve the existing
            // best-effort policy and let subsequent output continue to drain.
            await this.send(batch.events, batch.state).catch(() => undefined);
          }
        } finally {
          this.#draining = false;
        }
      });
    }
    return this.#completion;
  }
}
