/** Invalid configuration keeps the conservative default rather than disabling the cap. */
export function buildConcurrency(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

/** FIFO admission shared by all lifecycle service instances in this process. */
export class BuildSlots {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('build slot limit must be a positive integer');
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
    } else {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      // Transfer the occupied slot directly so a new arrival cannot jump the queue.
      if (next) next();
      else this.active--;
    };
  }
}

// Read once on first use: dotenv/bootstrap may not have loaded at module import time.
let sharedSlots: BuildSlots | undefined;
export const ontologyBuildSlots = {
  acquire(): Promise<() => void> {
    sharedSlots ??= new BuildSlots(buildConcurrency(process.env.ONTOLOGY_BUILD_CONCURRENCY));
    return sharedSlots.acquire();
  },
};
