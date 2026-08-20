---
name: Condition-based waiting
description: Wait for the condition you actually need, never for a fixed duration.
version: 1.0.0
author: AI Workflow Board
license: MIT
---

# Condition-Based Waiting

`sleep(2000)` encodes a guess about someone else's machine. On a slow CI runner
it is too short and the test flakes; on a fast one it is pure wasted wall clock.
Multiply by a suite and it is minutes per run.

## Instead

Poll the condition with a deadline:

```js
async function waitFor(predicate, { timeoutMs = 8000, intervalMs = 50, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
```

The timeout is a **failure bound**, not a duration: on success you leave as soon
as the condition holds.

## Better still: subscribe

If the system already emits an event for what you are waiting on — an SSE frame,
a process exit, a callback — wait on that. Polling is a fallback for state you
cannot be notified about.

## Naming the condition

`waitFor(() => rows.length > 0)` tells the next reader nothing when it times
out. `waitFor(() => rows.length > 0, { what: 'the dispatch to insert an
activity row' })` turns a flaky-test report into a diagnosis.

## Red flags

- A sleep whose comment says "give it a moment to settle".
- A sleep that was increased to fix a flake. It will be increased again.
- A retry loop with no deadline — that is a hang, not a wait.
