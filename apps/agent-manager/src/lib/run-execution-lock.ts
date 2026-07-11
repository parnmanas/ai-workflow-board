// Folder-keyed run-lifetime mutex (ticket e9d0e8bc).
//
// A QA/security run's working folder is scenario-keyed (`.awb/qa/<scenario>`),
// NOT run-keyed, so two runs of the SAME scenario resolve to the SAME folder.
// The parent ticket (6254fb4e) added a provisioning-only mutex in
// run-provisioner.ts (`withFolderLock`) that serializes the git checkout/pull —
// but it releases the instant that git work finishes, in its own `finally`,
// BEFORE the run subagent spawns. That leaves the EXECUTION window unguarded:
// two subagents run concurrently in the same shared folder and clobber each
// other's checkout / build artifacts.
//
// This mutex closes that gap. The dispatcher acquires it BEFORE provisioning and
// releases it from the run subagent's process-exit hook, so one hold spans the
// whole provision→execute lifetime. Same folder → serialized (the later run
// waits for the earlier run's subagent to exit, then provisions warm and runs);
// different scenarios (different folders) never contend. Serializing same-folder
// execution is the only design consistent with the shared warm folder that the
// server's `cold_then_warm` build decision depends on — a per-run isolated folder
// would hand every run an empty tree while the server may command a WARM
// (artifact-reusing) build.
//
// Same chained-promise shape as run-provisioner's `withFolderLock` and
// WorktreeManager.#withPoolLock, but with an EXPLICIT release handle instead of a
// lexical `finally` — the hold deliberately outlives the acquiring function and
// ends on an external event (process exit).

export interface RunLockHandle {
  /** True when another holder was already queued for this key at acquire time —
   *  i.e. this acquisition WAITED behind a concurrent same-folder run. Surfaced
   *  so the caller can note the serialization instead of swallowing it. */
  readonly wasBusy: boolean;
  /**
   * Release the lock, letting the next waiter proceed. IDEMPOTENT — safe to call
   * from both the process-exit hook and a dispatcher error/abort path; the second
   * and later calls are no-ops. This matters because kill / reaper paths in the
   * session managers can force-drop a record, so the exit hook and the dispatcher
   * both defensively release.
   */
  release(): void;
}

export class FolderMutex {
  readonly #chain = new Map<string, Promise<void>>();

  /**
   * Acquire the lock for `key`, waiting behind any current holder of the same
   * key. Resolves with a handle once the lock is held; the caller owns it until
   * it calls `handle.release()` (typically from a subagent process-exit hook).
   * Different keys never block each other.
   */
  async acquire(key: string): Promise<RunLockHandle> {
    const prev = this.#chain.get(key);
    const wasBusy = prev !== undefined; // someone already holds/queues this key
    let signalDone!: () => void;
    const mine = new Promise<void>((r) => (signalDone = r));
    // Chain our hold AFTER the previous holder's; a later waiter chains after us.
    const composed = (prev ?? Promise.resolve()).then(() => mine);
    this.#chain.set(key, composed);
    // Block here until the previous holder releases (its `mine` resolves). A
    // rejected predecessor never happens (we only resolve, never reject), but
    // guard anyway so a stray rejection can't wedge the chain.
    if (prev) await prev.catch(() => {});

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      signalDone(); // let the next waiter's `.then(() => mine)` fire
      // Drop the entry once the chain drains so a LATER, non-concurrent acquire
      // sees the key as free (wasBusy=false). A waiter that chained after us
      // replaced the map value, so only delete our own tail.
      if (this.#chain.get(key) === composed) this.#chain.delete(key);
    };
    return { wasBusy, release };
  }

  /** Number of keys with a live or queued holder (test/introspection only). */
  get activeKeyCount(): number {
    return this.#chain.size;
  }
}
